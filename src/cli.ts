import { spawn } from "node:child_process";
import { existsSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ConfigError,
  resolveRuntimeSettings,
  validateConfig,
  type LoadConfigOptions,
} from "./config.js";
import {
  ConfigWriteError,
  getByPath,
  readConfigFile,
  redactFileConfig,
  writeConfigFile,
  CONFIG_VERSION,
  type FileConfig,
} from "./configFile.js";
import { probeHealth } from "./healthClient.js";
import {
  isProcessAlive,
  readLock,
  removeStaleLock,
  verifyLockOwnership,
} from "./lock.js";
import {
  installService,
  restartService,
  serviceNames,
  serviceStatus,
  stopService,
  uninstallService,
  type ServiceStatusResult,
} from "./service.js";
import { formatDuration, sleep } from "./util.js";
import { packageVersion } from "./version.js";
import { EXIT } from "./exit.js";

export { EXIT };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

const VALUE_FLAGS = new Set([
  "config",
  "lines",
  "token-file",
  "user-id",
  "opencode-url",
  "opencode-username",
  "opencode-password-file",
  "model",
  "agent",
  "project",
  "health-port",
]);

const BOOLEAN_FLAGS = new Set([
  "json",
  "verbose",
  "quiet",
  "yes",
  "non-interactive",
  "dry-run",
  "force",
  "purge",
  "no-enable",
  "no-start",
  "follow",
  "bundle",
  "stdin",
  "token-stdin",
  "help",
  "version",
]);

const COMMANDS = [
  "setup",
  "start",
  "status",
  "stop",
  "restart",
  "logs",
  "config",
  "service",
  "doctor",
  "version",
  "help",
] as const;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-h") {
      flags.help = true;
      index += 1;
      continue;
    }
    if (token === "-v") {
      flags.version = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      if (name === "") {
        throw new UsageError("empty flag name");
      }
      if (name === "token" || name === "opencode-password") {
        throw new UsageError(
          `--${name} would expose a secret in the process list; use --${name}-file or the interactive prompt`,
        );
      }
      if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) {
        throw new UsageError(`unknown flag: --${name}`);
      }
      if (equals !== -1) {
        if (BOOLEAN_FLAGS.has(name)) {
          const value = token.slice(equals + 1);
          if (value !== "true" && value !== "false") {
            throw new UsageError(`--${name} does not take a value`);
          }
          flags[name] = value === "true";
        } else {
          flags[name] = token.slice(equals + 1);
        }
        index += 1;
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          throw new UsageError(`--${name} requires a value`);
        }
        flags[name] = value;
        index += 2;
        continue;
      }
      flags[name] = true;
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      throw new UsageError(`unknown flag: ${token}`);
    }
    positionals.push(token);
    index += 1;
  }

  const first = positionals[0];
  if (first !== undefined && !(COMMANDS as readonly string[]).includes(first)) {
    throw new UsageError(`unknown command: ${first}`);
  }

  return {
    command: first ?? "start",
    positionals: positionals.slice(first === undefined ? 0 : 1),
    flags,
  };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

