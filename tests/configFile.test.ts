import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig, validateConfig } from "../src/config.js";
import {
  CONFIG_VERSION,
  readConfigFile,
  redactFileConfig,
  writeConfigFile,
  type FileConfig,
} from "../src/configFile.js";
import { resolvePaths } from "../src/paths.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "bridge-paths-"));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

describe("resolvePaths", () => {
  it("uses XDG defaults rooted at HOME", () => {
    const home = tempHome();
    const paths = resolvePaths({ env: {}, home, cwd: "/" });
    expect(paths.configFile).toBe(join(home, ".config", "opencode-bale-bot", "config.json"));
    expect(paths.stateDir).toBe(join(home, ".local", "state", "opencode-bale-bot"));
    expect(paths.dataDir).toBe(join(home, ".local", "share", "opencode-bale-bot"));
    expect(paths.dbPath).toBe(join(paths.dataDir, "bridge.sqlite"));
    expect(paths.lockPath).toBe(join(paths.stateDir, "bridge.lock"));
    expect(paths.attachmentDir).toBe(join(paths.dataDir, "attachments"));
    expect(paths.logFile).toBe(join(paths.stateDir, "bridge.log"));
  });

  it("honours XDG variables and explicit overrides", () => {
    const home = tempHome();
    const xdg = join(home, "xdg");
    const paths = resolvePaths({
      env: {
        XDG_CONFIG_HOME: join(xdg, "config"),
        XDG_STATE_HOME: join(xdg, "state"),
        XDG_DATA_HOME: join(xdg, "data"),
        BRIDGE_DB_PATH: join(home, "custom.sqlite"),
        BRIDGE_LOCK_PATH: join(home, "custom.lock"),
      },
      home,
      cwd: "/",
    });
    expect(paths.configFile).toBe(join(xdg, "config", "opencode-bale-bot", "config.json"));
    expect(paths.stateDir).toBe(join(xdg, "state", "opencode-bale-bot"));
    expect(paths.dataDir).toBe(join(xdg, "data", "opencode-bale-bot"));
    expect(paths.dbPath).toBe(join(home, "custom.sqlite"));
    expect(paths.lockPath).toBe(join(home, "custom.lock"));
  });

  it("lets --config move the config file and directory", () => {
    const home = tempHome();
    const custom = join(home, "elsewhere", "bridge.json");
    const paths = resolvePaths({ env: {}, home, cwd: "/", configPath: custom });
    expect(paths.configFile).toBe(custom);
    expect(paths.configDir).toBe(join(home, "elsewhere"));
  });

  it("is cwd-independent", () => {
    const home = tempHome();
    const fromRoot = resolvePaths({ env: {}, home, cwd: "/" });
    const fromHome = resolvePaths({ env: {}, home, cwd: join(home, "project") });
    expect(fromRoot).toEqual(fromHome);
  });
});

