import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getByPath, readConfigFile, type ConfigFileReadResult } from "./configFile.js";
import { expandPath, resolvePaths, type ResolvedPaths } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Delivery = "queue" | "steer";

export interface Config {
  readonly bale: {
    readonly token: string;
    readonly baseUrl: string;
    readonly allowedUserId: string;
    readonly pollTimeoutSec: number;
    readonly pollLimit: number;
  };
  readonly opencode: {
    readonly baseUrl: string;
    readonly username: string;
    readonly password: string;
    readonly model: { readonly providerID: string; readonly id: string };
    readonly agent: string;
    readonly projectDirectory: string;
    readonly requestTimeoutMs: number;
    readonly startCommand?: string;
    readonly stopCommand?: string;
    readonly autoRestart: boolean;
    readonly healthCheckMs: number;
    readonly restartCooldownMs: number;
    readonly restartMaxCooldownMs: number;
    readonly restartFailures: number;
    readonly restartTimeoutMs: number;
  };
  readonly bridge: {
    readonly dbPath: string;
    readonly lockPath: string;
    readonly editIntervalMs: number;
    readonly liveTextLimit: number;
    readonly delivery: Delivery;
    readonly logLevel: LogLevel;
    readonly logFile?: string;
    readonly logMaxBytes: number;
    readonly logMaxFiles: number;
    readonly healthHost: string;
    readonly healthPort: number;
    readonly taskTickMs: number;
    readonly taskTimeoutMs: number;
    readonly sessionTitlePrefix: string;
    readonly attachmentDir: string;
    readonly attachmentMaxBytes: number;
    readonly attachmentTtlMs: number;
  };
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export interface LoadConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
  /** Explicit config path, equivalent to `--config`. */
  readonly configPath?: string;
  /**
   * Command-line overrides keyed by their environment-variable name, e.g.
   * `{ BALE_ALLOWED_USER_ID: "123" }`. Flags take precedence over everything.
   */
  readonly flags?: Partial<Record<string, string | number | boolean>>;
  /** Receives non-fatal configuration warnings (unknown keys and the like). */
  readonly warn?: (message: string) => void;
  /** Disable the config file for a single call. Mostly useful in tests. */
  readonly skipConfigFile?: boolean;
}

export interface PartialConfig {
  readonly paths: ResolvedPaths;
  readonly file: ConfigFileReadResult;
  readonly env: NodeJS.ProcessEnv;
  readonly warnings: readonly string[];
}

export interface ConfigValidation {
  readonly config: Config | null;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly paths: ResolvedPaths;
  readonly file: ConfigFileReadResult;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const DELIVERIES: readonly Delivery[] = ["queue", "steer"];
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1", "localhost"];

/**
 * True for the loopback names the bridge supports. WHATWG URL keeps the
 * brackets on an IPv6 hostname (`[::1]`), so strip them before comparing.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return LOOPBACK_HOSTS.includes(normalized);
}

type SourceKind = "flag" | "env" | "file" | "default";

interface Picked {
  readonly value: unknown;
  readonly source: SourceKind;
}

/**
 * Resolve paths and read the config file without requiring any secret. This is
 * the function `status` and `stop` use; it never throws for a bad config.
 */
export function loadPartialConfig(options: LoadConfigOptions = {}): PartialConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const paths = resolvePaths({ env, home, cwd, configPath: options.configPath });
  const file = options.skipConfigFile
    ? { path: paths.configFile, exists: false, data: {}, problems: [], warnings: [] }
    : readConfigFile(paths.configFile);
  return { paths, file, env, warnings: file.warnings };
}

/**
 * Full validation. Returns every problem at once so `doctor` and the wizard can
 * guide the user instead of failing on the first missing value.
 */
