import { describe, expect, it, vi } from "vitest";

import type { Outbox } from "../src/bale/outbox.js";
import type { BaleGateway } from "../src/bale/gateway.js";
import {
  FormManager,
  applyDefaults,
  buildAnswer,
  isFieldVisible,
  nextField,
  parseFieldValue,
  parseFormCallback,
  type LoadedForm,
} from "../src/bridge/forms.js";
import { CallbackRepo, FormSessionRepo, InteractionMessageRepo, openDatabase, type ChatRow, type FormSessionRow } from "../src/db.js";
import type { Logger } from "../src/logger.js";
import type { OpenCodeClient } from "../src/opencode/client.js";
import type { FormField } from "../src/opencode/types.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const chat: ChatRow = {
  chat_id: "chat-1",
  user_id: "user-1",
  active_session_id: "ses_1",
  project_directory: "/tmp",
  model_provider: "p",
  model_id: "m",
  agent: "build",
  delivery: "queue",
  live_message_id: null,
  updated_at: 0,
};

function loadedForm(
  fields: readonly FormField[],
  answers: Record<string, string | number | boolean | readonly string[]> = {},
  skipped: string[] = [],
  overrides: Partial<FormSessionRow> = {},
): LoadedForm {
  return {
    row: {
      form_id: "frm_1",
      chat_id: "chat-1",
      session_id: "ses_1",
      message_id: 10,
      title: "Deploy",
      fields_json: JSON.stringify(fields),
      answers_json: JSON.stringify(answers),
      skipped_json: JSON.stringify(skipped),
      current_key: null,
      awaiting_key: null,
      expires_at: Date.now() + 60_000,
      updated_at: Date.now(),
      ...overrides,
    },
    fields,
    answers: { ...answers },
    skipped: new Set(skipped),
  };
}

describe("parseFormCallback", () => {
  it("parses each form action", () => {
    expect(parseFormCallback("f:tok:o:2")).toEqual({
      token: "tok",
      action: { kind: "option", index: 2 },
    });
    expect(parseFormCallback("f:tok:t:1")).toEqual({
      token: "tok",
      action: { kind: "toggle", index: 1 },
    });
    expect(parseFormCallback("f:tok:b:1")).toEqual({
      token: "tok",
      action: { kind: "boolean", value: true },
    });
    expect(parseFormCallback("f:tok:done")?.action).toEqual({ kind: "done" });
    expect(parseFormCallback("f:tok:skip")?.action).toEqual({ kind: "skip" });
    expect(parseFormCallback("f:tok:cancel")?.action).toEqual({ kind: "cancel" });
    expect(parseFormCallback("f:tok:ack")?.action).toEqual({ kind: "ack" });
    expect(parseFormCallback("f:tok:custom")?.action).toEqual({ kind: "custom" });
  });

  it("rejects malformed data", () => {
    expect(parseFormCallback(undefined)).toBeNull();
    expect(parseFormCallback("perm:tok:once")).toBeNull();
    expect(parseFormCallback("f::o:1")).toBeNull();
    expect(parseFormCallback("f:tok:b:2")).toBeNull();
    expect(parseFormCallback("f:tok:o:abc")).toBeNull();
    expect(parseFormCallback("f:tok:nope")).toBeNull();
  });
});

