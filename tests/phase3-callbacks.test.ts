import { describe, expect, it } from "vitest";

import { parseCatalogCallback } from "../src/bridge/catalogs.js";
import { parseFileCallback } from "../src/bridge/files.js";
import { extractMessageText, parseHistoryCallback } from "../src/bridge/history.js";
import { parseProjectCallback } from "../src/bridge/projects.js";
import { parseWatchCallback } from "../src/bridge/watches.js";
import type { OpenCodeSessionMessage } from "../src/opencode/types.js";

describe("phase 3 callback parsers", () => {
  it("parses catalog callbacks", () => {
    expect(parseCatalogCallback("c:tok")).toEqual({ kind: "command", token: "tok" });
    expect(parseCatalogCallback("s:tok")).toEqual({ kind: "skill", token: "tok" });
    expect(parseCatalogCallback("m:tok")).toBeNull();
    expect(parseCatalogCallback("c:")).toBeNull();
    expect(parseCatalogCallback("c:a:b")).toBeNull();
  });

  it("parses file callbacks", () => {
    expect(parseFileCallback("fs:l:tok")).toEqual({ kind: "list", token: "tok" });
    expect(parseFileCallback("fs:r:tok")).toEqual({ kind: "read", token: "tok" });
    expect(parseFileCallback("fs:u:tok")).toEqual({ kind: "up", token: "tok" });
    expect(parseFileCallback("fs:x:tok")).toBeNull();
    expect(parseFileCallback("fs:l")).toBeNull();
    expect(parseFileCallback("f:tok:o:1")).toBeNull();
  });

  it("parses history callbacks", () => {
    expect(parseHistoryCallback("rv:s:tok")).toEqual({ kind: "revertStage", token: "tok" });
    expect(parseHistoryCallback("rv:c:tok")).toEqual({ kind: "revertConfirm", token: "tok" });
    expect(parseHistoryCallback("rv:x:tok")).toEqual({ kind: "revertCancel", token: "tok" });
    expect(parseHistoryCallback("fk:tok")).toEqual({ kind: "fork", token: "tok" });
    expect(parseHistoryCallback("rv:z:tok")).toBeNull();
    expect(parseHistoryCallback("fk:")).toBeNull();
    expect(parseHistoryCallback("q:tok")).toBeNull();
  });

  it("parses project callbacks", () => {
    expect(parseProjectCallback("p:tok")).toEqual({ kind: "project", token: "tok" });
    expect(parseProjectCallback("wt:u:tok")).toEqual({ kind: "worktreeUse", token: "tok" });
    expect(parseProjectCallback("wt:x:tok")).toEqual({ kind: "worktreeRemove", token: "tok" });
    expect(parseProjectCallback("wt:z:tok")).toBeNull();
    expect(parseProjectCallback("m:tok")).toBeNull();
  });

  it("parses watch callbacks", () => {
    expect(parseWatchCallback("w:o:tok")).toEqual({ kind: "open", token: "tok" });
    expect(parseWatchCallback("w:x:tok")).toEqual({ kind: "unwatch", token: "tok" });
    expect(parseWatchCallback("w:z:tok")).toBeNull();
    expect(parseWatchCallback("w:o")).toBeNull();
    expect(parseWatchCallback("perm:tok:once")).toBeNull();
  });
});

describe("extractMessageText", () => {
  function msg(overrides: Partial<OpenCodeSessionMessage>): OpenCodeSessionMessage {
    return { id: "msg_1", type: "assistant", ...overrides } as OpenCodeSessionMessage;
  }

  it("joins assistant text parts and ignores reasoning and tools", () => {
    const message = msg({
      content: [
        { type: "text", text: "Hello" },
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "world" },
        { type: "tool", name: "bash" },
      ],
    });
    expect(extractMessageText(message)).toBe("Hello\nworld");
  });

  it("falls back to a text field", () => {
    expect(extractMessageText(msg({ type: "user", text: "hi" }))).toBe("hi");
    expect(extractMessageText(msg({ type: "system" }))).toBe("");
  });
});