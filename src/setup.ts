import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getUpdateChat, getUpdateMessage } from "@erfanvahabpour/bale-bot-sdk";

import { SdkBaleGateway } from "./bale/gateway.js";
import { isLoopbackHostname, validateConfig } from "./config.js";
import { readConfigFile, writeConfigFile, CONFIG_VERSION, type FileConfig } from "./configFile.js";
import { ConfigWriteError } from "./configFile.js";
import { EXIT } from "./exit.js";
import { readLock, verifyLockOwnership } from "./lock.js";
import { createLogger } from "./logger.js";
import { OpenCodeClient, OpenCodeError } from "./opencode/client.js";
import type { OpenCodeAgentInfo, OpenCodeModelInfo } from "./opencode/types.js";
import { expandPath, resolvePaths } from "./paths.js";
import { installService, isEphemeralInstall, serviceStatus } from "./service.js";

interface CliArgs {
  readonly flags: Readonly<Record<string, string | boolean>>;
}

interface Answers {
  token?: string;
  tokenFile?: string;
  baleBaseUrl: string;
  allowedUserId: string;
  opencodeUrl: string;
  opencodeUsername: string;
  password?: string;
  passwordFile?: string;
  model: string;
  agent: string;
  projectDirectory: string;
  healthPort: number;
}

const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096";

