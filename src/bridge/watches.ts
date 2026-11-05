import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
} from "@erfanvahabpour/bale-bot-sdk";

import type {
  CallbackRepo,
  ChatRepo,
  ChatRow,
  SettingsRepo,
  WatchedSessionRepo,
} from "../db.js";
import { normalizeLocale, t } from "../i18n.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { OpenCodeSession } from "../opencode/types.js";
import { formatRelative, truncate } from "../util.js";
import type { BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { describeOpenCodeError } from "./errors.js";
import { extractMessageText } from "./history.js";
import type { SessionService } from "./sessions.js";
import type { InteractionManager } from "./interactions.js";
import type { FormManager } from "./forms.js";
import type { PermissionRequest, FormRequest } from "./runReducer.js";
import {
  answerCallback,
  createToken,
  escapeBold,
  finishMessage,
  safeCode,
  safeJson,
  safeText,
  shortId,
} from "./ui.js";

const TERMINAL_DEBOUNCE_MS = 10 * 1_000;

export interface WatchManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly sessions: SessionService;
  readonly interactions: InteractionManager;
  readonly forms: FormManager;
  readonly watches: WatchedSessionRepo;
  readonly callbacks: CallbackRepo;
  readonly settings: SettingsRepo;
  readonly outbox: Outbox;
  readonly logger: Logger;
}

export type WatchCallback =
  | { readonly kind: "open"; readonly token: string }
  | { readonly kind: "unwatch"; readonly token: string };

export function parseWatchCallback(data: string | undefined): WatchCallback | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "w") {
    return null;
  }
  const token = parts[2] ?? "";
  if (!token) {
    return null;
  }
  if (parts[1] === "o") {
    return { kind: "open", token };
  }
  if (parts[1] === "x") {
    return { kind: "unwatch", token };
  }
  return null;
}

export class WatchManager {
  private readonly options: WatchManagerOptions;
  private readonly lastTerminal = new Map<string, number>();
  private readonly notifiedInteractive = new Map<string, number>();

  constructor(options: WatchManagerOptions) {
    this.options = options;
  }

  watch(chatId: string, sessionId: string, title: string | null): void {
    this.options.watches.add(chatId, sessionId, title);
  }

  async watchCommand(chat: ChatRow, argument?: string): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    const target = argument ?? current.active_session_id;
    if (!target) {
      await this.reply(chat.chat_id, "No session is bound. Use /watch <session-id> or send a message first.");
      return;
    }

    try {
      const session = await this.options.client.getSession(target);
      this.watch(chat.chat_id, session.id, session.title ?? null);
      await this.reply(
        chat.chat_id,
        `👀 *Watching*\n\n*${escapeBold(session.title || "(untitled)")}*\n\`${safeCode(session.id)}\`\n\n_You will get a notice when this session finishes, even from another chat._`,
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not watch that session: ${safeText(describeOpenCodeError(error), 200)}`,
      );
    }
  }

  async unwatchCommand(chat: ChatRow, argument?: string): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    if (!argument || argument === "all") {
      if (!argument) {
        if (!current.active_session_id) {
          await this.reply(chat.chat_id, "No session is bound. Use `/unwatch all` to clear everything.");
          return;
        }
        this.options.watches.remove(chat.chat_id, current.active_session_id);
        await this.reply(chat.chat_id, "🙈 *No longer watching the active session.*");
        return;
      }
      this.options.watches.removeAll(chat.chat_id);
      await this.reply(chat.chat_id, "🙈 *All session watches cleared.*");
      return;
    }

    this.options.watches.remove(chat.chat_id, argument);
    await this.reply(chat.chat_id, `🙈 *No longer watching* \`${safeCode(argument)}\`.`);
  }

