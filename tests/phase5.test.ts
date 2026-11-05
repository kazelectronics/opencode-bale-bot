import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Outbox } from "../src/bale/outbox.js";
import type { Config } from "../src/config.js";
import type { ChatRepo, ScheduledTaskRow } from "../src/db.js";
import { HealthState } from "../src/health.js";
import { startHealthServer, type HealthServer } from "../src/healthServer.js";
import { RotatingFileSink } from "../src/logFile.js";
import type { Logger } from "../src/logger.js";
import type { OpenCodeClient } from "../src/opencode/client.js";
import { OpenCodeMonitor } from "../src/bridge/monitor.js";
import {
  describeSchedule,
  nextDailyRun,
  parseDuration,
  parseTaskCallback,
  parseTaskSchedule,
} from "../src/bridge/tasks.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

describe("task schedule parsing", () => {
  it("parses durations with a minimum of one minute", () => {
    expect(parseDuration("30s")).toBeNull();
    expect(parseDuration("15m")).toBe(15 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 60 * 60_000);
    expect(parseDuration("1d")).toBe(24 * 60 * 60_000);
    expect(parseDuration("5")).toBe(5 * 60_000);
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
  });

  it("parses interval schedules", () => {
    const now = 1_000_000;
    const parsed = parseTaskSchedule("every", "30m", now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.schedule).toEqual({
      kind: "interval",
      nextRunAt: now + 30 * 60_000,
      intervalMs: 30 * 60_000,
      dailyMinute: null,
    });
  });

  it("parses daily schedules in local time", () => {
    const now = new Date(2026, 10, 5, 10, 0, 0, 0).getTime();
    const parsed = parseTaskSchedule("daily", "09:30", now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.schedule.kind).toBe("daily");
    expect(parsed.schedule.dailyMinute).toBe(570);
    const next = new Date(parsed.schedule.nextRunAt);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
    expect(parsed.schedule.nextRunAt).toBeGreaterThan(now);

    const later = parseTaskSchedule("daily", "23:00", now);
    expect(later.ok && later.schedule.nextRunAt).toBe(new Date(2026, 10, 5, 23, 0).getTime());
    expect(parseTaskSchedule("daily", "24:00", now).ok).toBe(false);
    expect(parseTaskSchedule("daily", "noon", now).ok).toBe(false);
  });

  it("parses one-off absolute times", () => {
    const now = new Date(2026, 0, 1, 8, 0, 0, 0).getTime();
    const parsed = parseTaskSchedule("once", "2026-01-02 09:15", now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.schedule.nextRunAt).toBe(new Date(2026, 0, 2, 9, 15).getTime());
    expect(parseTaskSchedule("once", "2025-01-02 09:15", now).ok).toBe(false);
  });

  it("rolls a bare clock time to the next occurrence", () => {
    const morning = new Date(2026, 3, 1, 8, 0).getTime();
    const first = parseTaskSchedule("once", "09:00", morning);
    expect(first.ok && first.schedule.nextRunAt).toBe(new Date(2026, 3, 1, 9, 0).getTime());

    const evening = new Date(2026, 3, 1, 10, 0).getTime();
    const second = parseTaskSchedule("once", "09:00", evening);
    expect(second.ok && second.schedule.nextRunAt).toBe(new Date(2026, 3, 2, 9, 0).getTime());
  });

  it("parses relative one-off offsets", () => {
    const now = 5_000_000;
    const parsed = parseTaskSchedule("once", "in 45m", now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.schedule.nextRunAt).toBe(now + 45 * 60_000);
  });

  it("rejects unknown schedule kinds and phrases", () => {
    expect(parseTaskSchedule("sometimes", "1h").ok).toBe(false);
    expect(parseTaskSchedule("once", "whenever").ok).toBe(false);
  });

  it("parses task callbacks", () => {
    expect(parseTaskCallback("task:l")).toEqual({ kind: "list" });
    expect(parseTaskCallback("task:r:12")).toEqual({ kind: "run", id: 12 });
    expect(parseTaskCallback("task:p:3")).toEqual({ kind: "pause", id: 3 });
    expect(parseTaskCallback("task:u:3")).toEqual({ kind: "resume", id: 3 });
    expect(parseTaskCallback("task:x:3")).toEqual({ kind: "confirmDelete", id: 3 });
    expect(parseTaskCallback("task:X:3")).toEqual({ kind: "delete", id: 3 });
    expect(parseTaskCallback("task:r:0")).toBeNull();
    expect(parseTaskCallback("task:z:3")).toBeNull();
    expect(parseTaskCallback("set:l:fa")).toBeNull();
  });

  it("computes the next daily occurrence", () => {
    const now = new Date(2026, 0, 1, 10, 0).getTime();
    expect(nextDailyRun(600, now)).toBe(new Date(2026, 0, 1, 10, 0).getTime() + 24 * 60 * 60_000);
    expect(nextDailyRun(630, now)).toBe(new Date(2026, 0, 1, 10, 30).getTime());
  });

  it("describes schedules", () => {
    const base = row();
    expect(describeSchedule({ ...base, schedule_kind: "interval", interval_ms: 90 * 60_000 })).toBe(
      "every 1h 30m",
    );
    expect(describeSchedule({ ...base, schedule_kind: "daily", daily_minute: 570 })).toBe(
      "daily at 09:30",
    );
    expect(
      describeSchedule({
        ...base,
        schedule_kind: "once",
        next_run_at: new Date(2026, 0, 2, 9, 15).getTime(),
      }),
    ).toBe("once at 2026-01-02 09:15");
  });
});

