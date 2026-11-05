import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logger.js";
import {
  RunReducer,
  extractPermission,
  extractSessionID,
} from "../src/bridge/runReducer.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function event(type: string, data: Record<string, unknown> = {}) {
  return { type, data: { sessionID: "ses_test", ...data } };
}

describe("RunReducer", () => {
  it("accumulates text deltas and finalizes on success", () => {
    const onTerminal = vi.fn();
    const reducer = new RunReducer({ logger, onTerminal });

    reducer.handle(event("session.execution.started"), "chat-1");
    reducer.handle(event("session.step.started", {
      model: { providerID: "bailian-cli", id: "deepseek" },
    }), "chat-1");
    reducer.handle(event("session.text.started"), "chat-1");
    reducer.handle(event("session.text.delta", { delta: "Hello " }), "chat-1");
    reducer.handle(event("session.text.delta", { delta: "world" }), "chat-1");
    reducer.handle(event("session.text.ended", { text: "Hello world" }), "chat-1");
    reducer.handle(
      event("session.step.ended", {
        finish: "stop",
        cost: 0,
        tokens: {
          input: 10,
          output: 2,
          reasoning: 1,
          cache: { read: 3, write: 0 },
        },
      }),
      "chat-1",
    );

    const mid = reducer.get("ses_test");
    expect(mid?.text).toBe("Hello world");
    expect(mid?.model).toBe("bailian-cli/deepseek");

    const final = reducer.handle(event("session.execution.succeeded"), "chat-1");
    expect(final?.status).toBe("succeeded");
    expect(final?.outcome).toBe("succeeded");
    expect(final?.usage).toMatchObject({ input: 10, output: 2, reasoning: 1 });
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("records a failure message", () => {
    const reducer = new RunReducer({ logger });
    reducer.handle(event("session.execution.started"), "chat-1");
    const final = reducer.handle(
      event("session.execution.failed", {
        error: { type: "RegionError", message: "model is not available" },
      }),
      "chat-1",
    );
    expect(final?.status).toBe("failed");
    expect(final?.error).toBe("model is not available");
  });

  it("treats an aborted step as non-fatal", () => {
    const reducer = new RunReducer({ logger });
    reducer.handle(event("session.execution.started"), "chat-1");
    reducer.handle(
      event("session.step.failed", { error: { type: "aborted", message: "aborted" } }),
      "chat-1",
    );
    expect(reducer.get("ses_test")?.error).toBeNull();
  });

  it("only finalizes once per run", () => {
    const onTerminal = vi.fn();
    const reducer = new RunReducer({ logger, onTerminal });
    reducer.handle(event("session.execution.started"), "chat-1");
    reducer.handle(event("session.execution.succeeded"), "chat-1");
    reducer.handle(event("session.execution.succeeded"), "chat-1");
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("reports a permission request and marks the run as waiting", () => {
    const onPermission = vi.fn();
    const reducer = new RunReducer({ logger, onPermission });
    reducer.handle(event("session.execution.started"), "chat-1");
    reducer.handle(
      event("permission.asked", {
        request: {
          id: "per_123",
          sessionID: "ses_test",
          action: "bash",
          resources: ["echo hi"],
        },
      }),
      "chat-1",
    );
    expect(reducer.get("ses_test")?.status).toBe("waiting_permission");
    expect(onPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: "per_123", action: "bash" }),
      expect.anything(),
    );
  });

  it("tracks tool activity", () => {
    const reducer = new RunReducer({ logger });
    reducer.handle(event("session.execution.started"), "chat-1");
    reducer.handle(
      event("session.tool.called", { name: "shell", input: { command: "ls -la" } }),
      "chat-1",
    );
    expect(reducer.get("ses_test")?.tool).toMatchObject({
      name: "shell",
      detail: "ls -la",
      status: "running",
    });
    reducer.handle(event("session.tool.success"), "chat-1");
    expect(reducer.get("ses_test")?.tool?.status).toBe("done");
  });

  it("ignores events without a session", () => {
    const reducer = new RunReducer({ logger });
    expect(reducer.handle({ type: "server.connected" }, "chat-1")).toBeNull();
    expect(reducer.all()).toHaveLength(0);
  });

  it("tracks a compaction run and keeps the summary out of the answer text", () => {
    const reducer = new RunReducer({ logger });
    reducer.handle(event("session.execution.started"), "chat-1");
    reducer.handle(event("session.compaction.started", { reason: "manual" }), "chat-1");
    reducer.handle(event("session.compaction.delta", { text: "## " }), "chat-1");
    reducer.handle(event("session.compaction.delta", { text: "Objective" }), "chat-1");
    const mid = reducer.get("ses_test");
    expect(mid?.compaction).toMatchObject({ status: "running", text: "## Objective" });
    expect(mid?.text).toBe("");

    reducer.handle(
      event("session.compaction.ended", {
        reason: "manual",
        text: "## Objective\n- Summarized",
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      "chat-1",
    );
    expect(reducer.get("ses_test")?.compaction?.status).toBe("succeeded");
    expect(reducer.get("ses_test")?.text).toBe("");

    const final = reducer.handle(event("session.execution.succeeded"), "chat-1");
    expect(final?.status).toBe("succeeded");
    expect(final?.compaction?.status).toBe("succeeded");
  });

  it("records a compaction failure", () => {
    const reducer = new RunReducer({ logger });
    reducer.handle(event("session.execution.started"), "chat-1");
    reducer.handle(event("session.compaction.started", { reason: "manual" }), "chat-1");
    reducer.handle(
      event("session.compaction.failed", {
        error: { type: "CompactionError", message: "Nothing to compact yet" },
      }),
      "chat-1",
    );
    expect(reducer.get("ses_test")?.compaction).toMatchObject({
      status: "failed",
      error: "Nothing to compact yet",
    });

    const final = reducer.handle(event("session.execution.succeeded"), "chat-1");
    expect(final?.status).toBe("succeeded");
    expect(final?.text).toBe("");
    expect(final?.compaction).toMatchObject({
      status: "failed",
      error: "Nothing to compact yet",
    });
  });

  it("parses a form whose session lives inside data.form", () => {
    const onForm = vi.fn();
    const reducer = new RunReducer({ logger, onForm });
    reducer.handle(event("session.execution.started"), "chat-1");
    const snapshot = reducer.handle(
      {
        type: "form.created",
        data: {
          form: {
            id: "frm_123",
            sessionID: "ses_test",
            title: "Deploy settings",
            fields: [
              { key: "name", type: "string", title: "Name", required: true },
              { key: "enabled", type: "boolean", title: "Enabled", default: true },
            ],
          },
        },
      } as never,
      "chat-1",
    );
    expect(snapshot?.status).toBe("waiting_form");
    expect(onForm).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "frm_123",
        sessionID: "ses_test",
        title: "Deploy settings",
      }),
      expect.anything(),
    );
  });

  it("returns to running after a form is settled", () => {
    const reducer = new RunReducer({ logger });
    reducer.handle(event("session.execution.started"), "chat-1");
    reducer.handle(
      event("form.created", {
        form: { id: "frm_1", sessionID: "ses_test", title: "T", fields: [] },
      }),
      "chat-1",
    );
    expect(reducer.get("ses_test")?.status).toBe("waiting_form");
    reducer.handle(
      event("form.replied", { id: "frm_1", sessionID: "ses_test", answer: {} }),
      "chat-1",
    );
    expect(reducer.get("ses_test")?.status).toBe("running");
  });
});

describe("extractSessionID", () => {
  it("reads data.sessionID and top-level sessionID", () => {
    expect(extractSessionID({ type: "x", data: { sessionID: "ses_a" } })).toBe("ses_a");
    expect(
      extractSessionID({ type: "x", sessionID: "ses_b" } as unknown as {
        type: string;
      }),
    ).toBe("ses_b");
    expect(extractSessionID({ type: "x", data: {} })).toBeNull();
  });

  it("reads a session nested inside a form or permission payload", () => {
    expect(
      extractSessionID({
        type: "form.created",
        data: { form: { id: "frm_1", sessionID: "ses_form" } },
      } as never),
    ).toBe("ses_form");
    expect(
      extractSessionID({
        type: "permission.asked",
        data: { request: { id: "per_1", sessionID: "ses_perm" } },
      } as never),
    ).toBe("ses_perm");
  });
});

describe("extractPermission", () => {
  it("accepts request, permission, or the payload itself", () => {
    const base = { id: "per_1", action: "bash", resources: [] };
    expect(extractPermission({ request: base }, "ses_a")?.id).toBe("per_1");
    expect(extractPermission({ permission: base }, "ses_a")?.id).toBe("per_1");
    expect(extractPermission(base, "ses_a")?.id).toBe("per_1");
  });

  it("rejects IDs that are not permission IDs", () => {
    expect(extractPermission({ id: "frm_1" }, "ses_a")).toBeNull();
    expect(extractPermission({}, "ses_a")).toBeNull();
  });
});