export async function runSetup(parsed: CliArgs): Promise<number> {
  const json = parsed.flags.json === true;
  const nonInteractive =
    parsed.flags["non-interactive"] === true || !process.stdin.isTTY || !process.stdout.isTTY;
  const configPathFlag =
    typeof parsed.flags.config === "string" ? parsed.flags.config : undefined;
  const paths = resolvePaths({ configPath: configPathFlag });
  const existing = readConfigFile(paths.configFile);
  const input = new Input(!nonInteractive);
  const logger = createLogger({ level: "error", sink: () => undefined });

  if (existing.problems.length > 0) {
    process.stderr.write(
      `Cannot start setup because ${paths.configFile} has a problem:\n` +
        existing.problems.map((problem) => `  - ${problem}\n`).join("") +
        "Fix it, or remove the file and run setup again.\n",
    );
    return EXIT.NOT_CONFIGURED;
  }

  if (!nonInteractive) {
    process.stdout.write("OpenCode Bale bot setup\n");
    process.stdout.write(`Configuration file: ${paths.configFile}\n\n`);
    if (existing.exists && parsed.flags.yes !== true) {
      const reuse = await input.confirm("A configuration already exists. Use it as the starting point?", true);
      if (!reuse) {
        process.stdout.write("Aborted; the existing configuration was not changed.\n");
        return EXIT.OK;
      }
    }
  } else if (parsed.flags["non-interactive"] !== true) {
    process.stderr.write(
      "Setup requires a terminal. Re-run with --non-interactive and explicit flags, or run it from an interactive shell.\n",
    );
    return EXIT.USAGE;
  }

  let token: string | undefined;
  let tokenFile: string | undefined;
  if (parsed.flags["token-stdin"] === true) {
    token = (await readStdin()).trim();
    if (!token) {
      process.stderr.write("No token arrived on stdin.\n");
      return EXIT.USAGE;
    }
  } else if (typeof parsed.flags["token-file"] === "string") {
    tokenFile = expandPath(parsed.flags["token-file"], process.cwd());
    token = readSecretFile(tokenFile);
  } else if (nonInteractive) {
    const envToken = process.env.BALE_BOT_TOKEN?.trim();
    const envFile = process.env.BALE_BOT_TOKEN_FILE?.trim();
    if (envToken) {
      token = envToken;
    } else if (envFile) {
      tokenFile = expandPath(envFile, process.cwd());
      token = readSecretFile(tokenFile);
    } else if (existing.data.bale?.token) {
      token = existing.data.bale.token;
    } else if (existing.data.bale?.tokenFile) {
      tokenFile = expandPath(existing.data.bale.tokenFile, dirname(paths.configFile));
      token = readSecretFile(tokenFile);
    }
  } else {
    const defaultHint = existing.data.bale?.tokenFile ? " (press Enter to keep the current file)" : "";
    const entered = await input.secret(`Bale bot token${defaultHint}: `);
    if (entered.trim() !== "") {
      token = entered.trim();
    } else if (existing.data.bale?.token) {
      token = existing.data.bale.token;
    } else if (existing.data.bale?.tokenFile) {
      tokenFile = expandPath(existing.data.bale.tokenFile, dirname(paths.configFile));
      token = readSecretFile(tokenFile);
    }
  }

  if (!token) {
    process.stderr.write(
      "A Bale bot token is required. Pass --token-file <path>, --token-stdin, or set BALE_BOT_TOKEN.\n",
    );
    return EXIT.NOT_CONFIGURED;
  }

  const baleBaseUrl =
    process.env.BALE_API_BASE_URL?.trim() || existing.data.bale?.baseUrl || "https://tapi.bale.ai/bot";

  const gateway = new SdkBaleGateway({
    token,
    baseUrl: baleBaseUrl,
    logger,
  });

  let bot: { id: string; username: string | null; firstName: string };
  try {
    bot = await gateway.getMe();
  } catch (caught) {
    process.stderr.write(`The Bale token was rejected: ${(caught as Error).message}\n`);
    return EXIT.NOT_CONFIGURED;
  }
  if (!json) {
    process.stdout.write(`Bot: @${bot.username ?? bot.id} (${bot.firstName})\n`);
  }

  const rawUserId = nonInteractive
    ? (typeof parsed.flags["user-id"] === "string"
        ? parsed.flags["user-id"]
        : process.env.BALE_ALLOWED_USER_ID?.trim() ||
          (typeof existing.data.bale?.allowedUserId === "number"
            ? String(existing.data.bale.allowedUserId)
            : existing.data.bale?.allowedUserId))
    : await promptUserId(input, gateway, paths.lockPath, existing);
  const allowedUserId =
    rawUserId === undefined || rawUserId === null ? undefined : String(rawUserId).trim();

  if (!allowedUserId || !/^\d+$/.test(allowedUserId)) {
    process.stderr.write(
      "A numeric Bale user ID is required. Pass --user-id, set BALE_ALLOWED_USER_ID, or run setup interactively.\n",
    );
    return EXIT.NOT_CONFIGURED;
  }

  const opencode = await resolveOpenCode({
    input,
    nonInteractive,
    parsed,
    existing,
    json,
    logger,
  });
  if (!opencode.ok) {
    return opencode.exitCode;
  }

  const selectedModel = await chooseModel(input, nonInteractive, parsed, existing, opencode.client, opencode.models);
  if (selectedModel === null) {
    return EXIT.NOT_CONFIGURED;
  }

  const selectedAgent = await chooseAgent(input, nonInteractive, parsed, existing, opencode.agents);
  if (selectedAgent === null) {
    return EXIT.NOT_CONFIGURED;
  }

  const projectDirectory = await chooseProject(input, nonInteractive, parsed, existing);
  if (projectDirectory === null) {
    return EXIT.NOT_CONFIGURED;
  }

  const healthPort = await chooseHealthPort(input, nonInteractive, parsed, existing);
  if (healthPort === null) {
    return EXIT.NOT_CONFIGURED;
  }

  const answers: Answers = {
    ...(token ? { token } : {}),
    ...(tokenFile ? { tokenFile } : {}),
    baleBaseUrl,
    allowedUserId,
    opencodeUrl: opencode.url,
    opencodeUsername: opencode.username,
    ...(opencode.password ? { password: opencode.password } : {}),
    ...(opencode.passwordFile ? { passwordFile: opencode.passwordFile } : {}),
    model: selectedModel,
    agent: selectedAgent,
    projectDirectory,
    healthPort,
  };

  if (!json) {
    process.stdout.write("\nReview:\n");
    process.stdout.write(`  bot token:   ${token || tokenFile ? "[set]" : "[missing]"}${tokenFile ? ` (file ${tokenFile})` : ""}\n`);
    process.stdout.write(`  owner id:    ${allowedUserId}\n`);
    process.stdout.write(`  OpenCode:    ${opencode.url}\n`);
    process.stdout.write(`  model:       ${selectedModel}\n`);
    process.stdout.write(`  agent:       ${selectedAgent}\n`);
    process.stdout.write(`  project:     ${projectDirectory}\n`);
    process.stdout.write(`  health port: ${healthPort === 0 ? "disabled" : healthPort}\n`);
    if (!(await input.confirm("\nWrite this configuration?", true))) {
      process.stdout.write("Aborted; nothing was written.\n");
      return EXIT.OK;
    }
  }

  const data = buildFileConfig(existing.data, answers);
  const tempPath = `${paths.configFile}.tmp-${process.pid}`;
  let check;
  try {
    writeConfigFile(tempPath, data);
    check = validateConfig({ configPath: tempPath, env: {} });
  } catch (caught) {
    process.stderr.write(`Could not write the configuration: ${(caught as Error).message}\n`);
    return EXIT.FAILURE;
  }
  if (check.problems.length > 0) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Ignore.
    }
    process.stderr.write("The configuration is incomplete:\n");
    for (const problem of check.problems) {
      process.stderr.write(`  - ${problem}\n`);
    }
    return EXIT.NOT_CONFIGURED;
  }
  try {
    renameSync(tempPath, paths.configFile);
  } catch (caught) {
    throw new ConfigWriteError(`could not replace ${paths.configFile}: ${(caught as Error).message}`);
  }

  const result = {
    wrote: true,
    configPath: paths.configFile,
    bot: { id: bot.id, username: bot.username },
    allowedUserId,
    opencodeUrl: opencode.url,
    model: selectedModel,
    agent: selectedAgent,
    projectDirectory,
    healthPort,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`\nWrote ${paths.configFile}\n\nNext steps:\n`);
    process.stdout.write("  opencode-bale-bot doctor\n");
    process.stdout.write("  opencode-bale-bot service install\n");
    process.stdout.write("  opencode-bale-bot status\n");
    process.stdout.write(`  message @${bot.username ?? bot.id} on Bale\n`);
  }

  if (!nonInteractive && !json) {
    const service = serviceStatus({ paths });
    if (!service.installed && isEphemeralInstall()) {
      process.stderr.write(
        "warning: this CLI is running from an npx cache. Install it globally before using `service install`, or the unit will point at a path npm may delete.\n",
      );
    } else if (!service.installed) {
      if (await input.confirm("Install and start the background service now?", false)) {
        const install = installService({ paths });
        process.stdout.write(`Service: ${install.file}\n`);
        for (const command of install.commands) {
          process.stdout.write(`$ ${command}\n`);
        }
        for (const warning of install.warnings) {
          process.stderr.write(`warning: ${warning}\n`);
        }
      }
    }
  }

  return EXIT.OK;
}

