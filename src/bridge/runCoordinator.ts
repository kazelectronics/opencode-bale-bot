import type { Config } from "../config.js";
import type { ChatRepo, SettingsRepo } from "../db.js";
import type { HealthState } from "../health.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { OpenCodeEvent } from "../opencode/types.js";
import { renderFinal, renderLive, type RenderedFinal } from "../renderer.js";
import { truncate } from "../util.js";
import { isMessageTooLong, type BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import type { FormManager } from "./forms.js";
import type { InteractionManager } from "./interactions.js";
import type { MenuManager } from "./menus.js";
import {
  extractSessionID,
  RunReducer,
  extractPermission,
  extractForm,
  type RunSnapshot,
  type ToolActivity,
} from "./runReducer.js";
import type { SessionService } from "./sessions.js";
import type { WatchManager } from "./watches.js";
import type { DashboardManager } from "./dashboard.js";

/** Events that can change a field shown on the live dashboard. */
const DASHBOARD_REFRESH_EVENTS = new Set<string>([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.ended",
  "session.tool.success",
  "session.tool.failed",
  "session.usage.updated",
  "session.compaction.ended",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
]);

export interface RunCoordinatorOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly outbox: Outbox;
  readonly interactions: InteractionManager;
  readonly forms: FormManager;
  readonly menus: MenuManager;
  readonly sessions: SessionService;
  readonly watches: WatchManager;
  readonly dashboard: DashboardManager;
  readonly settings: SettingsRepo;
  readonly health: HealthState;
  readonly config: Config;
  readonly logger: Logger;
  /** Returns the chat that owns a scheduled-task session, if any. */
  readonly taskChatForSession?: (sessionID: string) => string | null;
}

export class RunCoordinator {
  private readonly options: RunCoordinatorOptions;
  private readonly reducer: RunReducer;
  private readonly liveCreation = new Map<string, Promise<number | null>>();
  private readonly typingSent = new Set<string>();
  private readonly finalized = new Set<string>();

  constructor(options: RunCoordinatorOptions) {
    this.options = options;
    this.reducer = new RunReducer({
      logger: options.logger,
      onUpdate: (snapshot) => {
        void this.preview(snapshot).catch((error) => {
          options.logger.debug("Live preview failed", {
            sessionId: snapshot.sessionID,
            error: errorMessage(error),
          });
        });
      },
      onTerminal: (snapshot) => {
        void this.finalize(snapshot).catch((error) => {
          options.logger.error("Finalizing run failed", {
            sessionId: snapshot.sessionID,
            error: errorMessage(error),
          });
        });
      },
      onPermission: (request, snapshot) => {
        void this.options.interactions
          .onPermissionAsked(request, snapshot.chatId)
          .catch((error) => {
            options.logger.error("Permission handling failed", {
              requestId: request.id,
              error: errorMessage(error),
            });
          });
      },
      onForm: (form, snapshot) => {
        void this.options.forms
          .onFormCreated(
            {
              id: form.id,
              sessionID: form.sessionID,
              title: form.title,
              fields: form.fields,
            },
            snapshot.chatId,
          )
          .catch((error) => {
            options.logger.error("Form handling failed", {
              formId: form.id,
              error: errorMessage(error),
            });
          });
      },
    });
  }

  snapshot(sessionID: string): RunSnapshot | null {
    return this.reducer.get(sessionID);
  }

  forget(sessionID: string): void {
    this.reducer.remove(sessionID);
    this.typingSent.delete(sessionID);
  }

  handleEvent(event: OpenCodeEvent): void {
    if (event.type === "session.created") {
      void this.onSessionCreated(event).catch((error) => {
        this.options.logger.debug("Could not announce a new session", {
          error: errorMessage(error),
        });
      });
      return;
    }

    const sessionID = extractSessionID(event);
    if (!sessionID) {
      return;
    }

    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      void this.options.watches.notifyTerminal(sessionID, event.type).catch((error) => {
        this.options.logger.warn("Background session notice failed", {
          sessionId: sessionID,
          error: errorMessage(error),
        });
      });
    }

