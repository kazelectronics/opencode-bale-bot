import type { Config } from "../config.js";
import type { ChatRepo, ChatRow, SettingsRepo } from "../db.js";
import { normalizeLocale, t, type Locale } from "../i18n.js";
import type { HealthState } from "../health.js";
import { errorMessage, type Logger } from "../logger.js";
import { OpenCodeError, type OpenCodeClient } from "../opencode/client.js";
import type { OpenCodeSession } from "../opencode/types.js";
import { transformInline } from "../renderer.js";
import { formatDuration, formatRelative, truncate } from "../util.js";
import type { Outbox } from "../bale/outbox.js";
import type { CatalogManager } from "./catalogs.js";
import type { FileBrowser } from "./files.js";
import type { FormManager } from "./forms.js";
import type { InteractionManager } from "./interactions.js";
import type { HistoryManager } from "./history.js";
import type { MenuManager } from "./menus.js";
import type { ProjectManager } from "./projects.js";
import type { SessionService } from "./sessions.js";
import type { WatchManager } from "./watches.js";
import type { SettingsManager } from "./settings.js";
import type { DashboardManager } from "./dashboard.js";
import type { DirectoryBrowser } from "./directoryBrowser.js";
import { isDirectoryArgument } from "./directoryBrowser.js";
import type { ServerControl } from "./serverControl.js";
import type { TaskManager } from "./tasks.js";

export interface CommandHandlerOptions {
  readonly client: OpenCodeClient;
  readonly chats: ChatRepo;
  readonly sessions: SessionService;
  readonly forms: FormManager;
  readonly interactions: InteractionManager;
  readonly menus: MenuManager;
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
  readonly settings: SettingsRepo;
  readonly outbox: Outbox;
  readonly health: HealthState;
  readonly config: Config;
  readonly logger: Logger;
}

export class CommandHandler {
  private readonly options: CommandHandlerOptions;
  private readonly lastSessions = new Map<string, string[]>();

  constructor(options: CommandHandlerOptions) {
    this.options = options;
  }