function output(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function error(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

function optionsFrom(parsed: ParsedArgs): LoadConfigOptions {
  return {
    configPath: stringFlag(parsed, "config"),
    warn: (message) => error(`warning: ${message}`),
  };
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (caught) {
    if (caught instanceof UsageError) {
      error(`error: ${caught.message}`);
      error("Run `opencode-bale-bot --help` for usage.");
      return EXIT.USAGE;
    }
    throw caught;
  }

  if (booleanFlag(parsed, "version") || parsed.command === "version") {
    output(`${packageVersion()}`);
    return EXIT.OK;
  }

  if (booleanFlag(parsed, "help") || parsed.command === "help") {
    output(helpText(parsed.positionals[0]));
    return EXIT.OK;
  }

  try {
    switch (parsed.command) {
      case "start":
        return await commandStart(parsed);
      case "status":
        return await commandStatus(parsed);
      case "stop":
        return await commandStop(parsed);
      case "restart":
        return await commandRestart(parsed);
      case "logs":
        return await commandLogs(parsed);
      case "config":
        return await commandConfig(parsed);
      case "service":
        return await commandService(parsed);
      case "doctor": {
        const { runDoctor } = await import("./doctor.js");
        return await runDoctor(parsed);
      }
      case "setup": {
        const { runSetup } = await import("./setup.js");
        return await runSetup(parsed);
      }
      default:
        throw new UsageError(`unknown command: ${parsed.command}`);
    }
  } catch (caught) {
    if (caught instanceof UsageError) {
      error(`error: ${caught.message}`);
      return EXIT.USAGE;
    }
    if (caught instanceof ConfigWriteError) {
      error(`error: ${caught.message}`);
      return EXIT.FAILURE;
    }
    if (caught instanceof ConfigError) {
      error(caught.message);
      return EXIT.NOT_CONFIGURED;
    }
    error(`error: ${(caught as Error).message}`);
    return EXIT.FAILURE;
  }
}

async function commandStart(parsed: ParsedArgs): Promise<number> {
  if (parsed.positionals.length > 0) {
    throw new UsageError(`unexpected arguments after "start": ${parsed.positionals.join(" ")}`);
  }
  const { startDaemon } = await import("./daemon.js");
  const flags: Record<string, string> = {};
  if (booleanFlag(parsed, "verbose")) {
    flags.LOG_LEVEL = "debug";
  }
  if (booleanFlag(parsed, "quiet")) {
    flags.LOG_LEVEL = "error";
  }
  await startDaemon({
    configPath: stringFlag(parsed, "config"),
    flags,
  });
  return typeof process.exitCode === "number" ? process.exitCode : EXIT.OK;
}

interface StatusReport {
  readonly running: boolean;
  readonly source: "lock" | "health" | "none";
  readonly pid: number | null;
  readonly instance: string | null;
  readonly version: string | null;
  readonly startedAt: number | null;
  readonly uptimeSeconds: number | null;
  readonly configPath: string;
  readonly configExists: boolean;
  readonly issueCount: number;
  readonly dbPath: string;
  readonly lockPath: string;
  readonly health: {
    readonly enabled: boolean;
    readonly url: string;
    readonly reachable: boolean;
    readonly ready: boolean | null;
    readonly status: number | null;
    readonly error: string | null;
  };
  readonly opencode: {
    readonly url: string | null;
    readonly version: string | null;
    readonly reachable: boolean | null;
    readonly error: string | null;
  };
  readonly bot: { readonly id: string | null; readonly username: string | null };
  readonly poller: { readonly running: boolean; readonly lastUpdateAt: number | null };
  readonly sse: { readonly connected: boolean };
  readonly tasks: { readonly active: number; readonly running: number };
  readonly service: ServiceStatusResult;
  readonly warnings: readonly string[];
}

async function gatherStatus(parsed: ParsedArgs): Promise<StatusReport> {
  const settings = resolveRuntimeSettings(optionsFrom(parsed));
  const lock = readLock(settings.paths.lockPath);
  const ownership = lock ? verifyLockOwnership(lock) : null;
  const warnings: string[] = [...settings.configProblems, ...settings.warnings];
  const probe = settings.healthPort > 0
    ? await probeHealth({ host: settings.healthHost, port: settings.healthPort })
    : null;

  if (lock && ownership === "dead") {
    warnings.push(`stale lock at ${settings.paths.lockPath} (pid ${lock.pid} is gone)`);
  }
  if (lock && ownership === "mismatch") {
    warnings.push(
      `the lock at ${settings.paths.lockPath} points at pid ${lock.pid}, but that PID now belongs to a different process`,
    );
  }

  const body = probe?.body;
  const healthPid = typeof body?.pid === "number" ? body.pid : null;
  const healthInstance = typeof body?.instance === "string" ? body.instance : "";
  const healthMatchesLock =
    lock !== null &&
    probe?.ok === true &&
    ((healthPid !== null && healthPid === lock.pid) ||
      (healthInstance !== "" && healthInstance === lock.instance));
  if (lock && probe?.ok === true && !healthMatchesLock) {
    warnings.push(
      "the health endpoint answered but does not match the lock; another instance may be using this port",
    );
  }

  const lockAlive = lock !== null && ownership !== "dead" && ownership !== "mismatch";
  const running = lockAlive || probe?.ok === true;
  const source: StatusReport["source"] = lockAlive
    ? "lock"
    : probe?.ok === true
      ? "health"
      : "none";

  const effectivePid = lockAlive ? lock?.pid ?? null : (healthPid ?? null);
  const service = serviceStatus({ paths: settings.paths });
  const healthEnabled = settings.healthPort > 0;

  const startedAt =
    lockAlive && lock !== null && lock.startedAt > 0
      ? lock.startedAt
      : typeof body?.startedAt === "number"
        ? body.startedAt
        : null;

  return {
    running,
    source,
    pid: effectivePid,
    instance: lockAlive ? (lock?.instance ?? null) : healthInstance || null,
    version: lockAlive ? (lock?.version || null) : (typeof body?.version === "string" ? body.version : null),
    startedAt,
    uptimeSeconds:
      startedAt !== null ? Math.max(0, Math.round((Date.now() - startedAt) / 1_000)) : null,
    configPath: settings.paths.configFile,
    configExists: existsSync(settings.paths.configFile),
    issueCount: warnings.length,
    dbPath: settings.paths.dbPath,
    lockPath: settings.paths.lockPath,
    health: {
      enabled: healthEnabled,
      url: `http://${settings.healthHost.includes(":") ? `[${settings.healthHost}]` : settings.healthHost}:${settings.healthPort}/health`,
      reachable: probe?.ok === true,
      ready: typeof body?.ready === "boolean" ? body.ready : null,
      status: probe?.status ?? null,
      error: probe?.error ?? null,
    },
    opencode: {
      url: typeof body?.opencodeUrl === "string" ? body.opencodeUrl : null,
      version: typeof body?.opencodeVersion === "string" ? body.opencodeVersion : null,
      reachable:
        typeof body?.opencodeReachable === "boolean" ? body.opencodeReachable : null,
      error: typeof body?.opencodeError === "string" ? body.opencodeError : null,
    },
    bot: {
      id: typeof body?.botId === "string" ? body.botId : null,
      username: typeof body?.botUsername === "string" ? body.botUsername : null,
    },
    poller: {
      running: body?.pollerRunning === true,
      lastUpdateAt: typeof body?.lastUpdateAt === "number" ? body.lastUpdateAt : null,
    },
    sse: { connected: body?.sseConnected === true },
    tasks: {
      active: typeof body?.tasksActive === "number" ? body.tasksActive : 0,
      running: typeof body?.tasksRunning === "number" ? body.tasksRunning : 0,
    },
    service,
    warnings,
  };
}

function printStatus(report: StatusReport): void {
  const lines: string[] = [];
  lines.push("OpenCode Bale bot");
  lines.push(`  status: ${report.running ? "running" : "stopped"} (${report.source})`);
  if (report.pid !== null) {
    lines.push(`  pid: ${report.pid}`);
  }
  if (report.version) {
    lines.push(`  version: ${report.version}`);
  }
  if (report.uptimeSeconds !== null) {
    lines.push(`  uptime: ${formatDuration(report.uptimeSeconds * 1_000)}`);
  }
  lines.push(`  config: ${report.configPath}${report.configExists ? "" : " (missing)"}`);
  lines.push(`  db: ${report.dbPath}`);
  lines.push(
    `  health: ${
      report.health.enabled
        ? `${report.health.url} (${report.health.reachable ? "reachable" : "unreachable"})`
        : "disabled"
    }`,
  );
  if (report.health.enabled && report.health.error) {
    lines.push(`  health error: ${report.health.error}`);
  }
  if (report.opencode.url) {
    lines.push(
      `  opencode: ${report.opencode.url} (${report.opencode.reachable === false ? "unreachable" : "reachable"}${report.opencode.version ? `, ${report.opencode.version}` : ""})`,
    );
  }
  if (report.bot.username || report.bot.id) {
    lines.push(`  bot: ${report.bot.username ? `@${report.bot.username}` : report.bot.id}`);
  }
  lines.push(`  poller: ${report.poller.running ? "running" : "stopped"}`);
  lines.push(`  sse: ${report.sse.connected ? "connected" : "disconnected"}`);
  lines.push(
    `  scheduled tasks: ${report.tasks.active} active, ${report.tasks.running} running`,
  );
  lines.push(
    `  service: ${report.service.manager} — ${report.service.detail}${report.service.enabled ? ", enabled" : ""}`,
  );
  for (const warning of report.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  output(lines.join("\n"));
}

async function commandStatus(parsed: ParsedArgs): Promise<number> {
  const report = await gatherStatus(parsed);
  if (booleanFlag(parsed, "json")) {
    outputJson(report);
  } else {
    printStatus(report);
  }

  if (!report.running) {
    return EXIT.NOT_RUNNING;
  }
  if (report.warnings.length > 0) {
    return EXIT.UNHEALTHY;
  }
  if (report.health.enabled && !report.health.reachable) {
    return EXIT.UNHEALTHY;
  }
  if (report.health.ready === false) {
    return EXIT.UNHEALTHY;
  }
  return EXIT.OK;
}

async function commandStop(parsed: ParsedArgs): Promise<number> {
  const settings = resolveRuntimeSettings(optionsFrom(parsed));
  const json = booleanFlag(parsed, "json");
  const force = booleanFlag(parsed, "force");
  const service = serviceStatus({ paths: settings.paths });
  let lock = readLock(settings.paths.lockPath);

  if (!lock) {
    const probe = settings.healthPort > 0
      ? await probeHealth({ host: settings.healthHost, port: settings.healthPort })
      : null;
    const pid = typeof probe?.body?.pid === "number" ? probe.body.pid : null;
    if (probe?.ok === true && pid !== null && isProcessAlive(pid)) {
      lock = {
        pid,
        startedAt: typeof probe.body?.startedAt === "number" ? probe.body.startedAt : 0,
        instance: typeof probe.body?.instance === "string" ? probe.body.instance : "",
        version: typeof probe.body?.version === "string" ? probe.body.version : "",
        procStart: null,
      };
    } else {
      if (json) {
        outputJson({ stopped: false, reason: "not running" });
      } else {
        output("The bridge is not running.");
      }
      return EXIT.NOT_RUNNING;
    }
  }

  const ownership = verifyLockOwnership(lock);
  if (ownership === "dead") {
    removeStaleLock(settings.paths.lockPath);
    if (json) {
      outputJson({ stopped: false, reason: "not running", staleLockRemoved: true });
    } else {
      output("The bridge is not running; removed a stale lock.");
    }
    return EXIT.NOT_RUNNING;
  }
  if (ownership === "mismatch") {
    error(
      `Refusing to signal pid ${lock.pid}: the PID belongs to a different process than the one that wrote ${settings.paths.lockPath}.`,
    );
    return EXIT.FAILURE;
  }
  if (ownership === "unknown" && lock.instance !== "") {
    const probe = settings.healthPort > 0
      ? await probeHealth({ host: settings.healthHost, port: settings.healthPort })
      : null;
    const instanceMatches = probe?.body?.instance === lock.instance;
    if (!instanceMatches && probe?.ok !== true) {
      error(
        "Refusing to signal the recorded PID because its start time could not be verified and the health endpoint did not confirm the instance.",
      );
      return EXIT.FAILURE;
    }
  }

  if (service.installed && service.active) {
    stopService({ paths: settings.paths, dryRun: false });
  } else {
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        error(`Permission denied while stopping pid ${lock.pid}.`);
        return EXIT.FAILURE;
      }
      if (code !== "ESRCH") {
        error(`Could not stop pid ${lock.pid}: ${(caught as Error).message}`);
        return EXIT.FAILURE;
      }
    }
  }

  const exited = await waitForExit(lock.pid, force ? 10_000 : 15_000, force);
  if (!exited) {
    error(`The bridge (pid ${lock.pid}) did not exit in time.`);
    return EXIT.FAILURE;
  }
  removeStaleLock(settings.paths.lockPath);

  if (json) {
    outputJson({ stopped: true, pid: lock.pid, method: service.active ? "service" : "signal" });
  } else {
    output(`Stopped the bridge (pid ${lock.pid}).`);
  }
  return EXIT.OK;
}

async function waitForExit(pid: number, timeoutMs: number, force: boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(150);
  }
  if (force) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return !isProcessAlive(pid);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!isProcessAlive(pid)) {
        return true;
      }
      await sleep(100);
    }
  }
  return !isProcessAlive(pid);
}

