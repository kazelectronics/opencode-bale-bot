import type { InlineKeyboardMarkup, Message } from "@erfanvahabpour/bale-bot-sdk";

import { errorMessage, type Logger } from "../logger.js";
import {
  isMessageNotFound,
  isMessageNotModified,
  type BaleGateway,
  type SendDocumentResult,
} from "./gateway.js";

export interface OutboxOptions {
  readonly editIntervalMs: number;
  readonly logger: Logger;
}

export interface SendOptions {
  readonly replyMarkup?: InlineKeyboardMarkup;
}

export interface EditOptions {
  readonly replyMarkup?: InlineKeyboardMarkup;
}

interface PendingEdit {
  readonly messageId: number;
  readonly text: string;
  readonly replyMarkup?: InlineKeyboardMarkup;
}

/**
 * One serialized queue per chat. Stream edits are coalesced; the newest text
 * wins and is written at most once per interval. `editNow` bypasses the
 * throttle for final messages.
 */
export class ChatOutbox {
  private readonly chatId: string;
  private readonly gateway: BaleGateway;
  private readonly logger: Logger;
  private readonly editIntervalMs: number;
  private chain: Promise<void> = Promise.resolve();
  private pending: PendingEdit | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastEditAt = 0;
  private closed = false;

  constructor(chatId: string, gateway: BaleGateway, options: OutboxOptions) {
    this.chatId = chatId;
    this.gateway = gateway;
    this.logger = options.logger.child({ chatId });
    this.editIntervalMs = options.editIntervalMs;
  }

  send(text: string, options: SendOptions = {}): Promise<Message> {
    return this.enqueue(() =>
      this.gateway.sendMessage({
        chatId: this.chatId,
        text,
        ...(options.replyMarkup ? { replyMarkup: options.replyMarkup } : {}),
      }),
    );
  }

  sendDocument(input: {
    filename: string;
    content: string | Buffer;
    caption?: string;
    mimeType?: string;
  }): Promise<SendDocumentResult> {
    return this.enqueue(() => this.gateway.sendDocument({ chatId: this.chatId, ...input }));
  }

  editNow(messageId: number, text: string, editOptions?: EditOptions): Promise<boolean> {
    this.cancelScheduled();
    return this.enqueue(() => this.performEdit(messageId, text, editOptions?.replyMarkup));
  }

  scheduleEdit(messageId: number, text: string, editOptions?: EditOptions): void {
    if (this.closed) {
      return;
    }
    this.pending = {
      messageId,
      text,
      ...(editOptions?.replyMarkup ? { replyMarkup: editOptions.replyMarkup } : {}),
    };
    if (this.timer) {
      return;
    }
    const delay = Math.max(0, this.lastEditAt + this.editIntervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushPending();
    }, delay);
    this.timer.unref?.();
  }

  editMarkup(messageId: number, replyMarkup: InlineKeyboardMarkup | null): Promise<boolean> {
    this.cancelScheduled();
    return this.enqueue(async () => {
      try {
        await this.gateway.editMessageReplyMarkup({ chatId: this.chatId, messageId, replyMarkup });
        this.lastEditAt = Date.now();
        return true;
      } catch (error) {
        if (isMessageNotModified(error) || isMessageNotFound(error)) {
          return false;
        }
        this.logger.warn("Failed to edit reply markup", { messageId, error: errorMessage(error) });
        return false;
      }
    });
  }

  async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    this.cancelTimer();
    if (pending) {
      try {
        await this.enqueue(() =>
          this.performEdit(pending.messageId, pending.text, pending.replyMarkup),
        );
      } catch (error) {
        this.logger.warn("Failed to flush pending edit", { error: errorMessage(error) });
      }
    }
    await this.chain;
  }

  close(): void {
    this.closed = true;
    this.cancelScheduled();
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) {
      return;
    }
    void this.editNow(pending.messageId, pending.text, {
      ...(pending.replyMarkup ? { replyMarkup: pending.replyMarkup } : {}),
    }).catch((error) => {
      this.logger.warn("Scheduled edit failed", { error: errorMessage(error) });
    });
  }

  private performEdit(
    messageId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<boolean> {
    return (async () => {
      try {
        await this.gateway.editMessageText({
          chatId: this.chatId,
          messageId,
          text,
          ...(replyMarkup ? { replyMarkup } : {}),
        });
        return true;
      } catch (error) {
        if (isMessageNotModified(error)) {
          return true;
        }
        if (isMessageNotFound(error)) {
          this.logger.debug("Edit target no longer exists", { messageId });
          return false;
        }
        throw error;
      } finally {
        this.lastEditAt = Date.now();
      }
    })();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cancelScheduled(): void {
    this.cancelTimer();
    this.pending = null;
  }
}

export class Outbox {
  private readonly chats = new Map<string, ChatOutbox>();

  constructor(
    private readonly gateway: BaleGateway,
    private readonly options: OutboxOptions,
  ) {}

  forChat(chatId: string): ChatOutbox {
    const existing = this.chats.get(chatId);
    if (existing) {
      return existing;
    }
    const created = new ChatOutbox(chatId, this.gateway, this.options);
    this.chats.set(chatId, created);
    return created;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.chats.values()].map((chat) => chat.flush()));
  }

  closeAll(): void {
    for (const chat of this.chats.values()) {
      chat.close();
    }
  }
}