export function validateConfig(options: LoadConfigOptions = {}): ConfigValidation {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const paths = resolvePaths({ env, home, cwd, configPath: options.configPath });
  const file = options.skipConfigFile
    ? { path: paths.configFile, exists: false, data: {}, problems: [], warnings: [] }
    : readConfigFile(paths.configFile);
  const warnings = [...file.warnings];

  for (const warning of warnings) {
    options.warn?.(warning);
  }

  // A file that cannot be parsed or trusted is fatal on its own. Reporting the
  // missing values that follow from empty data would bury the real problem.
  if (file.problems.length > 0) {
    return { config: null, problems: [...file.problems], warnings, paths, file };
  }

  const problems: string[] = [];
  const configDir = dirname(paths.configFile);
  const flags = options.flags ?? {};

  const pick = (envName: string, filePath: string, fallback?: unknown): Picked => {
    if (Object.prototype.hasOwnProperty.call(flags, envName)) {
      const value = flags[envName];
      if (value !== undefined && value !== null) {
        return { value, source: "flag" };
      }
    }
    const envRaw = env[envName];
    if (envRaw !== undefined && envRaw.trim() !== "") {
      return { value: envRaw, source: "env" };
    }
    const fileRaw = getByPath(file.data, filePath);
    if (fileRaw !== undefined && fileRaw !== null && fileRaw !== "") {
      return { value: fileRaw, source: "file" };
    }
    return { value: fallback, source: "default" };
  };

  const baseFor = (source: SourceKind): string => (source === "file" ? configDir : cwd);

  const readPath = (label: string, picked: Picked): string | undefined => {
    if (picked.value === undefined || picked.value === null) {
      return undefined;
    }
    if (typeof picked.value !== "string" || picked.value.trim() === "") {
      problems.push(`${label} must be a file path string`);
      return undefined;
    }
    return expandPath(picked.value, baseFor(picked.source), home);
  };

  const readSecretFile = (
    label: string,
    path: string,
    problems_: string[],
  ): string | undefined => {
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (!raw) {
        problems_.push(`${label}: file is empty (${path})`);
        return undefined;
      }
      // The OpenCode service file is JSON; accept raw secrets too.
      if (raw.startsWith("{")) {
        try {
          const parsed = JSON.parse(raw) as { password?: unknown; token?: unknown };
          const value = parsed.password ?? parsed.token;
          if (typeof value === "string" && value.length > 0) {
            return value;
          }
          problems_.push(`${label}: JSON file has no password or token field (${path})`);
          return undefined;
        } catch {
          problems_.push(`${label}: file is not valid JSON (${path})`);
          return undefined;
        }
      }
      return raw;
    } catch (error) {
      problems_.push(`${label}: cannot read ${path}: ${(error as Error).message}`);
      return undefined;
    }
  };

  /** Direct value first, then an explicit file, for each precedence layer. */
  const pickSecret = (
    directEnv: string,
    fileEnv: string,
    directFileKey: string,
    fileFileKey: string,
    label: string,
  ): string | undefined => {
    const candidates: Array<{ value: unknown; source: SourceKind; isFile: boolean }> = [
      { value: flags[directEnv], source: "flag", isFile: false },
      { value: flags[fileEnv], source: "flag", isFile: true },
      { value: env[directEnv], source: "env", isFile: false },
      { value: env[fileEnv], source: "env", isFile: true },
      { value: getByPath(file.data, directFileKey), source: "file", isFile: false },
      { value: getByPath(file.data, fileFileKey), source: "file", isFile: true },
    ];

    for (const candidate of candidates) {
      if (candidate.value === undefined || candidate.value === null) {
        continue;
      }
      if (typeof candidate.value !== "string") {
        problems.push(
          `${label} must be a string (${candidate.source === "file" ? `${directFileKey}/${fileFileKey}` : directEnv})`,
        );
        continue;
      }
      const raw = candidate.value.trim();
      if (raw === "") {
        continue;
      }
      if (!candidate.isFile) {
        return raw;
      }
      return readSecretFile(label, expandPath(raw, baseFor(candidate.source), home), problems);
    }
    return undefined;
  };

  const token = pickSecret(
    "BALE_BOT_TOKEN",
    "BALE_BOT_TOKEN_FILE",
    "bale.token",
    "bale.tokenFile",
    "BALE_BOT_TOKEN",
  );
  if (!token) {
    problems.push("BALE_BOT_TOKEN or BALE_BOT_TOKEN_FILE is required");
  }

  const allowedUserId = readTextValue(pick("BALE_ALLOWED_USER_ID", "bale.allowedUserId").value);
  if (!allowedUserId) {
    problems.push(
      "BALE_ALLOWED_USER_ID is required; use the numeric Bale user ID of the account that may control the bridge",
    );
  } else if (!/^\d+$/.test(allowedUserId)) {
    problems.push("BALE_ALLOWED_USER_ID must be a numeric Bale user ID");
  }

  const password =
    pickSecret(
      "OPENCODE_PASSWORD",
      "OPENCODE_PASSWORD_FILE",
      "opencode.password",
      "opencode.passwordFile",
      "OPENCODE_PASSWORD",
    ) ??
    defaultOpenCodePassword(home, readSecretFile, problems);
  if (!password) {
    problems.push(
      "OPENCODE_PASSWORD, OPENCODE_PASSWORD_FILE, or ~/.config/opencode/service.json is required",
    );
  }

  const modelPick = pick("OPENCODE_MODEL", "opencode.model");
  const model = parseModel(modelPick.value, problems);

  const projectDirectory = readPath(
    "PROJECT_DIRECTORY",
    pick("PROJECT_DIRECTORY", "opencode.projectDirectory", home),
  );
  if (projectDirectory && !existsSync(projectDirectory)) {
    problems.push(`PROJECT_DIRECTORY does not exist: ${projectDirectory}`);
  }

  const opencodeUrl =
    readTextValue(pick("OPENCODE_URL", "opencode.url", "http://127.0.0.1:4096").value) ??
    "http://127.0.0.1:4096";
  try {
    const parsedUrl = new URL(opencodeUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      problems.push("OPENCODE_URL must use http or https");
    } else if (!isLoopbackHostname(parsedUrl.hostname)) {
      problems.push(
        `OPENCODE_URL must be a loopback address (${LOOPBACK_HOSTS.join(", ")}); got ${parsedUrl.hostname}`,
      );
    }
  } catch {
    problems.push(`OPENCODE_URL is not a valid URL: ${opencodeUrl}`);
  }

  const dbPath =
    readPath("BRIDGE_DB_PATH", pick("BRIDGE_DB_PATH", "bridge.dbPath", paths.dbPath)) ??
    paths.dbPath;
  const lockPath =
    readPath("BRIDGE_LOCK_PATH", pick("BRIDGE_LOCK_PATH", "bridge.lockPath", paths.lockPath)) ??
    paths.lockPath;
  const attachmentDir =
    readPath(
      "BRIDGE_ATTACHMENT_DIR",
      pick("BRIDGE_ATTACHMENT_DIR", "bridge.attachmentDir", paths.attachmentDir),
    ) ?? paths.attachmentDir;

  const attachmentMaxMb = readInteger(
    pick("BRIDGE_ATTACHMENT_MAX_MB", "bridge.attachmentMaxMb", 15).value,
    15,
    problems,
    { name: "BRIDGE_ATTACHMENT_MAX_MB", min: 1, max: 20 },
  );
  const attachmentTtlHours = readInteger(
    pick("BRIDGE_ATTACHMENT_TTL_HOURS", "bridge.attachmentTtlHours", 24).value,
    24,
    problems,
    { name: "BRIDGE_ATTACHMENT_TTL_HOURS", min: 1, max: 24 * 30 },
  );

  const logLevelRaw = (
    readTextValue(pick("LOG_LEVEL", "bridge.logLevel", "info").value) ?? "info"
  ).toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }

  const deliveryRaw = (
    readTextValue(pick("BRIDGE_DELIVERY", "bridge.delivery", "queue").value) ?? "queue"
  ).toLowerCase();
  if (!DELIVERIES.includes(deliveryRaw as Delivery)) {
    problems.push(`BRIDGE_DELIVERY must be one of ${DELIVERIES.join(", ")}`);
  }

  const editIntervalMs = readInteger(
    pick("BRIDGE_EDIT_INTERVAL_MS", "bridge.editIntervalMs", 1_500).value,
    1_500,
    problems,
    { name: "BRIDGE_EDIT_INTERVAL_MS", min: 250, max: 60_000 },
  );
  const liveTextLimit = readInteger(
    pick("BRIDGE_LIVE_TEXT_LIMIT", "bridge.liveTextLimit", 3_900).value,
    3_900,
    problems,
    { name: "BRIDGE_LIVE_TEXT_LIMIT", min: 500, max: 4_096 },
  );
  const pollTimeoutSec = readInteger(
    pick("BALE_POLL_TIMEOUT_SEC", "bale.pollTimeoutSec", 30).value,
    30,
    problems,
    { name: "BALE_POLL_TIMEOUT_SEC", min: 1, max: 120 },
  );
  const pollLimit = readInteger(
    pick("BALE_POLL_LIMIT", "bale.pollLimit", 50).value,
    50,
    problems,
    { name: "BALE_POLL_LIMIT", min: 1, max: 100 },
  );
  const requestTimeoutMs = readInteger(
    pick("OPENCODE_TIMEOUT_MS", "opencode.timeoutMs", 60_000).value,
    60_000,
    problems,
    { name: "OPENCODE_TIMEOUT_MS", min: 1_000, max: 600_000 },
  );
  const autoRestart = readBoolean(
    pick("OPENCODE_AUTO_RESTART", "opencode.autoRestart", false).value,
    false,
    problems,
    { name: "OPENCODE_AUTO_RESTART" },
  );
  const healthCheckMs = readInteger(
    pick("OPENCODE_HEALTH_CHECK_MS", "opencode.healthCheckMs", 30_000).value,
    30_000,
    problems,
    { name: "OPENCODE_HEALTH_CHECK_MS", min: 5_000, max: 3_600_000 },
  );
  const restartCooldownMs = readInteger(
    pick("OPENCODE_RESTART_COOLDOWN_MS", "opencode.restartCooldownMs", 300_000).value,
    300_000,
    problems,
    { name: "OPENCODE_RESTART_COOLDOWN_MS", min: 10_000, max: 86_400_000 },
  );
  const restartMaxCooldownMs = readInteger(
    pick("OPENCODE_RESTART_MAX_COOLDOWN_MS", "opencode.restartMaxCooldownMs", 3_600_000).value,
    3_600_000,
    problems,
    { name: "OPENCODE_RESTART_MAX_COOLDOWN_MS", min: 10_000, max: 86_400_000 },
  );
  const restartFailures = readInteger(
    pick("OPENCODE_RESTART_FAILURES", "opencode.restartFailures", 2).value,
    2,
    problems,
    { name: "OPENCODE_RESTART_FAILURES", min: 1, max: 10 },
  );
  const restartTimeoutMs = readInteger(
    pick("OPENCODE_RESTART_TIMEOUT_MS", "opencode.restartTimeoutMs", 60_000).value,
    60_000,
    problems,
    { name: "OPENCODE_RESTART_TIMEOUT_MS", min: 5_000, max: 600_000 },
  );

  const logFile = readPath(
    "BRIDGE_LOG_FILE",
    pick("BRIDGE_LOG_FILE", "bridge.logFile", paths.logFile),
  );
  const logMaxMb = readInteger(
    pick("BRIDGE_LOG_MAX_MB", "bridge.logMaxMb", 10).value,
    10,
    problems,
    { name: "BRIDGE_LOG_MAX_MB", min: 1, max: 1_024 },
  );
  const logMaxFiles = readInteger(
    pick("BRIDGE_LOG_MAX_FILES", "bridge.logMaxFiles", 5).value,
    5,
    problems,
    { name: "BRIDGE_LOG_MAX_FILES", min: 1, max: 50 },
  );

  const healthHost = readTextValue(pick("BRIDGE_HEALTH_HOST", "bridge.healthHost", "127.0.0.1").value) ?? "127.0.0.1";
  if (!isLoopbackHostname(healthHost)) {
    problems.push(
      `BRIDGE_HEALTH_HOST must be a loopback address (${LOOPBACK_HOSTS.join(", ")})`,
    );
  }
  const healthPort = readInteger(
    pick("BRIDGE_HEALTH_PORT", "bridge.healthPort", 4_097).value,
    4_097,
    problems,
    { name: "BRIDGE_HEALTH_PORT", min: 0, max: 65_535 },
  );
  const taskTickMs = readInteger(
    pick("BRIDGE_TASK_TICK_MS", "bridge.taskTickMs", 15_000).value,
    15_000,
    problems,
    { name: "BRIDGE_TASK_TICK_MS", min: 1_000, max: 300_000 },
  );
  const taskTimeoutMin = readInteger(
    pick("BRIDGE_TASK_TIMEOUT_MIN", "bridge.taskTimeoutMin", 30).value,
    30,
    problems,
    { name: "BRIDGE_TASK_TIMEOUT_MIN", min: 1, max: 1_440 },
  );

  if (problems.length > 0) {
    return { config: null, problems, warnings, paths, file };
  }

  const config: Config = {
    bale: {
      token: token as string,
      baseUrl: normalizeBaleBaseUrl(
        readTextValue(pick("BALE_API_BASE_URL", "bale.baseUrl", "https://tapi.bale.ai/bot").value) ??
          "https://tapi.bale.ai/bot",
      ),
      allowedUserId: allowedUserId as string,
      pollTimeoutSec,
      pollLimit,
    },
    opencode: {
      baseUrl: opencodeUrl,
      username: readTextValue(pick("OPENCODE_USERNAME", "opencode.username", "opencode").value) ?? "opencode",
      password: password as string,
      model: model as { providerID: string; id: string },
      agent: readTextValue(pick("OPENCODE_AGENT", "opencode.agent", "build").value) ?? "build",
      projectDirectory: projectDirectory as string,
      requestTimeoutMs,
      startCommand:
        readTextValue(pick("OPENCODE_START_COMMAND", "opencode.startCommand").value) || undefined,
      stopCommand:
        readTextValue(pick("OPENCODE_STOP_COMMAND", "opencode.stopCommand").value) || undefined,
      autoRestart,
      healthCheckMs,
      restartCooldownMs,
      restartMaxCooldownMs,
      restartFailures,
      restartTimeoutMs,
    },
    bridge: {
      dbPath,
      lockPath,
      editIntervalMs,
      liveTextLimit,
      delivery: deliveryRaw as Delivery,
      logLevel: logLevelRaw as LogLevel,
      logFile,
      logMaxBytes: logMaxMb * 1024 * 1024,
      logMaxFiles,
      healthHost,
      healthPort,
      taskTickMs,
      taskTimeoutMs: taskTimeoutMin * 60 * 1_000,
      sessionTitlePrefix:
        readTextValue(pick("BRIDGE_SESSION_PREFIX", "bridge.sessionTitlePrefix", "Bale").value) ??
        "Bale",
      attachmentDir,
      attachmentMaxBytes: attachmentMaxMb * 1024 * 1024,
      attachmentTtlMs: attachmentTtlHours * 60 * 60 * 1_000,
    },
  };

  return { config, problems, warnings, paths, file };
}