interface OpenCodeResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly url: string;
  readonly username: string;
  readonly password?: string;
  readonly passwordFile?: string;
  readonly client: OpenCodeClient;
  readonly models: readonly OpenCodeModelInfo[];
  readonly agents: readonly OpenCodeAgentInfo[];
}

async function resolveOpenCode(args: {
  readonly input: Input;
  readonly nonInteractive: boolean;
  readonly parsed: CliArgs;
  readonly existing: ReturnType<typeof readConfigFile>;
  readonly json: boolean;
  readonly logger: ReturnType<typeof createLogger>;
}): Promise<OpenCodeResult> {
  const { input, nonInteractive, parsed, existing } = args;
  const existingOpenCode = existing.data.opencode ?? {};

  const url =
    (typeof parsed.flags["opencode-url"] === "string" ? parsed.flags["opencode-url"] : undefined) ??
    (existingOpenCode.url || DEFAULT_OPENCODE_URL);
  let checked: URL;
  try {
    checked = new URL(url);
  } catch {
    process.stderr.write(`That is not a valid OpenCode URL: ${url}\n`);
    return {
      ok: false,
      exitCode: EXIT.USAGE,
      url,
      username: "",
      client: null as unknown as OpenCodeClient,
      models: [],
      agents: [],
    };
  }
  if (!isLoopbackHostname(checked.hostname)) {
    process.stderr.write(
      `OpenCode must be a loopback URL (127.0.0.1, ::1, or localhost); got ${checked.hostname}.\n`,
    );
    return {
      ok: false,
      exitCode: EXIT.NOT_CONFIGURED,
      url,
      username: "",
      client: null as unknown as OpenCodeClient,
      models: [],
      agents: [],
    };
  }

  let username =
    (typeof parsed.flags["opencode-username"] === "string"
      ? parsed.flags["opencode-username"]
      : undefined) ??
    process.env.OPENCODE_USERNAME?.trim() ??
    existingOpenCode.username ??
    "opencode";

  let password: string | undefined;
  let passwordFile: string | undefined;

  const passwordFileFlag =
    typeof parsed.flags["opencode-password-file"] === "string"
      ? parsed.flags["opencode-password-file"]
      : undefined;
  if (passwordFileFlag) {
    passwordFile = expandPath(passwordFileFlag, process.cwd());
    password = readSecretFile(passwordFile);
    if (!password) {
      return {
        ok: false,
        exitCode: EXIT.NOT_CONFIGURED,
        url,
        username,
        client: null as unknown as OpenCodeClient,
        models: [],
        agents: [],
      };
    }
  } else if (existingOpenCode.password) {
    password = existingOpenCode.password;
  } else if (existingOpenCode.passwordFile) {
    passwordFile = expandPath(existingOpenCode.passwordFile, dirname(existing.path));
    password = readSecretFile(passwordFile);
  } else if (process.env.OPENCODE_PASSWORD?.trim()) {
    password = process.env.OPENCODE_PASSWORD.trim();
  } else {
    const serviceFile = join(homedir(), ".config", "opencode", "service.json");
    if (existsSync(serviceFile)) {
      passwordFile = serviceFile;
      password = readSecretFile(serviceFile);
    }
  }

  const makeClient = (): OpenCodeClient =>
    new OpenCodeClient({
      baseUrl: url,
      username,
      password: password ?? "",
      timeoutMs: 10_000,
      logger: args.logger,
    });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!password && nonInteractive) {
      process.stderr.write(
        "An OpenCode password is required. Pass --opencode-password-file <path> or set OPENCODE_PASSWORD.\n",
      );
      break;
    }
    if (!password && !nonInteractive) {
      password = await input.secret(`OpenCode password for ${username} at ${url}: `);
    }
    const client = makeClient();
    try {
      const info = await client.info();
      if (!info.version.startsWith("2.")) {
        process.stderr.write(
          `warning: this bridge targets OpenCode V2, but the server reports ${info.version}.\n`,
        );
      }
      const models = await client.listModels();
      const agents = await client.listAgents();
      return { ok: true, exitCode: EXIT.OK, url, username, ...(password ? { password } : {}), ...(passwordFile ? { passwordFile } : {}), client, models, agents };
    } catch (caught) {
      if (caught instanceof OpenCodeError && caught.status === 401) {
        if (nonInteractive) {
          process.stderr.write("OpenCode rejected the credentials (HTTP 401).\n");
          break;
        }
        process.stderr.write("OpenCode rejected those credentials.\n");
        password = await input.secret("OpenCode password: ");
        passwordFile = undefined;
        continue;
      }
      process.stderr.write(
        `Cannot reach OpenCode at ${url}: ${(caught as Error).message}\n`,
      );
      if (nonInteractive) {
        break;
      }
      const next = await input.ask("OpenCode URL (press Enter to retry, or type a new URL): ");
      if (next.trim() !== "") {
        try {
          const parsedUrl = new URL(next.trim());
          if (!isLoopbackHostname(parsedUrl.hostname)) {
            process.stderr.write("The URL must be loopback-only.\n");
            continue;
          }
        } catch {
          process.stderr.write("That is not a valid URL.\n");
          continue;
        }
      }
    }
  }

  return {
    ok: false,
    exitCode: EXIT.NOT_CONFIGURED,
    url,
    username,
    client: null as unknown as OpenCodeClient,
    models: [],
    agents: [],
  };
}

