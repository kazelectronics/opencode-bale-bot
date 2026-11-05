import type { Update } from "@erfanvahabpour/bale-bot-sdk";
import { describe, expect, it, vi } from "vitest";

import type { Outbox } from "../src/bale/outbox.js";
import type { AttachmentService } from "../src/bridge/attachments.js";
import type { CatalogManager } from "../src/bridge/catalogs.js";
import type { CommandHandler } from "../src/bridge/commands.js";
import type { FileBrowser } from "../src/bridge/files.js";
import type { FormManager } from "../src/bridge/forms.js";
import type { HistoryManager } from "../src/bridge/history.js";
import type { InteractionManager } from "../src/bridge/interactions.js";
import type { MenuManager } from "../src/bridge/menus.js";
import type { ProjectManager } from "../src/bridge/projects.js";
import type { PromptHandler } from "../src/bridge/prompts.js";
import type { WatchManager } from "../src/bridge/watches.js";
import type { SettingsManager } from "../src/bridge/settings.js";
import type { DashboardManager } from "../src/bridge/dashboard.js";
import type { DirectoryBrowser } from "../src/bridge/directoryBrowser.js";
import type { ServerControl } from "../src/bridge/serverControl.js";
import type { TaskManager } from "../src/bridge/tasks.js";
import { UpdateRouter } from "../src/bridge/router.js";
import type { Config } from "../src/config.js";
import type { ChatRepo, ChatRow } from "../src/db.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const chatRow: ChatRow = {
  chat_id: "77",
  user_id: "42",
  active_session_id: null,
  project_directory: "/tmp",
  model_provider: null,
  model_id: null,
  agent: null,
  delivery: "queue",
  live_message_id: null,
  updated_at: 0,
};

function setup() {
  const ensure = vi.fn(() => chatRow);
  const commandHandle = vi.fn(async () => undefined);
  const promptHandle = vi.fn(async () => undefined);
  const callbackHandle = vi.fn(async () => undefined);
  const formTextHandle = vi.fn(async () => false);
  const formCallbackHandle = vi.fn(async () => undefined);
  const menuCallbackHandle = vi.fn(async () => undefined);
  const queueCallbackHandle = vi.fn(async () => undefined);
  const catalogCallbackHandle = vi.fn(async () => undefined);
  const fileCallbackHandle = vi.fn(async () => undefined);
  const historyCallbackHandle = vi.fn(async () => undefined);
  const projectCallbackHandle = vi.fn(async () => undefined);
  const watchCallbackHandle = vi.fn(async () => undefined);
  const settingsCallbackHandle = vi.fn(async () => undefined);
  const dashboardCallbackHandle = vi.fn(async () => undefined);
  const directoryCallbackHandle = vi.fn(async () => undefined);
  const mcpCallbackHandle = vi.fn(async () => undefined);
  const taskCallbackHandle = vi.fn(async () => undefined);
  const hasMedia = vi.fn((value: { document?: unknown; photo?: unknown }) =>
    Boolean(value.document ?? value.photo),
  );
  const download = vi.fn(async () => ({
    file: { uri: "file:///tmp/a.txt", name: "a.txt" },
    filename: "a.txt",
    mimeType: "text/plain",
    bytes: 5,
  }));
  const send = vi.fn(async () => ({ message_id: 1 }));

  const router = new UpdateRouter({
    allowedUserId: "42",
    chats: { ensure } as unknown as ChatRepo,
    commands: { handle: commandHandle } as unknown as CommandHandler,
    prompts: { handleText: promptHandle } as unknown as PromptHandler,
    interactions: {
      handleCallback: callbackHandle,
      handleQueueCallback: queueCallbackHandle,
    } as unknown as InteractionManager,
    forms: {
      handleText: formTextHandle,
      handleCallback: formCallbackHandle,
    } as unknown as FormManager,
    menus: { handleCallback: menuCallbackHandle } as unknown as MenuManager,
    attachments: { hasMedia, download } as unknown as AttachmentService,
    catalogs: { handleCallback: catalogCallbackHandle } as unknown as CatalogManager,
    files: { handleCallback: fileCallbackHandle } as unknown as FileBrowser,
    history: { handleCallback: historyCallbackHandle } as unknown as HistoryManager,
    projects: { handleCallback: projectCallbackHandle } as unknown as ProjectManager,
    watches: { handleCallback: watchCallbackHandle } as unknown as WatchManager,
    settingsManager: { handleCallback: settingsCallbackHandle } as unknown as SettingsManager,
    dashboard: { handleCallback: dashboardCallbackHandle } as unknown as DashboardManager,
    directoryBrowser: {
      handleCallback: directoryCallbackHandle,
    } as unknown as DirectoryBrowser,
    serverControl: { handleCallback: mcpCallbackHandle } as unknown as ServerControl,
    tasks: { handleCallback: taskCallbackHandle } as unknown as TaskManager,
    outbox: { forChat: () => ({ send }) } as unknown as Outbox,
    config: {
      opencode: {
        model: { providerID: "p", id: "m" },
        agent: "build",
        projectDirectory: "/tmp",
      },
      bridge: { delivery: "queue" },
    } as unknown as Config,
    logger,
  });

  return {
    router,
    ensure,
    commandHandle,
    promptHandle,
    callbackHandle,
    formTextHandle,
    formCallbackHandle,
    menuCallbackHandle,
    queueCallbackHandle,
    catalogCallbackHandle,
    fileCallbackHandle,
    historyCallbackHandle,
    projectCallbackHandle,
    watchCallbackHandle,
    settingsCallbackHandle,
    dashboardCallbackHandle,
    directoryCallbackHandle,
    mcpCallbackHandle,
    hasMedia,
    download,
    send,
  };
}