async function commandRestart(parsed: ParsedArgs): Promise<number> {
  const settings = resolveRuntimeSettings(optionsFrom(parsed));
  const service = serviceStatus({ paths: settings.paths });
  if (service.installed) {
    const result = restartService({ paths: settings.paths, dryRun: booleanFlag(parsed, "dry-run") });
    if (booleanFlag(parsed, "json")) {
      outputJson(result);
    } else {
      for (const command of result.commands) {
        output(`$ ${command}`);
      }
      for (const warning of result.warnings) {
        error(`warning: ${warning}`);
      }
    }
    return result.warnings.length > 0 ? EXIT.FAILURE : EXIT.OK;
  }

  const stopped = await commandStop(parsed);
  if (stopped !== EXIT.OK && stopped !== EXIT.NOT_RUNNING) {
    return stopped;
  }
  output("The bridge is not managed by a service. Start it again with:");
  output("  opencode-bale-bot start");
  return EXIT.OK;
}

async function commandLogs(parsed: ParsedArgs): Promise<number> {
  const settings = resolveRuntimeSettings(optionsFrom(parsed));
  const service = serviceStatus({ paths: settings.paths });
  const follow = booleanFlag(parsed, "follow");
  const lines = stringFlag(parsed, "lines") ?? "200";

  if (service.manager === "systemd" && service.installed) {
    const args = ["--user", "-u", serviceNames.systemdUnit, "-n", lines];
    if (follow) {
      args.push("-f");
    }
    return runStream("journalctl", args);
  }

  if (!existsSync(settings.logFile)) {
    error(`No log file at ${settings.logFile}. Start the bridge once, or install the service.`);
    return EXIT.FAILURE;
  }
  const args = follow ? ["-f", "-n", lines, settings.logFile] : ["-n", lines, settings.logFile];
  return runStream("tail", args);
}