describe("form field helpers", () => {
  const conditional: FormField = {
    key: "tier",
    type: "string",
    title: "Tier",
    when: [{ key: "enabled", op: "eq", value: true }],
  };

  it("evaluates conditional visibility", () => {
    expect(isFieldVisible(conditional, {})).toBe(false);
    expect(isFieldVisible(conditional, { enabled: true })).toBe(true);
    expect(isFieldVisible(conditional, { enabled: false })).toBe(false);
    expect(isFieldVisible({ ...conditional, hidden: true }, { enabled: true })).toBe(false);
  });

  it("applies defaults and finds the next unanswered field", () => {
    const fields: FormField[] = [
      { key: "enabled", type: "boolean", title: "Enabled", default: true },
      { key: "name", type: "string", title: "Name", required: true },
      { key: "regions", type: "multiselect", title: "Regions", options: [], default: ["eu"] },
    ];
    const answers = applyDefaults(fields);
    expect(answers).toEqual({ enabled: true, regions: ["eu"] });
    expect(nextField(loadedForm(fields, answers))?.key).toBe("name");
  });

  it("skips answered, skipped, hidden, and conditional fields", () => {
    const fields: FormField[] = [
      { key: "len", type: "integer", title: "Len" },
      { key: "skip", type: "string", title: "Skip" },
      { key: "hidden", type: "string", title: "Hidden", hidden: true },
      conditional,
    ];
    const loaded = loadedForm(fields, { len: 3 }, ["skip"]);
    expect(nextField(loaded)).toBeNull();
    loaded.answers.enabled = true;
    expect(nextField(loaded)?.key).toBe("tier");
  });

  it("builds an answer without hidden or inapplicable fields", () => {
    const fields: FormField[] = [
      { key: "name", type: "string", title: "Name" },
      { key: "hidden", type: "string", title: "Hidden", hidden: true, default: "x" },
      conditional,
    ];
    const loaded = loadedForm(fields, { name: "api", hidden: "x" });
    expect(buildAnswer(loaded)).toEqual({ name: "api", hidden: "x" });
  });

  it("validates strings, numbers, integers, and formats", () => {
    const text: FormField = { key: "s", type: "string", title: "S", minLength: 2 };
    expect(parseFieldValue(text, "a")).toEqual({ ok: false, error: "Use at least 2 characters." });
    expect(parseFieldValue(text, "ab")).toEqual({ ok: true, value: "ab" });

    const integer: FormField = {
      key: "n",
      type: "integer",
      title: "N",
      minimum: 1,
      maximum: 10,
    };
    expect(parseFieldValue(integer, "0")).toEqual({ ok: false, error: "The minimum is 1." });
    expect(parseFieldValue(integer, "11")).toEqual({ ok: false, error: "The maximum is 10." });
    expect(parseFieldValue(integer, "2.5")).toEqual({ ok: false, error: "Send a whole number." });
    expect(parseFieldValue(integer, "4")).toEqual({ ok: true, value: 4 });

    const number: FormField = { key: "r", type: "number", title: "R" };
    expect(parseFieldValue(number, "0,5")).toEqual({ ok: true, value: 0.5 });

    const email: FormField = { key: "e", type: "string", title: "E", format: "email" };
    expect(parseFieldValue(email, "nope")).toEqual({
      ok: false,
      error: "Expected a valid email.",
    });

    const external: FormField = {
      key: "x",
      type: "external",
      title: "X",
      url: "https://example.com",
    };
    expect(parseFieldValue(external, "yes")).toEqual({
      ok: false,
      error: "Open the link and tap Acknowledge.",
    });
  });
});

function managerFixture() {
  const db = openDatabase(":memory:");
  const callbacks = new CallbackRepo(db);
  const forms = new FormSessionRepo(db);
  const interactionMessages = new InteractionMessageRepo(db);

  const formReply = vi.fn(async () => undefined);
  const cancelForm = vi.fn(async () => undefined);
  const client = { formReply, cancelForm } as unknown as OpenCodeClient;

  const send = vi.fn(async () => ({ message_id: 10 }) as never);
  const editNow = vi.fn(async () => true);
  const editMarkup = vi.fn(async () => true);
  const outbox = {
    forChat: () => ({ send, editNow, editMarkup }),
  } as unknown as Outbox;

  const answerCallbackQuery = vi.fn(async () => undefined);
  const gateway = { answerCallbackQuery } as unknown as BaleGateway;

  const manager = new FormManager({
    client,
    gateway,
    callbacks,
    forms,
    interactionMessages,
    outbox,
    logger,
  });

  return {
    manager,
    callbacks,
    forms,
    formReply,
    cancelForm,
    send,
    editNow,
    editMarkup,
    answerCallbackQuery,
  };
}

