import { randomBytes } from "node:crypto";

import type { InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type { CallbackRepo, ChatRepo, ChatRow } from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { OpenCodeAgentInfo, OpenCodeModelInfo } from "../opencode/types.js";
import { transformInline } from "../renderer.js";
import { truncate } from "../util.js";
import { isMessageNotFound, isMessageNotModified, type BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { describeOpenCodeError } from "./errors.js";
import type { SessionService } from "./sessions.js";

const MENU_TTL_MS = 15 * 60 * 1_000;
const MAX_MODELS = 20;

export interface MenuManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly sessions: SessionService;
  readonly callbacks: CallbackRepo;
  readonly outbox: Outbox;
  readonly defaultModel: { readonly providerID: string; readonly id: string };
  readonly logger: Logger;
}

export type MenuCallback =
  | { readonly kind: "model"; readonly token: string }
  | { readonly kind: "agent"; readonly token: string }
  | { readonly kind: "follow"; readonly token: string; readonly follow: boolean };

export function parseMenuCallback(data: string | undefined): MenuCallback | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  const prefix = parts[0];
  const token = parts[1] ?? "";
  if (!token) {
    return null;
  }
  if (prefix === "m") {
    return { kind: "model", token };
  }
  if (prefix === "a") {
    return { kind: "agent", token };
  }
  if (prefix === "fo") {
    const action = parts[2];
    if (action !== "y" && action !== "n") {
      return null;
    }
    return { kind: "follow", token, follow: action === "y" };
  }
  return null;
}

export class MenuManager {
  private readonly options: MenuManagerOptions;

  constructor(options: MenuManagerOptions) {
    this.options = options;
  }

  async showModels(chat: ChatRow): Promise<void> {
    const { client, chats, callbacks, outbox, logger } = this.options;
    let models: readonly OpenCodeModelInfo[];
    try {
      models = await client.listModels();
    } catch (error) {
      await this.reply(chat.chat_id, `⚠️ Could not load models: ${safe(describeOpenCodeError(error))}`);
      return;
    }

    const usable = models
      .filter((model) => model.enabled && (model.type === undefined || model.type === "chat"))
      .sort((a, b) =>
        a.providerID === b.providerID
          ? a.name.localeCompare(b.name)
          : a.providerID.localeCompare(b.providerID),
      );

    if (usable.length === 0) {
      await this.reply(chat.chat_id, "No chat models are enabled.");
      return;
    }

    const current = currentModel(chats.get(chat.chat_id) ?? chat, this.options.defaultModel);
    const shown = usable.slice(0, MAX_MODELS);
    const keyboard: InlineKeyboardMarkup["inline_keyboard"] = shown.map((model) => {
      const token = randomBytes(9).toString("base64url");
      callbacks.create({
        token,
        chat_id: chat.chat_id,
        kind: "model",
        ref_id: `${model.providerID}/${model.modelID}`,
        payload: JSON.stringify({ providerID: model.providerID, id: model.modelID }),
        expires_at: Date.now() + MENU_TTL_MS,
      });
      const selected =
        model.providerID === current.providerID && model.modelID === current.id ? "✅ " : "";
      return [
        {
          text: truncate(`${selected}${model.providerID} / ${model.name}`, 60),
          callback_data: `m:${token}`,
        },
      ];
    });

    const lines = [
      "🤖 *Models*",
      "",
      `Current: \`${safeCode(current.providerID)}/${safeCode(current.id)}\``,
      "",
      "_Tap a model to use it for this chat. The active session follows immediately._",
    ];
    if (usable.length > shown.length) {
      lines.push(
        "",
        `_Showing ${shown.length} of ${usable.length}. Use \`/model provider/model\` for the rest._`,
      );
    }

    try {
      await outbox.forChat(chat.chat_id).send(lines.join("\n"), {
        replyMarkup: { inline_keyboard: keyboard },
      });
    } catch (error) {
      logger.warn("Could not send model menu", {
        chatId: chat.chat_id,
        error: errorMessage(error),
      });
    }
  }