export interface RuntimeSettings {
  readonly paths: ResolvedPaths;
  readonly healthHost: string;
  readonly healthPort: number;
  readonly logFile: string;
  readonly configProblems: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Resolve the handful of settings `status`, `stop`, `logs`, and `doctor` need.
 * It never requires secrets and never throws for an invalid config file.
 */
export function resolveRuntimeSettings(options: LoadConfigOptions = {}): RuntimeSettings {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const paths = resolvePaths({ env, home, cwd, configPath: options.configPath });
  const file = options.skipConfigFile
    ? { path: paths.configFile, exists: false, data: {}, problems: [], warnings: [] }
    : readConfigFile(paths.configFile);
  const flags = options.flags ?? {};

  const pick = (envName: string, filePath: string, fallback?: unknown): unknown => {
    if (Object.prototype.hasOwnProperty.call(flags, envName)) {
      const value = flags[envName];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
    const envRaw = env[envName];
    if (envRaw !== undefined && envRaw.trim() !== "") {
      return envRaw;
    }
    const fileRaw = getByPath(file.data, filePath);
    if (fileRaw !== undefined && fileRaw !== null && fileRaw !== "") {
      return fileRaw;
    }
    return fallback;
  };

  const host = readTextValue(pick("BRIDGE_HEALTH_HOST", "bridge.healthHost", "127.0.0.1")) ?? "127.0.0.1";
  const portRaw = pick("BRIDGE_HEALTH_PORT", "bridge.healthPort", 4_097);
  const portValue = typeof portRaw === "number" ? portRaw : Number(portRaw);
  const healthPort =
    Number.isInteger(portValue) && portValue >= 0 && portValue <= 65_535 ? portValue : 4_097;

  const logFlag = flags.BRIDGE_LOG_FILE;
  const logEnv = env.BRIDGE_LOG_FILE;
  const logFileValue =
    logFlag !== undefined
      ? logFlag
      : logEnv !== undefined && logEnv.trim() !== ""
        ? logEnv
        : getByPath(file.data, "bridge.logFile");
  const logFile =
    typeof logFileValue === "string" && logFileValue.trim() !== ""
      ? expandPath(
          logFileValue,
          logFlag !== undefined || (logEnv !== undefined && logEnv.trim() !== "")
            ? cwd
            : dirname(paths.configFile),
          home,
        )
      : paths.logFile;

  return {
    paths,
    healthHost: isLoopbackHostname(host) ? host : "127.0.0.1",
    healthPort,
    logFile,
    configProblems: file.problems,
    warnings: file.warnings,
  };
}

/** Throwing wrapper used by the daemon. */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const result = validateConfig(options);
  if (!result.config) {
    throw new ConfigError(result.problems);
  }
  return result.config;
}

export function redactConfig(config: Config): Record<string, unknown> {
  return {
    bale: {
      ...config.bale,
      token: "[redacted]",
    },
    opencode: {
      ...config.opencode,
      password: "[redacted]",
    },
    bridge: config.bridge,
  };
}

function parseModel(
  raw: unknown,
  problems: string[],
): { providerID: string; id: string } | undefined {
  if (raw === undefined || raw === null || raw === "") {
    problems.push(
      'OPENCODE_MODEL is required in "providerID/modelID" form; the server default may be region-blocked',
    );
    return undefined;
  }

  if (typeof raw === "object") {
    const record = raw as { providerID?: unknown; id?: unknown };
    const providerID = typeof record.providerID === "string" ? record.providerID.trim() : "";
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!providerID || !id || /\s/.test(providerID) || /\s/.test(id)) {
      problems.push('opencode.model must contain non-empty "providerID" and "id" strings');
      return undefined;
    }
    return { providerID, id };
  }

