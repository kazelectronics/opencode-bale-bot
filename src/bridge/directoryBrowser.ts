import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type { CallbackRepo, ChatRepo, ChatRow, SettingsRepo } from "../db.js";
import { normalizeLocale, t, type Locale } from "../i18n.js";
import { errorMessage, type Logger } from "../logger.js";
import { truncate } from "../util.js";
import type { BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import type { ProjectManager } from "./projects.js";
import { answerCallback, createToken, safeCode, safeJson, safeText } from "./ui.js";

const MAX_ENTRIES = 20;

export interface DirectoryBrowserOptions {
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly callbacks: CallbackRepo;
  readonly settings: SettingsRepo;
  readonly outbox: Outbox;
  readonly projects: ProjectManager;
  readonly logger: Logger;
}

export type DirectoryCallback =
  | { readonly kind: "navigate"; readonly token: string }
  | { readonly kind: "use"; readonly token: string }
  | { readonly kind: "home" };

export function parseDirectoryCallback(data: string | undefined): DirectoryCallback | null {
  if (!data || !data.startsWith("dir:")) {
    return null;
  }
  const parts = data.split(":");
  const action = parts[1] ?? "";
  if (action === "h") {
    return { kind: "home" };
  }
  const token = parts[2] ?? "";
  if (!token) {
    return null;
  }
  if (action === "n" || action === "u") {
    return { kind: "navigate", token };
  }
  if (action === "s") {
    return { kind: "use", token };
  }
  return null;
}

export class DirectoryBrowser {
  private readonly options: DirectoryBrowserOptions;

  constructor(options: DirectoryBrowserOptions) {
    this.options = options;
  }

  async start(chat: ChatRow): Promise<void> {
    await this.show(chat, chat.project_directory ?? homedir());
  }

  async show(chat: ChatRow, path: string, messageId?: number): Promise<void> {
    const locale = this.locale(chat.chat_id);
    const target = resolve(expandHome(path));
    let entries: string[];
    try {
      const info = await stat(target);
      if (!info.isDirectory()) {
        await this.sendOrEdit(chat.chat_id, messageId, t(locale, "open.not_directory", { path: safeCode(target) }));
        return;
      }
      const dirents = await readdir(target, { withFileTypes: true });
      const dirs = dirents.filter(
        (entry) => entry.isDirectory() && entry.name !== ".git",
      );
      // Hidden directories are common noise; list them after real project dirs.
      const visible = dirs.filter((entry) => !entry.name.startsWith("."));
      const hidden = dirs.filter((entry) => entry.name.startsWith("."));
      entries = [...visible.sort(byName), ...hidden.sort(byName)]
        .map((entry) => entry.name)
        .slice(0, MAX_ENTRIES);
    } catch (error) {
      await this.sendOrEdit(
        chat.chat_id,
        messageId,
        `⚠️ ${safeText(errorMessage(error), 180)}\n\n\`${safeCode(target)}\``,
      );
      return;
    }

    const rows: InlineKeyboardButton[][] = [];
    for (const name of entries) {
      const child = join(target, name);
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "dir",
        refId: child,
        payload: { path: child },
      });
      rows.push([{ text: truncate(`📁 ${name}`, 58), callback_data: `dir:n:${token}` }]);
    }

    const parent = dirname(target);
    const navRow: InlineKeyboardButton[] = [];
    if (parent !== target) {
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "dir",
        refId: parent,
        payload: { path: parent },
      });
      navRow.push({ text: t(locale, "open.up"), callback_data: `dir:u:${token}` });
    }
    navRow.push({ text: t(locale, "open.home"), callback_data: "dir:h" });

    const useToken = createToken(this.options.callbacks, {
      chatId: chat.chat_id,
      kind: "dir",
      refId: target,
      payload: { path: target },
    });
    rows.push(navRow);
    rows.push([{ text: t(locale, "open.use"), callback_data: `dir:s:${useToken}` }]);

    const lines = [
      t(locale, "open.title"),
      "",
      `\`${safeCode(target)}\``,
      "",
      `_${t(locale, "open.subtitle")}_`,
    ];
    if (entries.length === 0) {
      lines.push("", t(locale, "open.empty"));
    }
    await this.sendOrEdit(chat.chat_id, messageId, lines.join("\n"), {
      inline_keyboard: rows,
    });
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseDirectoryCallback(input.data);
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

    if (parsed.kind === "home") {
      await answerCallback(this.options.gateway, input.callbackQueryId, undefined, this.options.logger);
      await this.show(chat, homedir(), input.messageId);
      return;
    }

    const row = this.options.callbacks.consume(parsed.token);
    if (!row || row.chat_id !== input.chatId || row.kind !== "dir" || row.expires_at < Date.now()) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This browser has expired.",
        this.options.logger,
      );
      return;
    }

    const payload = safeJson(row.payload);
    const path = typeof payload?.path === "string" ? payload.path : row.ref_id;
    if (parsed.kind === "navigate") {
      await answerCallback(this.options.gateway, input.callbackQueryId, undefined, this.options.logger);
      await this.show(chat, path, input.messageId);
      return;
    }

    await answerCallback(
      this.options.gateway,
      input.callbackQueryId,
      this.locale(chat.chat_id) === "fa" ? "در حال تنظیم پروژه…" : "Setting the project…",
      this.options.logger,
    );
    await this.options.projects.switchProject(chat, path, input.messageId);
  }

  private locale(chatId: string): Locale {
    return normalizeLocale(this.options.settings.get(chatId).locale);
  }

  private async sendOrEdit(
    chatId: string,
    messageId: number | undefined,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    const outbox = this.options.outbox.forChat(chatId);
    if (messageId !== undefined) {
      const edited = await outbox.editNow(messageId, text, replyMarkup ? { replyMarkup } : undefined);
      if (edited) {
        return;
      }
    }
    try {
      await outbox.send(text, replyMarkup ? { replyMarkup } : {});
    } catch (error) {
      this.options.logger.warn("Could not send the directory browser", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** True when the argument names an existing directory. */
export async function isDirectoryArgument(argument: string): Promise<boolean> {
  try {
    const info = await stat(resolve(expandHome(argument)));
    return info.isDirectory();
  } catch {
    return false;
  }
}

export function directoryLabel(path: string): string {
  return basename(path) || path;
}