function message(overrides: Record<string, unknown> = {}): Update {
  return {
    update_id: 1,
    type: "message",
    message: {
      message_id: 5,
      date: 0,
      chat: { id: 77, type: "private" },
      from: { id: 42, is_bot: false },
      text: "hello",
      ...overrides,
    },
  } as unknown as Update;
}

function callback(data: string, overrides: Record<string, unknown> = {}): Update {
  return {
    update_id: 2,
    type: "callback_query",
    callback_query: {
      id: "cb-1",
      from: { id: 42, is_bot: false },
      data,
      message: { message_id: 5, chat: { id: 77, type: "private" } },
      ...overrides,
    },
  } as unknown as Update;
}

describe("UpdateRouter", () => {
  it("routes plain text to the prompt handler", async () => {
    const s = setup();
    await s.router.handle(message());
    expect(s.formTextHandle).toHaveBeenCalledWith(chatRow, "hello");
    expect(s.promptHandle).toHaveBeenCalledWith(chatRow, "hello", 1);
  });

  it("does not prompt when a form consumes the text", async () => {
    const s = setup();
    s.formTextHandle.mockResolvedValueOnce(true);
    await s.router.handle(message({ text: "8080" }));
    expect(s.formTextHandle).toHaveBeenCalledWith(chatRow, "8080");
    expect(s.promptHandle).not.toHaveBeenCalled();
  });

  it("routes slash commands to the command handler", async () => {
    const s = setup();
    await s.router.handle(message({ text: "/status" }));
    expect(s.commandHandle).toHaveBeenCalledWith(chatRow, "/status");
    expect(s.promptHandle).not.toHaveBeenCalled();
  });

  it("ignores messages from other users", async () => {
    const s = setup();
    await s.router.handle(message({ from: { id: 99, is_bot: false } }));
    expect(s.ensure).not.toHaveBeenCalled();
    expect(s.promptHandle).not.toHaveBeenCalled();
  });

  it("ignores messages from bots", async () => {
    const s = setup();
    await s.router.handle(message({ from: { id: 42, is_bot: true } }));
    expect(s.ensure).not.toHaveBeenCalled();
  });

  it("ignores non-private chats", async () => {
    const s = setup();
    await s.router.handle(message({ chat: { id: 77, type: "group" } }));
    expect(s.ensure).not.toHaveBeenCalled();
  });

  it("downloads an attachment and prompts with the caption", async () => {
    const s = setup();
    await s.router.handle(
      message({
        text: undefined,
        caption: "read this",
        document: { file_id: "f", file_name: "a.txt" },
      }),
    );
    expect(s.download).toHaveBeenCalled();
    expect(s.promptHandle).toHaveBeenCalledWith(chatRow, "read this", 1, [
      { uri: "file:///tmp/a.txt", name: "a.txt" },
    ]);
  });

  it("uses a generated prompt when an attachment has no caption", async () => {
    const s = setup();
    await s.router.handle(
      message({ text: undefined, document: { file_id: "f", file_name: "a.txt" } }),
    );
    expect(s.promptHandle).toHaveBeenCalledWith(
      chatRow,
      expect.stringContaining("a.txt"),
      1,
      expect.any(Array),
    );
  });

  it("routes callbacks to the interaction manager", async () => {
    const s = setup();
    await s.router.handle(callback("perm:tok:once"));
    expect(s.callbackHandle).toHaveBeenCalledWith({
      chatId: "77",
      callbackQueryId: "cb-1",
      data: "perm:tok:once",
      messageId: 5,
    });
  });

  it("routes form callbacks to the form manager", async () => {
    const s = setup();
    await s.router.handle(callback("f:tok:o:1"));
    expect(s.formCallbackHandle).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "77", data: "f:tok:o:1", messageId: 5 }),
    );
    expect(s.callbackHandle).not.toHaveBeenCalled();
  });

  it.each(["m:tok", "a:tok", "fo:tok:y"])(
    "routes %s callbacks to the menu manager",
    async (data) => {
      const s = setup();
      await s.router.handle(callback(data));
      expect(s.menuCallbackHandle).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: "77", data }),
      );
      expect(s.callbackHandle).not.toHaveBeenCalled();
    },
  );

  it("routes queue callbacks to the queue handler", async () => {
    const s = setup();
    await s.router.handle(callback("q:tok"));
    expect(s.queueCallbackHandle).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "77", data: "q:tok" }),
    );
    expect(s.callbackHandle).not.toHaveBeenCalled();
  });

  it.each([
    ["c:tok", "catalog"],
    ["s:tok", "catalog"],
    ["fs:l:tok", "file"],
    ["rv:c:tok", "history"],
    ["fk:tok", "history"],
    ["p:tok", "project"],
    ["wt:u:tok", "project"],
    ["w:o:tok", "watch"],
    ["set:t", "settings"],
    ["dash:r", "dashboard"],
    ["ctx:o", "dashboard"],
    ["dir:n:tok", "directory"],
    ["mcp:c:tok", "mcp"],
  ])("routes %s callbacks to the %s manager", async (data, target) => {
    const s = setup();
    await s.router.handle(callback(data));
    const handler =
      target === "catalog"
        ? s.catalogCallbackHandle
        : target === "file"
          ? s.fileCallbackHandle
          : target === "history"
            ? s.historyCallbackHandle
            : target === "project"
              ? s.projectCallbackHandle
              : target === "watch"
                ? s.watchCallbackHandle
                : target === "settings"
                  ? s.settingsCallbackHandle
                  : target === "dashboard"
                    ? s.dashboardCallbackHandle
                    : target === "directory"
                      ? s.directoryCallbackHandle
                      : s.mcpCallbackHandle;
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "77", data }),
    );
    expect(s.callbackHandle).not.toHaveBeenCalled();
  });

  it("ignores unauthorized callbacks", async () => {
    const s = setup();
    await s.router.handle(callback("perm:tok:once", { from: { id: 99, is_bot: false } }));
    expect(s.callbackHandle).not.toHaveBeenCalled();
    expect(s.formCallbackHandle).not.toHaveBeenCalled();
    expect(s.menuCallbackHandle).not.toHaveBeenCalled();
  });
});