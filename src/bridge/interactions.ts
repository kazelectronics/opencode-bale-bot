import { randomBytes } from "node:crypto";

import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type { CallbackRepo, ChatRow, InteractionMessageRepo, SettingsRepo } from "../db.js";
import { normalizeLocale, t, type Locale } from "../i18n.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { transformInline, tidy } from "../renderer.js";
import { truncate } from "../util.js";
import type { Outbox } from "../bale/outbox.js";
import {
  isMessageNotFound,
  isMessageNotModified,
  type BaleGateway,
} from "../bale/gateway.js";
import type { PermissionRequest } from "./runReducer.js";

const CALLBACK_TTL_MS = 15 * 60 * 1_000;
const HANDLED_CACHE_TTL_MS = 5 * 60 * 1_000;

export type PermissionDecision = "once" | "always" | "reject";

export interface PermissionCallback {
  readonly kind: "permission";
  readonly token: string;
  readonly decision: PermissionDecision;
}

export function parseCallbackData(data: string | undefined): PermissionCallback | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "perm") {
    return null;
  }
  const token = parts[1] ?? "";
  const decision = parts[2] ?? "";
  if (!token || (decision !== "once" && decision !== "always" && decision !== "reject")) {
    return null;
  }
  return { kind: "permission", token, decision };
}

export function parseQueueCallback(data: string | undefined): { token: string } | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 2 || parts[0] !== "q") {
    return null;
  }
  const token = parts[1] ?? "";
  return token ? { token } : null;
}

export interface InteractionManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly callbacks: CallbackRepo;
  readonly interactionMessages: InteractionMessageRepo;
  readonly settings: SettingsRepo;
  readonly outbox: Outbox;
  readonly logger: Logger;
}

export class InteractionManager {
  private readonly options: InteractionManagerOptions;
  private readonly handling = new Set<string>();
  private readonly recentlyHandled = new Map<string, number>();

  constructor(options: InteractionManagerOptions) {
    this.options = options;
  }

  isHandling(requestId: string): boolean {
    return this.handling.has(requestId) || this.wasHandled(requestId);
  }