function row(): ScheduledTaskRow {
  return {
    id: 1,
    chat_id: "chat",
    name: "Task",
    prompt: "Do it",
    project_directory: "/tmp",
    model_provider: "p",
    model_id: "m",
    agent: "build",
    schedule_kind: "interval",
    next_run_at: 0,
    interval_ms: 60_000,
    daily_minute: null,
    status: "active",
    running: 0,
    run_count: 0,
    last_run_at: null,
    last_finished_at: null,
    last_status: null,
    last_error: null,
    last_session_id: null,
    created_at: 0,
    updated_at: 0,
  };
}

describe("RotatingFileSink", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rotates by size and keeps only the configured number of files", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-log-"));
    dirs.push(dir);
    const path = join(dir, "bridge.log");
    const sink = new RotatingFileSink({ path, maxBytes: 200, maxFiles: 3 });
    for (let index = 0; index < 20; index += 1) {
      sink.write(`${String(index).padStart(2, "0")} ${"x".repeat(40)}`);
    }
    sink.close();

    const files = readdirSync(dir).sort();
    expect(files).toEqual(["bridge.log", "bridge.log.1", "bridge.log.2"]);
    for (const file of files) {
      const contents = readFileSync(join(dir, file), "utf8");
      expect(contents.length).toBeGreaterThan(0);
      expect(contents.length).toBeLessThanOrEqual(200 + 2);
    }
    expect(readFileSync(path, "utf8")).toContain("19");
  });
});

