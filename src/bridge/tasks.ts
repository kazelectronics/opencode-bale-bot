import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
} from "@erfanvahabpour/bale-bot-sdk";

import type { Config } from "../config.js";
import type {
  ChatRepo,
  ChatRow,
  ScheduledTaskRow,
  TaskRepo,
  TaskScheduleKind,
} from "../db.js";
import type { HealthState } from "../health.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type { BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { sleep, formatDuration, formatRelative, truncate } from "../util.js";
import { extractMessageText } from "./history.js";
import { generatePromptMessageId } from "./prompts.js";
import { answerCallback, escapeBold, safeCode, safeText, shortId } from "./ui.js";

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;
const POLL_INTERVAL_MS = 2_500;
const PREVIEW_LIMIT = 1_400;
const MAX_TASKS_SHOWN = 10;

export type TaskOutcome = "succeeded" | "failed" | "interrupted" | "timeout";

export type TaskCallback =
  | { readonly kind: "list" }
  | { readonly kind: "run"; readonly id: number }
  | { readonly kind: "pause"; readonly id: number }
  | { readonly kind: "resume"; readonly id: number }
  | { readonly kind: "confirmDelete"; readonly id: number }
  | { readonly kind: "delete"; readonly id: number };

export function parseTaskCallback(data: string | undefined): TaskCallback | null {
  if (!data || !data.startsWith("task:")) {
    return null;
  }
  const parts = data.split(":");
  const action = parts[1] ?? "";
  if (action === "l") {
    return { kind: "list" };
  }
  const id = Number(parts[2]);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  switch (action) {
    case "r":
      return { kind: "run", id };
    case "p":
      return { kind: "pause", id };
    case "u":
      return { kind: "resume", id };
    case "x":
      return { kind: "confirmDelete", id };
    case "X":
      return { kind: "delete", id };
    default:
      return null;
  }
}

/** Parses `30s`, `15m`, `2h`, `1d`, `1w`, or a bare number of minutes. */
export function parseDuration(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  const match = /^(\d+)\s*([smhdw])?$/.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2] ?? "m";
  const multiplier =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 60 * 60 * 1_000
          : unit === "d"
            ? 24 * 60 * 60 * 1_000
            : 7 * 24 * 60 * 60 * 1_000;
  const ms = amount * multiplier;
  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) {
    return null;
  }
  return ms;
}

export interface ParsedSchedule {
  readonly kind: TaskScheduleKind;
  readonly nextRunAt: number;
  readonly intervalMs: number | null;
  readonly dailyMinute: number | null;
}

export type ScheduleParseResult =
  | { readonly ok: true; readonly schedule: ParsedSchedule }
  | { readonly ok: false; readonly error: string };

/**
 * Parses the schedule portion of `/task ...`, excluding the prompt.
 * `once` accepts an absolute local date/time, a bare `HH:MM`, or a duration.
 */
export function parseTaskSchedule(
  kindToken: string,
  rest: string,
  now = Date.now(),
): ScheduleParseResult {
  const kind = kindToken.trim().toLowerCase();
  const value = rest.trim();

  if (kind === "once" || kind === "at") {
    const nextRunAt = parseOneOff(value, now);
    if (nextRunAt === null) {
      return {
        ok: false,
        error:
          "Use an absolute time (`2026-11-06 09:00`), a clock time (`09:00`), or an offset (`30m`).",
      };
    }
    return {
      ok: true,
      schedule: { kind: "once", nextRunAt, intervalMs: null, dailyMinute: null },
    };
  }

  if (kind === "every" || kind === "interval" || kind === "recurring") {
    const intervalMs = parseDuration(value);
    if (intervalMs === null) {
      return {
        ok: false,
        error: "Use a duration between 1m and 365d, for example `every 30m` or `every 2h`.",
      };
    }
    return {
      ok: true,
      schedule: {
        kind: "interval",
        nextRunAt: now + intervalMs,
        intervalMs,
        dailyMinute: null,
      },
    };
  }

  if (kind === "daily") {
    const minute = parseClock(value);
    if (minute === null) {
      return { ok: false, error: "Use a 24-hour time, for example `daily 09:30`." };
    }
    return {
      ok: true,
      schedule: {
        kind: "daily",
        nextRunAt: nextDailyRun(minute, now),
        intervalMs: null,
        dailyMinute: minute,
      },
    };
  }

  return {
    ok: false,
    error: "Use `once`, `every`, or `daily` for the schedule.",
  };
}