async function chooseModel(
  input: Input,
  nonInteractive: boolean,
  parsed: CliArgs,
  existing: ReturnType<typeof readConfigFile>,
  client: OpenCodeClient,
  models: readonly OpenCodeModelInfo[],
): Promise<string | null> {
  const existingModel = existing.data.opencode?.model;
  const existingValue =
    typeof existingModel === "string"
      ? existingModel
      : existingModel
        ? `${existingModel.providerID ?? ""}/${existingModel.id ?? ""}`
        : undefined;
  const requested =
    (typeof parsed.flags.model === "string" ? parsed.flags.model : undefined) ??
    process.env.OPENCODE_MODEL?.trim() ??
    (nonInteractive ? existingValue : undefined);

  const available = models
    .filter((model) => model.enabled !== false)
    .map((model) => `${model.providerID}/${model.id}`);
  const all = available.length > 0 ? available : models.map((model) => `${model.providerID}/${model.id}`);

  if (requested) {
    if (all.includes(requested) || nonInteractive) {
      return requested;
    }
    process.stderr.write(`Model ${requested} is not available.\n`);
  }

  if (nonInteractive) {
    process.stderr.write(
      "A model is required. Pass --model provider/modelID or set OPENCODE_MODEL.\n",
    );
    return null;
  }

  let candidates = all;
  if (candidates.length > 40) {
    const filter = await input.ask(
      `Model filter (${all.length} available, blank shows the first 40): `,
    );
    if (filter.trim() !== "") {
      candidates = all.filter((model) => model.toLowerCase().includes(filter.trim().toLowerCase()));
    } else {
      candidates = all.slice(0, 40);
    }
  }
  if (candidates.length === 0) {
    process.stderr.write("No models matched. Run setup again or check the OpenCode server.\n");
    return null;
  }
  const defaultIndex = existingValue ? candidates.indexOf(existingValue) : -1;
  const picked = await input.choose(
    "Model",
    candidates,
    (model, index) => `${index + 1}) ${model}${index === defaultIndex ? " (current)" : ""}`,
    defaultIndex >= 0 ? defaultIndex : 0,
  );
  return candidates[picked] ?? null;
}

