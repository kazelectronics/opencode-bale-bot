import { describe, expect, it } from "vitest";

import { formatPermissionText, parseCallbackData } from "../src/bridge/interactions.js";
import { generatePromptMessageId } from "../src/bridge/prompts.js";

describe("parseCallbackData", () => {
  it("parses each supported decision", () => {
    for (const decision of ["once", "always", "reject"] as const) {
      expect(parseCallbackData(`perm:tok123:${decision}`)).toEqual({
        kind: "permission",
        token: "tok123",
        decision,
      });
    }
  });

  it("rejects malformed data", () => {
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData("")).toBeNull();
    expect(parseCallbackData("perm:tok")).toBeNull();
    expect(parseCallbackData("other:tok:once")).toBeNull();
    expect(parseCallbackData("perm::once")).toBeNull();
    expect(parseCallbackData("perm:tok:sometimes")).toBeNull();
    expect(parseCallbackData("perm:tok:once:extra")).toBeNull();
  });
});

describe("formatPermissionText", () => {
  it("includes the action and resources without leaking backticks", () => {
    const text = formatPermissionText({
      id: "per_1",
      sessionID: "ses_1",
      action: "bash",
      resources: ["echo `rm` x", "second"],
      message: "Allow this?",
    });
    expect(text).toContain("Permission required");
    expect(text).toContain("bash");
    expect(text).toContain("echo ′rm′ x");
    expect(text).toContain("Allow this?");
  });

  it("summarizes more than three resources", () => {
    const text = formatPermissionText({
      id: "per_1",
      sessionID: "ses_1",
      action: "edit",
      resources: ["a", "b", "c", "d"],
    });
    expect(text).toContain("…and 1 more");
  });
});

describe("generatePromptMessageId", () => {
  it("produces a valid OpenCode message ID", () => {
    const id = generatePromptMessageId();
    expect(id).toMatch(/^msg_[A-Za-z0-9]{26}$/);
  });

  it("is effectively unique", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generatePromptMessageId()));
    expect(ids.size).toBe(200);
  });
});