    const chat = this.options.chats.findByActiveSession(sessionID);
    if (!chat) {
      const taskChatId = this.options.taskChatForSession?.(sessionID) ?? null;
      if (taskChatId) {
        this.handleTaskSessionEvent(event, sessionID, taskChatId);
        return;
      }
      if (event.type === "permission.asked") {
        const request = extractPermission(event.data ?? {}, sessionID);
        if (request) {
          void this.options.watches
            .notifyInteractive(sessionID, "permission", request.id, request)
            .catch((error) => {
              this.options.logger.warn("Detached permission notice failed", {
                sessionId: sessionID,
                error: errorMessage(error),
              });
            });
        }
      } else if (event.type === "form.created") {
        const form = extractForm(event.data ?? {}, sessionID);
        if (form) {
          void this.options.watches
            .notifyInteractive(sessionID, "form", form.id, form)
            .catch((error) => {
              this.options.logger.warn("Detached form notice failed", {
                sessionId: sessionID,
                error: errorMessage(error),
              });
            });
        }
      }
      return;
    }

    if (event.type === "form.replied" || event.type === "form.cancelled") {
      const formId = extractFormID(event.data);
      if (formId) {
        void this.options.forms
          .onFormSettled(formId, event.type === "form.replied" ? "replied" : "cancelled")
          .catch((error) => {
            this.options.logger.debug("Could not mark form settled", {
              formId,
              error: errorMessage(error),
            });
          });
      }
    }

