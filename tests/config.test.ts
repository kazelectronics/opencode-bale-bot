import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, redactConfig } from "../src/config.js";

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-config-"));
  return {
    env: {
      BALE_BOT_TOKEN: "123456:secret-token",
      BALE_ALLOWED_USER_ID: "123456789",
      OPENCODE_MODEL: "bailian-cli/deepseek-v4.1-flash-1017",
      OPENCODE_PASSWORD: "open-code-password",
      PROJECT_DIRECTORY: dir,
      BRIDGE_DB_PATH: join(dir, "bridge.sqlite"),
      ...overrides,
    } as NodeJS.ProcessEnv,
    cwd: dir,
    home: dir,
  };
}

describe("loadConfig", () => {
  it("loads a valid configuration with defaults", () => {
    const { env, cwd, home } = baseEnv();
    const config = loadConfig({ env, cwd, home });
    expect(config.bale.token).toBe("123456:secret-token");
    expect(config.bale.allowedUserId).toBe("123456789");
    expect(config.bale.baseUrl).toBe("https://tapi.bale.ai/bot");
    expect(config.bale.pollTimeoutSec).toBe(30);
    expect(config.bale.pollLimit).toBe(50);
    expect(config.opencode.model).toEqual({
      providerID: "bailian-cli",
      id: "deepseek-v4.1-flash-1017",
    });
    expect(config.bridge.editIntervalMs).toBe(1_500);
    expect(config.bridge.liveTextLimit).toBe(3_900);
    expect(config.bridge.delivery).toBe("queue");
    expect(config.bridge.logLevel).toBe("info");
    expect(config.bridge.healthHost).toBe("127.0.0.1");
    expect(config.bridge.healthPort).toBe(4_097);
    expect(config.bridge.taskTickMs).toBe(15_000);
    expect(config.bridge.taskTimeoutMs).toBe(30 * 60 * 1_000);
    expect(config.bridge.logFile).toBe(
      join(home, ".local", "state", "opencode-bale-bot", "bridge.log"),
    );
    expect(config.opencode.autoRestart).toBe(false);
    expect(config.opencode.healthCheckMs).toBe(30_000);
  });

  it("normalizes the Bale base URL exactly once", () => {
    expect(
      loadConfig(baseEnv({ BALE_API_BASE_URL: "https://example.test/" })).bale.baseUrl,
    ).toBe("https://example.test/bot");
    expect(
      loadConfig(baseEnv({ BALE_API_BASE_URL: "https://example.test/bot/" })).bale.baseUrl,
    ).toBe("https://example.test/bot");
  });

  it("accepts explicit tuning values", () => {
    const config = loadConfig(
      baseEnv({
        BRIDGE_EDIT_INTERVAL_MS: "2500",
        BRIDGE_LIVE_TEXT_LIMIT: "2000",
        BRIDGE_DELIVERY: "steer",
        LOG_LEVEL: "debug",
        BALE_POLL_LIMIT: "10",
        BRIDGE_HEALTH_PORT: "0",
        BRIDGE_HEALTH_HOST: "::1",
        BRIDGE_TASK_TICK_MS: "5000",
        BRIDGE_TASK_TIMEOUT_MIN: "90",
        BRIDGE_LOG_FILE: "logs/bridge.log",
        BRIDGE_LOG_MAX_MB: "20",
        BRIDGE_LOG_MAX_FILES: "3",
        OPENCODE_AUTO_RESTART: "true",
        OPENCODE_HEALTH_CHECK_MS: "15000",
        OPENCODE_RESTART_FAILURES: "3",
      }),
    );
    expect(config.bridge.editIntervalMs).toBe(2_500);
    expect(config.bridge.liveTextLimit).toBe(2_000);
    expect(config.bridge.delivery).toBe("steer");
    expect(config.bridge.logLevel).toBe("debug");
    expect(config.bale.pollLimit).toBe(10);
    expect(config.bridge.healthPort).toBe(0);
    expect(config.bridge.healthHost).toBe("::1");
    expect(config.bridge.taskTickMs).toBe(5_000);
    expect(config.bridge.taskTimeoutMs).toBe(90 * 60 * 1_000);
    expect(config.bridge.logFile).toMatch(/logs\/bridge\.log$/);
    expect(config.bridge.logMaxBytes).toBe(20 * 1024 * 1024);
    expect(config.bridge.logMaxFiles).toBe(3);
    expect(config.opencode.autoRestart).toBe(true);
    expect(config.opencode.healthCheckMs).toBe(15_000);
    expect(config.opencode.restartFailures).toBe(3);
  });

  it("reports every problem in one error", () => {
    let caught: ConfigError | null = null;
    try {
      loadConfig({
        env: {
          BALE_ALLOWED_USER_ID: "not-a-number",
          OPENCODE_MODEL: "missing-slash",
          OPENCODE_PASSWORD: "pw",
          PROJECT_DIRECTORY: tmpdir(),
          BRIDGE_EDIT_INTERVAL_MS: "10",
          BRIDGE_DELIVERY: "sometimes",
          LOG_LEVEL: "verbose",
          BRIDGE_HEALTH_HOST: "8.8.8.8",
          BRIDGE_HEALTH_PORT: "70000",
          OPENCODE_AUTO_RESTART: "maybe",
        } as NodeJS.ProcessEnv,
        cwd: tmpdir(),
        home: tmpdir(),
      });
    } catch (error) {
      caught = error as ConfigError;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const text = caught?.message ?? "";
    expect(text).toContain("BALE_BOT_TOKEN");
    expect(text).toContain("numeric Bale user ID");
    expect(text).toContain('OPENCODE_MODEL must be "providerID/modelID"');
    expect(text).toContain("BRIDGE_EDIT_INTERVAL_MS");
    expect(text).toContain("BRIDGE_DELIVERY");
    expect(text).toContain("LOG_LEVEL");
    expect(text).toContain("BRIDGE_HEALTH_HOST");
    expect(text).toContain("BRIDGE_HEALTH_PORT");
    expect(text).toContain("OPENCODE_AUTO_RESTART");
  });

  it("requires an explicit model", () => {
    expect(() =>
      loadConfig(baseEnv({ OPENCODE_MODEL: undefined })),
    ).toThrowError(/OPENCODE_MODEL is required/);
  });

  it("rejects a non-loopback OpenCode URL", () => {
    expect(() =>
      loadConfig(baseEnv({ OPENCODE_URL: "http://192.0.2.10:4096" })),
    ).toThrowError(/OPENCODE_URL must be a loopback address/);
    expect(() =>
      loadConfig(baseEnv({ OPENCODE_URL: "not a url" })),
    ).toThrowError(/OPENCODE_URL is not a valid URL/);
  });

  it("accepts IPv6 loopback with brackets", () => {
    const config = loadConfig(baseEnv({ OPENCODE_URL: "http://[::1]:4096" }));
    expect(config.opencode.baseUrl).toBe("http://[::1]:4096");
  });

  it("requires an existing project directory", () => {
    expect(() =>
      loadConfig(baseEnv({ PROJECT_DIRECTORY: join(tmpdir(), "does-not-exist-xyz") })),
    ).toThrowError(/PROJECT_DIRECTORY does not exist/);
  });

  it("redacts secrets", () => {
    const config = loadConfig(baseEnv());
    const redacted = redactConfig(config) as {
      bale: { token: string };
      opencode: { password: string };
    };
    expect(redacted.bale.token).toBe("[redacted]");
    expect(redacted.opencode.password).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("open-code-password");
  });
});