async function chooseAgent(
  input: Input,
  nonInteractive: boolean,
  parsed: CliArgs,
  existing: ReturnType<typeof readConfigFile>,
  agents: readonly OpenCodeAgentInfo[],
): Promise<string | null> {
  const existingAgent = existing.data.opencode?.agent;
  const requested =
    (typeof parsed.flags.agent === "string" ? parsed.flags.agent : undefined) ??
    process.env.OPENCODE_AGENT?.trim() ??
    existingAgent;
  const usable = agents
    .filter((agent) => agent.hidden !== true && agent.mode !== "subagent")
    .map((agent) => agent.id);
  const fallback = usable.includes("build") ? "build" : (usable[0] ?? "build");

  if (requested) {
    return requested;
  }
  if (nonInteractive || usable.length === 0) {
    return fallback;
  }
  const defaultIndex = Math.max(0, usable.indexOf("build"));
  const picked = await input.choose(
    "Agent",
    usable,
    (agent, index) => `${index + 1}) ${agent}${index === defaultIndex ? " (default)" : ""}`,
    defaultIndex,
  );
  return usable[picked] ?? fallback;
}

async function chooseProject(
  input: Input,
  nonInteractive: boolean,
  parsed: CliArgs,
  existing: ReturnType<typeof readConfigFile>,
): Promise<string | null> {
  const requested =
    (typeof parsed.flags.project === "string" ? parsed.flags.project : undefined) ??
    process.env.PROJECT_DIRECTORY?.trim() ??
    existing.data.opencode?.projectDirectory;

  if (nonInteractive) {
    const value = expandPath(requested ?? homedir(), process.cwd());
    if (!existsSync(value) || !statSync(value).isDirectory()) {
      process.stderr.write(`Project directory does not exist: ${value}\n`);
      return null;
    }
    return value;
  }

  let current = requested ? expandPath(requested, process.cwd()) : homedir();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const entered = await input.ask(`Project directory [${current}]: `);
    if (entered.trim() !== "") {
      current = expandPath(entered.trim(), process.cwd());
    }
    if (!existsSync(current)) {
      process.stderr.write(`That directory does not exist: ${current}\n`);
      continue;
    }
    if (!statSync(current).isDirectory()) {
      process.stderr.write(`That is not a directory: ${current}\n`);
      continue;
    }
    const gitRoot = findGitRoot(current);
    if (gitRoot && gitRoot !== current) {
      if (await input.confirm(`Use the enclosing git root ${gitRoot}?`, true)) {
        current = gitRoot;
      }
    }
    return current;
  }
  return null;
}