function runStream(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", (caught) => {
      error(`Could not run ${command}: ${caught.message}`);
      resolvePromise(EXIT.FAILURE);
    });
    child.once("exit", (code) => {
      resolvePromise(code ?? EXIT.FAILURE);
    });
  });
}

async function commandConfig(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0] ?? "list";
  const rest = parsed.positionals.slice(1);
  const options = optionsFrom(parsed);
  const settings = resolveRuntimeSettings(options);
  const json = booleanFlag(parsed, "json");

  if (sub === "path") {
    if (json) {
      outputJson({ path: settings.paths.configFile, exists: existsSync(settings.paths.configFile) });
    } else {
      output(settings.paths.configFile);
    }
    return EXIT.OK;
  }

  if (sub === "validate") {
    const result = validateConfig(options);
    if (json) {
      outputJson({
        valid: result.problems.length === 0,
        configPath: result.paths.configFile,
        problems: result.problems,
        warnings: result.warnings,
      });
    } else {
      output(`Configuration: ${result.paths.configFile}`);
      if (result.problems.length === 0) {
        output("Valid.");
      } else {
        for (const problem of result.problems) {
          output(`  problem: ${problem}`);
        }
      }
      for (const warning of result.warnings) {
        output(`  warning: ${warning}`);
      }
    }
    return result.problems.length === 0 ? EXIT.OK : EXIT.NOT_CONFIGURED;
  }

  const read = readConfigFile(settings.paths.configFile);

  if (sub === "list" || sub === "show") {
    if (json) {
      outputJson({
        path: settings.paths.configFile,
        exists: read.exists,
        config: redactFileConfig(read.data),
        paths: {
          state: settings.paths.stateDir,
          data: settings.paths.dataDir,
          db: settings.paths.dbPath,
          lock: settings.paths.lockPath,
          log: settings.logFile,
        },
        problems: read.problems,
        warnings: read.warnings,
      });
    } else {
      output(`Configuration: ${settings.paths.configFile}${read.exists ? "" : " (missing)"}`);
      output(`State:         ${settings.paths.stateDir}`);
      output(`Data:          ${settings.paths.dataDir}`);
      output(`Database:      ${settings.paths.dbPath}`);
      output(`Log:           ${settings.logFile}`);
      output("");
      output(JSON.stringify(redactFileConfig(read.data), null, 2));
      for (const problem of read.problems) {
        output(`problem: ${problem}`);
      }
      for (const warning of read.warnings) {
        output(`warning: ${warning}`);
      }
    }
    return read.problems.length === 0 ? EXIT.OK : EXIT.NOT_CONFIGURED;
  }

  if (sub === "get") {
    const key = rest[0];
    if (!key) {
      throw new UsageError("config get requires a key, for example: bale.allowedUserId");
    }
    const value = getByPath(read.data, key);
    if (value === undefined) {
      error(`No value for ${key} in ${settings.paths.configFile}`);
      return EXIT.NOT_CONFIGURED;
    }
    const printable = redactValue(key, value);
    if (json) {
      outputJson({ key, value: printable });
    } else if (typeof printable === "string") {
      output(printable);
    } else {
      output(JSON.stringify(printable, null, 2));
    }
    return EXIT.OK;
  }

  if (sub === "set") {
    const key = rest[0];
    if (!key) {
      throw new UsageError(
        "config set requires a key, for example: config set bale.allowedUserId 123",
      );
    }
    const stdin = booleanFlag(parsed, "stdin");
    let raw = rest[1];
    if (stdin) {
      raw = await readStdin();
    }
    if (raw === undefined) {
      throw new UsageError("config set requires a value or --stdin");
    }
    const data = cloneConfig(read.data);
    setByPath(data as Record<string, unknown>, key, coerceValue(key, raw));
    if (!read.exists) {
      data.configVersion = data.configVersion ?? CONFIG_VERSION;
    }

    writeConfigFile(settings.paths.configFile, data);
    const after = validateConfig(options);
    if (after.problems.length > 0) {
      error(
        "The configuration was written, but it is not complete yet. Run `opencode-bale-bot config validate` after finishing setup.",
      );
      for (const problem of after.problems) {
        error(`  problem: ${problem}`);
      }
      return EXIT.NOT_CONFIGURED;
    }
    if (json) {
      outputJson({ updated: key, path: settings.paths.configFile });
    } else {
      output(`Updated ${key} in ${settings.paths.configFile}.`);
      output("Restart the service for the change to take effect: opencode-bale-bot service restart");
    }
    return EXIT.OK;
  }

  if (sub === "edit") {
    if (!read.exists) {
      writeConfigFile(settings.paths.configFile, { configVersion: CONFIG_VERSION });
    }
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const code = await runStream(editor, [settings.paths.configFile]);
    if (code !== EXIT.OK) {
      return code;
    }
    const after = validateConfig(options);
    if (after.problems.length > 0) {
      error("The configuration is not valid:");
      for (const problem of after.problems) {
        error(`  problem: ${problem}`);
      }
      return EXIT.NOT_CONFIGURED;
    }
    output("Configuration updated and valid. Restart the service for changes to take effect.");
    return EXIT.OK;
  }

  throw new UsageError(
    `unknown config subcommand: ${sub} (use list, get, set, edit, validate, or path)`,
  );
}

