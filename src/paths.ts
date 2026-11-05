import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface PathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Directory used to resolve relative environment values. */
  readonly cwd?: string;
  /** Explicit config file (from --config); overrides every other source. */
  readonly configPath?: string;
}

export interface ResolvedPaths {
  readonly configDir: string;
  readonly configFile: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly lockPath: string;
  readonly attachmentDir: string;
  readonly logFile: string;
}

/** Expand a leading `~` and make the path absolute. */
export function expandPath(value: string, base: string, home = homedir()): string {
  const trimmed = value.trim();
  const expanded =
    trimmed === "~"
      ? home
      : trimmed.startsWith("~/")
        ? join(home, trimmed.slice(2))
        : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function xdgDir(
  env: NodeJS.ProcessEnv,
  name: string,
  home: string,
  fallback: string,
): string {
  const configured = envValue(env, name);
  return configured ? expandPath(configured, home, home) : join(home, fallback);
}

/**
 * Resolve every path the CLI and daemon need. This never fails and never reads
 * a secret: status and stop must work with no configuration at all.
 */
export function resolvePaths(options: PathOptions = {}): ResolvedPaths {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();

  const configOverride = options.configPath ?? envValue(env, "OPENCODE_BALE_CONFIG");
  const configFile = configOverride
    ? expandPath(configOverride, cwd, home)
    : join(xdgDir(env, "XDG_CONFIG_HOME", home, ".config"), "opencode-bale-bot", "config.json");
  const configDir = dirname(configFile);

  const stateDir = envValue(env, "OPENCODE_BALE_STATE_DIR")
    ? expandPath(envValue(env, "OPENCODE_BALE_STATE_DIR") as string, cwd, home)
    : join(xdgDir(env, "XDG_STATE_HOME", home, join(".local", "state")), "opencode-bale-bot");

  const dataDir = envValue(env, "OPENCODE_BALE_DATA_DIR")
    ? expandPath(envValue(env, "OPENCODE_BALE_DATA_DIR") as string, cwd, home)
    : join(xdgDir(env, "XDG_DATA_HOME", home, join(".local", "share")), "opencode-bale-bot");

  const dbPath = envValue(env, "BRIDGE_DB_PATH")
    ? expandPath(envValue(env, "BRIDGE_DB_PATH") as string, cwd, home)
    : join(dataDir, "bridge.sqlite");

  const lockPath = envValue(env, "BRIDGE_LOCK_PATH")
    ? expandPath(envValue(env, "BRIDGE_LOCK_PATH") as string, cwd, home)
    : join(stateDir, "bridge.lock");

  const attachmentDir = envValue(env, "BRIDGE_ATTACHMENT_DIR")
    ? expandPath(envValue(env, "BRIDGE_ATTACHMENT_DIR") as string, cwd, home)
    : join(dataDir, "attachments");

  const logFile = envValue(env, "BRIDGE_LOG_FILE")
    ? expandPath(envValue(env, "BRIDGE_LOG_FILE") as string, cwd, home)
    : join(stateDir, "bridge.log");

  return {
    configDir,
    configFile,
    stateDir,
    dataDir,
    dbPath,
    lockPath,
    attachmentDir,
    logFile,
  };
}

export const DEFAULT_DIRECTORY_MODE = 0o700;
export const DEFAULT_FILE_MODE = 0o600;