export interface TaskManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly tasks: TaskRepo;
  readonly outbox: Outbox;
  readonly health: HealthState;
  readonly config: Config;
  readonly logger: Logger;
}

/**
 * Scheduled prompts. Each run creates a fresh OpenCode session in the task's
 * fixed project/model/agent, so task output never disturbs the chat's active
 * session. At most one run per task is in flight at a time.
 */
export class TaskManager {
  private readonly options: TaskManagerOptions;
  private readonly running = new Set<number>();
  private readonly sessionChats = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: TaskManagerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const recovered = this.options.tasks.recover();
    if (recovered > 0) {
      this.options.logger.warn("Recovered scheduled tasks left running by a previous process", {
        count: recovered,
      });
    }
    this.refreshHealth();
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.config.bridge.taskTickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Used by the run coordinator to route permissions and forms to the owner chat. */
  chatForSession(sessionId: string): string | null {
    return this.sessionChats.get(sessionId) ?? null;
  }

  async handle(chat: ChatRow, args: readonly string[]): Promise<void> {
    const [sub = "", ...rest] = args;
    const action = sub.toLowerCase();

    if (action === "" || action === "help") {
      await this.reply(chat.chat_id, usageText());
      return;
    }
    if (action === "list") {
      await this.showList(chat);
      return;
    }
    if (action === "run" || action === "pause" || action === "resume" || action === "delete") {
      await this.mutateById(chat, action, rest[0]);
      return;
    }

    const joined = [sub, ...rest].join(" ").trim();
    await this.create(chat, joined);
  }

  async create(chat: ChatRow, input: string): Promise<void> {
    const pipe = input.indexOf("|");
    if (pipe < 0) {
      await this.reply(
        chat.chat_id,
        "⚠️ Separate the schedule from the prompt with `|`.\n\n" +
          "`/task once 09:00 | Summarize the open TODOs`\n" +
          "`/task every 2h | Check the build`\n" +
          "`/task daily 08:30 | Write the standup note`",
      );
      return;
    }

    const scheduleText = input.slice(0, pipe).trim();
    const prompt = input.slice(pipe + 1).trim();
    if (!prompt) {
      await this.reply(chat.chat_id, "⚠️ The prompt after `|` is empty.");
      return;
    }
    if (prompt.length > 8_000) {
      await this.reply(chat.chat_id, "⚠️ The prompt is too long (maximum 8,000 characters).");
      return;
    }

    const tokens = scheduleText.split(/\s+/);
    let kindToken = tokens[0] ?? "";
    let whenText = tokens.slice(1).join(" ");
    if (kindToken.toLowerCase() === "add") {
      kindToken = tokens[1] ?? "";
      whenText = tokens.slice(2).join(" ");
    }

    const parsed = parseTaskSchedule(kindToken, whenText, Date.now());
    if (!parsed.ok) {
      await this.reply(chat.chat_id, `⚠️ ${parsed.error}`);
      return;
    }

    const current = this.options.chats.get(chat.chat_id) ?? chat;
    const task = this.options.tasks.create({
      chat_id: chat.chat_id,
      name: nameFromPrompt(prompt),
      prompt,
      project_directory:
        current.project_directory ?? this.options.config.opencode.projectDirectory,
      model_provider: current.model_provider ?? this.options.config.opencode.model.providerID,
      model_id: current.model_id ?? this.options.config.opencode.model.id,
      agent: current.agent ?? this.options.config.opencode.agent,
      schedule_kind: parsed.schedule.kind,
      next_run_at: parsed.schedule.nextRunAt,
      interval_ms: parsed.schedule.intervalMs,
      daily_minute: parsed.schedule.dailyMinute,
    });
    this.refreshHealth();
    this.options.logger.info("Scheduled task created", {
      taskId: task.id,
      chatId: task.chat_id,
      schedule: describeSchedule(task),
      nextRunAt: new Date(task.next_run_at).toISOString(),
    });

    const lines = [
      "🗓️ *Scheduled task created*",
      "",
      `*#${task.id} · ${escapeBold(task.name)}*`,
      `_${describeSchedule(task)} · next ${formatUntil(task.next_run_at)}_`,
      `\`${safeCode(task.project_directory)}\``,
      `\`${safeCode(`${task.model_provider}/${task.model_id}`)}\` · ${safeCode(task.agent ?? "default")}`,
      "",
      `_${escapeBold(truncate(prompt.replace(/\s+/g, " "), 180))}_`,
      "",
      "_Use /tasklist to run, pause, or delete it._",
    ];
    await this.reply(chat.chat_id, lines.join("\n"));
  }

