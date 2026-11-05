import {
  BaleApiError,
  BaleBot,
  BaleError,
  BaleInputFile,
  type InlineKeyboardMarkup,
  type Message,
  type Update,
} from "@erfanvahabpour/bale-bot-sdk";

import { errorMessage, type Logger } from "../logger.js";
import { sleep } from "../util.js";

export interface SendMessageInput {
  readonly chatId: string;
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

export interface EditMessageInput {
  readonly chatId: string;
  readonly messageId: number;
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

export interface SendDocumentInput {
  readonly chatId: string;
  readonly filename: string;
  readonly content: string | Buffer;
  readonly caption?: string;
  readonly mimeType?: string;
}

export interface SendDocumentResult {
  readonly messageId: number;
  readonly fileId: string | null;
  readonly filePath: string | null;
}

export interface BaleFileResult {
  readonly fileId: string;
  readonly filePath: string;
  readonly fileSize: number | null;
  readonly content: Buffer;
}

export interface BaleGateway {
  getMe(): Promise<{ id: string; username: string | null; firstName: string }>;
  deleteWebhook(): Promise<boolean>;
  getUpdates(params: {
    offset: number;
    limit: number;
    timeout: number;
    signal?: AbortSignal;
  }): Promise<readonly Update[]>;
  sendMessage(input: SendMessageInput): Promise<Message>;
  editMessageText(input: EditMessageInput): Promise<Message>;
  editMessageReplyMarkup(input: {
    chatId: string;
    messageId: number;
    replyMarkup: InlineKeyboardMarkup | null;
  }): Promise<Message>;
  deleteMessage(input: { chatId: string; messageId: number }): Promise<boolean>;
  pinChatMessage(input: { chatId: string; messageId: number }): Promise<boolean>;
  unpinChatMessage(input: { chatId: string; messageId?: number }): Promise<boolean>;
  sendChatAction(input: { chatId: string; action?: "typing" }): Promise<boolean>;
  sendDocument(input: SendDocumentInput): Promise<SendDocumentResult>;
  getFile(fileId: string): Promise<BaleFileResult>;
  answerCallbackQuery(input: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
  }): Promise<boolean>;
}

export interface BaleGatewayOptions {
  readonly token: string;
  readonly baseUrl: string;
  readonly logger: Logger;
}

export class SdkBaleGateway implements BaleGateway {
  private readonly bot: BaleBot;
  private readonly logger: Logger;

  constructor(options: BaleGatewayOptions) {
    this.logger = options.logger.child({ component: "bale" });
    this.bot = new BaleBot({
      token: options.token,
      baseUrl: options.baseUrl,
      timeout: 30_000,
      retries: 0,
    });
  }

  async getMe(): Promise<{ id: string; username: string | null; firstName: string }> {
    const me = await this.call("getMe", () => this.bot.getMe());
    return {
      id: String(me.id),
      username: me.username ?? null,
      firstName: me.first_name,
    };
  }

  async deleteWebhook(): Promise<boolean> {
    return this.call("deleteWebhook", () => this.bot.deleteWebhook());
  }