  async showWatching(chat: ChatRow): Promise<void> {
    const rows = this.options.watches.listForChat(chat.chat_id);
    if (rows.length === 0) {
      await this.reply(
        chat.chat_id,
        "👀 *Watching*\n\n_Nothing watched. Use `/watch` to follow a session's completion._",
      );
      return;
    }

    const current = this.options.chats.get(chat.chat_id) ?? chat;
    const active = await this.options.client
      .activeSessions()
      .catch((): Record<string, { readonly type: string } | undefined> => ({}));

    const lines = ["👀 *Watching*", ""];
    const keyboard: InlineKeyboardButton[][] = [];
    for (const row of rows) {
      const running = active[row.session_id]?.type === "running";
      const marker =
        row.session_id === current.active_session_id ? "✅ " : running ? "▶️ " : "• ";
      lines.push(
        `${marker}*${escapeBold(row.title || "(untitled)")}* — \`${shortId(row.session_id)}\` _${formatRelative(
          row.created_at,
        )}_`,
      );
      const openToken = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "watch",
        refId: row.session_id,
        payload: { sessionID: row.session_id },
      });
      const removeToken = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "unwatch",
        refId: row.session_id,
        payload: { sessionID: row.session_id },
      });
      keyboard.push([
        { text: truncate(`${row.title || shortId(row.session_id)}`, 36), callback_data: `w:o:${openToken}` },
        { text: "🙈", callback_data: `w:x:${removeToken}` },
      ]);
    }
    lines.push("", "_Tap a session to switch to it, or 🙈 to stop watching._");
    await this.sendWithKeyboard(chat.chat_id, lines.join("\n"), { inline_keyboard: keyboard });
  }

  async showRecent(chat: ChatRow): Promise<void> {
    const locale = normalizeLocale(this.options.settings.get(chat.chat_id).locale);
    let sessions: OpenCodeSession[];
    try {
      sessions = [...(await this.options.client.listSessions())]
        .sort((a, b) => b.time.updated - a.time.updated)
        .slice(0, 10);
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ ${safeText(describeOpenCodeError(error), 220)}`,
      );
      return;
    }

    if (sessions.length === 0) {
      await this.reply(chat.chat_id, t(locale, "recent.empty"));
      return;
    }

    const current = this.options.chats.get(chat.chat_id) ?? chat;
    const active = await this.options.client
      .activeSessions()
      .catch((): Record<string, { readonly type: string } | undefined> => ({}));

    const lines = [t(locale, "recent.title"), ""];
    const keyboard: InlineKeyboardButton[][] = [];
    for (const session of sessions) {
      const running = active[session.id]?.type === "running";
      const marker = session.id === current.active_session_id ? "✅ " : running ? "▶️ " : "• ";
      const directory = session.location?.directory;
      const where = directory ? ` · \`${safeCode(truncate(directory, 40))}\`` : "";
      lines.push(
        `${marker}*${escapeBold(session.title || "(untitled)")}* — \`${shortId(session.id)}\`\n   _${t(
          locale,
          "recent.updated",
          { when: formatRelative(session.time.updated) },
        )}${running ? ` · ${t(locale, "recent.running")}` : ""}_${where}`,
      );
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "watch",
        refId: session.id,
        payload: { sessionID: session.id },
      });
      keyboard.push([
        {
          text: truncate(`${marker}${session.title || shortId(session.id)}`, 56),
          callback_data: `w:o:${token}`,
        },
      ]);
    }
    lines.push("", `_${t(locale, "recent.hint")}_`);
    await this.sendWithKeyboard(chat.chat_id, lines.join("\n"), { inline_keyboard: keyboard });
  }

  async notifyInteractive(
    sessionId: string,
    kind: "permission" | "form",
    requestId: string,
    request?: PermissionRequest | FormRequest,
  ): Promise<void> {
    const key = `${kind}:${requestId}`;
    const now = Date.now();
    if (this.notifiedInteractive.has(key)) {
      return;
    }
    this.notifiedInteractive.set(key, now);
    this.pruneInteractive();

    const watchers = this.options.watches.listForSession(sessionId);
    if (watchers.length === 0) {
      return;
    }

    const session = await this.options.client.getSession(sessionId).catch(() => null);
    const title = session?.title ?? watchers[0]?.title ?? "(untitled)";
    // The interactive UI is keyed by request id, so only one chat can own it.
    // Other watchers get the generic "open session" notice instead.
    let forwarded = false;

    for (const watcher of watchers) {
      const chat = this.options.chats.get(watcher.chat_id);
      if (!chat || chat.active_session_id === sessionId) {
        continue;
      }
      try {
        if (!forwarded && kind === "permission" && request) {
          await this.options.interactions.onPermissionAsked(
            request as PermissionRequest,
            watcher.chat_id,
          );
          forwarded = true;
          continue;
        }
        if (!forwarded && kind === "form" && request) {
          await this.options.forms.onFormCreated(
            {
              id: (request as FormRequest).id,
              sessionID: (request as FormRequest).sessionID,
              title: (request as FormRequest).title,
              fields: (request as FormRequest).fields,
            },
            watcher.chat_id,
          );
          forwarded = true;
          continue;
        }
      } catch (error) {
        this.options.logger.warn("Could not forward an interactive notice", {
          chatId: watcher.chat_id,
          sessionId,
          error: errorMessage(error),
        });
      }
      const locale = normalizeLocale(this.options.settings.get(watcher.chat_id).locale);
      const token = createToken(this.options.callbacks, {
        chatId: watcher.chat_id,
        kind: "watch",
        refId: sessionId,
        payload: { sessionID: sessionId },
      });
      const lines = [
        kind === "permission"
          ? t(locale, "notice.permission")
          : t(locale, "notice.form"),
        "",
        `*${escapeBold(title)}*`,
        `\`${shortId(sessionId)}\``,
      ];
      try {
        await this.options.outbox.forChat(watcher.chat_id).send(lines.join("\n"), {
          replyMarkup: {
            inline_keyboard: [[{ text: "▶️ Open session", callback_data: `w:o:${token}` }]],
          },
        });
      } catch (error) {
        this.options.logger.warn("Could not send an interactive notice", {
          chatId: watcher.chat_id,
          sessionId,
          error: errorMessage(error),
        });
      }
    }
  }

  async openSession(chat: ChatRow, sessionId: string): Promise<void> {
    try {
      const session = await this.options.sessions.attach(chat, sessionId);
      await this.reply(
        chat.chat_id,
        `▶️ *Attached*\n\n*${escapeBold(session.title || "(untitled)")}*\n\`${safeCode(session.id)}\``,
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not attach to that session: ${safeText(describeOpenCodeError(error), 200)}`,
      );
    }
  }

  /**
   * Called for every terminal execution event. Notifies every chat that watches
   * the session except the chat currently attached to it (which already gets the
   * full answer).
   */
  async notifyTerminal(sessionId: string, eventType: string): Promise<void> {
    const now = Date.now();
    const last = this.lastTerminal.get(sessionId) ?? 0;
    if (now - last < TERMINAL_DEBOUNCE_MS) {
      return;
    }
    this.lastTerminal.set(sessionId, now);
    this.pruneTerminal();

    const watchers = this.options.watches.listForSession(sessionId);
    if (watchers.length === 0) {
      return;
    }

    let session: OpenCodeSession | null = null;
    try {
      session = await this.options.client.getSession(sessionId);
    } catch (error) {
      this.options.logger.debug("Could not read the watched session", {
        sessionId,
        error: errorMessage(error),
      });
    }

    const outcome =
      eventType === "session.execution.failed"
        ? "failed"
        : eventType === "session.execution.interrupted"
          ? "interrupted"
          : "succeeded";
    const icon = outcome === "failed" ? "❌" : outcome === "interrupted" ? "⏹" : "✅";
    const label =
      outcome === "failed" ? "Run failed" : outcome === "interrupted" ? "Run stopped" : "Run finished";
    const preview = await this.lastAssistantPreview(sessionId);

    for (const watcher of watchers) {
      const chat = this.options.chats.get(watcher.chat_id);
      if (!chat) {
        continue;
      }
      if (chat.active_session_id === sessionId) {
        continue;
      }
      if (this.options.chats.findByActiveSession(sessionId)?.chat_id === watcher.chat_id) {
        continue;
      }

      const title = session?.title ?? watcher.title ?? "(untitled)";
      if (session?.title && session.title !== watcher.title) {
        this.options.watches.updateTitle(sessionId, session.title);
      }
      const token = createToken(this.options.callbacks, {
        chatId: watcher.chat_id,
        kind: "watch",
        refId: sessionId,
        payload: { sessionID: sessionId },
      });
      const lines = [
        `${icon} *${label}*`,
        "",
        `*${escapeBold(title)}*`,
        `\`${shortId(sessionId)}\``,
      ];
      if (preview) {
        lines.push("", preview);
      }
      try {
        await this.options.outbox.forChat(watcher.chat_id).send(lines.join("\n"), {
          replyMarkup: {
            inline_keyboard: [[{ text: "▶️ Open session", callback_data: `w:o:${token}` }]],
          },
        });
      } catch (error) {
        this.options.logger.warn("Could not send a session notice", {
          chatId: watcher.chat_id,
          sessionId,
          error: errorMessage(error),
        });
      }
    }
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseWatchCallback(input.data);
    if (!parsed) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This button is no longer valid.",
        this.options.logger,
      );
      return;
    }

    const row = this.options.callbacks.consume(parsed.token);
    if (!row || row.chat_id !== input.chatId || row.expires_at < Date.now()) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This notice has expired.",
        this.options.logger,
      );
      return;
    }

    const chat = this.options.chats.get(input.chatId);
    if (!chat) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This chat is no longer active.",
        this.options.logger,
      );
      return;
    }

    const payload = safeJson(row.payload);
    const sessionId = typeof payload?.sessionID === "string" ? payload.sessionID : row.ref_id;

    if (parsed.kind === "open") {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Opening…",
        this.options.logger,
      );
      await this.openSession(chat, sessionId);
      if (input.messageId !== undefined) {
        await finishMessage(
          this.options.outbox,
          input.chatId,
          input.messageId,
          `▶️ *Opened* \`${shortId(sessionId)}\`.`,
          this.options.logger,
        );
      }
      return;
    }

    this.options.watches.remove(input.chatId, sessionId);
    await answerCallback(
      this.options.gateway,
      input.callbackQueryId,
      "No longer watching.",
      this.options.logger,
    );
    await finishMessage(
      this.options.outbox,
      input.chatId,
      input.messageId,
      `🙈 *No longer watching* \`${shortId(sessionId)}\`.`,
      this.options.logger,
    );
  }

  private async lastAssistantPreview(sessionId: string): Promise<string | null> {
    try {
      const response = await this.options.client.getMessages(sessionId, {
        limit: 1,
        order: "desc",
        type: "assistant",
      });
      const message = response.data[0];
      if (!message) {
        return null;
      }
      const text = safeText(extractMessageText(message), 240);
      return text ? `_${text}_` : null;
    } catch {
      return null;
    }
  }

  private pruneTerminal(): void {
    const cutoff = Date.now() - 60_000;
    for (const [sessionId, at] of this.lastTerminal) {
      if (at < cutoff) {
        this.lastTerminal.delete(sessionId);
      }
    }
  }

  private pruneInteractive(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, at] of this.notifiedInteractive) {
      if (at < cutoff) {
        this.notifiedInteractive.delete(key);
      }
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
      this.options.logger.warn("Could not send watch menu", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send watch reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}