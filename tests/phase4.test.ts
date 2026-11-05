import { describe, expect, it } from "vitest";

import { LOCALES, isLocale, normalizeLocale, t } from "../src/i18n.js";
import { parseSettingsCallback } from "../src/bridge/settings.js";
import { parseDashboardCallback } from "../src/bridge/dashboard.js";
import { parseDirectoryCallback, isDirectoryArgument } from "../src/bridge/directoryBrowser.js";
import { parseMcpCallback } from "../src/bridge/serverControl.js";
import { RunReducer } from "../src/bridge/runReducer.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

describe("i18n", () => {
  it("has an English and Persian message for every key", () => {
    const keys = [
      "help.title",
      "settings.title",
      "dashboard.title",
      "context.title",
      "queue.title",
      "recent.title",
      "open.title",
      "mcp.title",
      "server.reload",
      "notice.permission",
    ] as const;
    for (const key of keys) {
      for (const locale of LOCALES) {
        expect(t(locale, key).length).toBeGreaterThan(0);
      }
    }
    expect(t("fa", "settings.title")).not.toBe(t("en", "settings.title"));
  });

  it("interpolates parameters", () => {
    expect(t("en", "dashboard.files", { count: 3, added: 5, deleted: 1 })).toBe(
      "3 file(s) · +5 / -1",
    );
  });

  it("validates locale codes", () => {
    expect(isLocale("fa")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(normalizeLocale(undefined)).toBe("en");
    expect(normalizeLocale("fa")).toBe("fa");
  });
});

describe("phase 4 callbacks", () => {
  it("parses settings callbacks", () => {
    expect(parseSettingsCallback("set:l:fa")).toEqual({ kind: "language", locale: "fa" });
    expect(parseSettingsCallback("set:l:de")).toBeNull();
    expect(parseSettingsCallback("set:t")).toEqual({ kind: "thinking" });
    expect(parseSettingsCallback("set:d")).toEqual({ kind: "dashboard" });
    expect(parseSettingsCallback("set:r")).toEqual({ kind: "reset" });
  });

  it("parses dashboard and context callbacks", () => {
    expect(parseDashboardCallback("dash:r")).toEqual({ kind: "dashboardRefresh" });
    expect(parseDashboardCallback("ctx:o")).toEqual({ kind: "context" });
    expect(parseDashboardCallback("ctx:y")).toEqual({ kind: "compactYes" });
    expect(parseDashboardCallback("ctx:z")).toBeNull();
  });

  it("parses directory callbacks", () => {
    expect(parseDirectoryCallback("dir:n:tok")).toEqual({ kind: "navigate", token: "tok" });
    expect(parseDirectoryCallback("dir:s:tok")).toEqual({ kind: "use", token: "tok" });
    expect(parseDirectoryCallback("dir:h")).toEqual({ kind: "home" });
    expect(parseDirectoryCallback("dir:x:tok")).toBeNull();
  });

  it("parses MCP callbacks", () => {
    expect(parseMcpCallback("mcp:c:tok")).toEqual({ kind: "connect", token: "tok" });
    expect(parseMcpCallback("mcp:d:tok")).toEqual({ kind: "disconnect", token: "tok" });
    expect(parseMcpCallback("mcp:r")).toEqual({ kind: "refresh" });
  });

  it("detects directory arguments", async () => {
    expect(await isDirectoryArgument("/tmp")).toBe(true);
    expect(await isDirectoryArgument("/definitely/not/a/directory")).toBe(false);
  });
});

describe("RunReducer reasoning", () => {
  it("collects reasoning deltas and hides them from the final text", () => {
    const reducer = new RunReducer({ logger });
    reducer.handle({ type: "session.execution.started", data: { sessionID: "ses_1" } }, "chat-1");
    reducer.handle(
      { type: "session.reasoning.started", data: { sessionID: "ses_1" } },
      "chat-1",
    );
    reducer.handle(
      { type: "session.reasoning.delta", data: { sessionID: "ses_1", delta: "thinking" } },
      "chat-1",
    );
    reducer.handle(
      { type: "session.text.delta", data: { sessionID: "ses_1", delta: "answer" } },
      "chat-1",
    );
    const snapshot = reducer.get("ses_1");
    expect(snapshot?.reasoning).toBe("thinking");
    expect(snapshot?.text).toBe("answer");
  });
});