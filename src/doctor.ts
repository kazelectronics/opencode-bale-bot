import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { validateConfig, type Config } from "./config.js";
import { readConfigFile, redactFileConfig } from "./configFile.js";
import { probeHealth } from "./healthClient.js";
import { readLock, verifyLockOwnership } from "./lock.js";
import { createLogger, redact } from "./logger.js";
import { OpenCodeClient } from "./opencode/client.js";
import { SdkBaleGateway } from "./bale/gateway.js";
import { resolveRuntimeSettings } from "./config.js";
import { isEphemeralInstall, serviceStatus } from "./service.js";
import { packageVersion } from "./version.js";
import { EXIT } from "./exit.js";

interface CliArgs {
  readonly flags: Readonly<Record<string, string | boolean>>;
}

type CheckStatus = "ok" | "warn" | "fail";

interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly hint?: string;
}

const MIN_NODE = [22, 13, 0] as const;

export async function runDoctor(parsed: CliArgs): Promise<number> {
  const json = parsed.flags.json === true;
  const bundle = parsed.flags.bundle === true;
  const configPath = typeof parsed.flags.config === "string" ? parsed.flags.config : undefined;
  const checks: Check[] = [];

  checks.push(nodeCheck());
  checks.push(platformCheck());
  checks.push(
    isEphemeralInstall()
      ? {
          id: "install.method",
          status: "warn",
          message: "running from an npx cache",
          hint: "install globally with `npm install --global opencode-bale-bot` before installing the service",
        }
      : { id: "install.method", status: "ok", message: "stable install location" },
  );

  const options = { configPath };
  const settings = resolveRuntimeSettings(options);
  const file = readConfigFile(settings.paths.configFile, { checkPermissions: true });

  if (!file.exists) {
    checks.push({
      id: "config.file",
      status: "fail",
      message: `no configuration file at ${settings.paths.configFile}`,
      hint: "run `opencode-bale-bot setup`",
    });
  } else if (file.problems.length > 0) {
    checks.push({
      id: "config.file",
      status: "fail",
      message: file.problems.join("; "),
      hint: "run `opencode-bale-bot config validate` or `config edit`",
    });
  } else {
    checks.push({
      id: "config.file",
      status: "ok",
      message: `configuration file is readable and valid JSON (${settings.paths.configFile})`,
    });
  }

  for (const warning of file.warnings) {
    checks.push({ id: "config.keys", status: "warn", message: warning });
  }

  const validation = validateConfig(options);
  const config = validation.config;
  if (!config) {
    if (file.exists) {
      checks.push({
        id: "config.values",
        status: "fail",
        message: validation.problems.join("; "),
        hint: "run `opencode-bale-bot config validate`",
      });
    }
  } else {
    checks.push({
      id: "config.values",
      status: "ok",
      message: `model ${config.opencode.model.providerID}/${config.opencode.model.id}, agent ${config.opencode.agent}`,
    });
  }

  checks.push(...directoryChecks(settings.paths));

  const lock = readLock(settings.paths.lockPath);
  if (!lock) {
    checks.push({
      id: "daemon.lock",
      status: "warn",
      message: "no instance lock; the daemon is not running",
      hint: "start it with `opencode-bale-bot start` or install the service",
    });
  } else {
    const ownership = verifyLockOwnership(lock);
    if (ownership === "dead") {
      checks.push({
        id: "daemon.lock",
        status: "warn",
        message: `stale lock for pid ${lock.pid}`,
        hint: "run `opencode-bale-bot stop` to remove it",
      });
    } else if (ownership === "mismatch") {
      checks.push({
        id: "daemon.lock",
        status: "fail",
        message: `lock pid ${lock.pid} belongs to a different process`,
        hint: "remove the stale lock and restart",
      });
    } else {
      checks.push({
        id: "daemon.lock",
        status: "ok",
        message: `daemon lock is held by pid ${lock.pid} (${lock.version || "unknown version"})`,
      });
    }
  }

  if (settings.healthPort > 0) {
    const probe = await probeHealth({ host: settings.healthHost, port: settings.healthPort });
    if (probe.ok) {
      checks.push({
        id: "daemon.health",
        status: probe.body?.ready === false ? "warn" : "ok",
        message: `health endpoint ${probe.url} answered (${probe.body?.status ?? "unknown"})`,
      });
      if (lock && typeof probe.body?.pid === "number" && probe.body.pid !== lock.pid) {
        checks.push({
          id: "daemon.health.instance",
          status: "fail",
          message: `health pid ${probe.body.pid} does not match lock pid ${lock.pid}`,
          hint: "another process may be using the health port",
        });
      }
    } else if (lock) {
      checks.push({
        id: "daemon.health",
        status: "fail",
        message: `health endpoint ${probe.url} is unreachable: ${probe.error ?? "unknown error"}`,
        hint: "check the port and the daemon log",
      });
    } else {
      checks.push({
        id: "daemon.health",
        status: "warn",
        message: `health endpoint ${probe.url} is unreachable because the daemon is not running`,
      });
    }
  } else {
    checks.push({
      id: "daemon.health",
      status: "ok",
      message: "health endpoint is disabled (BRIDGE_HEALTH_PORT=0)",
    });
  }

  if (config) {
    const logger = createLogger({ level: "error", sink: () => undefined });
    const client = new OpenCodeClient({
      baseUrl: config.opencode.baseUrl,
      username: config.opencode.username,
      password: config.opencode.password,
      timeoutMs: Math.min(config.opencode.requestTimeoutMs, 10_000),
      logger,
    });
    try {
      const info = await client.info();
      checks.push({
        id: "opencode.info",
        status: info.version.startsWith("2.") ? "ok" : "warn",
        message: `OpenCode ${info.version} at ${config.opencode.baseUrl}`,
        ...(info.version.startsWith("2.")
          ? {}
          : { hint: "this bridge targets OpenCode V2; update the server" }),
      });
    } catch (caught) {
      checks.push({
        id: "opencode.info",
        status: "fail",
        message: `cannot reach ${config.opencode.baseUrl}: ${(caught as Error).message}`,
        hint: "start the OpenCode server and check the URL and credentials",
      });
    }

    try {
      const models = await client.listModels();
      const wanted = config.opencode.model;
      const found = models.some(
        (model) =>
          model.providerID === wanted.providerID &&
          (model.id === wanted.id || model.modelID === wanted.id),
      );
      checks.push({
        id: "opencode.model",
        status: found ? "ok" : "fail",
        message: found
          ? `model ${wanted.providerID}/${wanted.id} is available`
          : `model ${wanted.providerID}/${wanted.id} is not in /api/model`,
        ...(found ? {} : { hint: "run `opencode-bale-bot setup` to choose an available model" }),
      });
    } catch (caught) {
      checks.push({
        id: "opencode.model",
        status: "warn",
        message: `could not list models: ${(caught as Error).message}`,
      });
    }

    try {
      const agents = await client.listAgents();
      const found = agents.find((agent) => agent.id === config.opencode.agent);
      checks.push({
        id: "opencode.agent",
        status: found ? "ok" : "warn",
        message: found
          ? `agent ${config.opencode.agent} is available`
          : `agent ${config.opencode.agent} was not found`,
        ...(found ? {} : { hint: "run `opencode-bale-bot setup` to choose an available agent" }),
      });
    } catch {
      // The info check already reported connectivity; a missing agent list is
      // only a warning.
    }

    const gateway = new SdkBaleGateway({
      token: config.bale.token,
      baseUrl: config.bale.baseUrl,
      logger,
    });
    try {
      const me = await gateway.getMe();
      checks.push({
        id: "bale.bot",
        status: "ok",
        message: `bot @${me.username ?? me.id} authenticated (id ${me.id})`,
      });
    } catch (caught) {
      checks.push({
        id: "bale.bot",
        status: "fail",
        message: `Bale authentication failed: ${(caught as Error).message}`,
        hint: "check the bot token with @BotFather or your Bale bot settings",
      });
    }
  }

  const service = serviceStatus({ paths: settings.paths });
  if (service.manager === "unsupported") {
    checks.push({
      id: "service.manager",
      status: "warn",
      message: "no supported service manager; run the daemon in the foreground or use WSL2",
    });
  } else if (!service.installed) {
    checks.push({
      id: "service.manager",
      status: "warn",
      message: `no ${service.manager} unit installed`,
      hint: "run `opencode-bale-bot service install`",
    });
  } else {
    checks.push({
      id: "service.manager",
      status: service.active ? "ok" : "warn",
      message: `${service.manager}: ${service.detail}${service.enabled ? ", enabled" : ""}`,
    });
  }

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const exitCode =
    config === null
      ? EXIT.NOT_CONFIGURED
      : failures > 0
        ? EXIT.UNHEALTHY
        : EXIT.OK;

  const report = {
    ok: failures === 0 && config !== null,
    exitCode,
    package: { name: "opencode-bale-bot", version: packageVersion() },
    node: process.versions.node,
    platform: process.platform,
    configPath: settings.paths.configFile,
    checks,
    summary: { failures, warnings },
  };

  if (bundle) {
    const path = writeBundle(settings.paths.stateDir, settings.paths.configFile, report, config);
    if (!json) {
      process.stdout.write(`Support bundle: ${path}\n`);
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`opencode-bale-bot doctor (${pathLabel(settings.paths.configFile)})\n`);
    for (const check of checks) {
      const marker =
        check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "fail";
      process.stdout.write(`  [${marker}] ${check.id}: ${check.message}\n`);
      if (check.hint) {
        process.stdout.write(`         hint: ${check.hint}\n`);
      }
    }
    process.stdout.write(
      `\n${failures} failure(s), ${warnings} warning(s)\n`,
    );
  }

  return exitCode;
}