describe("health endpoints", () => {
  let server: HealthServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("reports liveness, readiness, and a full snapshot over loopback", async () => {
    const health = new HealthState("http://127.0.0.1:4096");
    health.botId = "1";
    health.opencodeReachable = false;
    health.pollerRunning = false;
    server = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      health,
      logger,
    });
    const base = `http://127.0.0.1:${server.port}`;

    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: "ok", pid: process.pid });

    const notReady = await fetch(`${base}/health/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toMatchObject({ ready: false });

    health.setOpenCode(true, { version: "2.2.5" });
    health.pollerRunning = true;
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ready: true,
      opencodeReachable: true,
      opencodeVersion: "2.2.5",
    });

    const full = await fetch(`${base}/health`);
    expect(full.status).toBe(200);
    expect(await full.json()).toMatchObject({
      status: "ok",
      ready: true,
      botId: "1",
      opencodeUrl: "http://127.0.0.1:4096",
    });

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    const post = await fetch(`${base}/health`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("marks OpenCode failures and recovers", () => {
    const health = new HealthState("http://127.0.0.1:4096");
    health.setOpenCode(false, { error: "ECONNREFUSED" });
    expect(health.opencodeReachable).toBe(false);
    expect(health.opencodeError).toBe("ECONNREFUSED");
    expect(health.isReady()).toBe(false);

    health.pollerRunning = true;
    health.setOpenCode(true, { version: "2.2.5" });
    expect(health.opencodeError).toBeNull();
    expect(health.isReady()).toBe(true);
  });
});
describe("OpenCodeMonitor", () => {
  function config(overrides: Partial<Config["opencode"]> = {}): Config {
    return {
      bale: {
        token: "token",
        baseUrl: "https://tapi.bale.ai/bot",
        allowedUserId: "1",
        pollTimeoutSec: 30,
        pollLimit: 50,
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "password",
        model: { providerID: "p", id: "m" },
        agent: "build",
        projectDirectory: "/tmp",
        requestTimeoutMs: 60_000,
        autoRestart: true,
        healthCheckMs: 30_000,
        restartCooldownMs: 10_000,
        restartMaxCooldownMs: 60_000,
        restartFailures: 1,
        restartTimeoutMs: 60_000,
        ...overrides,
      },
      bridge: {
        dbPath: "/tmp/bridge.sqlite",
        lockPath: "/tmp/bridge.sqlite.lock",
        editIntervalMs: 2_500,
        liveTextLimit: 2_000,
        delivery: "queue",
        logLevel: "info",
        logMaxBytes: 10 * 1024 * 1024,
        logMaxFiles: 5,
        healthHost: "127.0.0.1",
        healthPort: 4_097,
        taskTickMs: 15_000,
        taskTimeoutMs: 30 * 60_000,
        sessionTitlePrefix: "Bale",
        attachmentDir: "/tmp/attachments",
        attachmentMaxBytes: 15 * 1024 * 1024,
        attachmentTtlMs: 24 * 60 * 60_000,
      },
    };
  }

  function setup(overrides: Partial<Config["opencode"]> = {}) {
    const health = new HealthState("http://127.0.0.1:4096");
    const send = vi.fn(async () => undefined);
    const outbox = {
      forChat: () => ({ send }),
    } as unknown as Outbox;
    const chats = {
      list: () => [{ chat_id: "chat-1" }],
    } as unknown as ChatRepo;
    const info = vi.fn(async () => ({ version: "2.2.5" }));
    const client = { info } as unknown as OpenCodeClient;
    const monitor = new OpenCodeMonitor({
      client,
      health,
      chats,
      outbox,
      config: config(overrides),
      logger,
    });
    return { health, monitor, info, send };
  }

  it("records failures without restarting when automatic restart is off", async () => {
    const { health, monitor, send } = setup({ autoRestart: false });
    const info = (monitor as unknown as { options: { client: { info: ReturnType<typeof vi.fn> } } })
      .options.client.info;
    info.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    expect(await monitor.probeNow()).toBe(false);
    expect(health.opencodeReachable).toBe(false);
    expect(health.opencodeError).toBe("ECONNREFUSED");
    expect(health.restartCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not restart without a start command", async () => {
    const { health, monitor, info, send } = setup({ autoRestart: true });
    info.mockRejectedValueOnce(new Error("down"));

    expect(monitor.autoRestartEnabled).toBe(false);
    expect(await monitor.probeNow()).toBe(false);
    expect(health.restartCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses automatic restart after a manual stop", async () => {
    const { health, monitor, info, send } = setup({
      autoRestart: true,
      startCommand: "true",
    });
    info.mockRejectedValueOnce(new Error("stopped"));

    monitor.noteManualStop();
    expect(await monitor.probeNow()).toBe(false);
    expect(health.restartCount).toBe(0);
    expect(send).not.toHaveBeenCalled();

    monitor.noteManualStart();
    expect(await monitor.probeNow()).toBe(true);
    expect(health.opencodeReachable).toBe(true);
    expect(health.opencodeVersion).toBe("2.2.5");
  });

  it("restarts after the failure threshold and reports recovery", async () => {
    vi.useFakeTimers();
    try {
      const { health, monitor, info, send } = setup({
        autoRestart: true,
        startCommand: "true",
        restartFailures: 1,
        restartTimeoutMs: 5_000,
      });
      info.mockRejectedValueOnce(new Error("down"));

      const probe = monitor.probeNow();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(await probe).toBe(false);

      expect(health.restartCount).toBe(1);
      expect(health.restarting).toBe(false);
      expect(health.opencodeReachable).toBe(true);
      expect(health.opencodeVersion).toBe("2.2.5");
      expect(send).toHaveBeenCalledTimes(2);
      expect(health.isReady()).toBe(false);
      health.pollerRunning = true;
      expect(health.isReady()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
