import { basename } from "node:path";

import type { InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type { Config } from "../config.js";
import type { ChatRepo, ChatRow, SettingsRepo } from "../db.js";
import { normalizeLocale, t, type Locale, type MessageKey, type MessageParams } from "../i18n.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type {
  OpenCodeModelInfo,
  OpenCodeSession,
  OpenCodeSessionMessage,
  ProjectInfo,
} from "../opencode/types.js";
import { formatDuration, formatRelative } from "../util.js";
import type { BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { describeOpenCodeError } from "./errors.js";
import type { RunSnapshot } from "./runReducer.js";
import { answerCallback, finishMessage, safeCode, safeText, shortId } from "./ui.js";

const MIN_REFRESH_MS = 4_000;
const PROJECT_CACHE_MS = 60_000;
const MODEL_CACHE_MS = 5 * 60_000;

export interface DashboardManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly settings: SettingsRepo;
  readonly outbox: Outbox;
  readonly config: Config;
  readonly logger: Logger;
  readonly runState?: (sessionID: string) => RunSnapshot | null;
}

export type DashboardCallback =
  | { readonly kind: "dashboardRefresh" }
  | { readonly kind: "context" }
  | { readonly kind: "contextRefresh" }
  | { readonly kind: "compactAsk" }
  | { readonly kind: "compactYes" }
  | { readonly kind: "compactNo" };

export function parseDashboardCallback(data: string | undefined): DashboardCallback | null {
  if (!data) {
    return null;
  }
  if (data === "dash:r") return { kind: "dashboardRefresh" };
  if (data === "ctx:o") return { kind: "context" };
  if (data === "ctx:r") return { kind: "contextRefresh" };
  if (data === "ctx:c") return { kind: "compactAsk" };
  if (data === "ctx:y") return { kind: "compactYes" };
  if (data === "ctx:n") return { kind: "compactNo" };
  return null;
}

interface ContextUsage {
  readonly used: number;
  readonly limit: number | null;
  readonly lastReply: {
    readonly input: number;
    readonly output: number;
    readonly cost: number;
  } | null;
}

export class DashboardManager {
  private readonly options: DashboardManagerOptions;
  private readonly lastRefresh = new Map<string, number>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  /** Bale deployments may reject pinning outright; stop retrying per chat. */
  private readonly pinUnsupported = new Set<string>();
  private projects: { at: number; data: readonly ProjectInfo[] } | null = null;
  private models: { at: number; data: readonly OpenCodeModelInfo[] } | null = null;

  constructor(options: DashboardManagerOptions) {
    this.options = options;
  }

  async enable(chat: ChatRow): Promise<void> {
    await this.refreshForChat(chat.chat_id, { force: true, create: true });
  }

  async disable(chat: ChatRow): Promise<void> {
    const current = this.options.settings.get(chat.chat_id);
    if (current.dashboard_message_id !== null) {
      if (!this.pinUnsupported.has(chat.chat_id)) {
        try {
          await this.options.gateway.unpinChatMessage({
            chatId: chat.chat_id,
            messageId: current.dashboard_message_id,
          });
        } catch (error) {
          this.options.logger.debug("Could not unpin the dashboard", {
            chatId: chat.chat_id,
            error: errorMessage(error),
          });
        }
      }
      try {
        const outbox = this.options.outbox.forChat(chat.chat_id);
        const messageId = current.dashboard_message_id;
        await outbox.editNow(messageId, t(this.locale(chat.chat_id), "dashboard.disabled"));
        await outbox.editMarkup(messageId, null);
      } catch (error) {
        this.options.logger.debug("Could not retire the dashboard message", {
          chatId: chat.chat_id,
          error: errorMessage(error),
        });
      }
    }
    this.options.settings.patch(chat.chat_id, { dashboard_message_id: null });
  }

