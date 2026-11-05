import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA_VERSION = 5;

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current >= SCHEMA_VERSION) {
    return;
  }

  db.exec("BEGIN");
  try {
    if (current < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chats (
          chat_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          active_session_id TEXT,
          project_directory TEXT,
          model_provider TEXT,
          model_id TEXT,
          agent TEXT,
          delivery TEXT NOT NULL DEFAULT 'queue',
          live_message_id INTEGER,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS callback_tokens (
          token TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          ref_id TEXT NOT NULL,
          payload TEXT,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_callback_tokens_expires
          ON callback_tokens(expires_at);

        CREATE TABLE IF NOT EXISTS pending_input (
          chat_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          ref_id TEXT NOT NULL,
          field_key TEXT,
          expires_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS processed_updates (
          update_id INTEGER PRIMARY KEY,
          processed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_processed_updates_at
          ON processed_updates(processed_at);

        CREATE TABLE IF NOT EXISTS interaction_messages (
          request_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          kind TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS prompt_ids (
          update_id INTEGER PRIMARY KEY,
          message_id TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    }
    if (current < 2) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS form_sessions (
          form_id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id INTEGER,
          title TEXT NOT NULL,
          fields_json TEXT NOT NULL,
          answers_json TEXT NOT NULL,
          skipped_json TEXT NOT NULL DEFAULT '[]',
          current_key TEXT,
          awaiting_key TEXT,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_form_sessions_chat
          ON form_sessions(chat_id);
        CREATE INDEX IF NOT EXISTS idx_form_sessions_expires
          ON form_sessions(expires_at);
      `);
    }
    if (current < 3) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS watched_sessions (
          chat_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          title TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (chat_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_watched_sessions_session
          ON watched_sessions(session_id);
      `);
    }
    if (current < 4) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id TEXT PRIMARY KEY,
          locale TEXT,
          progress_style TEXT,
          show_thinking INTEGER,
          show_footer INTEGER,
          pinned_dashboard INTEGER,
          diff_attachments INTEGER,
          queue_behavior TEXT,
          dashboard_message_id INTEGER,
          updated_at INTEGER NOT NULL
        );
      `);
    }
    if (current < 5) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          project_directory TEXT NOT NULL,
          model_provider TEXT,
          model_id TEXT,
          agent TEXT,
          schedule_kind TEXT NOT NULL,
          next_run_at INTEGER NOT NULL,
          interval_ms INTEGER,
          daily_minute INTEGER,
          status TEXT NOT NULL DEFAULT 'active',
          running INTEGER NOT NULL DEFAULT 0,
          run_count INTEGER NOT NULL DEFAULT 0,
          last_run_at INTEGER,
          last_finished_at INTEGER,
          last_status TEXT,
          last_error TEXT,
          last_session_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
          ON scheduled_tasks(status, running, next_run_at);
        CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_chat
          ON scheduled_tasks(chat_id);
      `);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface ChatRow {
  readonly chat_id: string;
  readonly user_id: string;
  readonly active_session_id: string | null;
  readonly project_directory: string | null;
  readonly model_provider: string | null;
  readonly model_id: string | null;
  readonly agent: string | null;
  readonly delivery: string;
  readonly live_message_id: number | null;
  readonly updated_at: number;
}

export interface ChatPatch {
  activeSessionId?: string | null;
  projectDirectory?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  agent?: string | null;
  delivery?: string;
  liveMessageId?: number | null;
}

const COLUMN_BY_PATCH_KEY: Record<keyof ChatPatch, string> = {
  activeSessionId: "active_session_id",
  projectDirectory: "project_directory",
  modelProvider: "model_provider",
  modelId: "model_id",
  agent: "agent",
  delivery: "delivery",
  liveMessageId: "live_message_id",
};

export class MetaRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  getNumber(key: string): number | null {
    const value = this.get(key);
    if (value === null || value.trim() === "") {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}

export class ChatRepo {
  constructor(private readonly db: Db) {}

  get(chatId: string): ChatRow | null {
    const row = this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as
      | ChatRow
      | undefined;
    return row ?? null;
  }

  ensure(chatId: string, userId: string, defaults?: ChatPatch): ChatRow {
    const existing = this.get(chatId);
    if (existing) {
      if (existing.user_id !== userId) {
        this.db
          .prepare("UPDATE chats SET user_id = ?, updated_at = ? WHERE chat_id = ?")
          .run(userId, Date.now(), chatId);
      }
      return this.get(chatId) as ChatRow;
    }
    this.db
      .prepare(
        "INSERT INTO chats(chat_id, user_id, project_directory, model_provider, model_id, agent, delivery, updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        chatId,
        userId,
        defaults?.projectDirectory ?? null,
        defaults?.modelProvider ?? null,
        defaults?.modelId ?? null,
        defaults?.agent ?? null,
        defaults?.delivery ?? "queue",
        Date.now(),
      );
    return this.get(chatId) as ChatRow;
  }

  update(chatId: string, patch: ChatPatch): void {
    const entries = Object.entries(patch) as [keyof ChatPatch, string | number | null][];
    if (entries.length === 0) {
      return;
    }
    const assignments = entries.map(([key]) => `${COLUMN_BY_PATCH_KEY[key]} = ?`);
    const values = entries.map(([, value]) => value);
    this.db
      .prepare(`UPDATE chats SET ${assignments.join(", ")}, updated_at = ? WHERE chat_id = ?`)
      .run(...values, Date.now(), chatId);
  }

  setActiveSession(chatId: string, sessionId: string | null): void {
    this.update(chatId, { activeSessionId: sessionId });
  }

  setLiveMessage(chatId: string, messageId: number | null): void {
    this.update(chatId, { liveMessageId: messageId });
  }

  findByActiveSession(sessionId: string): ChatRow | null {
    const row = this.db
      .prepare("SELECT * FROM chats WHERE active_session_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sessionId) as ChatRow | undefined;
    return row ?? null;
  }

  list(): ChatRow[] {
    return this.db
      .prepare("SELECT * FROM chats ORDER BY updated_at DESC")
      .all() as unknown as ChatRow[];
  }
}

export interface CallbackTokenRow {
  readonly token: string;
  readonly chat_id: string;
  readonly kind: string;
  readonly ref_id: string;
  readonly payload: string | null;
  readonly expires_at: number;
}

export class CallbackRepo {
  constructor(private readonly db: Db) {}

  create(row: CallbackTokenRow): void {
    this.db
      .prepare(
        "INSERT INTO callback_tokens(token, chat_id, kind, ref_id, payload, expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(row.token, row.chat_id, row.kind, row.ref_id, row.payload, row.expires_at);
  }

  get(token: string): CallbackTokenRow | null {
    const row = this.db.prepare("SELECT * FROM callback_tokens WHERE token = ?").get(token) as
      | CallbackTokenRow
      | undefined;
    return row ?? null;
  }

  getByRef(chatId: string, kind: string, refId: string): CallbackTokenRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM callback_tokens WHERE chat_id = ? AND kind = ? AND ref_id = ? ORDER BY expires_at DESC LIMIT 1",
      )
      .get(chatId, kind, refId) as CallbackTokenRow | undefined;
    return row ?? null;
  }

  consume(token: string): CallbackTokenRow | null {
    const row = this.get(token);
    if (!row) {
      return null;
    }
    this.db.prepare("DELETE FROM callback_tokens WHERE token = ?").run(token);
    return row;
  }

  deleteByRef(chatId: string, kind: string, refId: string): void {
    this.db
      .prepare("DELETE FROM callback_tokens WHERE chat_id = ? AND kind = ? AND ref_id = ?")
      .run(chatId, kind, refId);
  }

  prune(now = Date.now()): number {
    const result = this.db.prepare("DELETE FROM callback_tokens WHERE expires_at < ?").run(now);
    return Number(result.changes);
  }
}

export interface PendingInputRow {
  readonly chat_id: string;
  readonly kind: string;
  readonly ref_id: string;
  readonly field_key: string | null;
  readonly expires_at: number;
}

export class PendingInputRepo {
  constructor(private readonly db: Db) {}

  get(chatId: string, now = Date.now()): PendingInputRow | null {
    const row = this.db.prepare("SELECT * FROM pending_input WHERE chat_id = ?").get(chatId) as
      | PendingInputRow
      | undefined;
    if (!row) {
      return null;
    }
    if (row.expires_at < now) {
      this.clear(chatId);
      return null;
    }
    return row;
  }

  set(row: PendingInputRow): void {
    this.db
      .prepare(
        "INSERT INTO pending_input(chat_id, kind, ref_id, field_key, expires_at) VALUES(?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET kind=excluded.kind, ref_id=excluded.ref_id, field_key=excluded.field_key, expires_at=excluded.expires_at",
      )
      .run(row.chat_id, row.kind, row.ref_id, row.field_key, row.expires_at);
  }

  clear(chatId: string): void {
    this.db.prepare("DELETE FROM pending_input WHERE chat_id = ?").run(chatId);
  }
}

export class ProcessedUpdatesRepo {
  constructor(private readonly db: Db) {}

  has(updateId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM processed_updates WHERE update_id = ?")
      .get(updateId) as { present: number } | undefined;
    return row !== undefined;
  }

  mark(updateId: number, now = Date.now()): void {
    this.db
      .prepare("INSERT OR IGNORE INTO processed_updates(update_id, processed_at) VALUES(?, ?)")
      .run(updateId, now);
  }

  prune(olderThanMs = 7 * 24 * 60 * 60 * 1_000, now = Date.now()): number {
    const result = this.db
      .prepare("DELETE FROM processed_updates WHERE processed_at < ?")
      .run(now - olderThanMs);
    return Number(result.changes);
  }
}

export class InteractionMessageRepo {
  constructor(private readonly db: Db) {}

  set(requestId: string, chatId: string, messageId: number, kind: string): void {
    this.db
      .prepare(
        "INSERT INTO interaction_messages(request_id, chat_id, message_id, kind) VALUES(?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET chat_id=excluded.chat_id, message_id=excluded.message_id, kind=excluded.kind",
      )
      .run(requestId, chatId, messageId, kind);
  }

  get(requestId: string): { request_id: string; chat_id: string; message_id: number; kind: string } | null {
    const row = this.db
      .prepare("SELECT * FROM interaction_messages WHERE request_id = ?")
      .get(requestId) as
      | { request_id: string; chat_id: string; message_id: number; kind: string }
      | undefined;
    return row ?? null;
  }

  delete(requestId: string): void {
    this.db.prepare("DELETE FROM interaction_messages WHERE request_id = ?").run(requestId);
  }
}

export interface FormSessionRow {
  readonly form_id: string;
  readonly chat_id: string;
  readonly session_id: string;
  readonly message_id: number | null;
  readonly title: string;
  readonly fields_json: string;
  readonly answers_json: string;
  readonly skipped_json: string;
  readonly current_key: string | null;
  readonly awaiting_key: string | null;
  readonly expires_at: number;
  readonly updated_at: number;
}

export interface FormSessionPatch {
  message_id?: number | null;
  answers_json?: string;
  skipped_json?: string;
  current_key?: string | null;
  awaiting_key?: string | null;
  expires_at?: number;
}

export class FormSessionRepo {
  constructor(private readonly db: Db) {}

  create(row: FormSessionRow): void {
    this.db
      .prepare(
        "INSERT INTO form_sessions(form_id, chat_id, session_id, message_id, title, fields_json, answers_json, skipped_json, current_key, awaiting_key, expires_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(form_id) DO UPDATE SET chat_id=excluded.chat_id, session_id=excluded.session_id, message_id=excluded.message_id, title=excluded.title, fields_json=excluded.fields_json, answers_json=excluded.answers_json, skipped_json=excluded.skipped_json, current_key=excluded.current_key, awaiting_key=excluded.awaiting_key, expires_at=excluded.expires_at, updated_at=excluded.updated_at",
      )
      .run(
        row.form_id,
        row.chat_id,
        row.session_id,
        row.message_id,
        row.title,
        row.fields_json,
        row.answers_json,
        row.skipped_json,
        row.current_key,
        row.awaiting_key,
        row.expires_at,
        row.updated_at,
      );
  }

  get(formId: string): FormSessionRow | null {
    const row = this.db.prepare("SELECT * FROM form_sessions WHERE form_id = ?").get(formId) as
      | FormSessionRow
      | undefined;
    return row ?? null;
  }

  findByChat(chatId: string, now = Date.now()): FormSessionRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM form_sessions WHERE chat_id = ? AND expires_at >= ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(chatId, now) as FormSessionRow | undefined;
    return row ?? null;
  }

  /** The newest form row for a chat, including expired rows. */
  findLatest(chatId: string): FormSessionRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM form_sessions WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(chatId) as FormSessionRow | undefined;
    return row ?? null;
  }

  update(formId: string, patch: FormSessionPatch): void {
    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    const columns: Record<keyof FormSessionPatch, string> = {
      message_id: "message_id",
      answers_json: "answers_json",
      skipped_json: "skipped_json",
      current_key: "current_key",
      awaiting_key: "awaiting_key",
      expires_at: "expires_at",
    };
    for (const [key, column] of Object.entries(columns) as [
      keyof FormSessionPatch,
      string,
    ][]) {
      if (key in patch) {
        assignments.push(`${column} = ?`);
        values.push(patch[key] ?? null);
      }
    }
    if (assignments.length === 0) {
      return;
    }
    this.db
      .prepare(
        `UPDATE form_sessions SET ${assignments.join(", ")}, updated_at = ? WHERE form_id = ?`,
      )
      .run(...values, Date.now(), formId);
  }

  delete(formId: string): void {
    this.db.prepare("DELETE FROM form_sessions WHERE form_id = ?").run(formId);
  }

  takeExpired(now = Date.now()): FormSessionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM form_sessions WHERE expires_at < ?")
      .all(now) as unknown as FormSessionRow[];
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.form_id);
    const placeholders = ids.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM form_sessions WHERE form_id IN (${placeholders})`)
      .run(...ids);
    return rows;
  }

  prune(now = Date.now()): number {
    const result = this.db
      .prepare("DELETE FROM form_sessions WHERE expires_at < ?")
      .run(now);
    return Number(result.changes);
  }
}

export interface WatchedSessionRow {
  readonly chat_id: string;
  readonly session_id: string;
  readonly title: string | null;
  readonly created_at: number;
}

export class WatchedSessionRepo {
  constructor(private readonly db: Db) {}

  add(chatId: string, sessionId: string, title: string | null = null, now = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO watched_sessions(chat_id, session_id, title, created_at) VALUES(?,?,?,?) ON CONFLICT(chat_id, session_id) DO UPDATE SET title = COALESCE(excluded.title, watched_sessions.title)",
      )
      .run(chatId, sessionId, title, now);
  }

  remove(chatId: string, sessionId: string): void {
    this.db
      .prepare("DELETE FROM watched_sessions WHERE chat_id = ? AND session_id = ?")
      .run(chatId, sessionId);
  }

  removeAll(chatId: string): void {
    this.db.prepare("DELETE FROM watched_sessions WHERE chat_id = ?").run(chatId);
  }

  listForChat(chatId: string): WatchedSessionRow[] {
    return this.db
      .prepare("SELECT * FROM watched_sessions WHERE chat_id = ? ORDER BY created_at DESC")
      .all(chatId) as unknown as WatchedSessionRow[];
  }

  listForSession(sessionId: string): WatchedSessionRow[] {
    return this.db
      .prepare("SELECT * FROM watched_sessions WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId) as unknown as WatchedSessionRow[];
  }

  isWatching(chatId: string, sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM watched_sessions WHERE chat_id = ? AND session_id = ?")
      .get(chatId, sessionId) as { present: number } | undefined;
    return row !== undefined;
  }

  updateTitle(sessionId: string, title: string): void {
    this.db
      .prepare("UPDATE watched_sessions SET title = ? WHERE session_id = ?")
      .run(title, sessionId);
  }
}

export type ProgressStyle = "normal" | "compact";
export type QueueBehavior = "queue" | "steer";

export interface ChatSettings {
  readonly chat_id: string;
  readonly locale: string;
  readonly progress_style: ProgressStyle;
  readonly show_thinking: boolean;
  readonly show_footer: boolean;
  readonly pinned_dashboard: boolean;
  readonly diff_attachments: boolean;
  /** Null means "inherit the chat delivery mode". */
  readonly queue_behavior: QueueBehavior | null;
  readonly dashboard_message_id: number | null;
  readonly updated_at: number;
}

export interface ChatSettingsPatch {
  locale?: string;
  progress_style?: ProgressStyle;
  show_thinking?: boolean;
  show_footer?: boolean;
  pinned_dashboard?: boolean;
  diff_attachments?: boolean;
  queue_behavior?: QueueBehavior | null;
  dashboard_message_id?: number | null;
}

const SETTINGS_COLUMN_BY_PATCH_KEY: Record<keyof ChatSettingsPatch, string> = {
  locale: "locale",
  progress_style: "progress_style",
  show_thinking: "show_thinking",
  show_footer: "show_footer",
  pinned_dashboard: "pinned_dashboard",
  diff_attachments: "diff_attachments",
  queue_behavior: "queue_behavior",
  dashboard_message_id: "dashboard_message_id",
};

interface ChatSettingsRow {
  readonly chat_id: string;
  readonly locale: string | null;
  readonly progress_style: string | null;
  readonly show_thinking: number | null;
  readonly show_footer: number | null;
  readonly pinned_dashboard: number | null;
  readonly diff_attachments: number | null;
  readonly queue_behavior: string | null;
  readonly dashboard_message_id: number | null;
  readonly updated_at: number;
}

function toBoolean(value: number | null, fallback: boolean): boolean {
  if (value === null || value === undefined) {
    return fallback;
  }
  return value !== 0;
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  /** Returns defaults merged with any stored override; never null. */
  get(chatId: string): ChatSettings {
    const row = this.db.prepare("SELECT * FROM chat_settings WHERE chat_id = ?").get(chatId) as
      | ChatSettingsRow
      | undefined;
    return SettingsRepo.toSettings(chatId, row);
  }

  /** Raw row, or null when the chat has never saved settings. */
  getRaw(chatId: string): ChatSettingsRow | null {
    const row = this.db.prepare("SELECT * FROM chat_settings WHERE chat_id = ?").get(chatId) as
      | ChatSettingsRow
      | undefined;
    return row ?? null;
  }

  patch(chatId: string, patch: ChatSettingsPatch): ChatSettings {
    const current = this.getRaw(chatId);
    if (!current) {
      this.db
        .prepare(
          "INSERT INTO chat_settings(chat_id, locale, progress_style, show_thinking, show_footer, pinned_dashboard, diff_attachments, queue_behavior, dashboard_message_id, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          chatId,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          Date.now(),
        );
    }
    const entries = Object.entries(patch) as [
      keyof ChatSettingsPatch,
      string | number | null | boolean,
    ][];
    if (entries.length > 0) {
      const assignments = entries.map(([key]) => `${SETTINGS_COLUMN_BY_PATCH_KEY[key]} = ?`);
      const values = entries.map(([, value]) => SettingsRepo.encode(value));
      this.db
        .prepare(
          `UPDATE chat_settings SET ${assignments.join(", ")}, updated_at = ? WHERE chat_id = ?`,
        )
        .run(...values, Date.now(), chatId);
    }
    return this.get(chatId);
  }

  reset(chatId: string): ChatSettings {
    this.db.prepare("DELETE FROM chat_settings WHERE chat_id = ?").run(chatId);
    return this.get(chatId);
  }

  list(): ChatSettings[] {
    const rows = this.db.prepare("SELECT * FROM chat_settings").all() as unknown as ChatSettingsRow[];
    return rows.map((row) => SettingsRepo.toSettings(row.chat_id, row));
  }

  private static encode(value: string | number | boolean | null): string | number | null {
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    return value ?? null;
  }

  private static toSettings(chatId: string, row: ChatSettingsRow | undefined): ChatSettings {
    return {
      chat_id: chatId,
      locale: row?.locale ?? "en",
      progress_style: row?.progress_style === "compact" ? "compact" : "normal",
      show_thinking: toBoolean(row?.show_thinking ?? null, false),
      show_footer: toBoolean(row?.show_footer ?? null, true),
      pinned_dashboard: toBoolean(row?.pinned_dashboard ?? null, false),
      diff_attachments: toBoolean(row?.diff_attachments ?? null, true),
      queue_behavior:
        row?.queue_behavior === "queue" || row?.queue_behavior === "steer"
          ? row.queue_behavior
          : null,
      dashboard_message_id: row?.dashboard_message_id ?? null,
      updated_at: row?.updated_at ?? 0,
    };
  }
}

export class PromptIdRepo {
  constructor(private readonly db: Db) {}

  getOrCreate(updateId: number, factory: () => string, now = Date.now()): string {
    const row = this.db
      .prepare("SELECT message_id FROM prompt_ids WHERE update_id = ?")
      .get(updateId) as { message_id: string } | undefined;
    if (row) {
      return row.message_id;
    }
    const messageId = factory();
    this.db
      .prepare("INSERT INTO prompt_ids(update_id, message_id, created_at) VALUES(?,?,?)")
      .run(updateId, messageId, now);
    return messageId;
  }

  prune(olderThanMs = 7 * 24 * 60 * 60 * 1_000, now = Date.now()): number {
    const result = this.db
      .prepare("DELETE FROM prompt_ids WHERE created_at < ?")
      .run(now - olderThanMs);
    return Number(result.changes);
  }
}

export type TaskScheduleKind = "once" | "interval" | "daily";
export type TaskStatus = "active" | "paused" | "completed";

export interface ScheduledTaskRow {
  readonly id: number;
  readonly chat_id: string;
  readonly name: string;
  readonly prompt: string;
  readonly project_directory: string;
  readonly model_provider: string | null;
  readonly model_id: string | null;
  readonly agent: string | null;
  readonly schedule_kind: TaskScheduleKind;
  readonly next_run_at: number;
  readonly interval_ms: number | null;
  readonly daily_minute: number | null;
  readonly status: TaskStatus;
  readonly running: number;
  readonly run_count: number;
  readonly last_run_at: number | null;
  readonly last_finished_at: number | null;
  readonly last_status: string | null;
  readonly last_error: string | null;
  readonly last_session_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ScheduledTaskInput {
  readonly chat_id: string;
  readonly name: string;
  readonly prompt: string;
  readonly project_directory: string;
  readonly model_provider: string | null;
  readonly model_id: string | null;
  readonly agent: string | null;
  readonly schedule_kind: TaskScheduleKind;
  readonly next_run_at: number;
  readonly interval_ms: number | null;
  readonly daily_minute: number | null;
}

export interface ScheduledTaskPatch {
  name?: string;
  status?: TaskStatus;
  next_run_at?: number;
  interval_ms?: number | null;
  daily_minute?: number | null;
  running?: number;
  run_count?: number;
  last_run_at?: number | null;
  last_finished_at?: number | null;
  last_status?: string | null;
  last_error?: string | null;
  last_session_id?: string | null;
}

const TASK_COLUMN_BY_PATCH_KEY: Record<keyof ScheduledTaskPatch, string> = {
  name: "name",
  status: "status",
  next_run_at: "next_run_at",
  interval_ms: "interval_ms",
  daily_minute: "daily_minute",
  running: "running",
  run_count: "run_count",
  last_run_at: "last_run_at",
  last_finished_at: "last_finished_at",
  last_status: "last_status",
  last_error: "last_error",
  last_session_id: "last_session_id",
};

export class TaskRepo {
  constructor(private readonly db: Db) {}

  create(input: ScheduledTaskInput, now = Date.now()): ScheduledTaskRow {
    const result = this.db
      .prepare(
        `INSERT INTO scheduled_tasks(
          chat_id, name, prompt, project_directory, model_provider, model_id, agent,
          schedule_kind, next_run_at, interval_ms, daily_minute, status, running,
          run_count, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',0,0,?,?)`,
      )
      .run(
        input.chat_id,
        input.name,
        input.prompt,
        input.project_directory,
        input.model_provider,
        input.model_id,
        input.agent,
        input.schedule_kind,
        input.next_run_at,
        input.interval_ms,
        input.daily_minute,
        now,
        now,
      );
    return this.get(Number(result.lastInsertRowid)) as ScheduledTaskRow;
  }

  get(id: number): ScheduledTaskRow | null {
    const row = this.db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as
      | ScheduledTaskRow
      | undefined;
    return row ?? null;
  }

  listForChat(chatId: string): ScheduledTaskRow[] {
    return this.db
      .prepare("SELECT * FROM scheduled_tasks WHERE chat_id = ? ORDER BY id ASC")
      .all(chatId) as unknown as ScheduledTaskRow[];
  }

  listAll(): ScheduledTaskRow[] {
    return this.db
      .prepare("SELECT * FROM scheduled_tasks ORDER BY id ASC")
      .all() as unknown as ScheduledTaskRow[];
  }

  listDue(now = Date.now()): ScheduledTaskRow[] {
    return this.db
      .prepare(
        "SELECT * FROM scheduled_tasks WHERE status = 'active' AND running = 0 AND next_run_at <= ? ORDER BY next_run_at ASC",
      )
      .all(now) as unknown as ScheduledTaskRow[];
  }

  update(id: number, patch: ScheduledTaskPatch): void {
    const entries = Object.entries(patch) as [
      keyof ScheduledTaskPatch,
      string | number | null,
    ][];
    if (entries.length === 0) {
      return;
    }
    const assignments = entries.map(([key]) => `${TASK_COLUMN_BY_PATCH_KEY[key]} = ?`);
    const values = entries.map(([, value]) => value);
    this.db
      .prepare(
        `UPDATE scheduled_tasks SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`,
      )
      .run(...values, Date.now(), id);
  }

  markRunning(id: number, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE scheduled_tasks SET running = 1, last_run_at = ?, run_count = run_count + 1, updated_at = ? WHERE id = ? AND running = 0",
      )
      .run(now, now, id);
    return Number(result.changes) > 0;
  }

  finish(
    id: number,
    patch: Omit<ScheduledTaskPatch, "running"> & { running?: 0 },
    now = Date.now(),
  ): void {
    this.update(id, {
      ...patch,
      running: 0,
      last_finished_at: patch.last_finished_at ?? now,
    });
  }

  remove(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM scheduled_tasks WHERE id = ? AND running = 0")
      .run(id);
    return Number(result.changes) > 0;
  }

  countActive(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM scheduled_tasks WHERE status = 'active'")
      .get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countRunning(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM scheduled_tasks WHERE running = 1")
      .get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /** Clear in-memory run markers left behind by a crash or restart. */
  recover(now = Date.now()): number {
    const result = this.db
      .prepare(
        "UPDATE scheduled_tasks SET running = 0, last_status = 'interrupted', last_error = 'bridge restarted during the run', updated_at = ? WHERE running = 1",
      )
      .run(now);
    return Number(result.changes);
  }
}