    if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") {
      const inboxID = typeof event.data?.inboxID === "string" ? event.data.inboxID : null;
      if (inboxID) {
        void this.options.interactions
          .onInboxSettled(
            inboxID,
            event.type === "session.inbox.delivered" ? "delivered" : "cancelled",
          )
          .catch((error) => {
            this.options.logger.debug("Could not mark inbox item settled", {
              inboxID,
              error: errorMessage(error),
            });
          });
      }
    }

    if (event.type === "permission.replied" || event.type === "permission.rejected") {
      const requestId = extractRequestID(event.data);
      if (requestId) {
        void this.options.interactions.onPermissionReplied(requestId).catch((error) => {
          this.options.logger.debug("Could not mark permission resolved", {
            requestId,
            error: errorMessage(error),
          });
        });
      }
    }

    if (event.type === "session.execution.started") {
      // A new run supersedes the finalization guard for earlier runs.
      for (const key of this.finalized) {
        if (key.startsWith(`${sessionID}:`)) {
          this.finalized.delete(key);
        }
      }
      void this.sendTyping(chat.chat_id, sessionID);
    }

    this.reducer.handle(event, chat.chat_id);
    if (DASHBOARD_REFRESH_EVENTS.has(event.type)) {
      void this.options.dashboard.refreshForSession(sessionID).catch((error) => {
        this.options.logger.debug("Dashboard refresh failed", {
          sessionId: sessionID,
          error: errorMessage(error),
        });
      });
    }

    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      this.typingSent.delete(sessionID);
    }
  }

  /**
   * On SSE reconnect, reconcile any tracked run with REST. This covers a missed
   * terminal event without replaying the whole message history.
   */
  async resync(): Promise<void> {
    const { client, chats, logger } = this.options;
    for (const chat of chats.list()) {
      if (!chat.active_session_id) {
        continue;
      }
      const sessionID = chat.active_session_id;
      const state = this.reducer.get(sessionID);
      if (!state || isTerminal(state.status)) {
        continue;
      }
      try {
        const session = await client.getSession(sessionID);
        const idleAt = session.time.idle;
        if (idleAt !== undefined && idleAt >= state.startedAt) {
          const outcome =
            session.outcome === "failed"
              ? "failed"
              : session.outcome === "interrupted"
                ? "interrupted"
                : "succeeded";
          logger.info("REST resync found a finished run", { sessionId: sessionID, outcome });
          this.handleEvent({
            type: `session.execution.${outcome}`,
            data: { sessionID },
          });
        }
      } catch (error) {
        logger.debug("REST resync failed for session", {
          sessionId: sessionID,
          error: errorMessage(error),
        });
      }
    }
  }

  /**
   * Scheduled-task sessions have no chats.active_session_id binding. Route
   * blocking interactions to the owning chat; the task runner reports the
   * terminal result itself.
   */
  private handleTaskSessionEvent(
    event: OpenCodeEvent,
    sessionID: string,
    chatId: string,
  ): void {
    if (event.type === "permission.asked") {
      const request = extractPermission(event.data ?? {}, sessionID);
      if (request) {
        void this.options.interactions
          .onPermissionAsked(request, chatId)
          .catch((error) => {
            this.options.logger.warn("Task permission notice failed", {
              sessionId: sessionID,
              chatId,
              error: errorMessage(error),
            });
          });
      }
      return;
    }
    if (event.type === "form.created") {
      const form = extractForm(event.data ?? {}, sessionID);
      if (form) {
        void this.options.forms
          .onFormCreated(
            {
              id: form.id,
              sessionID: form.sessionID,
              title: form.title,
              fields: form.fields,
            },
            chatId,
          )
          .catch((error) => {
            this.options.logger.warn("Task form notice failed", {
              sessionId: sessionID,
              chatId,
              error: errorMessage(error),
            });
          });
      }
      return;
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      const formId = extractFormID(event.data);
      if (formId) {
        void this.options.forms
          .onFormSettled(formId, event.type === "form.replied" ? "replied" : "cancelled")
          .catch(() => undefined);
      }
      return;
    }
    if (event.type === "permission.replied" || event.type === "permission.rejected") {
      const requestId = extractRequestID(event.data);
      if (requestId) {
        void this.options.interactions.onPermissionReplied(requestId).catch(() => undefined);
      }
      return;
    }
    if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") {
      const inboxID = typeof event.data?.inboxID === "string" ? event.data.inboxID : null;
      if (inboxID) {
        void this.options.interactions
          .onInboxSettled(
            inboxID,
            event.type === "session.inbox.delivered" ? "delivered" : "cancelled",
          )
          .catch(() => undefined);
      }
    }
  }

  private async preview(snapshot: RunSnapshot): Promise<void> {
    if (isTerminal(snapshot.status)) {
      return;
    }
    if (!snapshot.text.trim() && !snapshot.tool && !snapshot.compaction) {
      return;
    }

    const messageId = await this.ensureLiveMessage(
      snapshot.chatId,
      snapshot.compaction?.status === "running" ? "🗜️ Compacting…" : "⏳ Working…",
    );
    if (messageId === null) {
      return;
    }

    const settings = this.options.settings.get(snapshot.chatId);
    const compact = settings.progress_style === "compact";
    const preview = renderLive(compact ? "" : snapshot.text, {
      limit: this.options.config.bridge.liveTextLimit,
      workingLabel: snapshot.queued ? "Queued" : "Working",
      ...(activityOf(snapshot) ? { activity: activityOf(snapshot) as string } : {}),
    });
    const withReasoning =
      settings.show_thinking && snapshot.reasoning.trim().length > 0
        ? `${preview}\n\n🧠 _${truncate(snapshot.reasoning, 600)}_`
        : preview;

    this.options.outbox.forChat(snapshot.chatId).scheduleEdit(messageId, withReasoning);
  }

  private async finalize(snapshot: RunSnapshot): Promise<void> {
    const key = runKey(snapshot.sessionID, snapshot.startedAt);
    if (this.finalized.has(key)) {
      return;
    }
    this.finalized.add(key);

    if (snapshot.compaction && snapshot.text.trim().length === 0) {
      await this.finalizeCompaction(snapshot);
      return;
    }

    const messageId = await this.ensureLiveMessage(snapshot.chatId, "⏳ Working…");
    const chat = this.options.outbox.forChat(snapshot.chatId);
    const durationMs = Math.max(0, Date.now() - snapshot.startedAt);
    const settings = this.options.settings.get(snapshot.chatId);
    const rendered = renderFinal({
      markdown: snapshot.text,
      outcome: snapshot.outcome ?? "succeeded",
      ...(snapshot.error ? { error: snapshot.error } : {}),
      model: snapshot.model ?? `${this.options.config.opencode.model.providerID}/${this.options.config.opencode.model.id}`,
      durationMs,
      ...(snapshot.usage ? { usage: snapshot.usage } : {}),
      limit: this.options.config.bridge.liveTextLimit,
      sessionId: snapshot.sessionID,
      showFooter: settings.show_footer,
    });

    try {
      if (rendered.kind === "text") {
        await this.deliverText(chat, messageId, rendered.text);
      } else {
        await this.deliverDocument(chat, messageId, rendered, snapshot);
      }
    } finally {
      const current = this.options.chats.get(snapshot.chatId)?.live_message_id ?? null;
      if (messageId !== null && current === messageId) {
        this.options.chats.setLiveMessage(snapshot.chatId, null);
      }
      this.typingSent.delete(snapshot.sessionID);
    }

    this.options.logger.info("Run finalized", {
      sessionId: snapshot.sessionID,
      chatId: snapshot.chatId,
      outcome: snapshot.outcome,
      durationMs,
      characters: snapshot.text.length,
      kind: rendered.kind,
    });
    void this.options.dashboard
      .refreshForChat(snapshot.chatId, { force: true })
      .catch(() => undefined);
  }

  private async finalizeCompaction(snapshot: RunSnapshot): Promise<void> {
    const messageId = await this.ensureLiveMessage(snapshot.chatId, "🗜️ Compacting…");
    const chat = this.options.outbox.forChat(snapshot.chatId);
    const compaction = snapshot.compaction;
    const text =
      compaction?.status === "failed"
        ? `⚠️ *Compaction failed*\n\n${truncate(compaction.error ?? "Unknown error", 300)}`
        : "🗜️ *Compaction complete.*\n\n_Context summarized. The next message starts with the compacted context._";
    try {
      if (messageId !== null) {
        try {
          await chat.editNow(messageId, text);
        } catch (error) {
          this.options.logger.debug("Could not edit compaction message; sending a new one", {
            error: errorMessage(error),
          });
          await chat.send(text);
        }
      } else {
        await chat.send(text);
      }
    } finally {
      const current = this.options.chats.get(snapshot.chatId)?.live_message_id ?? null;
      if (messageId !== null && current === messageId) {
        this.options.chats.setLiveMessage(snapshot.chatId, null);
      }
      this.typingSent.delete(snapshot.sessionID);
    }
    this.options.logger.info("Compaction finalized", {
      sessionId: snapshot.sessionID,
      chatId: snapshot.chatId,
      status: compaction?.status,
    });
    void this.options.dashboard
      .refreshForChat(snapshot.chatId, { force: true })
      .catch(() => undefined);
  }

  private async onSessionCreated(event: OpenCodeEvent): Promise<void> {
    const data = event.data ?? {};
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : null;
    if (!sessionID) {
      return;
    }
    if (this.options.sessions.createdByBridge(sessionID)) {
      return;
    }
    if (
      typeof data.title === "string" &&
      data.title.startsWith(this.options.config.bridge.sessionTitlePrefix)
    ) {
      return;
    }

    const location =
      data.location && typeof data.location === "object"
        ? (data.location as Record<string, unknown>)
        : null;
    const directory = typeof location?.directory === "string" ? location.directory : undefined;
    const title = typeof data.title === "string" ? data.title : "";

    for (const chat of this.options.chats.list()) {
      if (chat.active_session_id) {
        continue;
      }
      if (directory) {
        const project = chat.project_directory ?? this.options.config.opencode.projectDirectory;
        if (directory !== project) {
          continue;
        }
      }
      await this.options.menus.notifySessionCreated(chat, {
        id: sessionID,
        title,
        ...(directory ? { directory } : {}),
      });
    }
  }

  private async deliverText(
    chat: ReturnType<Outbox["forChat"]>,
    messageId: number | null,
    text: string,
  ): Promise<void> {
    if (messageId !== null) {
      try {
        const edited = await chat.editNow(messageId, text);
        if (edited) {
          return;
        }
      } catch (error) {
        if (!isMessageTooLong(error)) {
          this.options.logger.warn("Final edit failed; sending a new message", {
            messageId,
            error: errorMessage(error),
          });
        }
      }
    }
    await chat.send(text);
  }

  private async deliverDocument(
    chat: ReturnType<Outbox["forChat"]>,
    messageId: number | null,
    rendered: Extract<RenderedFinal, { kind: "document" }>,
    snapshot: RunSnapshot,
  ): Promise<void> {
    if (messageId !== null) {
      const note =
        snapshot.outcome === "failed"
          ? "❌ *Run failed* — details attached."
          : snapshot.outcome === "interrupted"
            ? "⏹ *Stopped* — partial output attached."
            : "✅ *Done* — full response attached.";
      try {
        await chat.editNow(messageId, note);
      } catch (error) {
        this.options.logger.debug("Could not edit live message before document", {
          error: errorMessage(error),
        });
      }
    }

    try {
      await chat.sendDocument({
        filename: rendered.filename,
        content: rendered.text,
        caption: rendered.caption,
        mimeType: rendered.mimeType,
      });
      return;
    } catch (error) {
      this.options.logger.error("Document upload failed; falling back to text", {
        error: errorMessage(error),
      });
    }

    const fallback = truncate(rendered.text, this.options.config.bridge.liveTextLimit);
    try {
      if (messageId !== null && (await chat.editNow(messageId, fallback))) {
        return;
      }
    } catch {
      // fall through to a new message
    }
    await chat.send(fallback);
  }

  private async ensureLiveMessage(chatId: string, initialText: string): Promise<number | null> {
    const existing = this.options.chats.get(chatId)?.live_message_id ?? null;
    if (existing !== null) {
      return existing;
    }
    const inFlight = this.liveCreation.get(chatId);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      try {
        const message = await this.options.outbox.forChat(chatId).send(initialText);
        const current = this.options.chats.get(chatId);
        if (!current) {
          return message.message_id;
        }
        this.options.chats.setLiveMessage(chatId, message.message_id);
        return message.message_id;
      } catch (error) {
        this.options.logger.warn("Could not create live message", {
          chatId,
          error: errorMessage(error),
        });
        return null;
      } finally {
        this.liveCreation.delete(chatId);
      }
    })();

    this.liveCreation.set(chatId, promise);
    return promise;
  }

  private async sendTyping(chatId: string, sessionID: string): Promise<void> {
    if (this.typingSent.has(sessionID)) {
      return;
    }
    this.typingSent.add(sessionID);
    try {
      await this.options.gateway.sendChatAction({ chatId });
    } catch (error) {
      this.options.logger.debug("sendChatAction failed", { error: errorMessage(error) });
    }
  }

  }

