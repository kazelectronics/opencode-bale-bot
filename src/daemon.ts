import type { Config } from "./config.js";
import { ConfigError, loadConfig, redactConfig } from "./config.js";
import {
  CallbackRepo,
  ChatRepo,
  FormSessionRepo,
  InteractionMessageRepo,
  MetaRepo,
  ProcessedUpdatesRepo,
  PromptIdRepo,
  SettingsRepo,
  TaskRepo,
  WatchedSessionRepo,
  openDatabase,
  type Db,
} from "./db.js";
import { EXIT } from "./exit.js";
import { HealthState } from "./health.js";
import { startHealthServer, type HealthServer } from "./healthServer.js";
import { acquireLock, type ProcessLock } from "./lock.js";
import { createLogger, errorMessage, type Logger } from "./logger.js";
import { RotatingFileSink } from "./logFile.js";
import { BalePoller } from "./bale/poller.js";
import { Outbox } from "./bale/outbox.js";
import { SdkBaleGateway } from "./bale/gateway.js";
import { OpenCodeClient } from "./opencode/client.js";
import { OpenCodeEventStream } from "./opencode/events.js";
import { AttachmentService } from "./bridge/attachments.js";
import { CatalogManager } from "./bridge/catalogs.js";
import { FileBrowser } from "./bridge/files.js";
import { FormManager } from "./bridge/forms.js";
import { HistoryManager } from "./bridge/history.js";
import { InteractionManager } from "./bridge/interactions.js";
import { MenuManager } from "./bridge/menus.js";
import { ProjectManager } from "./bridge/projects.js";
import { RunCoordinator } from "./bridge/runCoordinator.js";
import { SessionService } from "./bridge/sessions.js";
import { PromptHandler } from "./bridge/prompts.js";
import { CommandHandler } from "./bridge/commands.js";
import { UpdateRouter } from "./bridge/router.js";
import { WatchManager } from "./bridge/watches.js";
import { SettingsManager } from "./bridge/settings.js";
import { DashboardManager } from "./bridge/dashboard.js";
import { DirectoryBrowser } from "./bridge/directoryBrowser.js";
import { ServerControl } from "./bridge/serverControl.js";
import { TaskManager } from "./bridge/tasks.js";
import { OpenCodeMonitor } from "./bridge/monitor.js";

interface Runtime {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Db;
  readonly lock: ProcessLock;
  readonly poller: BalePoller;
  readonly eventStream: OpenCodeEventStream;
  readonly outbox: Outbox;
  pollerDone: Promise<void>;
  eventDone: Promise<void>;
  readonly healthTimer: NodeJS.Timeout;
  readonly pruneTimer: NodeJS.Timeout;
  readonly dashboardTimer: NodeJS.Timeout;
  readonly monitor: OpenCodeMonitor;
  readonly tasks: TaskManager;
  readonly healthServer: HealthServer | null;
  readonly logFile: RotatingFileSink | null;
}

export interface StartDaemonOptions {
  /** Explicit config path, from --config. */
  readonly configPath?: string;
  /** Command-line overrides keyed by environment-variable name. */
  readonly flags?: Partial<Record<string, string | number | boolean>>;
  /** Pre-validated config, mostly for embedding and tests. */
  readonly config?: Config;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<void> {
  let config: Config;
  try {
    config =
      options.config ??
      loadConfig({
        configPath: options.configPath,
        flags: options.flags,
        warn: (message) => process.stderr.write(`warning: ${message}\n`),
      });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = EXIT.NOT_CONFIGURED;
      return;
    }
    throw error;
  }

  let logFile: RotatingFileSink | null = null;
  if (config.bridge.logFile) {
    try {
      logFile = new RotatingFileSink({
        path: config.bridge.logFile,
        maxBytes: config.bridge.logMaxBytes,
        maxFiles: config.bridge.logMaxFiles,
      });
    } catch (error) {
      process.stderr.write(
        `Could not open the log file (${config.bridge.logFile}): ${errorMessage(error)}\n`,
      );
    }
  }

  const logger = createLogger({
    level: config.bridge.logLevel,
    secrets: [config.bale.token, config.opencode.password],
    baseFields: { component: "bridge" },
    sink: (line) => {
      process.stdout.write(`${line}\n`);
      logFile?.write(line);
    },
  });