describe("FormManager", () => {
  it("sends the first field, consumes text, and submits the answer", async () => {
    const f = managerFixture();
    await f.manager.onFormCreated(
      {
        id: "frm_1",
        sessionID: "ses_1",
        title: "Deploy",
        fields: [
          { key: "name", type: "string", title: "Name", required: true },
          { key: "enabled", type: "boolean", title: "Enabled", default: true },
        ],
      },
      "chat-1",
    );

    expect(f.send).toHaveBeenCalledWith(
      expect.stringContaining("Deploy"),
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
    expect(f.forms.findByChat("chat-1")?.awaiting_key).toBe("name");

    const consumed = await f.manager.handleText(chat, "api");
    expect(consumed).toBe(true);
    expect(f.formReply).toHaveBeenCalledWith("ses_1", "frm_1", {
      name: "api",
      enabled: true,
    });
    expect(f.forms.get("frm_1")).toBeNull();
    expect(f.editNow).toHaveBeenCalledWith(
      10,
      expect.stringContaining("Form submitted"),
      expect.anything(),
    );
    expect(f.callbacks.getByRef("chat-1", "form", "frm_1")).toBeNull();
  });

  it("applies a boolean button selection and submits", async () => {
    const f = managerFixture();
    await f.manager.onFormCreated(
      {
        id: "frm_2",
        sessionID: "ses_1",
        title: "Confirm",
        fields: [{ key: "enabled", type: "boolean", title: "Enabled", required: true }],
      },
      "chat-1",
    );
    const row = f.callbacks.getByRef("chat-1", "form", "frm_2");
    expect(row).not.toBeNull();

    await f.manager.handleCallback({
      chatId: "chat-1",
      callbackQueryId: "cb-1",
      data: `f:${row?.token}:b:1`,
    });

    expect(f.answerCallbackQuery).toHaveBeenCalledWith({
      callbackQueryId: "cb-1",
    });
    expect(f.formReply).toHaveBeenCalledWith("ses_1", "frm_2", { enabled: true });
  });

  it("rejects invalid text without advancing", async () => {
    const f = managerFixture();
    await f.manager.onFormCreated(
      {
        id: "frm_3",
        sessionID: "ses_1",
        title: "Port",
        fields: [
          { key: "port", type: "integer", title: "Port", minimum: 1, maximum: 10 },
          { key: "name", type: "string", title: "Name" },
        ],
      },
      "chat-1",
    );

    expect(await f.manager.handleText(chat, "0")).toBe(true);
    expect(f.formReply).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith(expect.stringContaining("The minimum is 1."));
    expect(f.forms.get("frm_3")?.current_key).toBe("port");
    expect(f.forms.get("frm_3")?.awaiting_key).toBe("port");

    await f.manager.handleText(chat, "5");
    expect(f.forms.get("frm_3")?.current_key).toBe("name");
    expect(f.forms.get("frm_3")?.awaiting_key).toBe("name");
  });

  it("shows an error when text arrives while a button choice is expected", async () => {
    const f = managerFixture();
    await f.manager.onFormCreated(
      {
        id: "frm_4",
        sessionID: "ses_1",
        title: "Pick",
        fields: [
          {
            key: "tier",
            type: "string",
            title: "Tier",
            options: [{ value: "free", label: "Free" }],
          },
        ],
      },
      "chat-1",
    );
    expect(await f.manager.handleText(chat, "free")).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.stringContaining("button choice"));
  });

  it("cancels the form through OpenCode", async () => {
    const f = managerFixture();
    await f.manager.onFormCreated(
      {
        id: "frm_5",
        sessionID: "ses_1",
        title: "Cancel me",
        fields: [{ key: "x", type: "string", title: "X" }],
      },
      "chat-1",
    );
    const row = f.callbacks.getByRef("chat-1", "form", "frm_5");
    await f.manager.handleCallback({
      chatId: "chat-1",
      callbackQueryId: "cb-2",
      data: `f:${row?.token}:cancel`,
    });
    expect(f.cancelForm).toHaveBeenCalledWith("ses_1", "frm_5");
    expect(f.forms.get("frm_5")).toBeNull();
  });

  it("stops consuming text once the form is expired", async () => {
    const f = managerFixture();
    await f.manager.onFormCreated(
      {
        id: "frm_6",
        sessionID: "ses_1",
        title: "Expire",
        fields: [{ key: "x", type: "string", title: "X" }],
      },
      "chat-1",
    );
    const row = f.forms.get("frm_6");
    expect(row).not.toBeNull();
    if (row) {
      f.forms.update(row.form_id, { expires_at: Date.now() - 1 });
    }
    expect(await f.manager.handleText(chat, "hello")).toBe(true);
    expect(f.send).toHaveBeenCalledWith(expect.stringContaining("expired"));
    expect(f.formReply).not.toHaveBeenCalled();
  });
});