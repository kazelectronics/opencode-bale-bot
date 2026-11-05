import { describe, expect, it } from "vitest";

import {
  CallbackRepo,
  ChatRepo,
  FormSessionRepo,
  InteractionMessageRepo,
  MetaRepo,
  PendingInputRepo,
  ProcessedUpdatesRepo,
  PromptIdRepo,
  SettingsRepo,
  TaskRepo,
  WatchedSessionRepo,
  openDatabase,
} from "../src/db.js";

function fresh() {
  return openDatabase(":memory:");
}

describe("MetaRepo", () => {
  it("stores, reads, and deletes values", () => {
    const meta = new MetaRepo(fresh());
    expect(meta.get("offset")).toBeNull();
    meta.set("offset", "42");
    expect(meta.get("offset")).toBe("42");
    meta.set("offset", "43");
    expect(meta.get("offset")).toBe("43");
    expect(meta.getNumber("offset")).toBe(43);
    meta.delete("offset");
    expect(meta.get("offset")).toBeNull();
  });

  it("returns null for non-numeric values", () => {
    const meta = new MetaRepo(fresh());
    meta.set("x", "not-a-number");
    expect(meta.getNumber("x")).toBeNull();
  });
});

describe("ChatRepo", () => {
  it("creates a chat with defaults and updates it", () => {
    const chats = new ChatRepo(fresh());
    const created = chats.ensure("chat-1", "user-1");
    expect(created.chat_id).toBe("chat-1");
    expect(created.delivery).toBe("queue");
    expect(created.active_session_id).toBeNull();

    chats.update("chat-1", {
      activeSessionId: "ses_abc",
      liveMessageId: 77,
      modelProvider: "bailian-cli",
      modelId: "deepseek-v4.1-flash-1017",
    });
    const updated = chats.get("chat-1");
    expect(updated?.active_session_id).toBe("ses_abc");
    expect(updated?.live_message_id).toBe(77);
    expect(updated?.model_provider).toBe("bailian-cli");

    chats.setLiveMessage("chat-1", null);
    expect(chats.get("chat-1")?.live_message_id).toBeNull();
  });

  it("is idempotent and finds a chat by active session", () => {
    const chats = new ChatRepo(fresh());
    chats.ensure("chat-1", "user-1");
    chats.ensure("chat-1", "user-1");
    expect(chats.list()).toHaveLength(1);
    chats.setActiveSession("chat-1", "ses_xyz");
    expect(chats.findByActiveSession("ses_xyz")?.chat_id).toBe("chat-1");
    expect(chats.findByActiveSession("ses_missing")).toBeNull();
  });
});

describe("CallbackRepo", () => {
  it("consumes a token exactly once and prunes expired rows", () => {
    const callbacks = new CallbackRepo(fresh());
    callbacks.create({
      token: "tok",
      chat_id: "chat-1",
      kind: "permission",
      ref_id: "per_1",
      payload: "{}",
      expires_at: Date.now() + 60_000,
    });
    expect(callbacks.get("tok")?.ref_id).toBe("per_1");
    expect(callbacks.consume("tok")?.ref_id).toBe("per_1");
    expect(callbacks.consume("tok")).toBeNull();

    callbacks.create({
      token: "old",
      chat_id: "chat-1",
      kind: "permission",
      ref_id: "per_2",
      payload: null,
      expires_at: Date.now() - 1,
    });
    expect(callbacks.prune()).toBe(1);
    expect(callbacks.get("old")).toBeNull();
  });

  it("deletes tokens by ref", () => {
    const callbacks = new CallbackRepo(fresh());
    callbacks.create({
      token: "a",
      chat_id: "chat-1",
      kind: "permission",
      ref_id: "per_1",
      payload: null,
      expires_at: Date.now() + 60_000,
    });
    callbacks.create({
      token: "b",
      chat_id: "chat-1",
      kind: "permission",
      ref_id: "per_1",
      payload: null,
      expires_at: Date.now() + 60_000,
    });
    callbacks.deleteByRef("chat-1", "permission", "per_1");
    expect(callbacks.get("a")).toBeNull();
    expect(callbacks.get("b")).toBeNull();
  });
});

describe("PendingInputRepo", () => {
  it("expires stale input", () => {
    const pending = new PendingInputRepo(fresh());
    pending.set({
      chat_id: "chat-1",
      kind: "form",
      ref_id: "frm_1",
      field_key: null,
      expires_at: Date.now() + 60_000,
    });
    expect(pending.get("chat-1")?.ref_id).toBe("frm_1");
    expect(pending.get("chat-1", Date.now() + 120_000)).toBeNull();
  });
});

