import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
} from "@erfanvahabpour/bale-bot-sdk";

import type { CallbackRepo, ChatRepo, ChatRow } from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type {
  OpenCodeSessionMessage,
  SessionRevert,
} from "../opencode/types.js";
import { transformInline } from "../renderer.js";
import { formatRelative, truncate } from "../util.js";
import type { BaleGateway } from "../bale/gateway.js";
import { isMessageNotFound, isMessageNotModified } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { describeOpenCodeError } from "./errors.js";
import type { SessionService } from "./sessions.js";
import {
  answerCallback,
  createToken,
  escapeBold,
  safeCode,
  safeJson,
  safeText,
  shortId,
} from "./ui.js";

const MAX_MESSAGES = 25;
const BUTTON_MESSAGES = 6;
const MESSAGE_TEXT_BUDGET = 3_400;

export interface HistoryManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly sessions: SessionService;
  readonly callbacks: CallbackRepo;
  readonly outbox: Outbox;
  readonly logger: Logger;
}

export type HistoryCallback =
  | { readonly kind: "revertStage"; readonly token: string }
  | { readonly kind: "revertConfirm"; readonly token: string }
  | { readonly kind: "revertCancel"; readonly token: string }
  | { readonly kind: "fork"; readonly token: string };

export function parseHistoryCallback(data: string | undefined): HistoryCallback | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts[0] === "fk" && parts.length === 2) {
    const token = parts[1] ?? "";
    return token ? { kind: "fork", token } : null;
  }
  if (parts[0] !== "rv" || parts.length !== 3) {
    return null;
  }
  const token = parts[2] ?? "";
  if (!token) {
    return null;
  }
  if (parts[1] === "s") {
    return { kind: "revertStage", token };
  }
  if (parts[1] === "c") {
    return { kind: "revertConfirm", token };
  }
  if (parts[1] === "x") {
    return { kind: "revertCancel", token };
  }
  return null;
}

export class HistoryManager {
  private readonly options: HistoryManagerOptions;
  private readonly recent = new Map<string, readonly OpenCodeSessionMessage[]>();

  constructor(options: HistoryManagerOptions) {
    this.options = options;
  }

  async showMessages(chat: ChatRow, argument?: string): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    if (!current.active_session_id) {
      await this.reply(chat.chat_id, "No session is bound. Use /new or send a message first.");
      return;
    }

    const requested = argument ? Number(argument) : 10;
    const limit = Number.isFinite(requested)
      ? Math.min(MAX_MESSAGES, Math.max(1, Math.trunc(requested)))
      : 10;