function isTerminal(status: RunSnapshot["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "interrupted";
}

function runKey(sessionID: string, startedAt: number): string {
  return `${sessionID}:${startedAt}`;
}

function activityOf(snapshot: RunSnapshot): string | null {
  if (snapshot.compaction?.status === "running") {
    return "🗜️ Compacting context";
  }
  if (snapshot.tool) {
    return formatTool(snapshot.tool);
  }
  if (snapshot.status === "waiting_permission") {
    return "Waiting for permission";
  }
  if (snapshot.status === "waiting_form") {
    return "Waiting for form input";
  }
  return null;
}

function formatTool(tool: ToolActivity): string {
  const icon = tool.status === "done" ? "✓" : tool.status === "failed" ? "✗" : "⏳";
  const detail = tool.detail ? ` · ${truncate(tool.detail.replace(/\s+/g, " "), 90)}` : "";
  return `${icon} ${tool.name}${detail}`;
}

function extractFormID(data: Record<string, unknown> | undefined): string | null {
  if (!data) {
    return null;
  }
  const candidate =
    (data.form as Record<string, unknown> | undefined) ?? data;
  const id = typeof candidate.id === "string" ? candidate.id : null;
  return id && id.startsWith("frm_") ? id : null;
}

function extractRequestID(data: Record<string, unknown> | undefined): string | null {
  if (!data) {
    return null;
  }
  if (typeof data.id === "string") {
    return data.id;
  }
  if (typeof data.requestID === "string") {
    return data.requestID;
  }
  const request = data.request;
  if (request && typeof request === "object") {
    const id = (request as Record<string, unknown>).id;
    if (typeof id === "string") {
      return id;
    }
  }
  return null;
}