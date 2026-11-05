import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type { Config } from "../config.js";
import type { CallbackRepo, ChatRepo, ChatRow, SettingsRepo } from "../db.js";
import { normalizeLocale, t, type Locale } from "../i18n.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { McpServerInfo, McpStatusName } from "../opencode/types.js";
import { sleep } from "../util.js";
import type { BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { describeOpenCodeError } from "./errors.js";
import { launchDetached, runToCompletion } from "./processControl.js";
import { answerCallback, createToken, safeCode, safeJson, safeText } from "./ui.js";

const START_TIMEOUT_MS = 30_000;

export interface ServerLifecycleControl {
  noteManualStart(): void;
  noteManualStop(): void;
}

export interface ServerControlOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly callbacks: CallbackRepo;
  readonly settings: SettingsRepo;
  readonly outbox: Outbox;
  readonly config: Config;
  readonly logger: Logger;
  readonly lifecycle?: ServerLifecycleControl;
}

export type McpCallback =
  | { readonly kind: "connect"; readonly token: string }
  | { readonly kind: "disconnect"; readonly token: string }
  | { readonly kind: "refresh" };

export function parseMcpCallback(data: string | undefined): McpCallback | null {
  if (!data || !data.startsWith("mcp:")) {
    return null;
  }
  const parts = data.split(":");
  const action = parts[1] ?? "";
  if (action === "r") {
    return { kind: "refresh" };
  }
  const token = parts[2] ?? "";
  if (!token) {
    return null;
  }
  if (action === "c") {
    return { kind: "connect", token };
  }
  if (action === "d") {
    return { kind: "disconnect", token };
  }
  return null;
}

export class ServerControl {
  private readonly options: ServerControlOptions;

  constructor(options: ServerControlOptions) {
    this.options = options;
  }