async function chooseHealthPort(
  input: Input,
  nonInteractive: boolean,
  parsed: CliArgs,
  existing: ReturnType<typeof readConfigFile>,
): Promise<number | null> {
  const raw =
    (typeof parsed.flags["health-port"] === "string" ? parsed.flags["health-port"] : undefined) ??
    process.env.BRIDGE_HEALTH_PORT?.trim() ??
    (typeof existing.data.bridge?.healthPort === "number"
      ? String(existing.data.bridge.healthPort)
      : undefined) ??
    "4097";

  if (nonInteractive) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      process.stderr.write(`Invalid health port: ${raw}\n`);
      return null;
    }
    if (port !== 0 && !(await isPortFree("127.0.0.1", port))) {
      process.stderr.write(`Port ${port} is already in use.\n`);
      return null;
    }
    return port;
  }

  let candidate = raw;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const entered = await input.ask(`Health port (0 disables) [${candidate}]: `);
    if (entered.trim() !== "") {
      candidate = entered.trim();
    }
    const port = Number(candidate);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      process.stderr.write("Enter a port between 0 and 65535.\n");
      continue;
    }
    if (port === 0) {
      return 0;
    }
    if (await isPortFree("127.0.0.1", port)) {
      return port;
    }
    process.stderr.write(`Port ${port} is already in use; choose another.\n`);
  }
  return null;
}

async function promptUserId(
  input: Input,
  gateway: SdkBaleGateway,
  lockPath: string,
  existing: ReturnType<typeof readConfigFile>,
): Promise<string | undefined> {
  const existingId = existing.data.bale?.allowedUserId;
  const existingValue =
    typeof existingId === "number" ? String(existingId) : existingId;

  const lock = readLock(lockPath);
  if (lock) {
    const ownership = verifyLockOwnership(lock);
    if (ownership === "valid" || ownership === "unknown") {
      process.stdout.write(
        "A daemon is running, so setup will not read Bale updates. Enter the owner ID manually.\n",
      );
      return promptManualId(input, existingValue);
    }
  }

  process.stdout.write(
    "\nSend any message to the bot from your own Bale account now.\n" +
      "Setup will read the pending Bale update queue once to identify you.\n" +
      "Warning: this consumes updates that arrived before the bridge started.\n\n",
  );
  await input.ask("Press Enter once you have sent the message: ");

  try {
    const updates = await gateway.getUpdates({ offset: -1, limit: 100, timeout: 25 });
    const candidates = new Map<string, string>();
    for (const update of updates) {
      const message = getUpdateMessage(update);
      const chat = getUpdateChat(update);
      const from = message?.from;
      if (!message || !from || from.is_bot) {
        continue;
      }
      if (chat?.type !== "private") {
        continue;
      }
      const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
      candidates.set(String(from.id), name || String(from.id));
    }

    if (candidates.size === 1) {
      const [id, name] = [...candidates.entries()][0] as [string, string];
      process.stdout.write(`Found ${name} (id ${id}).\n`);
      if (await input.confirm("Use this account as the owner?", true)) {
        return id;
      }
    } else if (candidates.size > 1) {
      const entries = [...candidates.entries()];
      const picked = await input.choose(
        "Choose the owner",
        entries,
        ([id, name], index) => `${index + 1}) ${name} (id ${id})`,
        0,
      );
      const selected = entries[picked];
      if (selected) {
        return selected[0];
      }
    } else {
      process.stdout.write("No private messages were found. Enter the ID manually.\n");
    }
  } catch (caught) {
    process.stderr.write(`Could not read Bale updates: ${(caught as Error).message}\n`);
  }

  return promptManualId(input, existingValue);
}

