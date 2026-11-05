import type { Update } from "@erfanvahabpour/bale-bot-sdk";

import type { Config } from "../config.js";
import type { ChatRepo, ChatRow } from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import type { Outbox } from "../bale/outbox.js";
import type { InteractionManager } from "./interactions.js";
import type { CommandHandler } from "./commands.js";
import {
  AttachmentError,
  attachmentPromptText,
  type AttachmentService,
} from "./attachments.js";
import type { CatalogManager } from "./catalogs.js";
import type { FileBrowser } from "./files.js";
import type { FormManager } from "./forms.js";
import type { HistoryManager } from "./history.js";
import type { MenuManager } from "./menus.js";
import type { ProjectManager } from "./projects.js";
import type { PromptHandler } from "./prompts.js";
import type { WatchManager } from "./watches.js";
import type { SettingsManager } from "./settings.js";
import type { DashboardManager } from "./dashboard.js";
import type { DirectoryBrowser } from "./directoryBrowser.js";
import type { ServerControl } from "./serverControl.js";
import type { TaskManager } from "./tasks.js";

export interface UpdateRouterOptions {
  readonly allowedUserId: string;
  readonly chats: ChatRepo;
  readonly commands: CommandHandler;
  readonly prompts: PromptHandler;
  readonly interactions: InteractionManager;
  readonly forms: FormManager;
  readonly menus: MenuManager;
  readonly attachments: AttachmentService;
  readonly catalogs: CatalogManager;
  readonly files: FileBrowser;
  readonly history: HistoryManager;
  readonly projects: ProjectManager;
  readonly watches: WatchManager;
  readonly settingsManager: SettingsManager;
  readonly dashboard: DashboardManager;
  readonly directoryBrowser: DirectoryBrowser;
  readonly serverControl: ServerControl;
  readonly tasks: TaskManager;
  readonly outbox: Outbox;
  readonly config: Config;
  readonly logger: Logger;
}

export class UpdateRouter {
  private readonly options: UpdateRouterOptions;

  constructor(options: UpdateRouterOptions) {
    this.options = options;
  }

  async handle(update: Update): Promise<void> {
    const { logger } = this.options;

    if (update.type === "callback_query") {
      await this.handleCallback(update.callback_query);
      return;
    }

    if (update.type !== "message") {
      return;
    }

    const message = update.message;
    const from = message.from;
    const chat = message.chat;

    if (!from || from.is_bot) {
      return;
    }
    if (String(from.id) !== this.options.allowedUserId) {
      logger.debug("Ignoring message from an unauthorized user", {
        userId: String(from.id),
        chatId: String(chat.id),
      });
      return;
    }
    if (chat.type !== "private") {
      logger.debug("Ignoring non-private chat", { chatId: String(chat.id), type: chat.type });
      return;
    }

    const chatRow = this.ensureChat(String(chat.id), String(from.id));
    const hasMedia = this.options.attachments.hasMedia(message);

    if (hasMedia) {
      await this.handleAttachment(chatRow, message, update.update_id);
      return;
    }

    if (typeof message.text === "string" && message.text.trim().length > 0) {
      const text = message.text;
      if (text.trimStart().startsWith("/")) {
        await this.options.commands.handle(chatRow, text);
      } else if (!(await this.options.forms.handleText(chatRow, text))) {
        await this.options.prompts.handleText(chatRow, text, update.update_id);
      }
      return;
    }

    logger.debug("Ignoring message with no usable content", {
      chatId: chatRow.chat_id,
      messageId: message.message_id,
    });
  }

  private async handleCallback(
    callback: Extract<Update, { type: "callback_query" }>["callback_query"],
  ): Promise<void> {
    const from = callback.from;
    if (!from || from.is_bot) {
      return;
    }
    if (String(from.id) !== this.options.allowedUserId) {
      this.options.logger.debug("Ignoring callback from an unauthorized user", {
        userId: String(from.id),
      });
      return;
    }

    const message = callback.message;
    const chat = message?.chat;
    if (!chat || chat.type !== "private") {
      return;
    }

    const input = {
      chatId: String(chat.id),
      callbackQueryId: callback.id,
      data: callback.data,
      ...(message ? { messageId: message.message_id } : {}),
    };
    const data = callback.data ?? "";
    if (data.startsWith("f:")) {
      await this.options.forms.handleCallback(input);
      return;
    }
    if (data.startsWith("set:")) {
      await this.options.settingsManager.handleCallback(input);
      return;
    }
    if (data.startsWith("dash:") || data.startsWith("ctx:")) {
      await this.options.dashboard.handleCallback(input);
      return;
    }
    if (data.startsWith("dir:")) {
      await this.options.directoryBrowser.handleCallback(input);
      return;
    }
    if (data.startsWith("mcp:")) {
      await this.options.serverControl.handleCallback(input);
      return;
    }
    if (data.startsWith("task:")) {
      await this.options.tasks.handleCallback(input);
      return;
    }
    if (data.startsWith("m:") || data.startsWith("a:") || data.startsWith("fo:")) {
      await this.options.menus.handleCallback(input);
      return;
    }
    if (data.startsWith("q:")) {
      await this.options.interactions.handleQueueCallback(input);
      return;
    }
    if (data.startsWith("c:") || data.startsWith("s:")) {
      await this.options.catalogs.handleCallback(input);
      return;
    }
    if (data.startsWith("fs:")) {
      await this.options.files.handleCallback(input);
      return;
    }
    if (data.startsWith("rv:") || data.startsWith("fk:")) {
      await this.options.history.handleCallback(input);
      return;
    }
    if (data.startsWith("p:") || data.startsWith("wt:")) {
      await this.options.projects.handleCallback(input);
      return;
    }
    if (data.startsWith("w:")) {
      await this.options.watches.handleCallback(input);
      return;
    }
    await this.options.interactions.handleCallback(input);
  }

  private async handleAttachment(
    chat: ChatRow,
    message: Extract<Update, { type: "message" }>["message"],
    updateId: number,
  ): Promise<void> {
    let downloaded;
    try {
      downloaded = await this.options.attachments.download(message, updateId);
    } catch (error) {
      const text =
        error instanceof AttachmentError
          ? `📎 ${error.message}`
          : "📎 Could not read that attachment.";
      if (!(error instanceof AttachmentError)) {
        this.options.logger.warn("Unexpected attachment failure", {
          chatId: chat.chat_id,
          error: errorMessage(error),
        });
      }
      await this.safeReply(chat.chat_id, text);
      return;
    }

    const displayName = downloaded.file.name ?? downloaded.filename;
    const text = attachmentPromptText(message.caption, displayName);
    this.options.logger.info("Attachment prepared", {
      chatId: chat.chat_id,
      filename: downloaded.filename,
      mimeType: downloaded.mimeType,
      bytes: downloaded.bytes,
    });

    if (!(await this.options.forms.handleText(chat, text))) {
      await this.options.prompts.handleText(chat, text, updateId, [downloaded.file]);
    }
  }

  private ensureChat(chatId: string, userId: string): ChatRow {
    const { config, chats } = this.options;
    return chats.ensure(chatId, userId, {
      projectDirectory: config.opencode.projectDirectory,
      modelProvider: config.opencode.model.providerID,
      modelId: config.opencode.model.id,
      agent: config.opencode.agent,
      delivery: config.bridge.delivery,
    });
  }

  private async safeReply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send router reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}