  if (typeof raw !== "string") {
    problems.push('OPENCODE_MODEL must be "providerID/modelID"');
    return undefined;
  }
  const value = raw.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    problems.push('OPENCODE_MODEL must be "providerID/modelID"');
    return undefined;
  }
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

function defaultOpenCodePassword(
  home: string,
  readSecretFile: (label: string, path: string, problems: string[]) => string | undefined,
  problems: string[],
): string | undefined {
  const path = join(home, ".config", "opencode", "service.json");
  if (!existsSync(path)) {
    return undefined;
  }
  return readSecretFile("OPENCODE_PASSWORD_FILE", path, problems);
}

function normalizeBaleBaseUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.endsWith("/bot") ? trimmed : `${trimmed}/bot`;
}

function readTextValue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  return undefined;
}

interface IntegerRule {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

function readInteger(
  raw: unknown,
  fallback: number,
  problems: string[],
  rule: IntegerRule,
): number {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return fallback;
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
    problems.push(`${rule.name} must be an integer between ${rule.min} and ${rule.max}`);
    return fallback;
  }
  return value;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function readBoolean(
  raw: unknown,
  fallback: boolean,
  problems: string[],
  rule: { readonly name: string },
): boolean {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return fallback;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  const value = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(value)) {
    return true;
  }
  if (FALSE_VALUES.has(value)) {
    return false;
  }
  problems.push(`${rule.name} must be a boolean (true/false)`);
  return fallback;
}