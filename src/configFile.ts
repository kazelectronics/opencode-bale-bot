import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Delivery, LogLevel } from "./config.js";

export const CONFIG_VERSION = 1;

export interface BaleFileConfig {
  token?: string;
  tokenFile?: string;
  baseUrl?: string;
  allowedUserId?: string | number;
  pollTimeoutSec?: number;
  pollLimit?: number;
}

export interface OpenCodeFileConfig {
  url?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  model?: string | { providerID?: string; id?: string };
  agent?: string;
  projectDirectory?: string;
  timeoutMs?: number;
  startCommand?: string;
  stopCommand?: string;
  autoRestart?: boolean;
  healthCheckMs?: number;
  restartCooldownMs?: number;
  restartMaxCooldownMs?: number;
  restartFailures?: number;
  restartTimeoutMs?: number;
}

export interface BridgeFileConfig {
  dbPath?: string;
  lockPath?: string;
  editIntervalMs?: number;
  liveTextLimit?: number;
  delivery?: Delivery;
  logLevel?: LogLevel;
  logFile?: string;
  logMaxMb?: number;
  logMaxFiles?: number;
  healthHost?: string;
  healthPort?: number;
  taskTickMs?: number;
  taskTimeoutMin?: number;
  sessionTitlePrefix?: string;
  attachmentDir?: string;
  attachmentMaxMb?: number;
  attachmentTtlHours?: number;
}

export interface FileConfig {
  configVersion?: number;
  bale?: BaleFileConfig;
  opencode?: OpenCodeFileConfig;
  bridge?: BridgeFileConfig;
}

export interface ConfigFileReadResult {
  readonly path: string;
  readonly exists: boolean;
  readonly data: FileConfig;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

const KNOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  "": ["configVersion", "bale", "opencode", "bridge"],
  bale: [
    "token",
    "tokenFile",
    "baseUrl",
    "allowedUserId",
    "pollTimeoutSec",
    "pollLimit",
  ],
  opencode: [
    "url",
    "username",
    "password",
    "passwordFile",
    "model",
    "agent",
    "projectDirectory",
    "timeoutMs",
    "startCommand",
    "stopCommand",
    "autoRestart",
    "healthCheckMs",
    "restartCooldownMs",
    "restartMaxCooldownMs",
    "restartFailures",
    "restartTimeoutMs",
  ],
  bridge: [
    "dbPath",
    "lockPath",
    "editIntervalMs",
    "liveTextLimit",
    "delivery",
    "logLevel",
    "logFile",
    "logMaxMb",
    "logMaxFiles",
    "healthHost",
    "healthPort",
    "taskTickMs",
    "taskTimeoutMin",
    "sessionTitlePrefix",
    "attachmentDir",
    "attachmentMaxMb",
    "attachmentTtlHours",
  ],
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a dotted path such as `opencode.model` from a parsed config file. */
export function getByPath(source: unknown, path: string): unknown {
  if (path === "") {
    return source;
  }
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function collectUnknownKeys(
  value: Record<string, unknown>,
  prefix: string,
  warnings: string[],
): void {
  const allowed = KNOWN_KEYS[prefix] ?? [];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      warnings.push(`unknown configuration key: ${prefix === "" ? key : `${prefix}.${key}`}`);
    }
  }
  for (const section of ["bale", "opencode", "bridge"]) {
    const nested = value[section];
    if (isPlainObject(nested)) {
      collectUnknownKeys(nested, section, warnings);
    }
  }
}

/**
 * Read and parse the config file. A missing file is not an error: it only means
 * the next layer (environment, then defaults) supplies the values.
 */
export function readConfigFile(
  path: string,
  options: { readonly checkPermissions?: boolean } = {},
): ConfigFileReadResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { path, exists: false, data: {}, problems, warnings };
    }
    problems.push(`cannot read the configuration file ${path}: ${(error as Error).message}`);
    return { path, exists: false, data: {}, problems, warnings };
  }

  if (options.checkPermissions !== false && process.platform !== "win32") {
    try {
      const mode = statSync(path).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        problems.push(
          `the configuration file ${path} is readable by other users (mode ${mode.toString(8)}); run "chmod 600 '${path}'"`,
        );
      }
    } catch {
      // The read above already proved the file is accessible; a mode check
      // failure is not fatal.
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(
      `the configuration file ${path} is not valid JSON: ${(error as Error).message}; fix it or run "opencode-bale-bot config edit"`,
    );
    return { path, exists: true, data: {}, problems, warnings };
  }

  if (!isPlainObject(parsed)) {
    problems.push(`the configuration file ${path} must contain a JSON object`);
    return { path, exists: true, data: {}, problems, warnings };
  }

  const version = parsed.configVersion;
  if (version !== undefined) {
    if (!Number.isInteger(version) || (version as number) < 1) {
      problems.push(`configVersion in ${path} must be a positive integer`);
    } else if ((version as number) > CONFIG_VERSION) {
      problems.push(
        `configVersion ${version} is newer than this CLI supports (${CONFIG_VERSION}); upgrade opencode-bale-bot`,
      );
    }
  }

  collectUnknownKeys(parsed, "", warnings);

  return {
    path,
    exists: true,
    data: parsed as FileConfig,
    problems,
    warnings,
  };
}

export class ConfigWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

/**
 * Write the configuration atomically: a temp file in the same directory, fsync,
 * then rename. The file is created with mode 0600 and a truncated file is never
 * visible to readers.
 */
export function writeConfigFile(path: string, data: FileConfig): void {
  const directory = dirname(path);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (basename(directory) === "opencode-bale-bot") {
      chmodSync(directory, 0o700);
    }
  } catch (error) {
    throw new ConfigWriteError(
      `cannot create the configuration directory ${directory}: ${(error as Error).message}`,
    );
  }

  const temp = join(
    directory,
    `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const payload = `${JSON.stringify(data, null, 2)}\n`;

  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore a close failure; the temp file is removed below.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // Not created, or already renamed.
    }
    throw new ConfigWriteError(
      `cannot write the configuration file ${path}: ${(error as Error).message}`,
    );
  }
}

/** Return a copy safe to print: secrets are replaced, everything else remains. */
export function redactFileConfig(data: FileConfig): FileConfig {
  const copy = JSON.parse(JSON.stringify(data)) as FileConfig;
  if (copy.bale && typeof copy.bale.token === "string") {
    copy.bale.token = "[redacted]";
  }
  if (copy.opencode && typeof copy.opencode.password === "string") {
    copy.opencode.password = "[redacted]";
  }
  return copy;
}

export function configFileExists(path: string): boolean {
  return existsSync(path);
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}