async function promptManualId(input: Input, current?: string): Promise<string | undefined> {
  const hint = current ? ` [${current}]` : "";
  const entered = await input.ask(
    `Owner Bale user ID${hint} (message the bot, or check the /id command): `,
  );
  if (entered.trim() !== "") {
    return entered.trim();
  }
  return current;
}

function buildFileConfig(existing: FileConfig, answers: Answers): FileConfig {
  const bale: FileConfig["bale"] = {
    ...(existing.bale ?? {}),
    baseUrl: answers.baleBaseUrl,
    allowedUserId: answers.allowedUserId,
  };
  delete bale.token;
  delete bale.tokenFile;
  if (answers.tokenFile) {
    bale.tokenFile = answers.tokenFile;
  } else if (answers.token) {
    bale.token = answers.token;
  }

  const opencode: FileConfig["opencode"] = {
    ...(existing.opencode ?? {}),
    url: answers.opencodeUrl,
    username: answers.opencodeUsername,
    model: answers.model,
    agent: answers.agent,
    projectDirectory: answers.projectDirectory,
  };
  delete opencode.password;
  delete opencode.passwordFile;
  if (answers.passwordFile) {
    opencode.passwordFile = answers.passwordFile;
  } else if (answers.password) {
    opencode.password = answers.password;
  }

  const bridge: FileConfig["bridge"] = {
    ...(existing.bridge ?? {}),
    healthHost: "127.0.0.1",
    healthPort: answers.healthPort,
  };

  return {
    ...existing,
    configVersion: CONFIG_VERSION,
    bale,
    opencode,
    bridge,
  };
}

class Input {
  constructor(private readonly interactive: boolean) {}

  async ask(prompt: string): Promise<string> {
    if (!this.interactive) {
      throw new Error(`cannot prompt for "${prompt}" in non-interactive mode`);
    }
    return readLine(prompt);
  }

  async secret(prompt: string): Promise<string> {
    if (!this.interactive) {
      throw new Error("cannot prompt for a secret in non-interactive mode");
    }
    if (process.stdin.isTTY) {
      return readMasked(prompt);
    }
    return readLine(prompt);
  }

  async confirm(prompt: string, defaultValue: boolean): Promise<boolean> {
    if (!this.interactive) {
      return defaultValue;
    }
    const suffix = defaultValue ? " [Y/n]: " : " [y/N]: ";
    const answer = (await readLine(`${prompt}${suffix}`)).trim().toLowerCase();
    if (answer === "") {
      return defaultValue;
    }
    return answer === "y" || answer === "yes";
  }

  async choose<T>(
    label: string,
    items: readonly T[],
    render: (item: T, index: number) => string,
    defaultIndex: number,
  ): Promise<number> {
    if (!this.interactive) {
      return defaultIndex;
    }
    items.forEach((item, index) => {
      process.stdout.write(`${render(item, index)}\n`);
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const answer = (await readLine(`${label} [${defaultIndex + 1}]: `)).trim();
      if (answer === "") {
        return defaultIndex;
      }
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < items.length) {
        return index;
      }
      const matched = items.findIndex((item) => String(item) === answer);
      if (matched >= 0) {
        return matched;
      }
      process.stdout.write("Enter a number from the list.\n");
    }
    return defaultIndex;
  }
}

function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      cleanup();
      process.stdout.write("\n");
      resolvePromise(line);
    };
    const onError = (caught: Error): void => {
      cleanup();
      reject(caught);
    };
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("error", onError);
      process.stdin.pause();
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });
}

function readMasked(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("interrupted"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolvePromise(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += character;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.once("end", () => resolvePromise(data));
    process.stdin.once("error", reject);
    process.stdin.resume();
  });
}

function readSecretFile(path: string): string | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) {
      return undefined;
    }
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as { password?: unknown; token?: unknown };
      const value = parsed.password ?? parsed.token;
      return typeof value === "string" ? value : undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

function findGitRoot(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 40; depth += 1) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, host);
  });
}