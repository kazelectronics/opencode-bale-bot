import { basename, join, posix } from "node:path";

import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
} from "@erfanvahabpour/bale-bot-sdk";

import type { CallbackRepo, ChatRepo, ChatRow, SettingsRepo } from "../db.js";
import type { Config } from "../config.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { FileDiffInfo, FileSystemEntry } from "../opencode/types.js";
import { truncate } from "../util.js";
import type { BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { describeOpenCodeError } from "./errors.js";
import {
  answerCallback,
  createToken,
  formatBytes,
  safeCode,
  safeJson,
  safeText,
} from "./ui.js";

const MAX_BUTTONS = 24;
const MAX_INLINE_CHARS = 3_000;
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export interface FileBrowserOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly callbacks: CallbackRepo;
  readonly settings: SettingsRepo;
  readonly outbox: Outbox;
  readonly config: Config;
  readonly logger: Logger;
}

export type FileCallback =
  | { readonly kind: "list"; readonly token: string }
  | { readonly kind: "read"; readonly token: string }
  | { readonly kind: "up"; readonly token: string };

export function parseFileCallback(data: string | undefined): FileCallback | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "fs") {
    return null;
  }
  const token = parts[2] ?? "";
  if (!token) {
    return null;
  }
  if (parts[1] === "l") {
    return { kind: "list", token };
  }
  if (parts[1] === "r") {
    return { kind: "read", token };
  }
  if (parts[1] === "u") {
    return { kind: "up", token };
  }
  return null;
}

export class FileBrowser {
  private readonly options: FileBrowserOptions;

  constructor(options: FileBrowserOptions) {
    this.options = options;
  }

  async showDirectory(chat: ChatRow, path = "."): Promise<void> {
    const normalized = normalizeRelative(path);
    if (normalized === null) {
      await this.reply(chat.chat_id, "⚠️ That path is outside the project directory.");
      return;
    }

    let entries: readonly FileSystemEntry[];
    try {
      entries = await this.options.client.listDirectory(this.root(chat), normalized);
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not list \`${safeCode(normalized)}\`: ${safeText(describeOpenCodeError(error), 200)}`,
      );
      return;
    }