  async showAgents(chat: ChatRow): Promise<void> {
    const { client, chats, callbacks, outbox, logger } = this.options;
    let agents: readonly OpenCodeAgentInfo[];
    try {
      agents = await client.listAgents();
    } catch (error) {
      await this.reply(chat.chat_id, `⚠️ Could not load agents: ${safe(describeOpenCodeError(error))}`);
      return;
    }

    const usable = agents
      .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
      .sort((a, b) => a.name.localeCompare(b.name));

    if (usable.length === 0) {
      await this.reply(chat.chat_id, "No primary agents are available.");
      return;
    }

    const current = (chats.get(chat.chat_id) ?? chat).agent ?? "build";
    const keyboard: InlineKeyboardMarkup["inline_keyboard"] = usable.map((agent) => {
      const token = randomBytes(9).toString("base64url");
      callbacks.create({
        token,
        chat_id: chat.chat_id,
        kind: "agent",
        ref_id: agent.id,
        payload: JSON.stringify({ agent: agent.id }),
        expires_at: Date.now() + MENU_TTL_MS,
      });
      return [
        {
          text: truncate(`${agent.id === current ? "✅ " : ""}${agent.name}`, 60),
          callback_data: `a:${token}`,
        },
      ];
    });

    const lines = [
      "🧭 *Agents*",
      "",
      `Current: ${transformInline(current)}`,
      "",
      "_Tap an agent to use it for this chat. The active session follows immediately._",
    ];
    if (usable.some((agent) => agent.description)) {
      lines.push("", ...usable.slice(0, 4).map((agent) => `• *${safe(agent.name)}* — ${safe(agent.description ?? "")}`));
    }

    try {
      await outbox.forChat(chat.chat_id).send(lines.join("\n"), {
        replyMarkup: { inline_keyboard: keyboard },
      });
    } catch (error) {
      logger.warn("Could not send agent menu", {
        chatId: chat.chat_id,
        error: errorMessage(error),
      });
    }
  }

  async applyModel(chat: ChatRow, providerID: string, id: string): Promise<void> {
    const { client, chats } = this.options;
    const current = chats.get(chat.chat_id) ?? chat;
    if (current.active_session_id) {
      await client.switchModel(current.active_session_id, { providerID, id });
    }
    chats.update(chat.chat_id, { modelProvider: providerID, modelId: id });
    this.options.logger.info("Model selected", {
      chatId: chat.chat_id,
      sessionId: current.active_session_id,
      model: `${providerID}/${id}`,
    });
  }

  async applyAgent(chat: ChatRow, agent: string): Promise<void> {
    const { client, chats } = this.options;
    const current = chats.get(chat.chat_id) ?? chat;
    if (current.active_session_id) {
      await client.switchAgent(current.active_session_id, agent);
    }
    chats.update(chat.chat_id, { agent });
    this.options.logger.info("Agent selected", {
      chatId: chat.chat_id,
      sessionId: current.active_session_id,
      agent,
    });
  }

