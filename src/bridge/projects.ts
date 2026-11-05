import { stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import type { InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type { Config } from "../config.js";
import type { CallbackRepo, ChatRepo, ChatRow } from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { ProjectInfo, WorktreeInfo } from "../opencode/types.js";
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

const MAX_PROJECTS = 20;
const MAX_WORKTREES = 20;

export interface ProjectManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly sessions: SessionService;
  readonly callbacks: CallbackRepo;
  readonly outbox: Outbox;
  readonly config: Config;
  readonly logger: Logger;
}

export type ProjectCallback =
  | { readonly kind: "project"; readonly token: string }
  | { readonly kind: "worktreeUse"; readonly token: string }
  | { readonly kind: "worktreeRemove"; readonly token: string };

export function parseProjectCallback(data: string | undefined): ProjectCallback | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts[0] === "p" && parts.length === 2) {
    const token = parts[1] ?? "";
    return token ? { kind: "project", token } : null;
  }
  if (parts[0] !== "wt" || parts.length !== 3) {
    return null;
  }
  const token = parts[2] ?? "";
  if (!token) {
    return null;
  }
  if (parts[1] === "u") {
    return { kind: "worktreeUse", token };
  }
  if (parts[1] === "x") {
    return { kind: "worktreeRemove", token };
  }
  return null;
}

export class ProjectManager {
  private readonly options: ProjectManagerOptions;
  private readonly recentProjects = new Map<string, readonly ProjectInfo[]>();
  private readonly recentWorktrees = new Map<string, readonly WorktreeInfo[]>();

  constructor(options: ProjectManagerOptions) {
    this.options = options;
  }

  async showProjects(chat: ChatRow): Promise<void> {
    let projects: readonly ProjectInfo[];
    try {
      projects = await this.options.client.listProjects();
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not load projects: ${safeText(describeOpenCodeError(error), 200)}`,
      );
      return;
    }

    if (projects.length === 0) {
      await this.reply(chat.chat_id, "No OpenCode projects found.");
      return;
    }

    const current = this.root(chat);
    const shown = projects.slice(0, MAX_PROJECTS);
    this.recentProjects.set(chat.chat_id, shown);
    const rows: InlineKeyboardMarkup["inline_keyboard"] = shown.map((project) => {
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "project",
        refId: project.canonical,
        payload: { directory: project.canonical },
      });
      const selected = project.canonical === current ? "✅ " : "";
      return [
        {
          text: truncate(`${selected}📁 ${project.name || basename(project.canonical)}`, 60),
          callback_data: `p:${token}`,
        },
      ];
    });

    const lines = [
      "📁 *Projects*",
      "",
      `Current: \`${safeCode(current)}\``,
      "",
      "_Tap a project to use it. The active session moves when possible._",
    ];
    if (projects.length > shown.length) {
      lines.push("", `_Showing ${shown.length} of ${projects.length}._`);
    }

    await this.sendWithKeyboard(chat.chat_id, lines.join("\n"), { inline_keyboard: rows });
  }

  async switchProject(chat: ChatRow, directory: string, messageId?: number): Promise<void> {
    const target = resolve(expandHome(directory.trim()));
    if (!target) {
      await this.reply(chat.chat_id, "Usage: /project <path>");
      return;
    }
    if (!(await isDirectory(target))) {
      const text = `⚠️ \`${safeCode(target)}\` is not an existing directory.`;
      if (messageId !== undefined) {
        await finishMessage(this.options.outbox, chat.chat_id, messageId, text, this.options.logger);
      } else {
        await this.reply(chat.chat_id, text);
      }
      return;
    }

    const current = this.options.chats.get(chat.chat_id) ?? chat;
    if (current.active_session_id) {
      try {
        await this.options.client.moveSession(current.active_session_id, target);
      } catch (error) {
        const text = `⚠️ Could not move the active session: ${safeText(describeOpenCodeError(error), 220)}`;
        if (messageId !== undefined) {
          await finishMessage(this.options.outbox, chat.chat_id, messageId, text, this.options.logger);
        } else {
          await this.reply(chat.chat_id, text);
        }
        return;
      }
    }

    this.options.chats.update(chat.chat_id, { projectDirectory: target });
    const text = `✅ *Project set*\n\n\`${safeCode(target)}\`\n\n${
      current.active_session_id ? "_The active session moved with it._" : "_Send a message or use /new to start a session._"
    }`;
    if (messageId !== undefined) {
      await finishMessage(this.options.outbox, chat.chat_id, messageId, text, this.options.logger);
    } else {
      await this.reply(chat.chat_id, text);
    }
    this.options.logger.info("Project switched", {
      chatId: chat.chat_id,
      directory: target,
      sessionId: current.active_session_id,
    });
  }

