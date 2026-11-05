import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BaleGateway } from "../src/bale/gateway.js";
import { ChatOutbox, Outbox } from "../src/bale/outbox.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

interface Harness {
  readonly gateway: BaleGateway;
  readonly edits: string[];
  readonly sends: string[];
  failNextEdit?: Error;
}

function harness(): Harness {
  const edits: string[] = [];
  const sends: string[] = [];
  let nextMessageId = 100;
  const state: Harness = { edits, sends, gateway: undefined as unknown as BaleGateway };
  const gateway = {
    getMe: async () => ({ id: "1", username: null, firstName: "bot" }),
    deleteWebhook: async () => true,
    getUpdates: async () => [],
    sendMessage: async (input: { text: string }) => {
      sends.push(input.text);
      nextMessageId += 1;
      return { message_id: nextMessageId, date: 0, chat: { id: 1, type: "private" } };
    },
    editMessageText: async (input: { text: string }) => {
      if (state.failNextEdit) {
        const error = state.failNextEdit;
        state.failNextEdit = undefined;
        throw error;
      }
      edits.push(input.text);
      return { message_id: 1, date: 0, chat: { id: 1, type: "private" } };
    },
    editMessageReplyMarkup: async () => ({
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" },
    }),
    deleteMessage: async () => true,
    sendChatAction: async () => true,
    sendDocument: async () => ({ messageId: 1, fileId: null, filePath: null }),
    getFile: async () => ({ fileId: "f", filePath: "p", fileSize: 0, content: Buffer.alloc(0) }),
    answerCallbackQuery: async () => true,
  } as unknown as BaleGateway;
  return Object.assign(state, { gateway });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatOutbox", () => {
  it("coalesces rapid scheduleEdit calls into one throttled edit", async () => {
    const h = harness();
    const chat = new ChatOutbox("1", h.gateway, { editIntervalMs: 1_500, logger });

    chat.scheduleEdit(10, "first");
    chat.scheduleEdit(10, "second");
    chat.scheduleEdit(10, "third");
    expect(h.edits).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.edits).toEqual(["third"]);
  });

  it("waits for the interval between consecutive edits", async () => {
    const h = harness();
    const chat = new ChatOutbox("1", h.gateway, { editIntervalMs: 1_500, logger });

    chat.scheduleEdit(10, "a");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.edits).toEqual(["a"]);

    chat.scheduleEdit(10, "b");
    await vi.advanceTimersByTimeAsync(1_400);
    expect(h.edits).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.edits).toEqual(["a", "b"]);
  });

  it("editNow cancels a scheduled edit", async () => {
    const h = harness();
    const chat = new ChatOutbox("1", h.gateway, { editIntervalMs: 1_500, logger });

    chat.scheduleEdit(10, "stale");
    await chat.editNow(10, "final");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.edits).toEqual(["final"]);
  });

  it("treats 'message is not modified' as success", async () => {
    const h = harness();
    h.failNextEdit = new Error("Bad Request: message is not modified");
    const chat = new ChatOutbox("1", h.gateway, { editIntervalMs: 1_500, logger });
    await expect(chat.editNow(10, "same")).resolves.toBe(true);
  });

  it("reports false when the message no longer exists", async () => {
    const h = harness();
    h.failNextEdit = new Error("Bad Request: message to edit not found");
    const chat = new ChatOutbox("1", h.gateway, { editIntervalMs: 1_500, logger });
    await expect(chat.editNow(10, "gone")).resolves.toBe(false);
  });

  it("serializes sends in order", async () => {
    const h = harness();
    const chat = new ChatOutbox("1", h.gateway, { editIntervalMs: 1_500, logger });
    await Promise.all([chat.send("one"), chat.send("two"), chat.send("three")]);
    expect(h.sends).toEqual(["one", "two", "three"]);
  });

  it("flushes a pending edit on demand", async () => {
    const h = harness();
    const chat = new ChatOutbox("1", h.gateway, { editIntervalMs: 1_500, logger });
    chat.scheduleEdit(10, "pending");
    await chat.flush();
    expect(h.edits).toEqual(["pending"]);
  });
});

describe("Outbox", () => {
  it("returns one outbox per chat", () => {
    const h = harness();
    const outbox = new Outbox(h.gateway, { editIntervalMs: 1_500, logger });
    expect(outbox.forChat("1")).toBe(outbox.forChat("1"));
    expect(outbox.forChat("2")).not.toBe(outbox.forChat("1"));
  });
});