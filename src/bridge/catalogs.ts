import type { InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type { Config } from "../config.js";
import type { CallbackRepo, ChatRepo, ChatRow } from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { OpenCodeCommandInfo, OpenCodeSkillInfo } from "../opencode/types.js";
import { transformInline } from "../renderer.js";
import { truncate } from "../util.js";
import type { BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { describeOpenCodeError } from "./errors.js";
import type { SessionService } from "./sessions.js";
import {
  answerCallback,
  createToken,
  finishMessage,
  safeCode,
  safeJson,
  safeText,
} from "./ui.js";

const MAX_BUTTONS = 20;

export interface CatalogManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly sessions: SessionService;
  readonly callbacks: CallbackRepo;
  readonly outbox: Outbox;
  readonly config: Config;
  readonly logger: Logger;
}

export type CatalogCallback =
  | { readonly kind: "command"; readonly token: string }
  | { readonly kind: "skill"; readonly token: string };

export function parseCatalogCallback(data: string | undefined): CatalogCallback | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 2) {
    return null;
  }
  const token = parts[1] ?? "";
  if (!token) {
    return null;
  }
  if (parts[0] === "c") {
    return { kind: "command", token };
  }
  if (parts[0] === "s") {
    return { kind: "skill", token };
  }
  return null;
}

export class CatalogManager {
  private readonly options: CatalogManagerOptions;

  constructor(options: CatalogManagerOptions) {
    this.options = options;
  }