  async selectProject(chat: ChatRow, argument?: string): Promise<void> {
    if (!argument) {
      await this.showProjects(chat);
      return;
    }
    if (/^\d+$/.test(argument)) {
      let projects = this.recentProjects.get(chat.chat_id);
      if (!projects) {
        projects = await this.options.client.listProjects().catch(() => []);
        this.recentProjects.set(chat.chat_id, projects);
      }
      const project = projects[Number(argument) - 1];
      if (!project) {
        await this.reply(chat.chat_id, "That project number is out of range. Use /projects.");
        return;
      }
      await this.switchProject(chat, project.canonical);
      return;
    }
    await this.switchProject(chat, argument);
  }

  async showWorktrees(chat: ChatRow): Promise<void> {
    const project = await this.currentProject(chat);
    if (!project) {
      await this.reply(chat.chat_id, "Could not find the OpenCode project for this directory.");
      return;
    }
    let worktrees: readonly WorktreeInfo[];
    try {
      worktrees = await this.options.client.listWorktrees(project.id);
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not list worktrees: ${safeText(describeOpenCodeError(error), 200)}`,
      );
      return;
    }

    this.recentWorktrees.set(chat.chat_id, worktrees);
    if (worktrees.length === 0) {
      await this.reply(
        chat.chat_id,
        `🌳 *Worktrees*\n\n_None yet. Use \`/worktree new [name]\` to create one._`,
      );
      return;
    }

    const current = this.root(chat);
    const shown = worktrees.slice(0, MAX_WORKTREES);
    const rows: InlineKeyboardMarkup["inline_keyboard"] = shown.map((worktree) => {
      const token = createToken(this.options.callbacks, {
        chatId: chat.chat_id,
        kind: "worktree",
        refId: worktree.directory,
        payload: { directory: worktree.directory },
      });
      const selected = worktree.directory === current ? "✅ " : "";
      return [
        {
          text: truncate(`${selected}🌳 ${basename(worktree.directory)}`, 40),
          callback_data: `wt:u:${token}`,
        },
        {
          text: "🗑️",
          callback_data: `wt:x:${token}`,
        },
      ];
    });