function cloneConfig(data: FileConfig): FileConfig {
  return JSON.parse(JSON.stringify(data)) as FileConfig;
}

function redactValue(key: string, value: unknown): unknown {
  if (key === "bale.token" || key === "opencode.password") {
    return "[redacted]";
  }
  return value;
}

function coerceValue(key: string, raw: string): string | number | boolean | unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed) && key !== "bale.token") {
    return Number(trimmed);
  }
  if (/^[{[].*[}\]]$/s.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").filter((segment) => segment !== "");
  if (segments.length === 0) {
    throw new UsageError("config key cannot be empty");
  }
  let current: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    const next = current[segment];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    } else if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      throw new UsageError(`${segments.slice(0, index + 1).join(".")} is not an object`);
    }
  }
  current[segments[segments.length - 1] as string] = value;
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.once("end", () => resolvePromise(data.trim()));
    process.stdin.once("error", reject);
    process.stdin.resume();
  });
}

async function commandService(parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0] ?? "status";
  const options = optionsFrom(parsed);
  const settings = resolveRuntimeSettings(options);
  const json = booleanFlag(parsed, "json");
  const dryRun = booleanFlag(parsed, "dry-run");

  if (sub === "install") {
    const result = installService({
      paths: settings.paths,
      dryRun,
      force: booleanFlag(parsed, "force"),
      enable: !booleanFlag(parsed, "no-enable"),
      start: !booleanFlag(parsed, "no-start"),
    });
    if (json) {
      outputJson(result);
    } else {
      output(`Service manager: ${result.manager}`);
      if (dryRun) {
        output("Dry run: nothing was written.");
        output("");
        output(result.content);
      } else {
        output(`Wrote ${result.file}`);
      }
      for (const command of result.commands) {
        output(`$ ${command}`);
      }
      for (const warning of result.warnings) {
        error(`warning: ${warning}`);
      }
      if (result.installed && !dryRun) {
        output("");
        output("Next steps:");
        output("  opencode-bale-bot doctor");
        output("  opencode-bale-bot status");
      }
    }
    if (result.manager === "unsupported") {
      return EXIT.FAILURE;
    }
    return result.warnings.some((warning) => warning.includes("already exists"))
      ? EXIT.FAILURE
      : EXIT.OK;
  }

  if (sub === "uninstall") {
    const result = uninstallService({ paths: settings.paths, dryRun });
    if (!dryRun) {
      if (booleanFlag(parsed, "purge")) {
        rmSync(settings.paths.configFile, { force: true });
        // Remove the config directory only if it is now empty. A custom
        // --config may live in a shared folder that must survive a purge.
        try {
          rmdirSync(settings.paths.configDir);
        } catch {
          // Not empty, already gone, or not removable: leave it alone.
        }
        rmSync(settings.paths.stateDir, { recursive: true, force: true });
        rmSync(settings.paths.dataDir, { recursive: true, force: true });
      }
    }
    if (json) {
      outputJson({ ...result, purged: booleanFlag(parsed, "purge") && !dryRun });
    } else {
      for (const command of result.commands) {
        output(`$ ${command}`);
      }
      if (dryRun && booleanFlag(parsed, "purge")) {
        output("Dry run: nothing was removed.");
      } else {
        output(booleanFlag(parsed, "purge") ? "Service and local data removed." : "Service removed.");
      }
    }
    return result.manager === "unsupported" ? EXIT.FAILURE : EXIT.OK;
  }

  if (sub === "status") {
    const status = serviceStatus({ paths: settings.paths });
    if (json) {
      outputJson(status);
    } else {
      output(`Service manager: ${status.manager}`);
      output(`Unit:           ${status.installed ? status.file : "not installed"}`);
      output(`State:          ${status.detail}`);
      output(`Enabled:        ${status.enabled ? "yes" : "no"}`);
    }
    return status.installed && status.active ? EXIT.OK : EXIT.NOT_RUNNING;
  }

  if (sub === "restart") {
    const result = restartService({ paths: settings.paths, dryRun });
    if (json) {
      outputJson(result);
    } else {
      for (const command of result.commands) {
        output(`$ ${command}`);
      }
      for (const warning of result.warnings) {
        error(`warning: ${warning}`);
      }
    }
    return result.warnings.length > 0 ? EXIT.FAILURE : EXIT.OK;
  }

  if (sub === "logs") {
    return commandLogs(parsed);
  }

  throw new UsageError(`unknown service subcommand: ${sub} (use install, uninstall, status, restart, or logs)`);
}