  async onPermissionAsked(request: PermissionRequest, chatId: string): Promise<void> {
    const { interactionMessages, callbacks, outbox, logger } = this.options;
    if (interactionMessages.get(request.id)) {
      return;
    }

    const token = randomBytes(12).toString("base64url");
    callbacks.create({
      token,
      chat_id: chatId,
      kind: "permission",
      ref_id: request.id,
      payload: JSON.stringify({ sessionID: request.sessionID }),
      expires_at: Date.now() + CALLBACK_TTL_MS,
    });

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text: "✅ Allow once",
            callback_data: `perm:${token}:once`,
          },
          {
            text: "♾️ Always",
            callback_data: `perm:${token}:always`,
          },
        ],
        [
          {
            text: "⛔ Reject",
            callback_data: `perm:${token}:reject`,
          },
        ],
      ],
    };

    try {
      const message = await outbox.forChat(chatId).send(formatPermissionText(request), {
        replyMarkup: keyboard,
      });
      interactionMessages.set(request.id, chatId, message.message_id, "permission");
      logger.info("Permission request sent", {
        requestId: request.id,
        sessionId: request.sessionID,
        action: request.action,
      });
    } catch (error) {
      callbacks.deleteByRef(chatId, "permission", request.id);
      logger.error("Failed to send permission request", {
        requestId: request.id,
        error: errorMessage(error),
      });
    }
  }

  async onPromptQueued(input: {
    readonly chatId: string;
    readonly sessionID: string;
    readonly inboxID: string;
    readonly promptText: string;
  }): Promise<void> {
    const { interactionMessages, callbacks, outbox, logger } = this.options;
    if (interactionMessages.get(input.inboxID)) {
      return;
    }
    const locale = this.locale(input.chatId);

    const token = randomBytes(12).toString("base64url");
    callbacks.create({
      token,
      chat_id: input.chatId,
      kind: "inbox",
      ref_id: input.inboxID,
      payload: JSON.stringify({ sessionID: input.sessionID }),
      expires_at: Date.now() + CALLBACK_TTL_MS,
    });

    const lines = [
      t(locale, "queue.notice_title"),
      "",
      `_${t(locale, "queue.notice_body")}_`,
      "",
      `\`${safeCode(truncate(input.promptText.replace(/\s+/g, " ").trim(), 180))}\``,
    ];
    try {
      const message = await outbox.forChat(input.chatId).send(lines.join("\n"), {
        replyMarkup: {
          inline_keyboard: [[{ text: t(locale, "queue.withdraw"), callback_data: `q:${token}` }]],
        },
      });
      interactionMessages.set(input.inboxID, input.chatId, message.message_id, "inbox");
      logger.info("Queued prompt notice sent", {
        chatId: input.chatId,
        sessionId: input.sessionID,
        inboxId: input.inboxID,
      });
    } catch (error) {
      callbacks.deleteByRef(input.chatId, "inbox", input.inboxID);
      logger.warn("Could not send queued prompt notice", {
        chatId: input.chatId,
        error: errorMessage(error),
      });
    }
  }

  async showQueue(chat: ChatRow): Promise<void> {
    const locale = this.locale(chat.chat_id);
    const sessionID = chat.active_session_id;
    if (!sessionID) {
      await this.reply(chat.chat_id, t(locale, "queue.empty"));
      return;
    }
    await this.renderQueue(chat.chat_id, sessionID, undefined, locale);
  }

  private async renderQueue(
    chatId: string,
    sessionID: string,
    messageId: number | undefined,
    locale: Locale,
  ): Promise<void> {
    let items;
    try {
      items = await this.options.client.listInbox(sessionID);
    } catch (error) {
      await this.finishOrReply(
        chatId,
        messageId,
        t(locale, "queue.failed", { error: safeStatusText(errorMessage(error)) }),
      );
      return;
    }

    if (items.length === 0) {
      await this.finishOrReply(chatId, messageId, t(locale, "queue.empty"));
      return;
    }

    const lines = [t(locale, "queue.title"), ""];
    const keyboard: InlineKeyboardButton[][] = [];
    items.slice(0, 10).forEach((item, index) => {
      const text = truncate(
        typeof item.payload?.text === "string" ? item.payload.text : item.type,
        120,
      );
      lines.push(t(locale, "queue.item", { index: index + 1, text }));
      const token = randomBytes(12).toString("base64url");
      this.options.callbacks.create({
        token,
        chat_id: chatId,
        kind: "inbox",
        ref_id: item.id,
        payload: JSON.stringify({ sessionID, list: true }),
        expires_at: Date.now() + CALLBACK_TTL_MS,
      });
      keyboard.push([
        {
          text: `${t(locale, "queue.withdraw")} #${index + 1}`,
          callback_data: `q:${token}`,
        },
      ]);
    });
    if (items.length > 10) {
      lines.push("", `_…and ${items.length - 10} more_`);
    }

    const outbox = this.options.outbox.forChat(chatId);
    if (messageId !== undefined) {
      try {
        if (await outbox.editNow(messageId, lines.join("\n"), {
          replyMarkup: { inline_keyboard: keyboard },
        })) {
          return;
        }
      } catch (error) {
        this.options.logger.debug("Could not edit the queue list", {
          chatId,
          error: errorMessage(error),
        });
      }
    }
    try {
      await outbox.send(lines.join("\n"), { replyMarkup: { inline_keyboard: keyboard } });
    } catch (error) {
      this.options.logger.warn("Could not send the queue", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async finishOrReply(
    chatId: string,
    messageId: number | undefined,
    text: string,
  ): Promise<void> {
    if (messageId === undefined) {
      await this.reply(chatId, text);
      return;
    }
    await this.finishMessage({ chatId, messageId }, text);
  }

  async handleQueueCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseQueueCallback(input.data);
    if (!parsed) {
      await this.answer(input.callbackQueryId, "This button is no longer valid.");
      return;
    }

    const { callbacks, interactionMessages, client, logger } = this.options;
    const locale = this.locale(input.chatId);
    await this.answer(input.callbackQueryId);

    const row = callbacks.consume(parsed.token);
    if (!row || row.chat_id !== input.chatId || row.kind !== "inbox") {
      await this.finishMessage(input, t(locale, "queue.expired"));
      return;
    }
    if (row.expires_at < Date.now()) {
      await this.finishMessage(input, t(locale, "queue.expired"));
      return;
    }

    const payload = safeJson(row.payload);
    const sessionID = typeof payload?.sessionID === "string" ? payload.sessionID : null;
    const fromList = payload?.list === true;
    if (!sessionID) {
      await this.finishMessage(input, "⚠️ Could not find the session for this prompt.");
      return;
    }

    try {
      await client.cancelInbox(sessionID, row.ref_id);
      const source = interactionMessages.get(row.ref_id);
      interactionMessages.delete(row.ref_id);
      callbacks.deleteByRef(input.chatId, "inbox", row.ref_id);
      if (source) {
        await this.finishMessage(
          { chatId: source.chat_id, messageId: source.message_id },
          t(locale, "queue.withdrawn"),
        );
      } else if (fromList) {
        // Keep the remaining numbered buttons usable instead of replacing the
        // whole list with a cancellation notice.
        await this.renderQueue(input.chatId, sessionID, input.messageId, locale);
      } else {
        await this.finishMessage(input, t(locale, "queue.withdrawn"));
      }
      logger.info("Queued prompt cancelled", {
        sessionId: sessionID,
        inboxId: row.ref_id,
      });
    } catch (error) {
      await this.finishMessage(
        input,
        t(locale, "queue.failed", { error: safeStatusText(errorMessage(error)) }),
      );
      logger.warn("Queued prompt cancellation failed", {
        inboxId: row.ref_id,
        error: errorMessage(error),
      });
    }
  }

  async onInboxSettled(inboxId: string, status: "delivered" | "cancelled"): Promise<void> {
    const message = this.options.interactionMessages.get(inboxId);
    if (!message) {
      return;
    }
    const text =
      status === "delivered"
        ? "▶️ *Queued prompt started.*"
        : "⛔ *Queued prompt cancelled.*";
    await this.finishMessage(
      { chatId: message.chat_id, messageId: message.message_id },
      text,
    );
    this.options.interactionMessages.delete(inboxId);
    this.options.callbacks.deleteByRef(message.chat_id, "inbox", inboxId);
  }

  async onPermissionReplied(requestId: string): Promise<void> {
    if (this.isHandling(requestId)) {
      return;
    }
    const { interactionMessages, callbacks, outbox, logger } = this.options;
    const message = interactionMessages.get(requestId);
    if (!message) {
      return;
    }
    const chat = outbox.forChat(message.chat_id);
    try {
      await chat.editNow(message.message_id, "✅ *Resolved* in another client.");
      await chat.editMarkup(message.message_id, null);
    } catch (error) {
      if (!isMessageNotFound(error) && !isMessageNotModified(error)) {
        logger.warn("Failed to mark permission as resolved elsewhere", {
          requestId,
          error: errorMessage(error),
        });
      }
    }
    interactionMessages.delete(requestId);
    callbacks.deleteByRef(message.chat_id, "permission", requestId);
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const { callbacks, interactionMessages, outbox, client, logger } = this.options;
    const parsed = parseCallbackData(input.data);

    if (!parsed) {
      await this.answer(input.callbackQueryId, "This button is no longer valid.");
      return;
    }

    // Always answer first so the button stops spinning.
    await this.answer(input.callbackQueryId, undefined);

    const row = callbacks.consume(parsed.token);
    if (!row) {
      await this.finishMessage(input, "⌛ This request has expired.");
      return;
    }
    if (row.chat_id !== input.chatId || row.kind !== "permission") {
      await this.finishMessage(input, "⌛ This request is no longer valid.");
      return;
    }
    if (row.expires_at < Date.now()) {
      await this.finishMessage(input, "⌛ This request has expired.");
      return;
    }

    const payload = safeJson(row.payload);
    const sessionID = typeof payload?.sessionID === "string" ? payload.sessionID : null;
    if (!sessionID) {
      await this.finishMessage(input, "⚠️ Could not find the session for this request.");
      return;
    }

    this.handling.add(row.ref_id);
    try {
      await client.permissionReply(sessionID, row.ref_id, { decision: parsed.decision });
      this.recentlyHandled.set(row.ref_id, Date.now());
      const label =
        parsed.decision === "once"
          ? "✅ *Allowed* once."
          : parsed.decision === "always"
            ? "✅ *Allowed* always."
            : "⛔ *Rejected*.";
      await this.finishMessage(input, label);
      interactionMessages.delete(row.ref_id);
      callbacks.deleteByRef(input.chatId, "permission", row.ref_id);
      logger.info("Permission answered", {
        requestId: row.ref_id,
        decision: parsed.decision,
        sessionId: sessionID,
      });
    } catch (error) {
      const description = errorMessage(error);
      await this.finishMessage(input, `⚠️ Could not apply permission: ${safeStatusText(description)}`);
      logger.warn("Permission reply failed", {
        requestId: row.ref_id,
        decision: parsed.decision,
        error: description,
      });
    } finally {
      this.handling.delete(row.ref_id);
      this.pruneHandled();
    }
  }

  private locale(chatId: string): Locale {
    return normalizeLocale(this.options.settings.get(chatId).locale);
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send a queue reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async answer(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.options.gateway.answerCallbackQuery({
        callbackQueryId,
        ...(text ? { text } : {}),
      });
    } catch (error) {
      this.options.logger.warn("answerCallbackQuery failed", {
        callbackQueryId,
        error: errorMessage(error),
      });
    }
  }

  private async finishMessage(
    input: { readonly chatId: string; readonly messageId?: number },
    text: string,
  ): Promise<void> {
    if (input.messageId === undefined) {
      return;
    }
    const chat = this.options.outbox.forChat(input.chatId);
    try {
      await chat.editNow(input.messageId, text);
      await chat.editMarkup(input.messageId, null);
    } catch (error) {
      if (!isMessageNotFound(error) && !isMessageNotModified(error)) {
        this.options.logger.debug("Failed to edit callback message", {
          messageId: input.messageId,
          error: errorMessage(error),
        });
      }
    }
  }

  private wasHandled(requestId: string): boolean {
    const at = this.recentlyHandled.get(requestId);
    if (at === undefined) {
      return false;
    }
    if (Date.now() - at > HANDLED_CACHE_TTL_MS) {
      this.recentlyHandled.delete(requestId);
      return false;
    }
    return true;
  }

  private pruneHandled(): void {
    const cutoff = Date.now() - HANDLED_CACHE_TTL_MS;
    for (const [key, at] of this.recentlyHandled) {
      if (at < cutoff) {
        this.recentlyHandled.delete(key);
      }
    }
  }
}

export function formatPermissionText(request: PermissionRequest): string {
  const lines = ["🔐 *Permission required*", "", `*Action:* ${transformInline(request.action)}`];
  if (request.resources.length > 0) {
    const shown = request.resources.slice(0, 3).map((resource) => `\`${safeCode(resource)}\``);
    lines.push(`*Resource:* ${shown.join(", ")}`);
    if (request.resources.length > 3) {
      lines.push(`_…and ${request.resources.length - 3} more_`);
    }
  }
  if (request.save && request.save.length > 0) {
    lines.push(`*Always allows:* ${request.save.slice(0, 2).map((item) => transformInline(item)).join(", ")}`);
  }
  if (request.message) {
    lines.push("", transformInline(truncate(request.message, 300)));
  }
  lines.push("", "_Choose an option below._");
  return tidy(lines.join("\n"));
}

function safeCode(value: string): string {
  return truncate(value.replace(/`/g, "′"), 240);
}

function safeStatusText(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), 200);
}

function safeJson(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}