describe("config file", () => {
  it("loads every section and resolves relative paths against the config directory", () => {
    const home = tempHome();
    const configFile = join(home, "cfg", "config.json");
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    writeJson(configFile, {
      configVersion: CONFIG_VERSION,
      bale: {
        token: "file-token",
        allowedUserId: 123456789,
        pollLimit: 10,
      },
      opencode: {
        password: "file-password",
        model: { providerID: "provider", id: "model" },
        projectDirectory: project,
        agent: "plan",
      },
      bridge: {
        dbPath: "state/bridge.sqlite",
        logLevel: "debug",
        healthPort: 0,
        delivery: "steer",
      },
    } satisfies FileConfig);

    const result = validateConfig({
      env: {},
      home,
      cwd: "/",
      configPath: configFile,
    });
    expect(result.problems).toEqual([]);
    const config = result.config!;
    expect(config.bale.token).toBe("file-token");
    expect(config.bale.allowedUserId).toBe("123456789");
    expect(config.bale.pollLimit).toBe(10);
    expect(config.opencode.password).toBe("file-password");
    expect(config.opencode.model).toEqual({ providerID: "provider", id: "model" });
    expect(config.opencode.agent).toBe("plan");
    expect(config.bridge.dbPath).toBe(join(home, "cfg", "state", "bridge.sqlite"));
    expect(config.bridge.logLevel).toBe("debug");
    expect(config.bridge.healthPort).toBe(0);
    expect(config.bridge.delivery).toBe("steer");
  });

  it("applies flag > environment > file > default precedence", () => {
    const home = tempHome();
    const configFile = join(home, "config.json");
    writeJson(configFile, {
      bale: {
        token: "file-token",
        allowedUserId: "111",
        pollLimit: 7,
      },
      opencode: {
        password: "file-password",
        model: "file/model",
        projectDirectory: home,
      },
    });

    const config = loadConfig({
      env: {
        BALE_BOT_TOKEN: "env-token",
        BALE_ALLOWED_USER_ID: "222",
        OPENCODE_PASSWORD: "env-password",
        OPENCODE_MODEL: "env/model",
        PROJECT_DIRECTORY: home,
        BRIDGE_HEALTH_PORT: "5000",
      },
      home,
      cwd: "/",
      configPath: configFile,
      flags: {
        BALE_ALLOWED_USER_ID: "333",
        BRIDGE_HEALTH_PORT: 6000,
      },
    });

    expect(config.bale.token).toBe("env-token");
    expect(config.bale.allowedUserId).toBe("333");
    expect(config.bale.pollLimit).toBe(7);
    expect(config.opencode.password).toBe("env-password");
    expect(config.opencode.model).toEqual({ providerID: "env", id: "model" });
    expect(config.bridge.healthPort).toBe(6_000);
  });

  it("reads a secret from a file path relative to the config file", () => {
    const home = tempHome();
    const configDir = join(home, "cfg");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "token.txt"), "secret-from-file\n", { mode: 0o600 });
    const configFile = join(configDir, "config.json");
    writeJson(configFile, {
      bale: { tokenFile: "token.txt", allowedUserId: "1" },
      opencode: { password: "pw", model: "p/m", projectDirectory: home },
    });

    const config = loadConfig({ env: {}, home, cwd: "/", configPath: configFile });
    expect(config.bale.token).toBe("secret-from-file");
  });

  it("reports a group-readable config file with a repair hint", () => {
    if (process.platform === "win32") {
      return;
    }
    const home = tempHome();
    const configFile = join(home, "config.json");
    writeJson(configFile, {
      bale: { token: "t", allowedUserId: "1" },
      opencode: { password: "pw", model: "p/m", projectDirectory: home },
    });
    chmodSync(configFile, 0o644);

    const result = validateConfig({ env: {}, home, cwd: "/", configPath: configFile });
    expect(result.problems.join("\n")).toContain("readable by other users");
    expect(result.problems.join("\n")).toContain("chmod 600");
  });

  it("reports invalid JSON exactly once with a repair hint", () => {
    const home = tempHome();
    const configFile = join(home, "config.json");
    writeFileSync(configFile, "{ nope", { mode: 0o600 });
    const result = readConfigFile(configFile);
    expect(result.exists).toBe(true);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("not valid JSON");
    expect(result.problems[0]).toContain("config edit");
  });

  it("does not cascade missing-value errors after a parse failure", () => {
    const home = tempHome();
    const configFile = join(home, "config.json");
    writeFileSync(configFile, "{ nope", { mode: 0o600 });
    const result = validateConfig({
      env: {},
      home,
      cwd: "/",
      configPath: configFile,
    });
    expect(result.config).toBeNull();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("not valid JSON");
  });

  it("warns about unknown keys without failing", () => {
    const home = tempHome();
    const configFile = join(home, "config.json");
    writeJson(configFile, {
      bale: { token: "t", allowedUserId: "1", surprise: true },
      opencode: { password: "pw", model: "p/m", projectDirectory: home },
    });
    const result = validateConfig({ env: {}, home, cwd: "/", configPath: configFile });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toContain("unknown configuration key: bale.surprise");
  });

  it("writes atomically with mode 0600 and round-trips", () => {
    if (process.platform === "win32") {
      return;
    }
    const home = tempHome();
    const configFile = join(home, "opencode-bale-bot", "config.json");
    const data: FileConfig = {
      configVersion: CONFIG_VERSION,
      bale: { token: "secret", allowedUserId: "1" },
    };
    writeConfigFile(configFile, data);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "opencode-bale-bot")).mode & 0o777).toBe(0o700);
    expect(readFileSync(configFile, "utf8")).toBe(`${JSON.stringify(data, null, 2)}\n`);
    expect(readConfigFile(configFile).problems).toEqual([]);
  });

  it("redacts secrets in a printable copy", () => {
    const data: FileConfig = {
      bale: { token: "secret-token", tokenFile: "token.txt" },
      opencode: { password: "secret-password", passwordFile: "pw.txt" },
    };
    const redacted = redactFileConfig(data);
    expect(redacted.bale?.token).toBe("[redacted]");
    expect(redacted.opencode?.password).toBe("[redacted]");
    expect(redacted.bale?.tokenFile).toBe("token.txt");
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("secret-password");
  });

  it("can skip the config file for one call", () => {
    const home = tempHome();
    const configFile = join(home, "config.json");
    writeJson(configFile, { bale: { token: "t" } });
    const result = validateConfig({
      env: { BALE_BOT_TOKEN: "env" },
      home,
      cwd: "/",
      configPath: configFile,
      skipConfigFile: true,
    });
    expect(result.file.exists).toBe(false);
  });
});