  async handle(chat: ChatRow, raw: string): Promise<void> {
    const tokens = raw.trim().split(/\s+/);
    const head = tokens[0] ?? "";
    const command = head.replace(/^\//, "").split("@")[0]?.toLowerCase() ?? "";
    const args = tokens.slice(1);

    switch (command) {
      case "start":
      case "help":
        await this.reply(chat.chat_id, helpText(this.locale(chat.chat_id)));
        return;
      case "id":
        await this.reply(
          chat.chat_id,
          `*Your Bale IDs*\n\nUser: \`${chat.user_id}\`\nChat: \`${chat.chat_id}\``,
        );
        return;
      case "status":
        await this.status(chat);
        return;
      case "new":
        await this.newSession(chat, args.join(" ").trim());
        return;
      case "sessions":
        await this.listSessions(chat);
        return;
      case "switch":
        await this.switchSession(chat, args[0]);
        return;
      case "abort":
        await this.abort(chat);
        return;
      case "model":
        await this.model(chat, args.join(" ").trim());
        return;
      case "agent":
        await this.agent(chat, args.join(" ").trim());
        return;
      case "compact":
        await this.compact(chat);
        return;
      case "follow":
        await this.follow(chat, args[0]);
        return;
      case "cancelform":
        await this.cancelForm(chat);
        return;
      case "commands":
        await this.options.catalogs.showCommands(chat);
        return;
      case "run":
      case "command":
        await this.options.catalogs.runCommand(chat, args[0] ?? "", args.slice(1).join(" "));
        return;
      case "skills":
        await this.options.catalogs.showSkills(chat);
        return;
      case "skill":
        await this.options.catalogs.runSkill(chat, args[0] ?? "", args.slice(1).join(" "));
        return;
      case "ls":
      case "files":
        await this.options.files.showDirectory(chat, args.join(" ") || ".");
        return;
      case "find":
        await this.options.files.find(chat, args.join(" "));
        return;
      case "show":
      case "cat":
        await this.options.files.showFile(chat, args.join(" "));
        return;
      case "diff":
        await this.options.files.showDiff(chat);
        return;
      case "messages":
      case "history":
        await this.options.history.showMessages(chat, args[0]);
        return;
      case "revert":
        await this.options.history.revert(chat, args[0]);
        return;
      case "fork":
        await this.options.history.fork(chat, args[0]);
        return;
      case "projects":
        await this.options.projects.showProjects(chat);
        return;
      case "project":
        await this.options.projects.selectProject(chat, args.join(" ").trim() || undefined);
        return;
      case "worktree":
      case "worktrees":
        await this.options.projects.worktreeCommand(chat, args);
        return;
      case "watch":
        await this.options.watches.watchCommand(chat, args[0]);
        return;
      case "unwatch":
        await this.options.watches.unwatchCommand(chat, args[0]);
        return;
      case "watching":
        await this.options.watches.showWatching(chat);
        return;
      case "open":
        if (!args[0]) {
          await this.options.directoryBrowser.start(chat);
          return;
        } else if (await isDirectoryArgument(args.join(" "))) {
          await this.options.projects.switchProject(chat, args.join(" "));
          return;
        }
        await this.options.watches.openSession(chat, args[0]);
        return;
      case "attach":
        if (!args[0]) {
          await this.options.directoryBrowser.start(chat);
          return;
        }
        await this.options.watches.openSession(chat, args[0]);
        return;
      case "recent":
        await this.options.watches.showRecent(chat);
        return;
      case "settings":
        await this.options.settingsManager.show(chat);
        return;
      case "language":
        await this.options.settingsManager.language(chat, args[0]);
        return;
      case "context":
        await this.options.dashboard.showContext(chat);
        return;
      case "queue":
        await this.options.interactions.showQueue(chat);
        return;
      case "mcps":
        await this.options.serverControl.showMcps(chat);
        return;
      case "reload":
        await this.options.serverControl.reload(chat);
        return;
      case "opencode_start":
      case "opencode-start":
        await this.options.serverControl.start(chat);
        return;
      case "opencode_stop":
      case "opencode-stop":
        await this.options.serverControl.stop(chat);
        return;
      case "task":
        await this.options.tasks.handle(chat, args);
        return;
      case "tasklist":
        await this.options.tasks.showList(chat);
        return;
      case "detach":
        await this.options.sessions.detach(chat);
        await this.reply(chat.chat_id, t(this.locale(chat.chat_id), "cmd.detached"));
        return;
      default:
        await this.reply(
          chat.chat_id,
          t(this.locale(chat.chat_id), "cmd.unknown", { command: safeInline(command) }),
        );
    }
  }

  private async status(chat: ChatRow): Promise<void> {
    const { client, chats, health, config, sessions } = this.options;
    const snapshot = health.snapshot();
    const lines: string[] = ["*OpenCode Bale bridge*", ""];

    lines.push(
      `*Server:* ${snapshot.opencodeVersion ? safeInline(snapshot.opencodeVersion) : "unknown"} at \`${safeInline(snapshot.opencodeUrl)}\``,
    );
    lines.push(
      `*Bale:* ${snapshot.botUsername ? `@${safeInline(snapshot.botUsername)}` : "bot"} · ${
        snapshot.pollerRunning ? "polling" : "stopped"
      }${snapshot.lastUpdateAt ? ` · last update ${formatRelative(snapshot.lastUpdateAt)}` : ""}`,
    );
    lines.push(`*SSE:* ${snapshot.sseConnected ? "connected" : "disconnected"}`);
    lines.push(`*Project:* \`${safeInline(chat.project_directory ?? config.opencode.projectDirectory)}\``);
    lines.push("");

    const chatRow = chats.get(chat.chat_id) ?? chat;
    if (!chatRow.active_session_id) {
      lines.push("*Session:* none — send a message or use /new");
    } else {
      try {
        const [session, active] = await Promise.all([
          client.getSession(chatRow.active_session_id),
          client
            .activeSessions()
            .catch((): Record<string, { type: string } | undefined> => ({})),
        ]);
        const running = active[session.id]?.type === "running";
        lines.push(`*Session:* ${strong(session.title || "(untitled)")} · \`${shortId(session.id)}\``);
        lines.push(
          `*State:* ${running ? "running" : session.outcome ?? "idle"}${
            running && session.time.busy ? ` for ${formatDuration(Date.now() - session.time.busy)}` : ""
          }`,
        );
        const model = session.model
          ? `${session.model.providerID}/${session.model.id}`
          : `${config.opencode.model.providerID}/${config.opencode.model.id}`;
        lines.push(`*Model:* \`${safeInline(model)}\``);
        if (session.agent) {
          lines.push(`*Agent:* ${safeInline(session.agent)}`);
        }
        lines.push(
          `*Tokens:* ${compact(session.tokens.input)} in / ${compact(session.tokens.output)} out / ${compact(
            session.tokens.reasoning,
          )} reasoning`,
        );
        lines.push(`*Cost:* ${formatCost(session.cost)}`);
      } catch (error) {
        if (error instanceof OpenCodeError && error.status === 404) {
          chats.setActiveSession(chat.chat_id, null);
          lines.push("*Session:* the bound session no longer exists — use /new");
        } else {
          lines.push(`*Session:* could not read: ${safeInline(sessions.describeError(error))}`);
        }
      }
    }

    if (snapshot.pollerError) {
      lines.push("", `*Last poll error:* ${safeInline(truncate(snapshot.pollerError, 200))}`);
    }

    await this.reply(chat.chat_id, lines.join("\n"));
  }

  private async newSession(chat: ChatRow, title: string): Promise<void> {
    try {
      const session = await this.options.sessions.createSession(chat, title || undefined);
      await this.reply(
        chat.chat_id,
        `✅ *New session*\n\n*${escapeBold(session.title)}*\n\`${safeInline(session.id)}\`\n\nSend a message to start.`,
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not create a session: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async listSessions(chat: ChatRow): Promise<void> {
    try {
      const sessions = (await this.recentSessions()).slice(0, 10);
      this.lastSessions.set(chat.chat_id, sessions.map((session) => session.id));
      if (sessions.length === 0) {
        await this.reply(chat.chat_id, "No sessions found.");
        return;
      }
      const lines = ["*Recent sessions*", ""];
      sessions.forEach((session, index) => {
        const outcome = session.outcome ? ` · ${session.outcome}` : "";
        lines.push(
          `${index + 1}. ${strong(session.title || "(untitled)")} — \`${shortId(session.id)}\`\n   _${formatRelative(session.time.updated)}${outcome}_`,
        );
      });
      lines.push("", "_Use /switch <number> or /switch <session-id>._");
      await this.reply(chat.chat_id, lines.join("\n"));
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not list sessions: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async switchSession(chat: ChatRow, argument: string | undefined): Promise<void> {
    if (!argument) {
      await this.reply(chat.chat_id, "Usage: /switch <number|session-id>");
      return;
    }

    let target: string | undefined;
    try {
      if (/^\d+$/.test(argument)) {
        const index = Number(argument) - 1;
        const cached = this.lastSessions.get(chat.chat_id);
        const ids =
          cached ??
          (await this.recentSessions())
            .slice(0, 10)
            .map((session) => session.id);
        if (!cached) {
          this.lastSessions.set(chat.chat_id, ids);
        }
        target = ids[index];
        if (!target) {
          await this.reply(chat.chat_id, "That session number is out of range. Use /sessions first.");
          return;
        }
      } else {
        const sessions = await this.recentSessions();
        const matches = sessions.filter((session) => session.id.startsWith(argument));
        if (matches.length === 1) {
          target = matches[0]?.id;
        } else if (matches.length > 1) {
          await this.reply(chat.chat_id, "That session ID is ambiguous. Use more characters.");
          return;
        } else {
          target = argument;
        }
      }

      const session = await this.options.sessions.attach(chat, target as string);
      await this.reply(
        chat.chat_id,
        `✅ *Attached*\n\n*${escapeBold(session.title || "(untitled)")}*\n\`${safeInline(session.id)}\``,
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not attach to that session: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async model(chat: ChatRow, argument: string): Promise<void> {
    if (!argument) {
      await this.options.menus.showModels(chat);
      return;
    }
    try {
      const models = await this.options.client.listModels();
      const exact = models.find(
        (model) => `${model.providerID}/${model.modelID}` === argument,
      );
      const byId = models.filter((model) => model.modelID === argument);
      const target = exact ?? (byId.length === 1 ? byId[0] : undefined);
      if (!target) {
        await this.reply(
          chat.chat_id,
          `⚠️ No unique model matches \`${safeInline(argument)}\`. Use /model to pick from the list.`,
        );
        return;
      }
      await this.options.menus.applyModel(chat, target.providerID, target.modelID);
      await this.reply(
        chat.chat_id,
        `✅ *Model set*\n\n\`${safeInline(target.providerID)}/${safeInline(target.modelID)}\``,
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not switch model: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async agent(chat: ChatRow, argument: string): Promise<void> {
    if (!argument) {
      await this.options.menus.showAgents(chat);
      return;
    }
    try {
      const agents = await this.options.client.listAgents();
      const target = agents.find(
        (agent) =>
          agent.id === argument || agent.name.toLowerCase() === argument.toLowerCase(),
      );
      if (!target) {
        await this.reply(
          chat.chat_id,
          `⚠️ No agent matches \`${safeInline(argument)}\`. Use /agent to pick from the list.`,
        );
        return;
      }
      await this.options.menus.applyAgent(chat, target.id);
      await this.reply(chat.chat_id, `✅ *Agent set*\n\n${transformInline(target.name)}`);
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not switch agent: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async compact(chat: ChatRow): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    if (!current.active_session_id) {
      await this.reply(chat.chat_id, "No session is bound. Use /new or send a message first.");
      return;
    }
    try {
      await this.options.client.compact(current.active_session_id);
      await this.reply(
        chat.chat_id,
        "🗜️ *Compaction requested.*\n\n_This can take a moment. The result will appear here._",
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not compact: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async follow(chat: ChatRow, argument: string | undefined): Promise<void> {
    try {
      if (argument) {
        await this.switchSession(chat, argument);
        return;
      }

      const current = this.options.chats.get(chat.chat_id) ?? chat;
      const sessions = await this.recentSessions();
      const active = await this.options.client
        .activeSessions()
        .catch((): Record<string, { type: string } | undefined> => ({}));
      const running = sessions.filter(
        (session) => active[session.id]?.type === "running" && session.id !== current.active_session_id,
      );

      if (running.length === 1) {
        const session = running[0];
        if (!session) {
          return;
        }
        await this.options.sessions.attach(chat, session.id);
        await this.reply(
          chat.chat_id,
          `✅ *Following the running session*\n\n*${escapeBold(session.title || "(untitled)")}*\n\`${safeInline(session.id)}\``,
        );
        return;
      }

      if (running.length > 1) {
        this.lastSessions.set(chat.chat_id, running.slice(0, 10).map((session) => session.id));
        const lines = ["*Running sessions*", ""];
        running.slice(0, 10).forEach((session, index) => {
          lines.push(
            `${index + 1}. ${strong(session.title || "(untitled)")} — \`${shortId(session.id)}\``,
          );
        });
        lines.push("", "_Use /follow <number> or /switch <number>._");
        await this.reply(chat.chat_id, lines.join("\n"));
        return;
      }

      const latest = sessions.find((session) => session.id !== current.active_session_id);
      if (!latest) {
        await this.reply(chat.chat_id, "No other sessions found.");
        return;
      }
      await this.options.sessions.attach(chat, latest.id);
      await this.reply(
        chat.chat_id,
        `✅ *Following the latest session*\n\n*${escapeBold(latest.title || "(untitled)")}*\n\`${safeInline(latest.id)}\``,
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not follow a session: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async cancelForm(chat: ChatRow): Promise<void> {
    try {
      const cancelled = await this.options.forms.cancelForChat(chat);
      await this.reply(
        chat.chat_id,
        cancelled ? "⛔ Form cancelled." : "No form is waiting for input.",
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not cancel the form: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async abort(chat: ChatRow): Promise<void> {
    const current = this.options.chats.get(chat.chat_id) ?? chat;
    if (!current.active_session_id) {
      await this.reply(chat.chat_id, "No session is bound.");
      return;
    }
    try {
      const interrupted = await this.options.client.interrupt(current.active_session_id);
      await this.reply(
        chat.chat_id,
        interrupted ? "⏹ *Interrupt requested.*" : "No active run to interrupt.",
      );
    } catch (error) {
      await this.reply(
        chat.chat_id,
        `⚠️ Could not interrupt: ${safeInline(this.options.sessions.describeError(error))}`,
      );
    }
  }

  private async recentSessions(): Promise<OpenCodeSession[]> {
    const sessions = await this.options.client.listSessions();
    return [...sessions].sort((a, b) => b.time.updated - a.time.updated);
  }

  private locale(chatId: string): Locale {
    return normalizeLocale(this.options.settings.get(chatId).locale);
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send command response", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}

function helpText(locale: Locale): string {
  const tr = (key: Parameters<typeof t>[1]): string => t(locale, key);
  return [
    `*${tr("help.title")}*`,
    "",
    tr("help.send"),
    "",
    tr("help.status"),
    tr("help.new"),
    tr("help.sessions"),
    tr("help.recent"),
    tr("help.switch"),
    tr("help.follow"),
    tr("help.model"),
    tr("help.agent"),
    tr("help.compact"),
    tr("help.context"),
    tr("help.abort"),
    tr("help.cancelform"),
    tr("help.detach"),
    tr("help.id"),
    tr("help.settings"),
    tr("help.language"),
    tr("help.queue"),
    tr("help.open"),
    tr("help.attach"),
    tr("help.mcps"),
    tr("help.reload"),
    tr("help.oc_start"),
    tr("help.oc_stop"),
    "",
    `*${tr("help.automation_title")}*`,
    tr("help.task"),
    tr("help.tasklist"),
    "",
    `*${tr("help.files_title")}*`,
    tr("help.ls"),
    tr("help.find"),
    tr("help.show"),
    tr("help.diff"),
    "",
    `*${tr("help.history_title")}*`,
    tr("help.messages"),
    tr("help.revert"),
    tr("help.fork"),
    "",
    `*${tr("help.commands_title")}*`,
    tr("help.commands"),
    tr("help.run"),
    tr("help.skills"),
    tr("help.skill"),
    "",
    `*${tr("help.projects_title")}*`,
    tr("help.projects"),
    tr("help.project"),
    tr("help.worktree"),
    "",
    `*${tr("help.background_title")}*`,
    tr("help.watch"),
    tr("help.unwatch"),
    tr("help.watching"),
    "",
    `_${tr("help.note")}_`,
  ].join("\n");
}

function strong(value: string): string {
  return `*${escapeBold(value)}*`;
}

function escapeBold(value: string): string {
  return transformInline(value.replace(/\n+/g, " ").trim());
}

function safeInline(value: string): string {
  return value.replace(/`/g, "′").replace(/\n+/g, " ").trim();
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `…${id.slice(-10)}`;
}

function compact(value: number): string {
  if (value < 1_000) {
    return String(value);
  }
  return `${(value / 1_000).toFixed(1)}k`;
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost === 0) {
    return "$0";
  }
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}