describe("ProcessedUpdatesRepo", () => {
  it("deduplicates update IDs", () => {
    const processed = new ProcessedUpdatesRepo(fresh());
    expect(processed.has(10)).toBe(false);
    processed.mark(10);
    processed.mark(10);
    expect(processed.has(10)).toBe(true);
  });
});

describe("InteractionMessageRepo", () => {
  it("upserts and deletes by request ID", () => {
    const repo = new InteractionMessageRepo(fresh());
    repo.set("per_1", "chat-1", 5, "permission");
    expect(repo.get("per_1")?.message_id).toBe(5);
    repo.set("per_1", "chat-1", 6, "permission");
    expect(repo.get("per_1")?.message_id).toBe(6);
    repo.delete("per_1");
    expect(repo.get("per_1")).toBeNull();
  });
});

describe("PromptIdRepo", () => {
  it("returns the same ID for the same update and calls the factory once", () => {
    const repo = new PromptIdRepo(fresh());
    let calls = 0;
    const factory = () => {
      calls += 1;
      return `msg_${calls}`;
    };
    expect(repo.getOrCreate(1, factory)).toBe("msg_1");
    expect(repo.getOrCreate(1, factory)).toBe("msg_1");
    expect(calls).toBe(1);
    expect(repo.getOrCreate(2, factory)).toBe("msg_2");
  });
});

describe("FormSessionRepo", () => {
  function row(overrides: Record<string, unknown> = {}) {
    return {
      form_id: "frm_1",
      chat_id: "chat-1",
      session_id: "ses_1",
      message_id: 9,
      title: "Deploy",
      fields_json: "[]",
      answers_json: "{}",
      skipped_json: "[]",
      current_key: null,
      awaiting_key: null,
      expires_at: Date.now() + 60_000,
      updated_at: Date.now(),
      ...overrides,
    };
  }

  it("creates, reads, updates, and deletes a form session", () => {
    const forms = new FormSessionRepo(fresh());
    forms.create(row());
    expect(forms.get("frm_1")?.title).toBe("Deploy");
    forms.update("frm_1", {
      answers_json: '{"name":"api"}',
      current_key: "port",
      awaiting_key: "port",
      message_id: null,
    });
    const updated = forms.get("frm_1");
    expect(updated?.answers_json).toBe('{"name":"api"}');
    expect(updated?.current_key).toBe("port");
    expect(updated?.message_id).toBeNull();
    forms.delete("frm_1");
    expect(forms.get("frm_1")).toBeNull();
  });

  it("finds the newest active form for a chat", () => {
    const forms = new FormSessionRepo(fresh());
    forms.create(row({ form_id: "frm_1", expires_at: Date.now() - 1 }));
    forms.create(row({ form_id: "frm_2", updated_at: Date.now() + 1 }));
    expect(forms.findByChat("chat-1")?.form_id).toBe("frm_2");
    expect(forms.findByChat("chat-1", Date.now() + 120_000)).toBeNull();
  });

  it("takes and removes expired forms", () => {
    const forms = new FormSessionRepo(fresh());
    forms.create(row({ form_id: "frm_old", expires_at: Date.now() - 1 }));
    forms.create(row({ form_id: "frm_new" }));
    const expired = forms.takeExpired();
    expect(expired.map((item) => item.form_id)).toEqual(["frm_old"]);
    expect(forms.get("frm_old")).toBeNull();
    expect(forms.get("frm_new")).not.toBeNull();
  });
});

describe("WatchedSessionRepo", () => {
  it("adds, lists, updates, and removes watches", () => {
    const watches = new WatchedSessionRepo(fresh());
    watches.add("chat-1", "ses_1", "First");
    watches.add("chat-1", "ses_2", null);
    expect(watches.listForChat("chat-1")).toHaveLength(2);
    expect(watches.isWatching("chat-1", "ses_1")).toBe(true);
    expect(watches.listForSession("ses_1")[0]?.title).toBe("First");

    watches.updateTitle("ses_1", "Renamed");
    expect(watches.listForSession("ses_1")[0]?.title).toBe("Renamed");

    watches.remove("chat-1", "ses_1");
    expect(watches.isWatching("chat-1", "ses_1")).toBe(false);

    watches.removeAll("chat-1");
    expect(watches.listForChat("chat-1")).toHaveLength(0);
  });
});