  async getUpdates(params: {
    offset: number;
    limit: number;
    timeout: number;
    signal?: AbortSignal;
  }): Promise<readonly Update[]> {
    return this.bot.getUpdates(
      {
        offset: params.offset,
        limit: params.limit,
        timeout: params.timeout,
      },
      {
        dispatchEvents: false,
        timeout: (params.timeout + 15) * 1_000,
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
  }

  async sendMessage(input: SendMessageInput): Promise<Message> {
    return this.call("sendMessage", () =>
      this.bot.sendMessage({
        chat_id: input.chatId,
        text: input.text,
        ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
      }),
    );
  }

  async editMessageText(input: EditMessageInput): Promise<Message> {
    return this.call("editMessageText", () =>
      this.bot.editMessageText({
        chat_id: input.chatId,
        message_id: input.messageId,
        text: input.text,
        ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
      }),
    );
  }

  async editMessageReplyMarkup(input: {
    chatId: string;
    messageId: number;
    replyMarkup: InlineKeyboardMarkup | null;
  }): Promise<Message> {
    return this.call("editMessageReplyMarkup", () =>
      this.bot.editMessageReplyMarkup({
        chat_id: input.chatId,
        message_id: input.messageId,
        reply_markup: input.replyMarkup ?? { inline_keyboard: [] },
      }),
    );
  }

  async deleteMessage(input: { chatId: string; messageId: number }): Promise<boolean> {
    return this.call("deleteMessage", () =>
      this.bot.deleteMessage({ chat_id: input.chatId, message_id: input.messageId }),
    );
  }

  async sendChatAction(input: { chatId: string; action?: "typing" }): Promise<boolean> {
    return this.call("sendChatAction", () =>
      this.bot.sendChatAction({
        chat_id: input.chatId,
        action: input.action ?? "typing",
      }),
    );
  }

  async pinChatMessage(input: { chatId: string; messageId: number }): Promise<boolean> {
    return this.call("pinChatMessage", () =>
      this.bot.pinChatMessage({ chat_id: input.chatId, message_id: input.messageId }),
    );
  }

  async unpinChatMessage(input: { chatId: string; messageId?: number }): Promise<boolean> {
    return this.call("unpinChatMessage", () =>
      this.bot.unpinChatMessage({
        chat_id: input.chatId,
        ...(input.messageId !== undefined ? { message_id: input.messageId } : {}),
      }),
    );
  }

  async sendDocument(input: SendDocumentInput): Promise<SendDocumentResult> {
    const mimeType = input.mimeType ?? "text/markdown; charset=utf-8";
    const document =
      typeof input.content === "string"
        ? BaleInputFile.fromContents(input.content, input.filename, mimeType)
        : BaleInputFile.fromBuffer(input.content, input.filename, mimeType);
    const message = await this.call("sendDocument", () =>
      this.bot.sendDocument({
        chat_id: input.chatId,
        document,
        ...(input.caption ? { caption: input.caption } : {}),
      }),
    );
    return {
      messageId: message.message_id,
      fileId: message.document?.file_id ?? null,
      filePath: null,
    };
  }

  async getFile(fileId: string): Promise<BaleFileResult> {
    const file = await this.call("getFile", () => this.bot.getFile({ file_id: fileId }));
    if (!file.file_path) {
      throw new Error(`Bale file has no path: ${fileId}`);
    }
    const content = Buffer.from(await this.bot.downloadFile(file));
    return {
      fileId: file.file_id,
      filePath: file.file_path,
      fileSize: file.file_size ?? content.length,
      content,
    };
  }

  async answerCallbackQuery(input: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
  }): Promise<boolean> {
    return this.call("answerCallbackQuery", () =>
      this.bot.answerCallbackQuery({
        callback_query_id: input.callbackQueryId,
        ...(input.text ? { text: input.text } : {}),
        ...(input.showAlert !== undefined ? { show_alert: input.showAlert } : {}),
      }),
    );
  }

  private async call<T>(method: string, operation: () => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryAfterMs = rateLimitDelayMs(error);
        if (retryAfterMs !== null && attempt < maxAttempts) {
          this.logger.warn("Bale rate limit; backing off", {
            method,
            retryAfterMs,
            attempt,
          });
          await sleep(retryAfterMs);
          continue;
        }
        this.logger.debug("Bale call failed", {
          method,
          attempt,
          error: describeBaleError(error),
        });
        throw error;
      }
    }
  }
}

export function describeBaleError(error: unknown): Record<string, unknown> {
  if (error instanceof BaleError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      status: error.status,
      description: error.description,
      retryAfter: error.parameters?.retry_after,
    };
  }
  return { message: errorMessage(error) };
}

export function rateLimitDelayMs(error: unknown): number | null {
  if (error instanceof BaleError) {
    const retryAfter = error.parameters?.retry_after;
    if (typeof retryAfter === "number" && retryAfter >= 0) {
      return Math.max(1_000, retryAfter * 1_000);
    }
    if (error.status === 429) {
      return 5_000;
    }
  }
  return null;
}

export function isMessageNotModified(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("message is not modified") || text.includes("message not modified");
}

export function isMessageTooLong(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes("message is too long") ||
    text.includes("text is too long") ||
    (error instanceof BaleError && error.status === 400 && text.includes("too long"))
  );
}

export function isMessageNotFound(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("message to edit not found") || text.includes("message not found");
}

export function isBaleApiError(error: unknown): error is BaleApiError {
  return error instanceof BaleApiError;
}

function errorText(error: unknown): string {
  if (error instanceof BaleError) {
    return `${error.message} ${error.description ?? ""}`;
  }
  return errorMessage(error);
}