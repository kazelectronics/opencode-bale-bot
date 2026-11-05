import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, parseArgs, EXIT, UsageError } from "../src/cli.js";
import { acquireLock, readLock, removeStaleLock } from "../src/lock.js";
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdUnitPath,
  installService,
  uninstallService,
  serviceStatus,
} from "../src/service.js";
import { resolvePaths } from "../src/paths.js";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  homes.push(home);
  return home;
}

function completeConfigFile(home: string): string {
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const path = join(home, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        configVersion: 1,
        bale: { token: "secret-token", allowedUserId: "123456789" },
        opencode: {
          password: "secret-password",
          model: "provider/model",
          projectDirectory: project,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseArgs", () => {
  it("defaults to start and parses flags", () => {
    expect(parseArgs([]).command).toBe("start");
    const parsed = parseArgs(["status", "--json", "--config", "/tmp/x"]);
    expect(parsed.command).toBe("status");
    expect(parsed.flags.json).toBe(true);
    expect(parsed.flags.config).toBe("/tmp/x");
  });

  it("supports --flag=value", () => {
    const parsed = parseArgs(["setup", "--model=provider/model", "--non-interactive"]);
    expect(parsed.flags.model).toBe("provider/model");
    expect(parsed.flags["non-interactive"]).toBe(true);
  });

  it("rejects unknown commands and flags", () => {
    expect(() => parseArgs(["nope"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "--nope"])).toThrow(UsageError);
  });

  it("refuses secrets in argv", () => {
    expect(() => parseArgs(["setup", "--token", "secret"])).toThrow(/process list/);
  });
});

describe("lock", () => {
  it("writes JSON with mode 0600 and round-trips", () => {
    if (process.platform === "win32") {
      return;
    }
    const home = tempHome();
    const path = join(home, "state", "bridge.lock");
    const lock = acquireLock(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const info = readLock(path);
    expect(info?.pid).toBe(process.pid);
    expect(info?.instance).toBe(lock.info.instance);
    expect(info?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    lock.release();
    expect(readLock(path)).toBeNull();
  });

  it("refuses a second live lock", () => {
    const home = tempHome();
    const path = join(home, "bridge.lock");
    const lock = acquireLock(path);
    expect(() => acquireLock(path)).toThrow(/already running/);
    lock.release();
  });

  it("replaces a stale lock whose PID is gone", () => {
    const home = tempHome();
    const path = join(home, "bridge.lock");
    writeFileSync(
      path,
      `${JSON.stringify({ pid: 999_999, startedAt: Date.now(), instance: "x", version: "0", procStart: null })}\n`,
    );
    expect(removeStaleLock(path)).toBe(true);
    const lock = acquireLock(path);
    expect(readLock(path)?.pid).toBe(process.pid);
    lock.release();
  });
});

describe("service rendering", () => {
  it("renders a systemd user unit with absolute paths and hardening", () => {
    const unit = renderSystemdUnit({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/open code/dist/cli.js",
      configPath: "/home/a b/config.json",
      home: "/home/a b",
    });
    expect(unit).toContain("ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning \"/opt/open code/dist/cli.js\" start");
    expect(unit).toContain('Environment="OPENCODE_BALE_CONFIG=/home/a b/config.json"');
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("Restart=on-failure");
  });

  it("renders a launchd plist", () => {
    const plist = renderLaunchdPlist({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/dist/cli.js",
      configPath: "/Users/a/config.json",
      stateDir: "/Users/a/Library/Application Support/opencode-bale-bot",
    });
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>com.opencode-bale-bot</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/dist/cli.js</string>");
  });

  it("puts the systemd unit under XDG_CONFIG_HOME", () => {
    const path = systemdUnitPath("/home/a", { XDG_CONFIG_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv);
    expect(path).toBe("/tmp/xdg/systemd/user/opencode-bale-bot.service");
  });

  it("installs, reports, and uninstalls a systemd unit with an injected runner", () => {
    if (process.platform !== "linux") {
      return;
    }
    const home = tempHome();
    const env = { XDG_CONFIG_HOME: join(home, ".config") } as NodeJS.ProcessEnv;
    const paths = resolvePaths({ env, home });
    const run = vi.fn(() => ({ status: 0, stdout: "active", stderr: "" }));

    const dry = installService({
      paths,
      home,
      env,
      cliPath: "/opt/cli.js",
      nodePath: "/usr/bin/node",
      dryRun: true,
      run,
    });
    expect(dry.installed).toBe(false);
    expect(dry.content).toContain("ExecStart=/usr/bin/node");
    expect(existsSync(dry.file)).toBe(false);

    const installed = installService({
      paths,
      home,
      env,
      cliPath: "/opt/cli.js",
      nodePath: "/usr/bin/node",
      run,
    });
    expect(installed.installed).toBe(true);
    expect(readFileSync(installed.file, "utf8")).toContain("opencode-bale-bot");

    const status = serviceStatus({ paths, home, env, run });
    expect(status.installed).toBe(true);
    expect(status.active).toBe(true);

    uninstallService({ paths, home, env, run });
    expect(existsSync(installed.file)).toBe(false);
  });
});

describe("cli commands without a running instance", () => {
  function isolatedEnv(home: string): void {
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv("XDG_STATE_HOME", join(home, ".local", "state"));
    vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"));
    vi.stubEnv("BRIDGE_HEALTH_PORT", "0");
    vi.stubEnv("BRIDGE_DB_PATH", "");
    vi.stubEnv("BRIDGE_LOCK_PATH", "");
  }

  it("status exits 4 when nothing is running", async () => {
    const home = tempHome();
    isolatedEnv(home);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["status", "--json"]);
    expect(code).toBe(EXIT.NOT_RUNNING);
    const report = JSON.parse(writes.join("")) as {
      running: boolean;
      configPath: string;
      health: { enabled: boolean };
    };
    expect(report.running).toBe(false);
    expect(report.configPath).toBe(join(home, ".config", "opencode-bale-bot", "config.json"));
    expect(report.health.enabled).toBe(false);
  });

  it("stop exits 4 with no lock", async () => {
    const home = tempHome();
    isolatedEnv(home);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runCli(["stop", "--json"])).toBe(EXIT.NOT_RUNNING);
  });

  it("config validate reports a complete file", async () => {
    const home = tempHome();
    const path = completeConfigFile(home);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await runCli(["config", "validate", "--config", path]);
    expect(code).toBe(EXIT.OK);
    expect(writes.join("")).toContain("Valid.");
  });

  it("config get redacts secrets", async () => {
    const home = tempHome();
    const path = completeConfigFile(home);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    expect(await runCli(["config", "get", "bale.token", "--config", path])).toBe(EXIT.OK);
    expect(writes.join("")).toContain("[redacted]");
    expect(writes.join("")).not.toContain("secret-token");
  });

  it("config set writes atomically and preserves other values", async () => {
    const home = tempHome();
    const path = completeConfigFile(home);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await runCli(["config", "set", "bridge.healthPort", "5001", "--config", path]),
    ).toBe(EXIT.OK);
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      bridge: { healthPort: number };
      bale: { token: string };
    };
    expect(saved.bridge.healthPort).toBe(5_001);
    expect(saved.bale.token).toBe("secret-token");
  });

  it("config path matches the path resolver", async () => {
    const home = tempHome();
    const custom = join(home, "custom.json");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    expect(await runCli(["config", "path", "--config", custom])).toBe(EXIT.OK);
    expect(writes.join("").trim()).toBe(custom);
    expect(resolvePaths({ configPath: custom }).configFile).toBe(custom);
  });
});