describe("SettingsRepo", () => {
  it("returns defaults and persists overrides", () => {
    const settings = new SettingsRepo(fresh());
    const defaults = settings.get("chat-1");
    expect(defaults.locale).toBe("en");
    expect(defaults.progress_style).toBe("normal");
    expect(defaults.show_thinking).toBe(false);
    expect(defaults.show_footer).toBe(true);
    expect(defaults.pinned_dashboard).toBe(false);
    expect(defaults.diff_attachments).toBe(true);
    expect(defaults.queue_behavior).toBeNull();

    const updated = settings.patch("chat-1", {
      locale: "fa",
      progress_style: "compact",
      show_thinking: false,
      pinned_dashboard: true,
      queue_behavior: "steer",
      dashboard_message_id: 42,
    });
    expect(updated.locale).toBe("fa");
    expect(updated.progress_style).toBe("compact");
    expect(updated.show_thinking).toBe(false);
    expect(updated.pinned_dashboard).toBe(true);
    expect(updated.queue_behavior).toBe("steer");
    expect(updated.dashboard_message_id).toBe(42);

    const reread = settings.get("chat-1");
    expect(reread.locale).toBe("fa");
    expect(reread.progress_style).toBe("compact");
    expect(reread.show_thinking).toBe(false);

    settings.reset("chat-1");
    expect(settings.get("chat-1").locale).toBe("en");
    expect(settings.get("chat-1").queue_behavior).toBeNull();
  });

  it("keeps chats independent", () => {
    const settings = new SettingsRepo(fresh());
    settings.patch("a", { locale: "fa" });
    expect(settings.get("a").locale).toBe("fa");
    expect(settings.get("b").locale).toBe("en");
  });
});

describe("TaskRepo", () => {
  function input(overrides: Partial<Parameters<TaskRepo["create"]>[0]> = {}) {
    return {
      chat_id: "chat-1",
      name: "Standup",
      prompt: "Write the standup note",
      project_directory: "/tmp",
      model_provider: "p",
      model_id: "m",
      agent: "build",
      schedule_kind: "interval" as const,
      next_run_at: 1_000,
      interval_ms: 60_000,
      daily_minute: null,
      ...overrides,
    };
  }

  it("creates, lists, and finds due tasks", () => {
    const tasks = new TaskRepo(fresh());
    const first = tasks.create(input(), 100);
    tasks.create(input({ chat_id: "chat-2", next_run_at: 5_000 }), 100);
    expect(first.id).toBe(1);
    expect(first.status).toBe("active");
    expect(tasks.listForChat("chat-1")).toHaveLength(1);
    expect(tasks.listAll()).toHaveLength(2);
    expect(tasks.listDue(999)).toHaveLength(0);
    expect(tasks.listDue(1_000)).toHaveLength(1);
    expect(tasks.countActive()).toBe(2);
  });

  it("prevents overlapping runs and records completion", () => {
    const tasks = new TaskRepo(fresh());
    const task = tasks.create(input(), 100);
    expect(tasks.markRunning(task.id, 200)).toBe(true);
    expect(tasks.markRunning(task.id, 201)).toBe(false);
    expect(tasks.countRunning()).toBe(1);
    expect(tasks.listDue(2_000)).toHaveLength(0);

    tasks.finish(
      task.id,
      {
        status: "active",
        next_run_at: 62_000,
        last_status: "succeeded",
        last_error: null,
        last_session_id: "ses_1",
      },
      300,
    );
    const finished = tasks.get(task.id);
    expect(finished?.running).toBe(0);
    expect(finished?.run_count).toBe(1);
    expect(finished?.last_status).toBe("succeeded");
    expect(finished?.last_session_id).toBe("ses_1");
    expect(finished?.last_finished_at).toBe(300);
    expect(tasks.countRunning()).toBe(0);
  });

  it("recovers interrupted runs and refuses to delete a running task", () => {
    const tasks = new TaskRepo(fresh());
    const task = tasks.create(input(), 100);
    tasks.markRunning(task.id);
    expect(tasks.remove(task.id)).toBe(false);
    expect(tasks.recover(400)).toBe(1);
    const recovered = tasks.get(task.id);
    expect(recovered?.running).toBe(0);
    expect(recovered?.last_status).toBe("interrupted");
    expect(tasks.remove(task.id)).toBe(true);
    expect(tasks.get(task.id)).toBeNull();
  });

  it("pauses and resumes without losing the schedule", () => {
    const tasks = new TaskRepo(fresh());
    const task = tasks.create(input({ schedule_kind: "daily", daily_minute: 540, interval_ms: null }), 100);
    tasks.update(task.id, { status: "paused" });
    expect(tasks.get(task.id)?.status).toBe("paused");
    expect(tasks.listDue(10_000_000)).toHaveLength(0);
    tasks.update(task.id, { status: "active", next_run_at: 20_000 });
    expect(tasks.listDue(20_000)).toHaveLength(1);
  });
});

describe("migrations", () => {
  it("is safe to open twice and records the schema version", () => {
    const db = fresh();
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    expect(row.user_version).toBe(5);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('watched_sessions', 'scheduled_tasks') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(tables.map((table) => table.name)).toEqual([
      "scheduled_tasks",
      "watched_sessions",
    ]);
    db.close();
  });
});