  async showList(chat: ChatRow, messageId?: number): Promise<void> {
    const rows = this.options.tasks.listForChat(chat.chat_id);
    if (rows.length === 0) {
      const text = [
        "🗓️ *Scheduled tasks*",
        "",
        "_No tasks yet._",
        "",
        usageText(),
      ].join("\n");
      await this.sendOrEdit(chat.chat_id, messageId, text);
      return;
    }

    const lines = ["🗓️ *Scheduled tasks*", ""];
    const keyboard: InlineKeyboardButton[][] = [];
    for (const task of rows.slice(0, MAX_TASKS_SHOWN)) {
      const icon = task.running === 1 ? "⏳" : statusIcon(task.status);
      lines.push(`${icon} *#${task.id} · ${escapeBold(task.name)}*`);
      lines.push(`   _${describeSchedule(task)} · ${nextLabel(task)}_`);
      if (task.last_status) {
        lines.push(`   _${lastLabel(task)}_`);
      }
      lines.push(`   \`${safeCode(truncate(task.project_directory, 46))}\``);
      const run: InlineKeyboardButton = {
        text: `🚀 #${task.id}`,
        callback_data: `task:r:${task.id}`,
      };
      const toggle: InlineKeyboardButton =
        task.status === "paused"
          ? { text: `▶️ #${task.id}`, callback_data: `task:u:${task.id}` }
          : { text: `⏸ #${task.id}`, callback_data: `task:p:${task.id}` };
      const remove: InlineKeyboardButton = {
        text: `🗑 #${task.id}`,
        callback_data: `task:x:${task.id}`,
      };
      keyboard.push([run, toggle, remove]);
    }
    if (rows.length > MAX_TASKS_SHOWN) {
      lines.push("", `_…and ${rows.length - MAX_TASKS_SHOWN} more._`);
    }
    lines.push("", `_${usageText().split("\n")[0]}_`);
    await this.sendOrEdit(
      chat.chat_id,
      messageId,
      lines.join("\n"),
      keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
    );
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseTaskCallback(input.data);
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

    if (parsed.kind === "list") {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        undefined,
        this.options.logger,
      );
      await this.showList(chat, input.messageId);
      return;
    }