  logger.info("Starting OpenCode Bale bridge", { config: redactConfig(config) });

  let lock: ProcessLock;
  try {
    lock = acquireLock(config.bridge.lockPath);
  } catch (error) {
    logger.error("Could not acquire the single-instance lock", {
      error: errorMessage(error),
    });
    process.exitCode = 1;
    return;
  }

  let db: Db;
  try {
    db = openDatabase(config.bridge.dbPath);
  } catch (error) {
    logger.error("Could not open the state database", {
      path: config.bridge.dbPath,
      error: errorMessage(error),
    });
    lock.release();
    process.exitCode = 1;
    return;
  }

  const meta = new MetaRepo(db);
  const chats = new ChatRepo(db);
  const callbacks = new CallbackRepo(db);
  const processed = new ProcessedUpdatesRepo(db);
  const interactionMessages = new InteractionMessageRepo(db);
  const promptIds = new PromptIdRepo(db);
  const formSessions = new FormSessionRepo(db);
  const watchedSessions = new WatchedSessionRepo(db);
  const settingsRepo = new SettingsRepo(db);
  const tasksRepo = new TaskRepo(db);

  const health = new HealthState(config.opencode.baseUrl, {
    instance: lock.info.instance,
    version: lock.info.version,
  });
  const gateway = new SdkBaleGateway({
    token: config.bale.token,
    baseUrl: config.bale.baseUrl,
    logger,
  });
  const client = new OpenCodeClient({
    baseUrl: config.opencode.baseUrl,
    username: config.opencode.username,
    password: config.opencode.password,
    timeoutMs: config.opencode.requestTimeoutMs,
    logger: logger.child({ component: "opencode" }),
  });

  try {
    const me = await gateway.getMe();
    health.botId = me.id;
    health.botUsername = me.username;
    logger.info("Bale bot authenticated", {
      botId: me.id,
      username: me.username,
      name: me.firstName,
    });
  } catch (error) {
    logger.error("Bale authentication failed; check BALE_BOT_TOKEN", {
      error: errorMessage(error),
    });
    db.close();
    lock.release();
    process.exitCode = 1;
    return;
  }

  try {
    const info = await client.info();
    health.opencodeVersion = info.version;
    health.setOpenCode(true, { version: info.version });
    logger.info("OpenCode server reachable", {
      version: info.version,
      url: config.opencode.baseUrl,
    });
    if (!info.version.startsWith("2.")) {
      logger.warn("This bridge targets OpenCode V2; the server reports a different version", {
        version: info.version,
      });
    }
  } catch (error) {
    logger.error("Cannot reach the OpenCode server", {
      url: config.opencode.baseUrl,
      error: errorMessage(error),
    });
    db.close();
    lock.release();
    process.exitCode = 1;
    return;
  }

  const missingPaths = await client.checkContract();
  if (missingPaths.length > 0) {
    logger.warn("OpenCode is missing expected API paths; the bridge may not work", {
      missingPaths,
    });
  }