  async showCommands(chat: ChatRow): Promise<void> {
    let commands: readonly OpenCodeCommandInfo[];
    try {
      commands = await this.options.client.listCommands(this.root(chat));
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not load commands: ${safeText(describeOpenCodeError(error), 200)}`,
      );
      return;
    }

    if (commands.length === 0) {
      await this.reply(chat.chat_id, "No commands are available in this project.");
      return;
    }

    const shown = commands.slice(0, MAX_BUTTONS);
    const rows: InlineKeyboardMarkup["inline_keyboard"] = shown.map((command) => {
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "cmd",
        refId: command.name,
        payload: { name: command.name },
      });
      return [
        {
          text: truncate(
            `▶️ /${command.name}${command.description ? ` — ${safeText(command.description, 30)}` : ""}`,
            60,
          ),
          callback_data: `c:${token}`,
        },
      ];
    });

    const lines = [
      "📚 *Commands*",
      "",
      "_Tap a command to run it without arguments._",
      "_Use `/run <name> <text>` to pass arguments._",
    ];
    if (commands.length > shown.length) {
      lines.push("", `_Showing ${shown.length} of ${commands.length}._`);
    }
    const descriptions = shown.filter((command) => command.description).slice(0, 8);
    if (descriptions.length > 0) {
      lines.push(
        "",
        ...descriptions.map(
          (command) => `• \`/${safeCode(command.name)}\` — ${safeText(command.description ?? "", 90)}`,
        ),
      );
    }

    await this.sendWithKeyboard(chat.chat_id, lines.join("\n"), { inline_keyboard: rows });
  }

  async showSkills(chat: ChatRow): Promise<void> {
    let skills: readonly OpenCodeSkillInfo[];
    try {
      skills = await this.options.client.listSkills(this.root(chat));
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not load skills: ${safeText(describeOpenCodeError(error), 200)}`,
      );
      return;
    }

    if (skills.length === 0) {
      await this.reply(chat.chat_id, "No skills are available in this project.");
      return;
    }

    const shown = skills.slice(0, MAX_BUTTONS);
    const rows: InlineKeyboardMarkup["inline_keyboard"] = shown.map((skill) => {
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "skill",
        refId: skill.id,
        payload: { id: skill.id },
      });
      return [
        {
          text: truncate(`🧩 ${skill.name || skill.id}`, 60),
          callback_data: `s:${token}`,
        },
      ];
    });

    const lines = [
      "🧩 *Skills*",
      "",
      "_Tap a skill to start a run that loads it._",
      "_Use `/skill <id> <text>` to give the skill a request._",
    ];
    if (skills.length > shown.length) {
      lines.push("", `_Showing ${shown.length} of ${skills.length}._`);
    }
    const descriptions = shown.filter((skill) => skill.description).slice(0, 8);
    if (descriptions.length > 0) {
      lines.push(
        "",
        ...descriptions.map(
          (skill) => `• *${safeText(skill.name || skill.id, 40)}* — ${safeText(skill.description ?? "", 90)}`,
        ),
      );
    }

    await this.sendWithKeyboard(chat.chat_id, lines.join("\n"), { inline_keyboard: rows });
  }

  async runCommand(chat: ChatRow, name: string, text: string): Promise<void> {
    const trimmedName = name.trim().replace(/^\//, "");
    if (!trimmedName) {
      await this.reply(chat.chat_id, "Usage: /run <command> [text]");
      return;
    }
    try {
      const current = this.options.chats.get(chat.chat_id) ?? chat;
      const session = await this.options.sessions.ensureSession(current);
      await this.options.client.runCommand(session.id, {
        name: trimmedName,
        text: text.trim(),
        delivery: this.delivery(current),
      });
      await this.reply(
        chat.chat_id,
        `▶️ *Started* \`/${safeCode(trimmedName)}\`\n\n_The run will stream here._`,
      );
      this.options.logger.info("Command started", {
        chatId: chat.chat_id,
        sessionId: session.id,
        command: trimmedName,
      });
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not run \`/${safeCode(trimmedName)}\`: ${safeText(describeOpenCodeError(error), 220)}`,
      );
    }
  }

  async runSkill(chat: ChatRow, id: string, text: string): Promise<void> {
    const skillId = id.trim();
    if (!skillId) {
      await this.reply(chat.chat_id, "Usage: /skill <id> [text]");
      return;
    }
    try {
      const current = this.options.chats.get(chat.chat_id) ?? chat;
      const skills = await this.options.client.listSkills(this.root(current));
      const skill = skills.find(
        (candidate) => candidate.id === skillId || candidate.name === skillId,
      );
      if (!skill) {
        await this.reply(
          chat.chat_id,
          `⚠️ No skill matches \`${safeCode(skillId)}\`. Use /skills to see the list.`,
        );
        return;
      }
      const session = await this.options.sessions.ensureSession(current);
      const promptText =
        text.trim() || `Use the ${skill.name || skill.id} skill to help with the current task.`;
      await this.options.client.prompt(session.id, {
        text: promptText,
        skills: [{ id: skill.id }],
        delivery: this.delivery(current),
      });
      await this.reply(
        chat.chat_id,
        `🧩 *Using skill* ${transformInline(skill.name || skill.id)}\n\n_The run will stream here._`,
      );
      this.options.logger.info("Skill run started", {
        chatId: chat.chat_id,
        sessionId: session.id,
        skill: skill.id,
      });
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not start the skill: ${safeText(describeOpenCodeError(error), 220)}`,
      );
    }
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseCatalogCallback(input.data);
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
    if (!row || row.chat_id !== input.chatId || row.expires_at < Date.now()) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This menu has expired.",
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

    const payload = safeJson(row.payload);
    if (parsed.kind === "command") {
      if (row.kind !== "cmd") {
        await answerCallback(
          this.options.gateway,
          input.callbackQueryId,
          "This command is no longer valid.",
          this.options.logger,
        );
        return;
      }
      const name = typeof payload?.name === "string" ? payload.name : row.ref_id;
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        `Running /${name}…`,
        this.options.logger,
      );
      await finishMessage(
        this.options.outbox,
        input.chatId,
        input.messageId,
        `▶️ *Started* \`/${safeCode(name)}\`\n\n_The run will stream here._`,
        this.options.logger,
      );
      await this.runCommand(chat, name, "");
      return;
    }

    if (row.kind !== "skill") {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This skill is no longer valid.",
        this.options.logger,
      );
      return;
    }
    const id = typeof payload?.id === "string" ? payload.id : row.ref_id;
    await answerCallback(
      this.options.gateway,
      input.callbackQueryId,
      "Starting the skill…",
      this.options.logger,
    );
    await finishMessage(
      this.options.outbox,
      input.chatId,
      input.messageId,
      `🧩 *Using skill* ${transformInline(id)}\n\n_The run will stream here._`,
      this.options.logger,
    );
    await this.runSkill(chat, id, "");
  }

  private root(chat: ChatRow): string {
    return chat.project_directory ?? this.options.config.opencode.projectDirectory;
  }

  private delivery(chat: ChatRow): "queue" | "steer" {
    return chat.delivery === "steer" ? "steer" : "queue";
  }

  private async sendWithKeyboard(
    chatId: string,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text, { replyMarkup });
    } catch (error) {
      this.options.logger.warn("Could not send catalog menu", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send catalog reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}