  async notifySessionCreated(
    chat: ChatRow,
    session: { id: string; title: string; directory?: string },
  ): Promise<void> {
    const { callbacks, outbox, logger } = this.options;
    const token = randomBytes(9).toString("base64url");
    callbacks.create({
      token,
      chat_id: chat.chat_id,
      kind: "follow",
      ref_id: session.id,
      payload: JSON.stringify({ sessionID: session.id }),
      expires_at: Date.now() + MENU_TTL_MS,
    });

    const lines = [
      "🆕 *Session started in OpenCode*",
      "",
      `*${escapeBold(session.title || "(untitled)")}*`,
      `\`${safeCode(session.id)}\``,
    ];
    if (session.directory) {
      lines.push(`_${safeCode(session.directory)}_`);
    }
    lines.push("", "Follow it from Bale?");

    try {
      await outbox.forChat(chat.chat_id).send(lines.join("\n"), {
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "▶️ Follow", callback_data: `fo:${token}:y` },
              { text: "✖️ Dismiss", callback_data: `fo:${token}:n` },
            ],
          ],
        },
      });
    } catch (error) {
      callbacks.deleteByRef(chat.chat_id, "follow", session.id);
      logger.warn("Could not send session notice", {
        chatId: chat.chat_id,
        sessionId: session.id,
        error: errorMessage(error),
      });
    }
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseMenuCallback(input.data);
    if (!parsed) {
      await this.answer(input.callbackQueryId, "This button is no longer valid.");
      return;
    }

    const { callbacks, outbox, logger } = this.options;
    const row = callbacks.get(parsed.token);
    if (!row || row.chat_id !== input.chatId || row.expires_at < Date.now()) {
      await this.answer(input.callbackQueryId, "This menu has expired.");
      return;
    }

    if (parsed.kind === "model") {
      if (row.kind !== "model") {
        await this.answer(input.callbackQueryId, "This menu is no longer valid.");
        return;
      }
      const payload = safeJson(row.payload);
      const providerID = typeof payload?.providerID === "string" ? payload.providerID : null;
      const id = typeof payload?.id === "string" ? payload.id : null;
      if (!providerID || !id) {
        await this.answer(input.callbackQueryId, "That model is no longer valid.");
        return;
      }
      callbacks.consume(parsed.token);
      await this.answer(input.callbackQueryId, "Switching model…");
      try {
        const chat = this.options.chats.get(input.chatId);
        if (!chat) {
          return;
        }
        await this.applyModel(chat, providerID, id);
        await this.finishMessage(input.chatId, input.messageId, `✅ *Model set*\n\n\`${safeCode(providerID)}/${safeCode(id)}\``);
      } catch (error) {
        logger.warn("Model switch failed", {
          chatId: input.chatId,
          model: `${providerID}/${id}`,
          error: errorMessage(error),
        });
        await this.finishMessage(
          input.chatId,
          input.messageId,
          `⚠️ Could not switch model: ${safe(describeOpenCodeError(error))}`,
        );
      }
      return;
    }

    if (parsed.kind === "agent") {
      if (row.kind !== "agent") {
        await this.answer(input.callbackQueryId, "This menu is no longer valid.");
        return;
      }
      const payload = safeJson(row.payload);
      const agent = typeof payload?.agent === "string" ? payload.agent : null;
      if (!agent) {
        await this.answer(input.callbackQueryId, "That agent is no longer valid.");
        return;
      }
      callbacks.consume(parsed.token);
      await this.answer(input.callbackQueryId, "Switching agent…");
      try {
        const chat = this.options.chats.get(input.chatId);
        if (!chat) {
          return;
        }
        await this.applyAgent(chat, agent);
        await this.finishMessage(input.chatId, input.messageId, `✅ *Agent set*\n\n${transformInline(agent)}`);
      } catch (error) {
        logger.warn("Agent switch failed", {
          chatId: input.chatId,
          agent,
          error: errorMessage(error),
        });
        await this.finishMessage(
          input.chatId,
          input.messageId,
          `⚠️ Could not switch agent: ${safe(describeOpenCodeError(error))}`,
        );
      }
      return;
    }

    // Follow / dismiss a session started elsewhere.
    if (row.kind !== "follow") {
      await this.answer(input.callbackQueryId, "This notice is no longer valid.");
      return;
    }
    const payload = safeJson(row.payload);
    const sessionID = typeof payload?.sessionID === "string" ? payload.sessionID : null;
    if (!sessionID) {
      await this.answer(input.callbackQueryId, "That session is no longer valid.");
      return;
    }

    if (!parsed.follow) {
      callbacks.consume(parsed.token);
      await this.answer(input.callbackQueryId, "Dismissed.");
      await this.finishMessage(input.chatId, input.messageId, "✖️ _Session notice dismissed._");
      return;
    }

    await this.answer(input.callbackQueryId, "Following…");
    try {
      const chat = this.options.chats.get(input.chatId);
      if (!chat) {
        return;
      }
      const session = await this.options.sessions.attach(chat, sessionID);
      callbacks.consume(parsed.token);
      await this.finishMessage(
        input.chatId,
        input.messageId,
        `▶️ *Following*\n\n*${escapeBold(session.title || "(untitled)")}*\n\`${safeCode(session.id)}\``,
      );
    } catch (error) {
      logger.warn("Follow session failed", {
        chatId: input.chatId,
        sessionId: sessionID,
        error: errorMessage(error),
      });
      await this.finishMessage(
        input.chatId,
        input.messageId,
        `⚠️ Could not follow that session: ${safe(describeOpenCodeError(error))}`,
      );
    }
  }

  private async finishMessage(
    chatId: string,
    messageId: number | undefined,
    text: string,
  ): Promise<void> {
    if (messageId === undefined) {
      return;
    }
    const chat = this.options.outbox.forChat(chatId);
    try {
      await chat.editNow(messageId, text);
      await chat.editMarkup(messageId, null);
    } catch (error) {
      if (!isMessageNotFound(error) && !isMessageNotModified(error)) {
        this.options.logger.debug("Could not edit menu message", {
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
      this.options.logger.warn("Could not send menu reply", {
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
      this.options.logger.debug("answerCallbackQuery failed", {
        callbackQueryId,
        error: errorMessage(error),
      });
    }
  }
}

function currentModel(
  chat: ChatRow,
  fallback: { readonly providerID: string; readonly id: string },
): { providerID: string; id: string } {
  return chat.model_provider && chat.model_id
    ? { providerID: chat.model_provider, id: chat.model_id }
    : fallback;
}

function safe(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), 240);
}

function safeCode(value: string): string {
  return value.replace(/`/g, "′");
}

function escapeBold(value: string): string {
  return value.replace(/\*/g, "′").replace(/\n+/g, " ").trim();
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

export function formatMenuError(error: unknown): string {
  return isMessageNotFound(error) || isMessageNotModified(error)
    ? "The message no longer exists."
    : errorMessage(error);
}