  async showMcps(chat: ChatRow, messageId?: number): Promise<void> {
    const locale = this.locale(chat.chat_id);
    const directory = chat.project_directory ?? this.options.config.opencode.projectDirectory;
    let servers: readonly McpServerInfo[];
    try {
      servers = await this.options.client.listMcpServers(directory);
    } catch (error) {
      await this.sendOrEdit(
        chat.chat_id,
        messageId,
        `⚠️ ${safeText(describeOpenCodeError(error), 220)}`,
      );
      return;
    }

    const lines = [t(locale, "mcp.title"), "", `\`${safeCode(directory)}\``, ""];
    if (servers.length === 0) {
      lines.push(t(locale, "mcp.empty"));
    }
    const rows: InlineKeyboardButton[][] = [];
    for (const server of servers) {
      lines.push(`${statusIcon(server.status.status)} *${safeText(server.name, 60)}* — ${this.statusLabel(locale, server.status.status)}`);
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "mcp",
        refId: server.name,
        payload: { server: server.name, directory },
      });
      const connected = server.status.status === "connected";
      rows.push([
        {
          text: truncateLabel(
            `${connected ? t(locale, "mcp.disconnect") : t(locale, "mcp.connect")} ${server.name}`,
          ),
          callback_data: `${connected ? "mcp:d" : "mcp:c"}:${token}`,
        },
      ]);
    }
    rows.push([{ text: t(locale, "common.refresh"), callback_data: "mcp:r" }]);
    if (servers.length > 0) {
      lines.push("", `_${t(locale, "mcp.experimental")}_`);
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
    const parsed = parseMcpCallback(input.data);
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
    const locale = this.locale(chat.chat_id);

    if (parsed.kind === "refresh") {
      await answerCallback(this.options.gateway, input.callbackQueryId, undefined, this.options.logger);
      await this.showMcps(chat, input.messageId);
      return;
    }

    const row = this.options.callbacks.consume(parsed.token);
    if (!row || row.chat_id !== input.chatId || row.kind !== "mcp" || row.expires_at < Date.now()) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        t(locale, "common.expired"),
        this.options.logger,
      );
      return;
    }
    const payload = safeJson(row.payload);
    const server = typeof payload?.server === "string" ? payload.server : row.ref_id;
    const directory =
      typeof payload?.directory === "string"
        ? payload.directory
        : chat.project_directory ?? this.options.config.opencode.projectDirectory;

    try {
      if (parsed.kind === "connect") {
        await this.options.client.connectMcp(server, directory);
        await answerCallback(
          this.options.gateway,
          input.callbackQueryId,
          t(locale, "mcp.connected_toast"),
          this.options.logger,
        );
      } else {
        await this.options.client.disconnectMcp(server, directory);
        await answerCallback(
          this.options.gateway,
          input.callbackQueryId,
          t(locale, "mcp.disconnected_toast"),
          this.options.logger,
        );
      }
    } catch (error) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        t(locale, "mcp.failed_toast", {
          error: safeText(describeOpenCodeError(error), 160),
        }),
        this.options.logger,
      );
    }
    await this.showMcps(chat, input.messageId);
  }

  async reload(chat: ChatRow): Promise<void> {
    const locale = this.locale(chat.chat_id);
    await this.reply(chat.chat_id, t(locale, "server.reload"));
    try {
      await this.options.client.reloadConfig();
      await this.reply(chat.chat_id, t(locale, "server.reload_done"));
    } catch (error) {
      await this.reply(
        chat.chat_id,
        t(locale, "server.reload_failed", {
          error: safeText(describeOpenCodeError(error), 220),
        }),
      );
    }
  }

  async start(chat: ChatRow): Promise<void> {
    const locale = this.locale(chat.chat_id);
    const command = this.options.config.opencode.startCommand;
    if (!command) {
      await this.reply(
        chat.chat_id,
        t(locale, "server.not_configured", { variable: "OPENCODE_START_COMMAND" }),
      );
      return;
    }

    await this.reply(chat.chat_id, t(locale, "server.start"));
    this.options.lifecycle?.noteManualStart();
    try {
      launchDetached(command, this.options.logger, "OpenCode start");
    } catch (error) {
      await this.reply(
        chat.chat_id,
        t(locale, "server.start_failed", { error: safeText(errorMessage(error), 220) }),
      );
      return;
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(1_000);
      try {
        await this.options.client.info();
        await this.reply(chat.chat_id, t(locale, "server.start_done"));
        return;
      } catch {
        // keep polling
      }
    }
    await this.reply(
      chat.chat_id,
      t(locale, "server.start_timeout", { seconds: Math.round(START_TIMEOUT_MS / 1_000) }),
    );
  }

  async stop(chat: ChatRow): Promise<void> {
    const locale = this.locale(chat.chat_id);
    const command = this.options.config.opencode.stopCommand;
    if (!command) {
      await this.reply(
        chat.chat_id,
        t(locale, "server.not_configured", { variable: "OPENCODE_STOP_COMMAND" }),
      );
      return;
    }

    await this.reply(chat.chat_id, t(locale, "server.stop"));
    this.options.lifecycle?.noteManualStop();
    try {
      await runToCompletion(command, this.options.logger, "OpenCode stop");
      await this.reply(chat.chat_id, t(locale, "server.stop_done"));
    } catch (error) {
      await this.reply(
        chat.chat_id,
        t(locale, "server.stop_failed", { error: safeText(errorMessage(error), 220) }),
      );
    }
  }

  private statusLabel(locale: Locale, status: McpStatusName): string {
    const key = `mcp.${status}` as const;
    return t(locale, key);
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
      this.options.logger.warn("Could not send the MCP panel", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send a server control reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}

function statusIcon(status: McpStatusName): string {
  switch (status) {
    case "connected":
      return "🟢";
    case "pending":
      return "🟡";
    case "disabled":
      return "⚪";
    case "needs_auth":
      return "🔐";
    case "failed":
      return "🔴";
    default:
      return "•";
  }
}

function truncateLabel(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 59)}…`;
}