function nodeCheck(): Check {
  const parts = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  let supported = true;
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    const current = Number.isFinite(parts[index]) ? (parts[index] as number) : 0;
    const minimum = MIN_NODE[index] as number;
    if (current > minimum) {
      break;
    }
    if (current < minimum) {
      supported = false;
      break;
    }
  }
  return supported
    ? { id: "node.version", status: "ok", message: `Node ${process.versions.node}` }
    : {
        id: "node.version",
        status: "fail",
        message: `Node ${process.versions.node} is older than ${MIN_NODE.join(".")}`,
        hint: "install a current Node.js release from https://nodejs.org/",
      };
}

function platformCheck(): Check {
  if (process.platform === "linux" || process.platform === "darwin") {
    return { id: "platform", status: "ok", message: process.platform };
  }
  if (process.platform === "win32") {
    return {
      id: "platform",
      status: "warn",
      message: "native Windows is not supported",
      hint: "run the bridge inside WSL2",
    };
  }
  return { id: "platform", status: "warn", message: `untested platform: ${process.platform}` };
}

function directoryChecks(paths: {
  readonly configDir: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly logFile: string;
}): Check[] {
  const checks: Check[] = [];
  for (const [label, path] of [
    ["config", paths.configDir],
    ["state", paths.stateDir],
    ["data", paths.dataDir],
  ] as const) {
    checks.push(writabilityCheck(`${label}.dir`, path));
  }
  checks.push(writabilityCheck("logs.dir", dirname(paths.logFile)));
  return checks;
}