  const outbox = new Outbox(gateway, {
    editIntervalMs: config.bridge.editIntervalMs,
    logger: logger.child({ component: "outbox" }),
  });
  const monitor = new OpenCodeMonitor({
    client,
    health,
    chats,
    outbox,
    config,
    logger: logger.child({ component: "monitor" }),
  });
  const taskManager = new TaskManager({
    client,
    gateway,
    chats,
    tasks: tasksRepo,
    outbox,
    health,
    config,
    logger: logger.child({ component: "tasks" }),
  });
  const settingsManager = new SettingsManager({
    gateway,
    chats,
    settings: settingsRepo,
    config,
    outbox,
    logger: logger.child({ component: "settings" }),
  });
  let coordinator: RunCoordinator | null = null;
  const dashboard = new DashboardManager({
    client,
    gateway,
    chats,
    settings: settingsRepo,
    outbox,
    config,
    logger: logger.child({ component: "dashboard" }),
    runState: (sessionID) => coordinator?.snapshot(sessionID) ?? null,
  });
  settingsManager.setDashboard(dashboard);
  const sessions = new SessionService(client, chats, config, logger.child({ component: "sessions" }));
  const attachments = new AttachmentService({
    gateway,
    config,
    logger: logger.child({ component: "attachments" }),
  });
  const calls = new InteractionManager({
    client,
    gateway,
    callbacks,
    interactionMessages,
    settings: settingsRepo,
    outbox,
    logger: logger.child({ component: "interactions" }),
  });
  const forms = new FormManager({
    client,
    gateway,
    callbacks,
    forms: formSessions,
    interactionMessages,
    outbox,
    logger: logger.child({ component: "forms" }),
  });
  const menus = new MenuManager({
    client,
    gateway,
    chats,
    sessions,
    callbacks,
    outbox,
    defaultModel: config.opencode.model,
    logger: logger.child({ component: "menus" }),
  });
  const watchManager = new WatchManager({
    client,
    gateway,
    chats,
    sessions,
    watches: watchedSessions,
    callbacks,
    settings: settingsRepo,
    interactions: calls,
    forms,
    outbox,
    logger: logger.child({ component: "watches" }),
  });
  sessions.setWatcher(watchManager);
  const catalogs = new CatalogManager({
    client,
    gateway,
    chats,
    sessions,
    callbacks,
    outbox,
    config,
    logger: logger.child({ component: "catalogs" }),
  });
  const files = new FileBrowser({
    client,
    gateway,
    chats,
    callbacks,
    settings: settingsRepo,
    outbox,
    config,
    logger: logger.child({ component: "files" }),
  });
  const historyManager = new HistoryManager({
    client,
    gateway,
    chats,
    sessions,
    callbacks,
    outbox,
    logger: logger.child({ component: "history" }),
  });
  const projects = new ProjectManager({
    client,
    gateway,
    chats,
    sessions,
    callbacks,
    outbox,
    config,
    logger: logger.child({ component: "projects" }),
  });
  const directoryBrowser = new DirectoryBrowser({
    gateway,
    chats,
    callbacks,
    settings: settingsRepo,
    outbox,
    projects,
    logger: logger.child({ component: "directories" }),
  });
  const serverControl = new ServerControl({
    client,
    gateway,
    chats,
    callbacks,
    settings: settingsRepo,
    outbox,
    config,
    logger: logger.child({ component: "servers" }),
    lifecycle: monitor,
  });
  coordinator = new RunCoordinator({
    client,
    gateway,
    chats,
    outbox,
    interactions: calls,
    forms,
    menus,
    sessions,
    watches: watchManager,
    dashboard,
    settings: settingsRepo,
    health,
    config,
    logger: logger.child({ component: "runs" }),
    taskChatForSession: (sessionID) => taskManager.chatForSession(sessionID),
  });
  const prompts = new PromptHandler({
    client,
    chats,
    promptIds,
    sessions,
    interactions: calls,
    outbox,
    config,
    logger: logger.child({ component: "prompts" }),
  });
  const commands = new CommandHandler({
    client,
    chats,
    sessions,
    forms,
    interactions: calls,
    menus,
    catalogs,
    files,
    history: historyManager,
    projects,
    watches: watchManager,
    settingsManager,
    dashboard,
    directoryBrowser,
    serverControl,
    tasks: taskManager,
    settings: settingsRepo,
    outbox,
    health,
    config,
    logger: logger.child({ component: "commands" }),
  });
  const router = new UpdateRouter({
    allowedUserId: config.bale.allowedUserId,
    chats,
    commands,
    prompts,
    interactions: calls,
    forms,
    menus,
    attachments,
    catalogs,
    files,
    history: historyManager,
    projects,
    watches: watchManager,
    settingsManager,
    dashboard,
    directoryBrowser,
    serverControl,
    tasks: taskManager,
    outbox,
    config,
    logger: logger.child({ component: "router" }),
  });

  const eventStream = new OpenCodeEventStream({
    baseUrl: config.opencode.baseUrl,
    username: config.opencode.username,
    password: config.opencode.password,
    logger: logger.child({ component: "sse" }),
    onEvent: (event) => {
      health.sseLastEventAt = Date.now();
      coordinator.handleEvent(event);
    },
    onConnectionChange: (connected, reconnected) => {
      health.sseConnected = connected;
      if (connected && reconnected) {
        void coordinator.resync().catch((error) => {
          logger.warn("Post-reconnect resync failed", { error: errorMessage(error) });
        });
      }
    },
  });

  const poller = new BalePoller({
    gateway,
    meta,
    processed,
    promptIds,
    logger: logger.child({ component: "poller" }),
    limit: config.bale.pollLimit,
    timeoutSec: config.bale.pollTimeoutSec,
    onUpdate: (update) => router.handle(update),
  });