  async refreshForSession(sessionID: string): Promise<void> {
    for (const chat of this.options.chats.list()) {
      if (chat.active_session_id !== sessionID) {
        continue;
      }
      await this.refreshForChat(chat.chat_id);
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(
      this.options.settings
        .list()
        .filter((row) => row.pinned_dashboard)
        .map((row) => this.refreshForChat(row.chat_id)),
    );
  }

  async refreshForChat(
    chatId: string,
    options: { force?: boolean; create?: boolean } = {},
  ): Promise<void> {
    const chat = this.options.chats.get(chatId);
    const settings = this.options.settings.get(chatId);
    if (!chat || !settings.pinned_dashboard) {
      return;
    }
    if (this.inFlight.has(chatId)) {
      return;
    }

    const now = Date.now();
    const last = this.lastRefresh.get(chatId) ?? 0;
    if (!options.force && now - last < MIN_REFRESH_MS) {
      if (!this.refreshTimers.has(chatId)) {
        const timer = setTimeout(() => {
          this.refreshTimers.delete(chatId);
          void this.refreshForChat(chatId, { force: true }).catch(() => undefined);
        }, MIN_REFRESH_MS - (now - last));
        timer.unref?.();
        this.refreshTimers.set(chatId, timer);
      }
      return;
    }

    this.inFlight.add(chatId);
    this.lastRefresh.set(chatId, now);
    try {
      await this.doRefresh(chat, options.create === true);
    } finally {
      this.inFlight.delete(chatId);
    }
  }

  async showContext(chat: ChatRow, messageId?: number): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    const locale = this.locale(current.chat_id);
    if (!current.active_session_id) {
      const text = t(locale, "context.no_session");
      await this.sendOrEdit(current.chat_id, messageId, text);
      return;
    }

    let session: OpenCodeSession;
    try {
      session = await this.options.client.getSession(current.active_session_id);
    } catch (error) {
      const text = t(locale, "context.failed", {
        error: safeText(describeOpenCodeError(error), 220),
      });
      await this.sendOrEdit(current.chat_id, messageId, text);
      return;
    }

    const usage = await this.contextUsage(session);
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: t(locale, "context.compact"), callback_data: "ctx:c" },
          { text: t(locale, "dashboard.refresh_button"), callback_data: "ctx:r" },
        ],
      ],
    };
    const text = this.renderContext(session, usage, locale);
    if (messageId !== undefined) {
      const edited = await this.options.outbox
        .forChat(current.chat_id)
        .editNow(messageId, text, { replyMarkup: keyboard });
      if (edited) {
        return;
      }
    }
    await this.sendWithKeyboard(current.chat_id, text, keyboard);
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseDashboardCallback(input.data);
    const chat = this.options.chats.get(input.chatId);
    if (!parsed || !chat) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This button is no longer valid.",
        this.options.logger,
      );
      return;
    }

    const locale = this.locale(chat.chat_id);

    switch (parsed.kind) {
      case "dashboardRefresh":
        await answerCallback(
          this.options.gateway,
          input.callbackQueryId,
          t(locale, "common.refresh"),
          this.options.logger,
        );
        await this.refreshForChat(chat.chat_id, { force: true, create: true });
        return;
      case "context":
      case "contextRefresh":
        await answerCallback(this.options.gateway, input.callbackQueryId, undefined, this.options.logger);
        await this.showContext(chat, input.messageId);
        return;
      case "compactAsk": {
        await answerCallback(this.options.gateway, input.callbackQueryId, undefined, this.options.logger);
        const keyboard: InlineKeyboardMarkup = {
          inline_keyboard: [
            [
              { text: t(locale, "context.confirm_yes"), callback_data: "ctx:y" },
              { text: t(locale, "context.confirm_no"), callback_data: "ctx:n" },
            ],
          ],
        };
        const text = [
          t(locale, "context.confirm"),
          "",
          `_${t(locale, "context.confirm_hint")}_`,
        ].join("\n");
        await this.sendWithKeyboard(chat.chat_id, text, keyboard);
        return;
      }
      case "compactNo":
        await answerCallback(
          this.options.gateway,
          input.callbackQueryId,
          t(locale, "context.cancelled"),
          this.options.logger,
        );
        await finishMessage(
          this.options.outbox,
          chat.chat_id,
          input.messageId,
          t(locale, "context.cancelled"),
          this.options.logger,
        );
        return;
      case "compactYes": {
        const sessionID = chat.active_session_id;
        if (!sessionID) {
          await answerCallback(
            this.options.gateway,
            input.callbackQueryId,
            t(locale, "context.no_session"),
            this.options.logger,
          );
          return;
        }
        await answerCallback(this.options.gateway, input.callbackQueryId, undefined, this.options.logger);
        try {
          await this.options.client.compact(sessionID);
          await finishMessage(
            this.options.outbox,
            chat.chat_id,
            input.messageId,
            t(locale, "context.requested"),
            this.options.logger,
          );
        } catch (error) {
          await finishMessage(
            this.options.outbox,
            chat.chat_id,
            input.messageId,
            t(locale, "context.failed", {
              error: safeText(describeOpenCodeError(error), 220),
            }),
            this.options.logger,
          );
        }
        return;
      }
    }
  }

  private async doRefresh(chat: ChatRow, create: boolean): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    const locale = this.locale(current.chat_id);
    const text = await this.renderDashboard(current, locale);
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: t(locale, "dashboard.context_button"), callback_data: "ctx:o" },
          { text: t(locale, "dashboard.refresh_button"), callback_data: "dash:r" },
        ],
      ],
    };

    const settings = this.options.settings.get(current.chat_id);
    const outbox = this.options.outbox.forChat(current.chat_id);
    if (settings.dashboard_message_id !== null && !create) {
      try {
        const edited = await outbox.editNow(settings.dashboard_message_id, text, {
          replyMarkup: keyboard,
        });
        if (edited) {
          return;
        }
      } catch (error) {
        this.options.logger.debug("Dashboard edit failed; recreating", {
          chatId: current.chat_id,
          error: errorMessage(error),
        });
      }
    }

    try {
      const message = await outbox.send(text, { replyMarkup: keyboard });
      this.options.settings.patch(current.chat_id, { dashboard_message_id: message.message_id });
      if (!this.pinUnsupported.has(current.chat_id)) {
        try {
          await this.options.gateway.pinChatMessage({
            chatId: current.chat_id,
            messageId: message.message_id,
          });
        } catch (error) {
          // Some Bale deployments answer 500 for pinChatMessage. Keep the live
          // message, stop retrying, and tell the user once.
          this.pinUnsupported.add(current.chat_id);
          this.options.logger.warn("Bale rejected pinning; the dashboard will stay unpinned", {
            chatId: current.chat_id,
            error: errorMessage(error),
          });
          // Drop the pin icon right away instead of waiting for the next sweep.
          try {
            const retitled = text.replace(
              t(locale, "dashboard.title"),
              t(locale, "dashboard.title_unpinned"),
            );
            await outbox.editNow(message.message_id, retitled, { replyMarkup: keyboard });
          } catch {
            // Cosmetic only.
          }
          try {
            await outbox.send(t(locale, "dashboard.pin_unsupported"));
          } catch {
            // The notice is best-effort.
          }
        }
      }
    } catch (error) {
      this.options.logger.warn("Could not send the dashboard", {
        chatId: current.chat_id,
        error: errorMessage(error),
      });
    }
  }

  private async renderDashboard(chat: ChatRow, locale: Locale): Promise<string> {
    const titleKey = this.pinUnsupported.has(chat.chat_id)
      ? "dashboard.title_unpinned"
      : "dashboard.title";
    const lines: string[] = [t(locale, titleKey), ""];
    if (!chat.active_session_id) {
      lines.push(t(locale, "dashboard.no_session"));
      lines.push("", `_${t(locale, "dashboard.updated", { when: formatRelative(Date.now()) })}_`);
      return lines.join("\n");
    }

    const directory = chat.project_directory ?? this.options.config.opencode.projectDirectory;
    lines.push(`*${t(locale, "dashboard.directory")}:* \`${safeCode(directory)}\``);

    try {
      const project = await this.findProject(chat.active_session_id, directory);
      if (project) {
        const isWorktree = project.canonical !== directory;
        lines.push(
          `*${t(locale, "dashboard.project")}:* ${safeCode(project.name || basename(project.canonical))}${
            isWorktree ? ` _(${t(locale, "dashboard.worktree")})_` : ""
          }`,
        );
      }
    } catch (error) {
      this.options.logger.debug("Could not resolve the dashboard project", {
        error: errorMessage(error),
      });
    }

    try {
      const vcs = await this.options.client.vcsInfo(directory);
      const branch = vcs.branch.current ?? vcs.branch.default;
      if (branch) {
        lines.push(`*${t(locale, "dashboard.branch")}:* \`${safeCode(branch)}\``);
      }
    } catch {
      // Not every directory is a VCS checkout.
    }

    try {
      const session = await this.options.client.getSession(chat.active_session_id);
      const model = session.model
        ? `${session.model.providerID}/${session.model.id}`
        : `${this.options.config.opencode.model.providerID}/${this.options.config.opencode.model.id}`;
      lines.push(`*${t(locale, "dashboard.model")}:* \`${safeCode(model)}\``);
      lines.push(
        `*${t(locale, "dashboard.session")}:* ${safeText(session.title || "(untitled)", 80)} \`${shortId(
          session.id,
        )}\``,
      );

      const active = await this.options.client
        .activeSessions()
        .catch((): Record<string, { readonly type: string } | undefined> => ({}));
      const run = this.options.runState?.(session.id) ?? null;
      const running = active[session.id]?.type === "running";
      lines.push(`*${t(locale, "dashboard.state")}:* ${this.stateLabel(locale, run, running, session)}`);

      const usage = await this.contextUsage(session);
      lines.push(`*${t(locale, "dashboard.context")}:* ${this.usageLabel(locale, usage)}`);
    } catch (error) {
      lines.push(
        `⚠️ ${safeText(t(locale, "status.read_failed"), 40)}: ${safeText(
          describeOpenCodeError(error),
          160,
        )}`,
      );
    }

    try {
      const status = await this.options.client.vcsStatus(directory);
      if (status.length > 0) {
        const additions = status.reduce((sum, file) => sum + file.additions, 0);
        const deletions = status.reduce((sum, file) => sum + file.deletions, 0);
        lines.push(
          `*${t(locale, "dashboard.changed")}:* ${t(locale, "dashboard.files", {
            count: status.length,
            added: additions,
            deleted: deletions,
          })}`,
        );
      }
    } catch {
      // VCS status is optional.
    }

    lines.push("", `_${t(locale, "dashboard.updated", { when: formatRelative(Date.now()) })}_`);
    return lines.join("\n");
  }

  private renderContext(session: OpenCodeSession, usage: ContextUsage, locale: Locale): string {
    const model = session.model
      ? `${session.model.providerID}/${session.model.id}`
      : `${this.options.config.opencode.model.providerID}/${this.options.config.opencode.model.id}`;
    const lines = [
      t(locale, "context.title"),
      "",
      `*${t(locale, "context.session")}:* ${safeText(session.title || "(untitled)", 80)} \`${shortId(
        session.id,
      )}\``,
      `*${t(locale, "context.model")}:* \`${safeCode(model)}\``,
      `*${t(locale, "context.usage")}:* ${this.usageLabel(locale, usage)}`,
    ];
    if (usage.lastReply) {
      lines.push(
        `*${t(locale, "context.last_reply")}:* ${t(locale, "context.last_reply_value", {
          input: compactNumber(usage.lastReply.input),
          output: compactNumber(usage.lastReply.output),
          cost: formatCost(usage.lastReply.cost),
        })}`,
      );
    } else {
      lines.push(`*${t(locale, "context.last_reply")}:* ${t(locale, "context.no_reply")}`);
    }
    return lines.join("\n");
  }

  private usageLabel(locale: Locale, usage: ContextUsage): string {
    if (usage.limit && usage.limit > 0) {
      const percent = Math.min(999, Math.round((usage.used / usage.limit) * 100));
      return t(locale, "context.usage_value", {
        used: compactNumber(usage.used),
        limit: compactNumber(usage.limit),
        percent,
      });
    }
    return t(locale, "context.usage_unknown", { used: compactNumber(usage.used) });
  }

  private stateLabel(
    locale: Locale,
    run: RunSnapshot | null,
    running: boolean,
    session: OpenCodeSession,
  ): string {
    const status = run?.status ?? (running ? "running" : null);
    if (status) {
      const key = `dashboard.state.${status}` as MessageKey;
      const label = t(locale, key);
      if (status === "running" && session.time.busy) {
        return `${label} · ${formatDuration(Date.now() - session.time.busy)}`;
      }
      return label;
    }
    if (session.outcome) {
      return t(locale, `dashboard.state.${session.outcome}` as MessageKey);
    }
    return t(locale, "dashboard.state.idle");
  }

  private async contextUsage(session: OpenCodeSession): Promise<ContextUsage> {
    let used = 0;
    let lastReply: ContextUsage["lastReply"] = null;
    try {
      const response = await this.options.client.getMessages(session.id, {
        limit: 10,
        order: "desc",
        type: "assistant",
      });
      const completed = response.data.find((message) => message.tokens != null);
      if (completed) {
        used = replyTokens(completed);
        lastReply = {
          input: completed.tokens?.input ?? 0,
          output: completed.tokens?.output ?? 0,
          cost: completed.cost ?? 0,
        };
      }
    } catch (error) {
      this.options.logger.debug("Could not read context usage", {
        sessionId: session.id,
        error: errorMessage(error),
      });
    }

    let limit: number | null = null;
    try {
      const models = await this.listModels();
      const model = session.model;
      const info = model
        ? models.find(
            (candidate) =>
              candidate.providerID === model.providerID && candidate.modelID === model.id,
          )
        : undefined;
      limit = info?.limit?.context ?? null;
    } catch {
      limit = null;
    }

    return { used, limit, lastReply };
  }

  private async listModels(): Promise<readonly OpenCodeModelInfo[]> {
    const now = Date.now();
    if (this.models && now - this.models.at < MODEL_CACHE_MS) {
      return this.models.data;
    }
    const data = await this.options.client.listModels();
    this.models = { at: now, data };
    return data;
  }

  private async findProject(
    sessionID: string,
    directory: string,
  ): Promise<ProjectInfo | null> {
    const now = Date.now();
    let projects: readonly ProjectInfo[];
    if (this.projects && now - this.projects.at < PROJECT_CACHE_MS) {
      projects = this.projects.data;
    } else {
      projects = await this.options.client.listProjects();
      this.projects = { at: now, data: projects };
    }

    if (projects.length === 0) {
      return null;
    }
    const session = await this.options.client.getSession(sessionID).catch(() => null);
    if (session?.projectID) {
      const byId = projects.find((project) => project.id === session.projectID);
      if (byId) {
        return byId;
      }
    }
    const byDirectory = projects.find(
      (project) =>
        directory === project.canonical || directory.startsWith(`${project.canonical}/`),
    );
    return byDirectory ?? projects[0] ?? null;
  }

  private locale(chatId: string): Locale {
    return normalizeLocale(this.options.settings.get(chatId).locale);
  }

  private async sendOrEdit(chatId: string, messageId: number | undefined, text: string): Promise<void> {
    if (messageId !== undefined) {
      const edited = await this.options.outbox.forChat(chatId).editNow(messageId, text);
      if (edited) {
        return;
      }
    }
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send dashboard text", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async sendWithKeyboard(
    chatId: string,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text, { replyMarkup });
    } catch (error) {
      this.options.logger.warn("Could not send dashboard menu", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}

function replyTokens(message: OpenCodeSessionMessage): number {
  const tokens = message.tokens;
  if (!tokens) {
    return 0;
  }
  return (
    (tokens.input ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.output ?? 0)
  );
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 1_000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost === 0) {
    return "$0";
  }
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}