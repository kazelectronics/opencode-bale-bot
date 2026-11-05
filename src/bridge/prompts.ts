import { randomBytes } from "node:crypto";

import type { Config } from "../config.js";
import type { ChatRepo, ChatRow, PromptIdRepo } from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { PromptFileAttachment } from "../opencode/types.js";
import type { Outbox } from "../bale/outbox.js";
import type { InteractionManager } from "./interactions.js";
import type { SessionService } from "./sessions.js";

export interface PromptHandlerOptions {
  readonly client: OpenCodeClient;
  readonly chats: ChatRepo;
  readonly promptIds: PromptIdRepo;
  readonly sessions: SessionService;
  readonly interactions: InteractionManager;
  readonly outbox: Outbox;
  readonly config: Config;
  readonly logger: Logger;
}

export class PromptHandler {
  private readonly options: PromptHandlerOptions;

  constructor(options: PromptHandlerOptions) {
    this.options = options;
  }

  async handleText(
    chat: ChatRow,
    text: string,
    updateId: number,
    files: readonly PromptFileAttachment[] = [],
  ): Promise<void> {
    const { client, promptIds, sessions, outbox, logger } = this.options;
    const body = text.trim();
    if (!body && files.length === 0) {
      return;
    }

    let session;
    try {
      session = await sessions.ensureSession(chat);
    } catch (error) {
      await this.reply(chat.chat_id, `⚠️ Could not create or open a session: ${safe(sessions.describeError(error))}`);
      return;
    }

    let busy = false;
    try {
      const active = await client.activeSessions();
      busy = active[session.id]?.type === "running";
    } catch (error) {
      logger.debug("Could not read active sessions before prompt", {
        error: errorMessage(error),
      });
    }

    const messageId = promptIds.getOrCreate(updateId, generatePromptMessageId);

    try {
      await client.prompt(session.id, {
        id: messageId,
        text: body,
        ...(files.length > 0 ? { files } : {}),
        delivery: chat.delivery === "steer" ? "steer" : "queue",
      });
    } catch (error) {
      logger.warn("Prompt failed", {
        sessionId: session.id,
        error: errorMessage(error),
      });
      await this.reply(
        chat.chat_id,
        `⚠️ Could not send the prompt: ${safe(sessions.describeError(error))}`,
      );
      return;
    }

    if (busy) {
      await this.options.interactions.onPromptQueued({
        chatId: chat.chat_id,
        sessionID: session.id,
        inboxID: messageId,
        promptText: files.length > 0 ? `${body} (${files.length} attachment${files.length === 1 ? "" : "s"})` : body,
      });
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send prompt status", {
        error: errorMessage(error),
      });
    }
  }
}

/**
 * Deterministic per-update ID is stored before the prompt is sent. A retried
 * update reuses the same OpenCode message ID, so the server treats it as the
 * same input instead of duplicating the prompt.
 */
export function generatePromptMessageId(): string {
  const timestamp = Date.now().toString(36).padStart(8, "0").slice(-8);
  const random = randomBytes(18)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 18)
    .padEnd(18, "0");
  return `msg_${timestamp}${random}`;
}

function safe(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}