  const pruneTimer = setInterval(
    () => {
      callbacks.prune();
      void forms.pruneExpired().catch((error) => {
        logger.warn("Form expiration sweep failed", { error: errorMessage(error) });
      });
      void attachments.prune().catch((error) => {
        logger.warn("Attachment expiration sweep failed", { error: errorMessage(error) });
      });
    },
    60 * 1_000,
  );
  pruneTimer.unref();

  const dashboardTimer = setInterval(() => {
    void dashboard.refreshAll().catch((error) => {
      logger.debug("Dashboard sweep failed", { error: errorMessage(error) });
    });
  }, 30 * 1_000);
  dashboardTimer.unref();

  const healthTimer = setInterval(() => {
    const snapshot = poller.snapshot();
    health.pollerRunning = snapshot.running;
    health.lastPollAt = snapshot.lastPollAt;
    health.lastUpdateAt = snapshot.lastUpdateAt;
    health.pollerError = snapshot.lastError;
    health.sseConnected = eventStream.isConnected();
    health.sseLastEventAt = eventStream.lastEventTimestamp() ?? health.sseLastEventAt;
  }, 2_000);
  healthTimer.unref();

  let healthServer: HealthServer | null = null;
  if (config.bridge.healthPort > 0) {
    try {
      healthServer = await startHealthServer({
        host: config.bridge.healthHost,
        port: config.bridge.healthPort,
        health,
        logger: logger.child({ component: "health" }),
      });
    } catch (error) {
      logger.error("Could not start the health endpoint", {
        host: config.bridge.healthHost,
        port: config.bridge.healthPort,
        error: errorMessage(error),
      });
    }
  }

  const runtime: Runtime = {
    config,
    logger,
    db,
    lock,
    poller,
    eventStream,
    outbox,
    pollerDone: Promise.resolve(),
    eventDone: Promise.resolve(),
    healthTimer,
    pruneTimer,
    dashboardTimer,
    monitor,
    tasks: taskManager,
    healthServer,
    logFile,
  };

  runtime.eventDone = eventStream.run().catch((error) => {
    logger.error("Event stream loop stopped unexpectedly", { error: errorMessage(error) });
  });
  runtime.pollerDone = poller.run().catch((error) => {
    logger.error("Bale polling loop stopped unexpectedly", { error: errorMessage(error) });
  });

  monitor.start();
  taskManager.start();

  logger.info("Bridge ready", {
    projectDirectory: config.opencode.projectDirectory,
    model: `${config.opencode.model.providerID}/${config.opencode.model.id}`,
    delivery: config.bridge.delivery,
    health: healthServer
      ? `http://${config.bridge.healthHost}:${healthServer.port}`
      : "disabled",
    scheduledTasks: tasksRepo.countActive(),
    autoRestart: monitor.autoRestartEnabled,
  });

  installSignalHandlers(runtime);
}

function installSignalHandlers(runtime: Runtime): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    runtime.logger.info("Shutting down", { signal });

    runtime.poller.stop();
    runtime.eventStream.stop();
    runtime.monitor.stop();
    runtime.tasks.stop();
    clearInterval(runtime.healthTimer);
    clearInterval(runtime.pruneTimer);
    clearInterval(runtime.dashboardTimer);

    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        runtime.logger.warn("Shutdown deadline reached; forcing exit");
        resolve();
      }, 10_000);
      timer.unref();
    });

    await Promise.race([
      Promise.allSettled([
        runtime.pollerDone,
        runtime.eventDone,
        runtime.outbox.flushAll(),
      ]).then(() => undefined),
      deadline,
    ]);

    runtime.outbox.closeAll();
    if (runtime.healthServer) {
      await runtime.healthServer.close();
    }
    try {
      runtime.db.close();
    } catch (error) {
      runtime.logger.warn("Database close failed", { error: errorMessage(error) });
    }
    runtime.lock.release();
    runtime.logger.info("Bridge stopped");
    runtime.logFile?.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.on("unhandledRejection", (reason) => {
    runtime.logger.error("Unhandled promise rejection", { error: errorMessage(reason) });
  });
  process.on("uncaughtException", (error) => {
    runtime.logger.error("Uncaught exception", { error });
    void shutdown("uncaughtException");
  });
}