export function helpText(command?: string): string {
  const header = `opencode-bale-bot ${packageVersion()} — Bale Messenger bridge for OpenCode`;
  if (command === "config") {
    return [
      header,
      "",
      "Usage: opencode-bale-bot config <list|get|set|edit|validate|path>",
      "",
      "  list|show        Print the redacted configuration and resolved paths",
      "  get <key>        Print one value, for example bale.allowedUserId",
      "  set <key> [val]  Write one value atomically; use --stdin for secrets",
      "  edit             Open the config file in $VISUAL or $EDITOR",
      "  validate         Check every required value",
      "  path             Print the config file path",
      "",
    ].join("\n");
  }
  if (command === "service") {
    return [
      header,
      "",
      "Usage: opencode-bale-bot service <install|uninstall|status|restart|logs>",
      "",
      "  install          Write and start the systemd user unit or launchd agent",
      "  uninstall        Stop and remove the unit; --purge also removes the config file and local data",
      "  status           Show whether the unit is installed, active, and enabled",
      "  restart          Restart through the service manager",
      "  logs             Follow the service log (--follow, --lines N)",
      "",
      "Options: --dry-run, --force, --no-enable, --no-start, --purge, --json",
      "",
    ].join("\n");
  }
  if (command === "setup" || command === "doctor") {
    return [
      header,
      "",
      `Usage: opencode-bale-bot ${command} [options]`,
      "",
      command === "setup"
        ? [
            "  --token-file <path>            Read the Bale bot token from a file",
            "  --token-stdin                  Read the Bale bot token from stdin",
            "  --user-id <id>                 Bale user ID allowed to control the bot",
            "  --opencode-url <url>           OpenCode server URL",
            "  --opencode-username <name>     OpenCode Basic-auth username",
            "  --opencode-password-file <p>   Read the OpenCode password from a file",
            "  --model <provider/id>          Model to use",
            "  --agent <name>                 Agent to use (default build)",
            "  --project <path>               Project directory for new sessions",
            "  --health-port <port>           Loopback health port; 0 disables it",
            "  --non-interactive --yes        Never prompt; require every value",
          ].join("\n")
        : [
            "  --json                         Emit a stable machine-readable report",
            "  --bundle                       Write a redacted support bundle",
          ].join("\n"),
      "",
    ].join("\n");
  }

  return [
    header,
    "",
    "Usage:",
    "  opencode-bale-bot [start]            Start the bridge in the foreground",
    "  opencode-bale-bot setup              Configure the bot interactively",
    "  opencode-bale-bot status [--json]    Show the running instance",
    "  opencode-bale-bot stop [--force]     Stop the instance",
    "  opencode-bale-bot restart            Restart through the service manager",
    "  opencode-bale-bot logs [--follow]    Read the service or file log",
    "  opencode-bale-bot config <command>   Read, write, or validate configuration",
    "  opencode-bale-bot service <command>  Install and manage the daemon",
    "  opencode-bale-bot doctor [--json]    Diagnose configuration and connectivity",
    "  opencode-bale-bot version | --version",
    "  opencode-bale-bot help [command]",
    "",
    "Global options:",
    "  --config <path>   Use a specific configuration file",
    "  --json            Machine-readable output where supported",
    "  --verbose         Log at debug level when starting",
    "  --quiet           Log only errors when starting",
    "  --yes             Accept defaults in setup",
    "",
    "Exit codes: 0 ok, 1 failure, 2 usage, 3 not configured,",
    "            4 not running, 5 unhealthy, 78 unsupported Node.",
    "",
    "The daemon must run from a stable install (npm install -g), not npx.",
    "",
  ].join("\n");
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (caught: NodeJS.ErrnoException) => {
      // A closed pipe (`opencode-bale-bot logs | head`) is not an error.
      if (caught.code === "EPIPE") {
        process.exit(0);
      }
      throw caught;
    });
  }
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