    const lines = [
      "🌳 *Worktrees*",
      "",
      `Project: \`${safeCode(project.canonical)}\``,
      `Current: \`${safeCode(current)}\``,
      "",
      "_Tap a worktree to switch, or 🗑️ to remove it._",
    ];
    await this.sendWithKeyboard(chat.chat_id, lines.join("\n"), { inline_keyboard: rows });
  }

  async worktreeCommand(chat: ChatRow, args: readonly string[]): Promise<void> {
    const action = (args[0] ?? "list").toLowerCase();
    const rest = args.slice(1);
    if (action === "list" || action === "ls") {
      await this.showWorktrees(chat);
      return;
    }
    if (action === "new" || action === "create") {
      await this.createWorktree(chat, rest.join(" ").trim());
      return;
    }
    if (action === "use" || action === "switch") {
      await this.useWorktree(chat, rest[0]);
      return;
    }
    if (action === "remove" || action === "rm" || action === "delete") {
      const force = rest.includes("force");
      await this.removeWorktree(chat, rest.filter((value) => value !== "force")[0], force);
      return;
    }
    await this.reply(
      chat.chat_id,
      "Usage: `/worktree [list]`, `/worktree new [name]`, `/worktree use <name>`, `/worktree remove <name>`.",
    );
  }

  async createWorktree(chat: ChatRow, name: string): Promise<void> {
    const project = await this.currentProject(chat);
    if (!project) {
      await this.reply(chat.chat_id, "Could not find the OpenCode project for this directory.");
      return;
    }
    try {
      const worktree = await this.options.client.createWorktree({
        projectID: project.id,
        ...(name ? { name } : {}),
      });
      await this.switchProject(chat, worktree.directory);
      this.options.logger.info("Worktree created", {
        chatId: chat.chat_id,
        projectId: project.id,
        directory: worktree.directory,
      });
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not create the worktree: ${safeText(describeOpenCodeError(error), 220)}`,
      );
    }
  }

  async useWorktree(chat: ChatRow, argument?: string): Promise<void> {
    if (!argument) {
      await this.showWorktrees(chat);
      return;
    }
    const project = await this.currentProject(chat);
    if (!project) {
      await this.reply(chat.chat_id, "Could not find the OpenCode project for this directory.");
      return;
    }
    let worktrees = this.recentWorktrees.get(chat.chat_id);
    if (!worktrees) {
      worktrees = await this.options.client.listWorktrees(project.id).catch(() => []);
      this.recentWorktrees.set(chat.chat_id, worktrees);
    }

    const target = /^\d+$/.test(argument)
      ? worktrees[Number(argument) - 1]
      : findWorktree(worktrees, argument);
    if (!target) {
      await this.reply(chat.chat_id, `⚠️ No worktree matches \`${safeCode(argument)}\`.`);
      return;
    }
    await this.switchProject(chat, target.directory);
  }

  async removeWorktree(chat: ChatRow, argument?: string, force = false): Promise<void> {
    if (!argument) {
      await this.showWorktrees(chat);
      return;
    }
    const project = await this.currentProject(chat);
    if (!project) {
      await this.reply(chat.chat_id, "Could not find the OpenCode project for this directory.");
      return;
    }
    const worktrees = await this.options.client.listWorktrees(project.id).catch(() => []);
    const target = /^\d+$/.test(argument)
      ? worktrees[Number(argument) - 1]
      : findWorktree(worktrees, argument);
    if (!target) {
      await this.reply(chat.chat_id, `⚠️ No worktree matches \`${safeCode(argument)}\`.`);
      return;
    }

    const current = this.root(chat);
    if (current === target.directory || current.startsWith(`${target.directory}${sep}`)) {
      await this.reply(
        chat.chat_id,
        "⚠️ This worktree is in use. Switch to another project first with `/project` or `/worktree use`.",
      );
      return;
    }

    try {
      await this.options.client.removeWorktree({
        projectID: project.id,
        directory: target.directory,
        force,
      });
      this.recentWorktrees.delete(chat.chat_id);
      await this.reply(
        chat.chat_id,
        `🗑️ *Worktree removed*\n\n\`${safeCode(target.directory)}\``,
      );
      this.options.logger.info("Worktree removed", {
        chatId: chat.chat_id,
        projectId: project.id,
        directory: target.directory,
        force,
      });
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not remove the worktree: ${safeText(describeOpenCodeError(error), 220)}`,
      );
    }
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseProjectCallback(input.data);
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
    const directory = typeof payload?.directory === "string" ? payload.directory : row.ref_id;

    if (parsed.kind === "project" || parsed.kind === "worktreeUse") {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Switching…",
        this.options.logger,
      );
      await this.switchProject(chat, directory, input.messageId);
      return;
    }

    await answerCallback(
      this.options.gateway,
      input.callbackQueryId,
      "Removing…",
      this.options.logger,
    );
    await this.removeWorktree(chat, directory);
    if (input.messageId !== undefined) {
      await finishMessage(
        this.options.outbox,
        input.chatId,
        input.messageId,
        `🗑️ *Removing worktree*\n\n\`${safeCode(directory)}\``,
        this.options.logger,
      );
    }
  }

  private async currentProject(chat: ChatRow): Promise<ProjectInfo | null> {
    const directory = this.root(chat);
    let projects: readonly ProjectInfo[];
    try {
      projects = await this.options.client.listProjects();
    } catch (error) {
      this.options.logger.debug("Could not list projects", { error: errorMessage(error) });
      return null;
    }

    const exact = projects.find((project) => project.canonical === directory);
    if (exact) {
      return exact;
    }
    const prefix = projects
      .filter((project) => directory.startsWith(`${project.canonical}${sep}`))
      .sort((a, b) => b.canonical.length - a.canonical.length);
    if (prefix[0]) {
      return prefix[0];
    }

    for (const project of projects) {
      const worktrees = await this.options.client.listWorktrees(project.id).catch(() => []);
      if (
        worktrees.some(
          (worktree) =>
            worktree.directory === directory ||
            directory.startsWith(`${worktree.directory}${sep}`),
        )
      ) {
        return project;
      }
    }
    return null;
  }

  private root(chat: ChatRow): string {
    return chat.project_directory ?? this.options.config.opencode.projectDirectory;
  }

  private async sendWithKeyboard(
    chatId: string,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text, { replyMarkup });
    } catch (error) {
      this.options.logger.warn("Could not send project menu", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send project reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}

function findWorktree(
  worktrees: readonly WorktreeInfo[],
  argument: string,
): WorktreeInfo | undefined {
  const target = argument.replace(/\/+$/, "");
  return (
    worktrees.find((worktree) => worktree.directory.replace(/\/+$/, "") === target) ??
    worktrees.find((worktree) => basename(worktree.directory) === target) ??
    worktrees.find((worktree) => worktree.directory.endsWith(target))
  );
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? `${process.env.HOME ?? ""}/${path.slice(2)}` : path;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}