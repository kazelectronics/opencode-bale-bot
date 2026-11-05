import { randomBytes } from "node:crypto";

import type { CallbackRepo } from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import {
  isMessageNotFound,
  isMessageNotModified,
  type BaleGateway,
} from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { truncate } from "../util.js";

export const MENU_TTL_MS = 15 * 60 * 1_000;

export interface TokenInput {
  readonly chatId: string;
  readonly kind: string;
  readonly refId: string;
  readonly payload?: Record<string, unknown>;
  readonly ttlMs?: number;
}

export function createToken(callbacks: CallbackRepo, input: TokenInput): string {
  const token = randomBytes(9).toString("base64url");
  callbacks.create({
    token,
    chat_id: input.chatId,
    kind: input.kind,
    ref_id: input.refId,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    expires_at: Date.now() + (input.ttlMs ?? MENU_TTL_MS),
  });
  return token;
}

export function safeJson(value: string | null): Record<string, unknown> | null {
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

export async function answerCallback(
  gateway: BaleGateway,
  callbackQueryId: string,
  text: string | undefined,
  logger: Logger,
): Promise<void> {
  try {
    await gateway.answerCallbackQuery({
      callbackQueryId,
      ...(text ? { text } : {}),
    });
  } catch (error) {
    logger.debug("answerCallbackQuery failed", {
      callbackQueryId,
      error: errorMessage(error),
    });
  }
}

export async function finishMessage(
  outbox: Outbox,
  chatId: string,
  messageId: number | undefined,
  text: string,
  logger: Logger,
): Promise<void> {
  if (messageId === undefined) {
    return;
  }
  const chat = outbox.forChat(chatId);
  try {
    await chat.editNow(messageId, text);
    await chat.editMarkup(messageId, null);
  } catch (error) {
    if (!isMessageNotFound(error) && !isMessageNotModified(error)) {
      logger.debug("Could not edit callback message", {
        messageId,
        error: errorMessage(error),
      });
    }
  }
}

/** Escapes text for use inside Bale bold markup. */
export function escapeBold(value: string): string {
  return value.replace(/\*/g, "′").replace(/\n+/g, " ").trim();
}

/** Escapes text for use inside an inline code span. */
export function safeCode(value: string): string {
  return value.replace(/`/g, "′").replace(/\n+/g, " ").trim();
}

/** A compact single-line string safe for labels and plain text. */
export function safeText(value: string, max = 240): string {
  return truncate(value.replace(/\s+/g, " ").trim(), max);
}

export function shortId(id: string): string {
  return id.length <= 14 ? id : `…${id.slice(-10)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}