function writabilityCheck(id: string, path: string): Check {
  if (!existsSync(path)) {
    return {
      id,
      status: "warn",
      message: `${path} does not exist yet`,
      hint: "it will be created on first start",
    };
  }
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      return { id, status: "fail", message: `${path} is not a directory` };
    }
    accessSync(path, constants.W_OK);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      return {
        id,
        status: "warn",
        message: `${path} is accessible by other users (mode ${(stat.mode & 0o777).toString(8)})`,
        hint: `chmod 700 '${path}'`,
      };
    }
    return { id, status: "ok", message: path };
  } catch (caught) {
    return {
      id,
      status: "fail",
      message: `${path} is not writable: ${(caught as Error).message}`,
      hint: `chmod u+w '${path}'`,
    };
  }
}

function pathLabel(path: string): string {
  return path;
}

function writeBundle(
  stateDir: string,
  configPath: string,
  report: unknown,
  config: Config | null,
): string {
  const secrets = config ? [config.bale.token, config.opencode.password] : [];
  let configSummary: unknown = null;
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as import("./configFile.js").FileConfig;
      configSummary = redact(JSON.stringify(redactFileConfig(raw)), secrets);
    }
  } catch {
    configSummary = "unreadable";
  }

  const bundle = {
    createdAt: new Date().toISOString(),
    report,
    config: configSummary,
    note: "Secrets are redacted. Review this file before sharing it.",
  };
  const path = join(stateDir, `support-bundle-${Date.now()}.json`);
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return path;
}