    const task = this.options.tasks.get(parsed.id);
    if (!task || task.chat_id !== input.chatId) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Task not found.",
        this.options.logger,
      );
      return;
    }

    if (parsed.kind === "run") {
      if (this.running.has(task.id) || task.running === 1) {
        await answerCallback(
          this.options.gateway,
          input.callbackQueryId,
          "This task is already running.",
          this.options.logger,
        );
        return;
      }
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Starting…",
        this.options.logger,
      );
      void this.runTask(task, "manual").catch((error) => {
        this.options.logger.error("Manual task run failed", {
          taskId: task.id,
          error: errorMessage(error),
        });
      });
      return;
    }

    if (parsed.kind === "pause") {
      this.options.tasks.update(task.id, { status: "paused" });
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Paused.",
        this.options.logger,
      );
      await this.showList(chat, input.messageId);
      return;
    }

    if (parsed.kind === "resume") {
      const next =
        task.schedule_kind === "daily" && task.daily_minute !== null
          ? nextDailyRun(task.daily_minute, Date.now())
          : Math.max(Date.now(), task.next_run_at);
      this.options.tasks.update(task.id, { status: "active", next_run_at: next });
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "Resumed.",
        this.options.logger,
      );
      await this.showList(chat, input.messageId);
      return;
    }

    if (parsed.kind === "confirmDelete") {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        undefined,
        this.options.logger,
      );
      const text = [
        `🗑 *Delete task #${task.id}?*`,
        "",
        `*${escapeBold(task.name)}*`,
        `_${describeSchedule(task)}_`,
        "",
        "_The scheduled prompt and its history are removed. Existing sessions stay._",
      ].join("\n");
      const markup: InlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: "🗑 Delete", callback_data: `task:X:${task.id}` },
            { text: "Cancel", callback_data: "task:l" },
          ],
        ],
      };
      await this.sendOrEdit(chat.chat_id, input.messageId, text, markup);
      return;
    }

    const removed = this.options.tasks.remove(task.id);
    await answerCallback(
      this.options.gateway,
      input.callbackQueryId,
      removed ? "Deleted." : "This task is running and cannot be deleted.",
      this.options.logger,
    );
    this.refreshHealth();
    await this.showList(chat, input.messageId);
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const due = this.options.tasks.listDue(Date.now());
      for (const task of due) {
        if (this.running.has(task.id)) {
          continue;
        }
        void this.runTask(task, "scheduled").catch((error) => {
          this.options.logger.error("Scheduled task run failed", {
            taskId: task.id,
            error: errorMessage(error),
          });
        });
      }
      this.refreshHealth();
    } finally {
      this.ticking = false;
    }
  }

  private async mutateById(chat: ChatRow, action: string, rawId: string | undefined): Promise<void> {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      await this.reply(chat.chat_id, "⚠️ Use a numeric task ID from /tasklist.");
      return;
    }
    const task = this.options.tasks.get(id);
    if (!task || task.chat_id !== chat.chat_id) {
      await this.reply(chat.chat_id, `⚠️ Task #${id} was not found.`);
      return;
    }

    if (action === "run") {
      if (this.running.has(task.id) || task.running === 1) {
        await this.reply(chat.chat_id, `⏳ Task #${task.id} is already running.`);
        return;
      }
      void this.runTask(task, "manual").catch((error) => {
        this.options.logger.error("Manual task run failed", {
          taskId: task.id,
          error: errorMessage(error),
        });
      });
      return;
    }

    if (action === "pause") {
      this.options.tasks.update(task.id, { status: "paused" });
      await this.reply(chat.chat_id, `⏸ *Task #${task.id} paused.*`);
      return;
    }

    if (action === "resume") {
      const next =
        task.schedule_kind === "daily" && task.daily_minute !== null
          ? nextDailyRun(task.daily_minute, Date.now())
          : Math.max(Date.now(), task.next_run_at);
      this.options.tasks.update(task.id, { status: "active", next_run_at: next });
      await this.reply(chat.chat_id, `▶️ *Task #${task.id} resumed.*`);
      return;
    }

    const text = [
      `🗑 *Delete task #${task.id}?*`,
      "",
      `*${escapeBold(task.name)}*`,
      `_${describeSchedule(task)}_`,
      "",
      "_The scheduled prompt and its history are removed. Existing sessions stay._",
    ].join("\n");
    await this.sendMarkup(chat.chat_id, text, {
      inline_keyboard: [
        [
          { text: "🗑 Delete", callback_data: `task:X:${task.id}` },
          { text: "Cancel", callback_data: "task:l" },
        ],
      ],
    });
  }

  private async runTask(
    task: ScheduledTaskRow,
    trigger: "scheduled" | "manual",
  ): Promise<void> {
    if (this.running.has(task.id)) {
      return;
    }
    this.running.add(task.id);
    if (!this.options.tasks.markRunning(task.id)) {
      this.running.delete(task.id);
      return;
    }
    this.refreshHealth();

    const started = Date.now();
    const model =
      task.model_provider && task.model_id
        ? { providerID: task.model_provider, id: task.model_id }
        : this.options.config.opencode.model;
    let sessionId: string | null = null;
    let outcome: TaskOutcome = "failed";
    let error: string | null = null;
    let preview: string | null = null;

    try {
      const session = await this.options.client.createSession({
        title: `${this.options.config.bridge.sessionTitlePrefix} task · ${task.name}`.slice(0, 90),
        directory: task.project_directory,
        model,
        agent: task.agent ?? this.options.config.opencode.agent,
      });
      sessionId = session.id;
      this.sessionChats.set(session.id, task.chat_id);
      if (trigger === "manual") {
        await this.notify(
          task.chat_id,
          `🚀 *Task #${task.id} running* · \`${shortId(session.id)}\``,
        );
      }
      await this.options.client.prompt(session.id, {
        id: generatePromptMessageId(),
        text: task.prompt,
        delivery: "queue",
      });

      const result = await this.waitForRun(session.id, started);
      outcome = result.outcome;
      error = result.error;
      preview = await this.lastAssistantText(session.id);
      await this.notifyResult(task, outcome, error, session.id, started, preview);
    } catch (errorObject) {
      error = errorMessage(errorObject);
      outcome = "failed";
      await this.notify(
        task.chat_id,
        [
          "❌ *Scheduled task failed*",
          "",
          `*#${task.id} · ${escapeBold(task.name)}*`,
          "",
          `⚠️ ${safeText(error, 400)}`,
        ].join("\n"),
      );
    } finally {
      if (sessionId) {
        this.sessionChats.delete(sessionId);
      }
      this.running.delete(task.id);
      const current = this.options.tasks.get(task.id);
      if (current) {
        const nextRunAt =
          task.schedule_kind === "once" ? task.next_run_at : this.nextRunAfter(task, Date.now());
        const status =
          current.status === "paused"
            ? "paused"
            : task.schedule_kind === "once"
              ? "completed"
              : "active";
        this.options.tasks.finish(task.id, {
          status,
          next_run_at: nextRunAt,
          last_status: outcome,
          last_error: error,
          last_session_id: sessionId,
        });
        this.options.logger.info("Scheduled task finished", {
          taskId: task.id,
          outcome,
          status,
          sessionId,
          durationMs: Date.now() - started,
        });
      }
      this.refreshHealth();
    }
  }

  private async waitForRun(
    sessionId: string,
    started: number,
  ): Promise<{ outcome: TaskOutcome; error: string | null }> {
    const deadline = started + this.options.config.bridge.taskTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const session = await this.options.client.getSession(sessionId);
        const idle = session.time.idle;
        if (
          session.outcome === "succeeded" ||
          session.outcome === "failed" ||
          session.outcome === "interrupted"
        ) {
          if (idle === undefined || idle >= started) {
            return { outcome: session.outcome, error: null };
          }
        }
      } catch (error) {
        return { outcome: "failed", error: errorMessage(error) };
      }
      await sleep(POLL_INTERVAL_MS);
    }

    try {
      await this.options.client.interrupt(sessionId);
    } catch (error) {
      this.options.logger.debug("Could not interrupt a timed-out task session", {
        sessionId,
        error: errorMessage(error),
      });
    }
    return {
      outcome: "timeout",
      error: `The run exceeded ${formatDuration(this.options.config.bridge.taskTimeoutMs)}.`,
    };
  }

  private async lastAssistantText(sessionId: string): Promise<string | null> {
    try {
      const response = await this.options.client.getMessages(sessionId, {
        limit: 1,
        order: "desc",
        type: "assistant",
      });
      const message = response.data[0];
      if (!message) {
        return null;
      }
      const text = extractMessageText(message).trim();
      return text.length > 0 ? truncate(text, PREVIEW_LIMIT) : null;
    } catch (error) {
      this.options.logger.debug("Could not read the scheduled task result", {
        sessionId,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async notifyResult(
    task: ScheduledTaskRow,
    outcome: TaskOutcome,
    error: string | null,
    sessionId: string,
    started: number,
    preview: string | null,
  ): Promise<void> {
    const icon =
      outcome === "succeeded"
        ? "✅"
        : outcome === "interrupted"
          ? "⏹"
          : outcome === "timeout"
            ? "⏱"
            : "❌";
    const label =
      outcome === "succeeded"
        ? "Scheduled task finished"
        : outcome === "interrupted"
          ? "Scheduled task stopped"
          : outcome === "timeout"
            ? "Scheduled task timed out"
            : "Scheduled task failed";
    const lines = [
      `${icon} *${label}*`,
      "",
      `*#${task.id} · ${escapeBold(task.name)}*`,
      `_${describeSchedule(task)} · ${formatDuration(Date.now() - started)} · \`${shortId(sessionId)}\`_`,
    ];
    if (error) {
      lines.push("", `⚠️ ${safeText(error, 400)}`);
    }
    if (preview) {
      lines.push("", preview);
    } else if (outcome === "succeeded") {
      lines.push("", "_The run finished without a text reply._");
    }
    lines.push("", `_Session \`${safeCode(sessionId)}\`_`);
    await this.notify(task.chat_id, lines.join("\n"));
  }

  private nextRunAfter(task: ScheduledTaskRow, finishedAt: number): number {
    if (task.schedule_kind === "interval" && task.interval_ms) {
      return finishedAt + task.interval_ms;
    }
    if (task.schedule_kind === "daily" && task.daily_minute !== null) {
      return nextDailyRun(task.daily_minute, finishedAt);
    }
    return task.next_run_at;
  }

  private refreshHealth(): void {
    this.options.health.tasksActive = this.options.tasks.countActive();
    this.options.health.tasksRunning = this.options.tasks.countRunning();
  }

  private async sendOrEdit(
    chatId: string,
    messageId: number | undefined,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    const outbox = this.options.outbox.forChat(chatId);
    if (messageId !== undefined) {
      const edited = await outbox.editNow(
        messageId,
        text,
        replyMarkup ? { replyMarkup } : undefined,
      );
      if (edited) {
        return;
      }
    }
    try {
      await outbox.send(text, replyMarkup ? { replyMarkup } : {});
    } catch (error) {
      this.options.logger.warn("Could not send the task panel", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    await this.notify(chatId, text);
  }

  private async sendMarkup(
    chatId: string,
    text: string,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text, { replyMarkup });
    } catch (error) {
      this.options.logger.warn("Could not send the task confirmation", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async notify(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send a task notice", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}

export function describeSchedule(task: ScheduledTaskRow): string {
  if (task.schedule_kind === "once") {
    return `once at ${localStamp(task.next_run_at)}`;
  }
  if (task.schedule_kind === "interval") {
    return `every ${formatDuration(task.interval_ms ?? 0)}`;
  }
  const minute = task.daily_minute ?? 0;
  return `daily at ${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

export function nextDailyRun(minute: number, now = Date.now()): number {
  const date = new Date(now);
  date.setSeconds(0, 0);
  date.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  if (date.getTime() <= now) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

function parseOneOff(value: string, now: number): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const relative = trimmed.startsWith("in ") ? trimmed.slice(3) : trimmed;
  if (trimmed.startsWith("in ") || /^\d+\s*[smhdw]$/i.test(trimmed)) {
    const duration = parseDuration(relative);
    return duration === null ? null : now + duration;
  }

  const absolute = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(trimmed);
  if (absolute) {
    const [, year, month, day, hour, minute] = absolute;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0,
      0,
    );
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.getTime() > now - 60_000 ? date.getTime() : null;
  }

  const clock = parseClock(trimmed);
  if (clock === null) {
    return null;
  }
  const date = new Date(now);
  date.setSeconds(0, 0);
  date.setHours(Math.floor(clock / 60), clock % 60, 0, 0);
  if (date.getTime() <= now) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
}

function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function statusIcon(status: string): string {
  if (status === "paused") {
    return "⏸";
  }
  if (status === "completed") {
    return "✅";
  }
  return "•";
}

function nextLabel(task: ScheduledTaskRow): string {
  if (task.running === 1) {
    return "running now";
  }
  if (task.status === "paused") {
    return "paused";
  }
  if (task.status === "completed") {
    return `finished ${formatRelative(task.last_finished_at ?? task.updated_at)}`;
  }
  return `next ${formatUntil(task.next_run_at)}`;
}

function lastLabel(task: ScheduledTaskRow): string {
  const icon =
    task.last_status === "succeeded"
      ? "✅"
      : task.last_status === "interrupted"
        ? "⏹"
        : task.last_status === "timeout"
          ? "⏱"
          : "❌";
  const when = task.last_finished_at ? ` · ${formatRelative(task.last_finished_at)}` : "";
  return `last ${icon} ${task.last_status}${when}`;
}

function formatUntil(timestamp: number, now = Date.now()): string {
  const delta = timestamp - now;
  if (delta <= 0) {
    return "due now";
  }
  return `in ${formatDuration(delta)}`;
}

function localStamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function nameFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length <= 48 ? compact : `${compact.slice(0, 47)}…`;
}

function usageText(): string {
  return [
    "🗓️ *Scheduled tasks*",
    "",
    "`/task once 2026-11-06 09:00 | <prompt>`",
    "`/task once 09:00 | <prompt>` — next occurrence",
    "`/task once 30m | <prompt>` — relative",
    "`/task every 2h | <prompt>` — recurring interval",
    "`/task daily 08:30 | <prompt>` — every day",
    "",
    "`/tasklist` — run, pause, resume, or delete",
    "",
    "_Each run uses a fresh session with this chat's project, model, and agent._",
  ].join("\n");
}