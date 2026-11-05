import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedPaths } from "./paths.js";

export type ServiceManager = "systemd" | "launchd" | "unsupported";

export interface ServiceOptions {
  readonly paths: ResolvedPaths;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly force?: boolean;
  readonly enable?: boolean;
  readonly start?: boolean;
  readonly dryRun?: boolean;
  readonly run?: RunCommand;
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunCommand = (command: string, args: readonly string[]) => CommandResult;

export interface ServiceInstallResult {
  readonly manager: ServiceManager;
  readonly file: string;
  readonly content: string;
  readonly commands: readonly string[];
  readonly warnings: readonly string[];
  readonly installed: boolean;
}

export interface ServiceStatusResult {
  readonly manager: ServiceManager;
  readonly file: string;
  readonly installed: boolean;
  readonly active: boolean;
  readonly enabled: boolean;
  readonly detail: string;
}

const UNIT_NAME = "opencode-bale-bot.service";
const LAUNCHD_LABEL = "com.opencode-bale-bot";

export function detectServiceManager(platform = process.platform): ServiceManager {
  if (platform === "linux") {
    return "systemd";
  }
  if (platform === "darwin") {
    return "launchd";
  }
  return "unsupported";
}

export function systemdUnitPath(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME.trim()
      : join(home, ".config");
  return join(configHome, "systemd", "user", UNIT_NAME);
}

export function launchdPlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function defaultCliPath(): string {
  // This module lives in dist/ next to cli.js once built, and in src/ when the
  // CLI runs through tsx during development.
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

/**
 * True when the running code lives in an npx cache. A service unit pointing
 * there breaks whenever npm evicts the cache, so setup/doctor warn instead of
 * silently installing one.
 */
export function isEphemeralInstall(): boolean {
  try {
    const path = fileURLToPath(import.meta.url);
    return /(^|[\\/])_npx[\\/]/.test(path) || /\.npm[\\/]_npx[\\/]/.test(path);
  } catch {
    return false;
  }
}

function quoteSystemdArg(value: string): string {
  if (!/[\s"'\\]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function environmentLine(configPath: string): string {
  const value = `OPENCODE_BALE_CONFIG=${configPath}`;
  return /[\s"'\\]/.test(value)
    ? `Environment="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : `Environment=${value}`;
}

export function renderSystemdUnit(options: {
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly configPath: string;
  readonly home?: string;
}): string {
  const node = options.nodePath ?? process.execPath;
  const cli = options.cliPath ?? defaultCliPath();
  const home = options.home ?? homedir();
  const exec = [
    node,
    "--disable-warning=ExperimentalWarning",
    cli,
    "start",
  ]
    .map(quoteSystemdArg)
    .join(" ");

  return [
    "[Unit]",
    "Description=OpenCode Bale bridge",
    "Documentation=https://github.com/kazelectronics/opencode-bale-bot",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    environmentLine(options.configPath),
    `WorkingDirectory=${quoteSystemdArg(home)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStopSec=20",
    "KillSignal=SIGTERM",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "UMask=0077",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderLaunchdPlist(options: {
  readonly nodePath?: string;
  readonly cliPath?: string;
  readonly configPath: string;
  readonly stateDir: string;
}): string {
  const node = options.nodePath ?? process.execPath;
  const cli = options.cliPath ?? defaultCliPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${xmlEscape(cli)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCODE_BALE_CONFIG</key>
    <string>${xmlEscape(options.configPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(options.stateDir, "daemon.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(options.stateDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

function defaultRun(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

function systemdAvailable(run: RunCommand): boolean {
  if (!existsSync("/run/systemd/system")) {
    return false;
  }
  const result = run("systemctl", ["--user", "show-environment"]);
  return result.status === 0;
}

function launchdAvailable(run: RunCommand): boolean {
  const result = run("launchctl", ["version"]);
  return result.status === 0;
}

export function installService(options: ServiceOptions): ServiceInstallResult {
  const run = options.run ?? defaultRun;
  const manager = detectServiceManager();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const commands: string[] = [];

  if (isEphemeralInstall()) {
    warnings.push(
      "this looks like an npx cache; install the package globally before installing the service, or the unit will point at a path npm may delete",
    );
  }

  if (manager === "systemd") {
    const file = systemdUnitPath(home, env);
    const content = renderSystemdUnit({
      nodePath: options.nodePath,
      cliPath: options.cliPath,
      configPath: options.paths.configFile,
      home,
    });
    if (existsSync(file) && options.force !== true) {
      return {
        manager,
        file,
        content,
        commands,
        warnings: [`${file} already exists; pass --force to replace it`],
        installed: false,
      };
    }
    if (!options.dryRun) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
      writeFileSync(file, content, { mode: 0o644 });
      commands.push(commandLine("systemctl", ["--user", "daemon-reload"]));
      run("systemctl", ["--user", "daemon-reload"]);
      if (options.enable !== false) {
        commands.push(commandLine("systemctl", ["--user", "enable", "--now", UNIT_NAME]));
        run("systemctl", ["--user", "enable", "--now", UNIT_NAME]);
        const linger = run("loginctl", ["enable-linger", userInfo().username]);
        if (linger.status !== 0) {
          warnings.push(
            `could not enable lingering; run "sudo loginctl enable-linger ${userInfo().username}" so the service starts at boot`,
          );
        }
      } else if (options.start !== false) {
        commands.push(commandLine("systemctl", ["--user", "start", UNIT_NAME]));
        run("systemctl", ["--user", "start", UNIT_NAME]);
      }
      if (!systemdAvailable(run)) {
        warnings.push(
          "systemd user services are not available in this session; the unit file was written, but start it after logging in with a user session",
        );
      }
    } else {
      commands.push(commandLine("systemctl", ["--user", "daemon-reload"]));
      if (options.enable !== false) {
        commands.push(commandLine("systemctl", ["--user", "enable", "--now", UNIT_NAME]));
        commands.push(commandLine("loginctl", ["enable-linger", userInfo().username]));
      }
    }
    return { manager, file, content, commands, warnings, installed: !options.dryRun };
  }

  if (manager === "launchd") {
    const file = launchdPlistPath(home);
    const content = renderLaunchdPlist({
      nodePath: options.nodePath,
      cliPath: options.cliPath,
      configPath: options.paths.configFile,
      stateDir: options.paths.stateDir,
    });
    if (existsSync(file) && options.force !== true) {
      return {
        manager,
        file,
        content,
        commands,
        warnings: [`${file} already exists; pass --force to replace it`],
        installed: false,
      };
    }
    const uid = process.getuid?.() ?? 501;
    if (!options.dryRun) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
      // launchd opens StandardOutPath/StandardErrorPath before the daemon runs,
      // so the state directory must already exist.
      mkdirSync(options.paths.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, content, { mode: 0o644 });
      const bootout = ["bootout", `gui/${uid}`, file];
      commands.push(commandLine("launchctl", bootout));
      run("launchctl", bootout);
      const bootstrap = ["bootstrap", `gui/${uid}`, file];
      commands.push(commandLine("launchctl", bootstrap));
      const result = run("launchctl", bootstrap);
      if (result.status !== 0) {
        warnings.push(`launchctl bootstrap failed: ${result.stderr.trim() || "unknown error"}`);
      }
      if (!launchdAvailable(run)) {
        warnings.push("launchctl is not available; the plist was written but not loaded");
      }
    } else {
      const uid = process.getuid?.() ?? 501;
      commands.push(commandLine("launchctl", ["bootout", `gui/${uid}`, file]));
      commands.push(commandLine("launchctl", ["bootstrap", `gui/${uid}`, file]));
    }
    return { manager, file, content, commands, warnings, installed: !options.dryRun };
  }

  return {
    manager: "unsupported",
    file: "",
    content: "",
    commands,
    warnings: [
      "service management supports Linux (systemd user units) and macOS (launchd); on Windows use WSL2 and run the daemon in the foreground",
    ],
    installed: false,
  };
}

export function uninstallService(options: ServiceOptions): ServiceInstallResult {
  const run = options.run ?? defaultRun;
  const manager = detectServiceManager();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const commands: string[] = [];
  const warnings: string[] = [];

  if (manager === "systemd") {
    const file = systemdUnitPath(home, env);
    commands.push(commandLine("systemctl", ["--user", "disable", "--now", UNIT_NAME]));
    if (!options.dryRun) {
      run("systemctl", ["--user", "disable", "--now", UNIT_NAME]);
      rmSync(file, { force: true });
      run("systemctl", ["--user", "daemon-reload"]);
    }
    return {
      manager,
      file,
      content: "",
      commands,
      warnings,
      installed: false,
    };
  }

  if (manager === "launchd") {
    const file = launchdPlistPath(home);
    const uid = process.getuid?.() ?? 501;
    commands.push(commandLine("launchctl", ["bootout", `gui/${uid}`, file]));
    if (!options.dryRun) {
      run("launchctl", ["bootout", `gui/${uid}`, file]);
      rmSync(file, { force: true });
    }
    return { manager, file, content: "", commands, warnings, installed: false };
  }

  return {
    manager: "unsupported",
    file: "",
    content: "",
    commands,
    warnings: ["no supported service manager was found"],
    installed: false,
  };
}

export function serviceStatus(options: ServiceOptions): ServiceStatusResult {
  const run = options.run ?? defaultRun;
  const manager = detectServiceManager();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  if (manager === "systemd") {
    const file = systemdUnitPath(home, env);
    const installed = existsSync(file);
    if (!installed) {
      return { manager, file, installed, active: false, enabled: false, detail: "not installed" };
    }
    const active = run("systemctl", ["--user", "is-active", UNIT_NAME]).stdout.trim() === "active";
    const enabled =
      run("systemctl", ["--user", "is-enabled", UNIT_NAME]).stdout.trim() === "enabled";
    return {
      manager,
      file,
      installed,
      active,
      enabled,
      detail: active ? "active" : "inactive",
    };
  }

  if (manager === "launchd") {
    const file = launchdPlistPath(home);
    const installed = existsSync(file);
    if (!installed) {
      return { manager, file, installed, active: false, enabled: false, detail: "not installed" };
    }
    const uid = process.getuid?.() ?? 501;
    const result = run("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`]);
    const active = result.status === 0;
    return {
      manager,
      file,
      installed,
      active,
      enabled: active,
      detail: active ? `loaded (${LAUNCHD_LABEL})` : "not loaded",
    };
  }

  return {
    manager: "unsupported",
    file: "",
    installed: false,
    active: false,
    enabled: false,
    detail: "no supported service manager",
  };
}

export function stopService(options: ServiceOptions): ServiceInstallResult {
  const run = options.run ?? defaultRun;
  const manager = detectServiceManager();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const commands: string[] = [];
  const warnings: string[] = [];

  if (manager === "systemd") {
    const file = systemdUnitPath(home, env);
    commands.push(commandLine("systemctl", ["--user", "stop", UNIT_NAME]));
    if (!options.dryRun) {
      const result = run("systemctl", ["--user", "stop", UNIT_NAME]);
      if (result.status !== 0) {
        warnings.push(result.stderr.trim() || "stop failed");
      }
    }
    return { manager, file, content: "", commands, warnings, installed: true };
  }

  if (manager === "launchd") {
    const file = launchdPlistPath(home);
    const uid = process.getuid?.() ?? 501;
    commands.push(commandLine("launchctl", ["bootout", `gui/${uid}`, file]));
    if (!options.dryRun) {
      const result = run("launchctl", ["bootout", `gui/${uid}`, file]);
      if (result.status !== 0) {
        warnings.push(result.stderr.trim() || "stop failed");
      }
    }
    return { manager, file, content: "", commands, warnings, installed: true };
  }

  return {
    manager: "unsupported",
    file: "",
    content: "",
    commands,
    warnings: ["no supported service manager was found"],
    installed: false,
  };
}

export function restartService(options: ServiceOptions): ServiceInstallResult {
  const run = options.run ?? defaultRun;
  const manager = detectServiceManager();
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const commands: string[] = [];
  const warnings: string[] = [];

  if (manager === "systemd") {
    const file = systemdUnitPath(home, env);
    commands.push(commandLine("systemctl", ["--user", "restart", UNIT_NAME]));
    if (!options.dryRun) {
      const result = run("systemctl", ["--user", "restart", UNIT_NAME]);
      if (result.status !== 0) {
        warnings.push(result.stderr.trim() || "restart failed");
      }
    }
    return { manager, file, content: "", commands, warnings, installed: true };
  }

  if (manager === "launchd") {
    const file = launchdPlistPath(home);
    const uid = process.getuid?.() ?? 501;
    commands.push(commandLine("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`]));
    if (!options.dryRun) {
      const result = run("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`]);
      if (result.status !== 0) {
        warnings.push(result.stderr.trim() || "restart failed");
      }
    }
    return { manager, file, content: "", commands, warnings, installed: true };
  }

  return {
    manager: "unsupported",
    file: "",
    content: "",
    commands,
    warnings: ["no supported service manager was found"],
    installed: false,
  };
}

export const serviceNames = {
  systemdUnit: UNIT_NAME,
  launchdLabel: LAUNCHD_LABEL,
};