    let response;
    try {
      response = await this.options.client.getMessages(current.active_session_id, {
        limit,
        order: "desc",
      });
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not read messages: ${safeText(describeOpenCodeError(error), 200)}`,
      );
      return;
    }

    const messages = [...response.data].reverse();
    if (messages.length === 0) {
      await this.reply(chat.chat_id, "This session has no messages yet.");
      return;
    }

    const shown: { index: number; message: OpenCodeSessionMessage; summary: string }[] = [];
    const body: string[] = [];
    let used = 0;

    for (const [offset, message] of messages.entries()) {
      const index = offset + 1;
      const summary = summarizeMessage(message, index);
      if (!summary) {
        continue;
      }
      if (shown.length > 0 && used + summary.length + 2 > MESSAGE_TEXT_BUDGET) {
        break;
      }
      body.push(summary, "");
      used += summary.length + 2;
      shown.push({ index, message, summary });
    }

    if (shown.length === 0) {
      await this.reply(chat.chat_id, "This session has no displayable messages yet.");
      return;
    }
    this.recent.set(
      chat.chat_id,
      shown.map((entry) => entry.message),
    );

    const lines = [
      `💬 *Last ${shown.length} message${shown.length === 1 ? "" : "s"}*`,
      "_Numbers refer to this list._",
      "",
      ...body,
    ];

    const buttons: InlineKeyboardButton[][] = [];
    for (const entry of shown.slice(-BUTTON_MESSAGES)) {
      if (entry.message.type === "user") {
        buttons.push([
          {
            text: `↩️ Revert #${entry.index}`,
            callback_data: `rv:s:${this.token(chat.chat_id, "revert", entry.message.id, {
              messageID: entry.message.id,
            })}`,
          },
          {
            text: `🌿 Fork #${entry.index}`,
            callback_data: `fk:${this.token(chat.chat_id, "fork", entry.message.id, {
              before: entry.message.id,
            })}`,
          },
        ]);
      }
    }
    if (shown.length > 0) {
      buttons.push([
        {
          text: "🌿 Fork full conversation",
          callback_data: `fk:${this.token(chat.chat_id, "fork", "all", { before: null })}`,
        },
      ]);
    }

    lines.push(
      "_Revert rewinds messages and files. Fork #N branches before that message._",
    );
    const text = truncate(lines.join("\n").trim(), 3_800);
    if (buttons.length === 0) {
      await this.reply(chat.chat_id, text);
      return;
    }
    await this.sendWithKeyboard(chat.chat_id, text, { inline_keyboard: buttons });
  }

  async revert(chat: ChatRow, argument?: string): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    if (!current.active_session_id) {
      await this.reply(chat.chat_id, "No session is bound.");
      return;
    }
    if (!argument) {
      await this.showMessages(chat, "10");
      return;
    }

    const messageID = await this.resolveMessageId(chat.chat_id, argument);
    if (!messageID) {
      await this.reply(
        chat.chat_id,
        "⚠️ Could not resolve that message. Use `/messages` or `/revert <message-id>`.",
      );
      return;
    }

    await this.stageRevert(chat, current.active_session_id, messageID);
  }

  async fork(chat: ChatRow, argument?: string): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    if (!current.active_session_id) {
      await this.reply(chat.chat_id, "No session is bound.");
      return;
    }

    let before: string | undefined;
    if (argument) {
      const resolved = await this.resolveMessageId(chat.chat_id, argument);
      if (!resolved) {
        await this.reply(
          chat.chat_id,
          "⚠️ Could not resolve that message. Use `/messages` or `/fork <message-id>`.",
        );
        return;
      }
      before = resolved;
    }

    try {
      const forked = await this.options.client.forkSession(current.active_session_id, before);
      const attached = await this.options.sessions.attach(chat, forked.id);
      await this.reply(
        chat.chat_id,
        `🌿 *Forked*\n\n*${escapeBold(attached.title || "(untitled)")}*\n\`${safeCode(attached.id)}\`\n\n_This chat now follows the fork._`,
      );
      this.options.logger.info("Session forked", {
        chatId: chat.chat_id,
        source: current.active_session_id,
        forked: forked.id,
        before: before ?? null,
      });
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not fork: ${safeText(describeOpenCodeError(error), 220)}`,
      );
    }
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseHistoryCallback(input.data);
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
        "This action has expired.",
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
    const current = this.options.chats.get(chat.chat_id) ?? chat;

    if (parsed.kind === "revertStage") {
      const messageID = typeof payload?.messageID === "string" ? payload.messageID : row.ref_id;
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Staging revert…",
        this.options.logger,
      );
      if (!current.active_session_id) {
        await this.finish(input, "⚠️ No session is bound.");
        return;
      }
      await this.stageRevert(chat, current.active_session_id, messageID, input.messageId);
      return;
    }

    if (parsed.kind === "revertCancel") {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Revert cancelled.",
        this.options.logger,
      );
      if (current.active_session_id) {
        try {
          await this.options.client.clearRevert(current.active_session_id);
        } catch (error) {
          this.options.logger.debug("Could not clear revert staging", {
            sessionId: current.active_session_id,
            error: errorMessage(error),
          });
        }
      }
      await this.finish(input, "✖️ *Revert cancelled.*");
      return;
    }

    if (parsed.kind === "revertConfirm") {
      if (!current.active_session_id) {
        await this.finish(input, "⚠️ No session is bound.");
        await answerCallback(this.options.gateway, input.callbackQueryId, undefined, this.options.logger);
        return;
      }
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Reverting…",
        this.options.logger,
      );
      try {
        await this.options.client.commitRevert(current.active_session_id);
        await this.finish(
          input,
          "✅ *Reverted*\n\n_Messages after the checkpoint were removed and file changes were rolled back._",
        );
        this.options.logger.info("Revert committed", {
          chatId: chat.chat_id,
          sessionId: current.active_session_id,
        });
      } catch (error) {
        await this.finish(
          input,
          `⚠️ Could not revert: ${safeText(describeOpenCodeError(error), 200)}`,
        );
      }
      return;
    }

    // Fork.
    const before = typeof payload?.before === "string" ? payload.before : undefined;
    await answerCallback(
      this.options.gateway,
      input.callbackQueryId,
      "Forking…",
      this.options.logger,
    );
    await this.finish(input, "🌿 *Forking…*");
    await this.fork(chat, before);
  }

  private async stageRevert(
    chat: ChatRow,
    sessionId: string,
    messageID: string,
    messageId?: number,
  ): Promise<void> {
    let staged: SessionRevert;
    try {
      staged = await this.options.client.stageRevert(sessionId, messageID, true);
    } catch (error) {
      const text = `⚠️ Could not stage the revert: ${safeText(describeOpenCodeError(error), 220)}`;
      if (messageId !== undefined) {
        await this.finishAt(chat.chat_id, messageId, text);
      } else {
        await this.reply(chat.chat_id, text);
      }
      return;
    }

    const files = staged.files?.length ?? 0;
    const token = this.token(chat.chat_id, "revert", staged.messageID, {
      messageID: staged.messageID,
    });
    const text = [
      "↩️ *Revert staged*",
      "",
      `Target: \`${safeCode(staged.messageID)}\``,
      `Files: ${files === 0 ? "_none changed_" : `${files} changed`}`,
      "",
      "_Confirm to delete the later messages and roll back files. This cannot be undone._",
    ].join("\n");
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Confirm revert", callback_data: `rv:c:${token}` },
          { text: "✖️ Cancel", callback_data: `rv:x:${token}` },
        ],
      ],
    };
    try {
      await this.options.outbox.forChat(chat.chat_id).send(text, { replyMarkup: keyboard });
    } catch (error) {
      this.options.logger.warn("Could not send revert confirmation", {
        chatId: chat.chat_id,
        error: errorMessage(error),
      });
    }
  }

  private async resolveMessageId(chatId: string, argument: string): Promise<string | null> {
    const trimmed = argument.trim();
    if (trimmed.startsWith("msg_")) {
      return trimmed;
    }
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    const index = Number(trimmed) - 1;
    let messages = this.recent.get(chatId);
    if (!messages) {
      const chat = this.options.chats.get(chatId);
      if (!chat?.active_session_id) {
        return null;
      }
      try {
        const response = await this.options.client.getMessages(chat.active_session_id, {
          limit: 10,
          order: "desc",
        });
        messages = [...response.data]
          .reverse()
          .filter((message) => summarizeMessage(message, 0) !== null);
        this.recent.set(chatId, messages);
      } catch {
        return null;
      }
    }
    return messages?.[index]?.id ?? null;
  }

  private token(
    chatId: string,
    kind: string,
    refId: string,
    payload: Record<string, unknown>,
  ): string {
    return createToken(this.options.callbacks, {
      chatId,
      kind,
      refId,
      payload,
    });
  }

  private async sendWithKeyboard(
    chatId: string,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text, { replyMarkup });
    } catch (error) {
      this.options.logger.warn("Could not send history message", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async finish(
    input: { readonly chatId: string; readonly messageId?: number },
    text: string,
  ): Promise<void> {
    if (input.messageId === undefined) {
      await this.reply(input.chatId, text);
      return;
    }
    await this.finishAt(input.chatId, input.messageId, text);
  }

  private async finishAt(chatId: string, messageId: number, text: string): Promise<void> {
    const chat = this.options.outbox.forChat(chatId);
    try {
      await chat.editNow(messageId, text);
      await chat.editMarkup(messageId, null);
    } catch (error) {
      if (!isMessageNotFound(error) && !isMessageNotModified(error)) {
        this.options.logger.debug("Could not edit history message", {
          messageId,
          error: errorMessage(error),
        });
      }
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send history reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}

export function extractMessageText(message: OpenCodeSessionMessage): string {
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  return "";
}

function summarizeMessage(message: OpenCodeSessionMessage, index: number): string | null {
  const when = message.time?.created
    ? ` · ${formatRelative(message.time.created)}`
    : "";
  const id = shortId(message.id);
  const label = `*#${index}*`;

  if (message.type === "user") {
    const text = safeText(message.text ?? "", 320);
    const files = Array.isArray(message.files) ? message.files.length : 0;
    const suffix = files > 0 ? ` _(${files} attachment${files === 1 ? "" : "s"})_` : "";
    return `${label} 👤 *You* · \`${safeCode(id)}\`${when}${suffix}\n${text || "_empty_"}`;
  }

  if (message.type === "assistant") {
    const text = safeText(extractMessageText(message), 420);
    return `${label} 🤖 *Assistant* · \`${safeCode(id)}\`${when}\n${text || "_no text_"} `;
  }

  if (message.type === "compaction") {
    const status =
      message.status === "failed"
        ? "failed"
        : message.status === "running"
          ? "running"
          : "complete";
    return `${label} 🗜️ _Compaction ${status}_`;
  }

  if (message.type === "skill") {
    return `${label} 🧩 _Skill ${transformInline(String(message.name ?? message.skill ?? "used"))}_`;
  }

  if (message.type === "system" || message.type === "synthetic") {
    return null;
  }

  return null;
}