    const sorted = [...entries].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.path.localeCompare(b.path);
    });
    const shown = sorted.slice(0, MAX_BUTTONS);
    const displayPath = this.displayPath(chat, normalized);

    if (shown.length === 0) {
      await this.reply(
        chat.chat_id,
        [
          `📂 *${escapePath(displayPath)}*`,
          "",
          "_Empty directory._",
          "",
          "_This is the session's project directory. Use `/projects` or `/project <path>` to switch._",
        ].join("\n"),
      );
      return;
    }

    const keyboard = this.entryKeyboard(chat, normalized, shown);
    const header = [
      `📂 *${escapePath(displayPath)}*`,
      "",
      `_${sorted.length} entr${sorted.length === 1 ? "y" : "ies"}${
        sorted.length > shown.length ? ` · showing ${shown.length}` : ""
      }_`,
      "_Tap a folder to open it or a file to read it._",
    ];
    await this.sendWithKeyboard(chat.chat_id, header.join("\n"), keyboard);
  }

  async find(chat: ChatRow, query: string): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      await this.reply(chat.chat_id, "Usage: /find <text>");
      return;
    }
    let entries: readonly FileSystemEntry[];
    try {
      entries = await this.options.client.findFiles(this.root(chat), trimmed, {
        limit: MAX_BUTTONS,
      });
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Search failed: ${safeText(describeOpenCodeError(error), 200)}`,
      );
      return;
    }

    if (entries.length === 0) {
      await this.reply(chat.chat_id, `🔎 No files match \`${safeCode(trimmed)}\`.`);
      return;
    }

    const keyboard = this.entryKeyboard(chat, ".", entries.slice(0, MAX_BUTTONS), true);
    const header = [
      `🔎 *Matches for* \`${safeCode(trimmed)}\``,
      "",
      `_${entries.length} result${entries.length === 1 ? "" : "s"}_`,
    ];
    await this.sendWithKeyboard(chat.chat_id, header.join("\n"), keyboard);
  }

  async showFile(chat: ChatRow, path: string): Promise<void> {
    const normalized = normalizeRelative(path);
    if (normalized === null || normalized === ".") {
      await this.reply(chat.chat_id, "⚠️ Give a file path, for example `/show src/index.ts`.");
      return;
    }

    let file;
    try {
      file = await this.options.client.readFile(this.root(chat), normalized);
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not read \`${safeCode(normalized)}\`: ${safeText(describeOpenCodeError(error), 200)}`,
      );
      return;
    }

    if (file.content.length > MAX_DOCUMENT_BYTES) {
      await this.reply(
        chat.chat_id,
        `⚠️ \`${safeCode(normalized)}\` is ${formatBytes(file.content.length)}; the limit is ${formatBytes(MAX_DOCUMENT_BYTES)}.`,
      );
      return;
    }

    const name = basename(normalized);
    const text = decodeText(file.content, file.contentType);
    if (text === null) {
      await this.sendDocument(
        chat.chat_id,
        name,
        file.content,
        file.contentType,
        `📎 \`${safeCode(normalized)}\` · ${formatBytes(file.content.length)}`,
      );
      return;
    }

    if (text.length > MAX_INLINE_CHARS) {
      await this.sendDocument(
        chat.chat_id,
        name,
        file.content,
        file.contentType.startsWith("text/") ? "text/plain; charset=utf-8" : file.contentType,
        `📄 \`${safeCode(normalized)}\` · ${formatBytes(file.content.length)}`,
      );
      return;
    }

    const fence = text.includes("```") ? "````" : "```";
    const language = languageFor(normalized);
    const body = `${fence}${language}\n${text.replace(/\n+$/, "")}\n${fence}`;
    await this.reply(chat.chat_id, `📄 *${escapePath(normalized)}*\n\n${body}`);
  }

  async showDiff(chat: ChatRow): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    let diffs: readonly FileDiffInfo[] = [];
    let source = "session";

    if (current.active_session_id) {
      try {
        diffs = await this.options.client.sessionDiff(current.active_session_id);
      } catch (error) {
        this.options.logger.debug("Session diff failed; trying VCS", {
          sessionId: current.active_session_id,
          error: errorMessage(error),
        });
      }
    }

    if (diffs.length === 0) {
      source = "working tree";
      try {
        diffs = await this.options.client.vcsDiff(this.root(current), {
          mode: "working",
          untracked: "files",
        });
      } catch (error) {
        await this.reply(
          chat.chat_id,
          `⚠️ Could not read a diff: ${safeText(describeOpenCodeError(error), 200)}`,
        );
        return;
      }
    }

    if (diffs.length === 0) {
      await this.reply(
        chat.chat_id,
        "🔍 *No changes detected.*\n\n_Session diffs need a git repository or an OpenCode snapshot._",
      );
      return;
    }

    const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
    const deletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0);
    const lines = [
      "🔍 *Diff*",
      "",
      `_${source} · ${diffs.length} file${diffs.length === 1 ? "" : "s"} · +${additions} −${deletions}_`,
      "",
    ];
    for (const diff of diffs.slice(0, 20)) {
      const icon = diff.status === "added" ? "🟢" : diff.status === "deleted" ? "🔴" : "🟡";
      lines.push(
        `${icon} \`${safeCode(diff.file)}\` _+${diff.additions} −${diff.deletions}_`,
      );
    }
    if (diffs.length > 20) {
      lines.push(`_…and ${diffs.length - 20} more_`);
    }

    const patch = diffs
      .map((diff) => diff.patch)
      .filter((value) => value.trim().length > 0)
      .join("\n");
    const attachDiff =
      this.options.settings.get(chat.chat_id).diff_attachments && patch.length > 0;
    if (attachDiff) {
      await this.sendDocument(
        chat.chat_id,
        `diff-${new Date().toISOString().slice(0, 10)}.patch`,
        Buffer.from(patch, "utf8"),
        "text/x-diff; charset=utf-8",
        `🔍 ${diffs.length} file${diffs.length === 1 ? "" : "s"} changed`,
      );
    }
    await this.reply(chat.chat_id, lines.join("\n"));
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseFileCallback(input.data);
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
    if (!row || row.chat_id !== input.chatId || row.kind !== "fs" || row.expires_at < Date.now()) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This browser has expired.",
        this.options.logger,
      );
      return;
    }

    const payload = safeJson(row.payload);
    const path = typeof payload?.path === "string" ? payload.path : null;
    if (path === null) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "That path is no longer available.",
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

    await answerCallback(this.options.gateway, input.callbackQueryId, undefined, this.options.logger);
    if (parsed.kind === "read") {
      await this.showFile(chat, path);
    } else {
      await this.showDirectory(chat, path);
    }
  }

  private entryKeyboard(
    chat: ChatRow,
    current: string,
    entries: readonly FileSystemEntry[],
    flat = false,
  ): InlineKeyboardMarkup {
    const rows: InlineKeyboardButton[][] = [];
    if (!flat && current !== ".") {
      const parent = posix.dirname(current);
      rows.push([
        {
          text: "⬆️ Up",
          callback_data: `fs:u:${createToken(this.options.callbacks, {
            chatId: chat.chat_id,
            kind: "fs",
            refId: parent === "" ? "." : parent,
            payload: { path: parent === "" ? "." : parent },
          })}`,
        },
      ]);
    }

    const buttons: InlineKeyboardButton[] = [];
    for (const entry of entries) {
      const isDirectory = entry.type === "directory";
      const path = isDirectory ? entry.path.replace(/\/+$/, "") : entry.path;
      const label = `${isDirectory ? "📁" : "📄"} ${basename(path) || path}`;
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "fs",
        refId: path,
        payload: { path },
      });
      buttons.push({
        text: truncate(label, 52),
        callback_data: `fs:${isDirectory ? "l" : "r"}:${token}`,
      });
    }
    for (let index = 0; index < buttons.length; index += 2) {
      rows.push(buttons.slice(index, index + 2));
    }
    return { inline_keyboard: rows };
  }

  private root(chat: ChatRow): string {
    return chat.project_directory ?? this.options.config.opencode.projectDirectory;
  }

  private displayPath(chat: ChatRow, relative: string): string {
    return relative === "." ? this.root(chat) : join(this.root(chat), relative);
  }

  private async sendWithKeyboard(
    chatId: string,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text, { replyMarkup });
    } catch (error) {
      this.options.logger.warn("Could not send file browser", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async sendDocument(
    chatId: string,
    filename: string,
    content: Buffer,
    mimeType: string,
    caption: string,
  ): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).sendDocument({
        filename,
        content,
        caption,
        mimeType,
      });
    } catch (error) {
      this.options.logger.warn("Could not send file document", {
        chatId,
        filename,
        error: errorMessage(error),
      });
      await this.reply(
        chatId,
        `⚠️ Could not upload \`${safeCode(filename)}\`: ${safeText(errorMessage(error), 160)}`,
      );
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send file browser reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}

function normalizeRelative(path: string): string | null {
  const cleaned = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleaned.length === 0 || cleaned === ".") {
    return ".";
  }
  const normalized = posix.normalize(cleaned);
  if (normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized;
}

function decodeText(content: Buffer, contentType: string): string | null {
  if (content.subarray(0, 4096).includes(0)) {
    return null;
  }
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const textual =
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/x-yaml" ||
    type === "application/yaml";
  if (!textual) {
    return null;
  }
  return content.toString("utf8");
}

function languageFor(path: string): string {
  const extension = posix.extname(path).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    json: "json",
    md: "md",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "bash",
    yml: "yaml",
    yaml: "yaml",
    css: "css",
    html: "html",
    sql: "sql",
    toml: "toml",
  };
  return map[extension] ?? "";
}

function escapePath(value: string): string {
  return value.replace(/\*/g, "′").replace(/\n+/g, " ").trim();
}