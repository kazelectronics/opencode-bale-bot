import { randomBytes } from "node:crypto";

import type { InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type {
  CallbackRepo,
  ChatRow,
  FormSessionRepo,
  FormSessionRow,
  InteractionMessageRepo,
} from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import type {
  FormAnswer,
  FormField,
  FormInfo,
  FormOption,
  FormValue,
} from "../opencode/types.js";
import { transformInline, tidy } from "../renderer.js";
import { truncate } from "../util.js";
import { isMessageNotFound, isMessageNotModified, type BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { describeOpenCodeError } from "./errors.js";

export const FORM_TTL_MS = 20 * 60 * 1_000;

export type FormAction =
  | { readonly kind: "option"; readonly index: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "toggle"; readonly index: number }
  | { readonly kind: "ack" }
  | { readonly kind: "custom" }
  | { readonly kind: "done" }
  | { readonly kind: "skip" }
  | { readonly kind: "cancel" };

export interface ParsedFormCallback {
  readonly token: string;
  readonly action: FormAction;
}

export function parseFormCallback(data: string | undefined): ParsedFormCallback | null {
  if (!data) {
    return null;
  }
  const parts = data.split(":");
  if (parts[0] !== "f" || parts.length < 3) {
    return null;
  }
  const token = parts[1] ?? "";
  if (!token) {
    return null;
  }
  const head = parts[2];
  const arg = parts[3];
  switch (head) {
    case "o":
      return integerArg(arg) === null ? null : { token, action: { kind: "option", index: Number(arg) } };
    case "t":
      return integerArg(arg) === null ? null : { token, action: { kind: "toggle", index: Number(arg) } };
    case "b":
      if (arg !== "0" && arg !== "1") {
        return null;
      }
      return { token, action: { kind: "boolean", value: arg === "1" } };
    case "ack":
      return { token, action: { kind: "ack" } };
    case "custom":
      return { token, action: { kind: "custom" } };
    case "done":
      return { token, action: { kind: "done" } };
    case "skip":
      return { token, action: { kind: "skip" } };
    case "cancel":
      return { token, action: { kind: "cancel" } };
    default:
      return null;
  }
}

function integerArg(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,3}$/.test(value)) {
    return null;
  }
  return Number(value);
}

export interface FormManagerOptions {
  readonly client: OpenCodeClient;
  readonly gateway: BaleGateway;
  readonly callbacks: CallbackRepo;
  readonly forms: FormSessionRepo;
  readonly interactionMessages: InteractionMessageRepo;
  readonly outbox: Outbox;
  readonly logger: Logger;
}

export interface LoadedForm {
  readonly row: FormSessionRow;
  readonly fields: readonly FormField[];
  readonly answers: FormAnswer;
  readonly skipped: Set<string>;
}

export class FormManager {
  private readonly options: FormManagerOptions;

  constructor(options: FormManagerOptions) {
    this.options = options;
  }

  async onFormCreated(form: FormInfo, chatId: string): Promise<void> {
    const { forms, callbacks, outbox, logger } = this.options;
    if (forms.get(form.id)) {
      return;
    }

    const answers = applyDefaults(form.fields);
    const now = Date.now();
    const expiresAt = now + FORM_TTL_MS;

    const row: FormSessionRow = {
      form_id: form.id,
      chat_id: chatId,
      session_id: form.sessionID,
      message_id: null,
      title: form.title,
      fields_json: JSON.stringify(form.fields),
      answers_json: JSON.stringify(answers),
      skipped_json: "[]",
      current_key: null,
      awaiting_key: null,
      expires_at: expiresAt,
      updated_at: now,
    };
    forms.create(row);
    const token = this.tokenFor(row);

    const loaded = this.load(form.id);
    if (!loaded) {
      return;
    }
    const current = nextField(loaded);
    const text = renderForm(loaded, current);
    const keyboard = current ? keyboardFor(current, loaded, token) : undefined;
    try {
      const message = await outbox.forChat(chatId).send(text, {
        ...(keyboard ? { replyMarkup: keyboard } : {}),
      });
      forms.update(form.id, {
        message_id: message.message_id,
        current_key: current?.key ?? null,
        awaiting_key: awaitingKey(current, loaded),
      });
      this.options.interactionMessages.set(form.id, chatId, message.message_id, "form");
      logger.info("Form request sent", {
        formId: form.id,
        sessionId: form.sessionID,
        fields: form.fields.length,
      });
    } catch (error) {
      logger.error("Failed to send form request", {
        formId: form.id,
        error: errorMessage(error),
      });
      this.cleanup(form.id, chatId);
      return;
    }

    if (!current) {
      await this.submit(this.load(form.id));
    }
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
  }): Promise<void> {
    const parsed = parseFormCallback(input.data);
    if (!parsed) {
      await this.answer(input.callbackQueryId, "This button is no longer valid.");
      return;
    }

    const { callbacks, forms, logger } = this.options;
    const row = callbacks.get(parsed.token);
    if (
      !row ||
      row.chat_id !== input.chatId ||
      row.kind !== "form" ||
      row.expires_at < Date.now()
    ) {
      await this.answer(input.callbackQueryId, "This form request has expired.");
      return;
    }

    const loaded = this.load(row.ref_id);
    if (!loaded) {
      await this.answer(input.callbackQueryId, "This form is no longer active.");
      return;
    }

    const current = currentField(loaded);
    if (parsed.action.kind === "cancel") {
      await this.answer(input.callbackQueryId, "Cancelling…");
      await this.cancel(loaded);
      return;
    }

    if (!current) {
      await this.answer(input.callbackQueryId, "This form is already complete.");
      return;
    }

    switch (parsed.action.kind) {
      case "option": {
        const option = (current as { options?: readonly FormOption[] }).options?.[parsed.action.index];
        if (!option) {
          await this.answer(input.callbackQueryId, "That option is no longer valid.", true);
          return;
        }
        await this.answer(input.callbackQueryId);
        loaded.answers[current.key] = option.value;
        loaded.skipped.delete(current.key);
        await this.persistAndAdvance(loaded);
        return;
      }
      case "boolean": {
        if (current.type !== "boolean") {
          await this.answer(input.callbackQueryId, "That choice is no longer valid.", true);
          return;
        }
        await this.answer(input.callbackQueryId);
        loaded.answers[current.key] = parsed.action.value;
        loaded.skipped.delete(current.key);
        await this.persistAndAdvance(loaded);
        return;
      }
      case "toggle": {
        if (current.type !== "multiselect") {
          await this.answer(input.callbackQueryId, "That choice is no longer valid.", true);
          return;
        }
        const option = current.options[parsed.action.index];
        if (!option) {
          await this.answer(input.callbackQueryId, "That option is no longer valid.", true);
          return;
        }
        await this.answer(input.callbackQueryId);
        const existing = readStringArray(loaded.answers[current.key]);
        const next = existing.includes(option.value)
          ? existing.filter((value) => value !== option.value)
          : [...existing, option.value];
        loaded.answers[current.key] = next;
        loaded.skipped.delete(current.key);
        await this.persist(loaded, { awaitingKey: null });
        await this.edit(loaded);
        return;
      }
      case "ack": {
        if (current.type !== "external") {
          await this.answer(input.callbackQueryId, "That choice is no longer valid.", true);
          return;
        }
        await this.answer(input.callbackQueryId);
        loaded.answers[current.key] = true;
        loaded.skipped.delete(current.key);
        await this.persistAndAdvance(loaded);
        return;
      }
      case "custom": {
        if (!supportsCustom(current)) {
          await this.answer(input.callbackQueryId, "That option is no longer valid.", true);
          return;
        }
        await this.answer(input.callbackQueryId);
        await this.persist(loaded, { awaitingKey: current.key });
        await this.edit(loaded);
        return;
      }
      case "done": {
        if (current.type !== "multiselect") {
          await this.answer(input.callbackQueryId, "That choice is no longer valid.", true);
          return;
        }
        const selected = readStringArray(loaded.answers[current.key]);
        const problem = validateMultiselectCount(current, selected);
        if (problem) {
          await this.answer(input.callbackQueryId, problem, true);
          return;
        }
        if ((current.required ?? false) && selected.length === 0) {
          await this.answer(input.callbackQueryId, "Select at least one option.", true);
          return;
        }
        await this.answer(input.callbackQueryId);
        await this.persistAndAdvance(loaded);
        return;
      }
      case "skip": {
        if (current.required ?? false) {
          await this.answer(input.callbackQueryId, "This field is required.", true);
          return;
        }
        await this.answer(input.callbackQueryId);
        delete loaded.answers[current.key];
        loaded.skipped.add(current.key);
        await this.persistAndAdvance(loaded);
        return;
      }
      default:
        await this.answer(input.callbackQueryId, "That choice is no longer valid.", true);
        logger.debug("Unhandled form action", { formId: loaded.row.form_id });
    }
  }

  /**
   * Consume text while a form is active. Returns true when the message belongs
   * to the form, so the router must not turn it into a prompt.
   */
  async handleText(chat: ChatRow, raw: string): Promise<boolean> {
    const row = this.options.forms.findLatest(chat.chat_id);
    if (!row) {
      return false;
    }
    if (row.expires_at < Date.now()) {
      this.options.forms.delete(row.form_id);
      this.options.callbacks.deleteByRef(row.chat_id, "form", row.form_id);
      this.options.interactionMessages.delete(row.form_id);
      await this.reply(chat.chat_id, "⌛ This form expired. Ask again in OpenCode.");
      return true;
    }

    const loaded = this.load(row.form_id);
    if (!loaded) {
      return false;
    }
    const current = currentField(loaded);
    if (!current) {
      return false;
    }
    if (row.awaiting_key !== current.key) {
      await this.reply(
        chat.chat_id,
        "This form expects a button choice. Tap an option above, or press Cancel.",
      );
      return true;
    }

    const text = raw.trim();
    if (text.length === 0) {
      return true;
    }

    if (current.type === "multiselect") {
      if (!current.custom) {
        await this.reply(chat.chat_id, "Tap the options above, then press Done.");
        return true;
      }
      if (current.maxItems !== undefined) {
        const existing = readStringArray(loaded.answers[current.key]);
        if (existing.length >= current.maxItems) {
          await this.reply(chat.chat_id, `Choose at most ${current.maxItems} values.`);
          return true;
        }
      }
      const existing = readStringArray(loaded.answers[current.key]);
      if (!existing.includes(text)) {
        loaded.answers[current.key] = [...existing, text];
      }
      loaded.skipped.delete(current.key);
      await this.persist(loaded, { awaitingKey: null });
      await this.edit(loaded);
      return true;
    }

    const result = parseFieldValue(current, text);
    if (!result.ok) {
      await this.reply(chat.chat_id, `⚠️ ${result.error}`);
      return true;
    }
    loaded.answers[current.key] = result.value;
    loaded.skipped.delete(current.key);
    await this.persistAndAdvance(loaded);
    return true;
  }

  async onFormSettled(formId: string, status: "replied" | "cancelled"): Promise<void> {
    const row = this.options.forms.get(formId);
    if (!row) {
      return;
    }
    const text =
      status === "replied"
        ? "✅ *Form resolved* in another client."
        : "⛔ *Form cancelled* in another client.";
    await this.finish(row, text);
  }

  async cancelForChat(chat: ChatRow): Promise<boolean> {
    const row = this.options.forms.findByChat(chat.chat_id);
    if (!row) {
      return false;
    }
    const loaded = this.load(row.form_id);
    if (loaded) {
      await this.cancel(loaded);
      return true;
    }
    this.cleanup(row.form_id, row.chat_id);
    return false;
  }

  async pruneExpired(now = Date.now()): Promise<void> {
    const expired = this.options.forms.takeExpired(now);
    for (const row of expired) {
      this.options.callbacks.deleteByRef(row.chat_id, "form", row.form_id);
      this.options.interactionMessages.delete(row.form_id);
      if (row.message_id !== null) {
        await this.editMessage(row.chat_id, row.message_id, "⌛ *Form expired.*");
      }
      this.options.client.cancelForm(row.session_id, row.form_id).catch(() => undefined);
    }
  }

  private async cancel(loaded: LoadedForm): Promise<void> {
    try {
      await this.options.client.cancelForm(loaded.row.session_id, loaded.row.form_id);
      await this.finish(loaded.row, "⛔ *Form cancelled.*");
    } catch (error) {
      if (error instanceof Error && /already settled|not found/i.test(error.message)) {
        await this.finish(loaded.row, "⛔ *Form cancelled.*");
        return;
      }
      this.options.logger.warn("Could not cancel form", {
        formId: loaded.row.form_id,
        error: describeOpenCodeError(error),
      });
      await this.editMessage(
        loaded.row.chat_id,
        loaded.row.message_id,
        `⚠️ Could not cancel the form: ${safeText(describeOpenCodeError(error))}`,
      );
    }
  }

  private async submit(loaded: LoadedForm | null): Promise<void> {
    if (!loaded) {
      return;
    }
    const answer = buildAnswer(loaded);
    try {
      await this.options.client.formReply(loaded.row.session_id, loaded.row.form_id, answer);
    } catch (error) {
      const message = describeOpenCodeError(error);
      if (error instanceof Error && /already settled|FormAlreadySettled/i.test(error.message)) {
        await this.finish(loaded.row, "✅ *Form already settled.*");
        return;
      }
      this.options.logger.warn("Form reply failed", {
        formId: loaded.row.form_id,
        error: errorMessage(error),
      });
      await this.editMessage(
        loaded.row.chat_id,
        loaded.row.message_id,
        `⚠️ Could not submit the form: ${safeText(message)}`,
      );
      return;
    }

    const summary = summarizeAnswer(loaded);
    await this.finish(
      loaded.row,
      tidy(["✅ *Form submitted*", "", `*${escapeBold(loaded.row.title)}*`, "", summary].join("\n")),
    );
  }

  private load(formId: string): LoadedForm | null {
    const row = this.options.forms.get(formId);
    if (!row) {
      return null;
    }
    return {
      row,
      fields: safeJsonArray<FormField>(row.fields_json),
      answers: safeJsonObject<FormAnswer>(row.answers_json),
      skipped: new Set(safeJsonArray<string>(row.skipped_json)),
    };
  }

  private async persistAndAdvance(loaded: LoadedForm): Promise<void> {
    const current = nextField(loaded);
    await this.persist(loaded, {
      currentKey: current?.key ?? null,
      awaitingKey: awaitingKey(current, loaded),
    });
    await this.edit(loaded);
    if (!current) {
      await this.submit(this.load(loaded.row.form_id));
    }
  }

  private async persist(
    loaded: LoadedForm,
    next: { currentKey?: string | null; awaitingKey?: string | null } = {},
  ): Promise<void> {
    this.options.forms.update(loaded.row.form_id, {
      answers_json: JSON.stringify(loaded.answers),
      skipped_json: JSON.stringify([...loaded.skipped]),
      ...(next.currentKey !== undefined ? { current_key: next.currentKey } : {}),
      ...(next.awaitingKey !== undefined ? { awaiting_key: next.awaitingKey } : {}),
    });
  }

  private async edit(loaded: LoadedForm): Promise<void> {
    const fresh = this.load(loaded.row.form_id) ?? loaded;
    const current = currentField(fresh);
    const text = renderForm(fresh, current);
    const keyboard = current ? keyboardFor(current, fresh, this.tokenFor(fresh.row)) : undefined;
    await this.editMessage(
      loaded.row.chat_id,
      loaded.row.message_id,
      text,
      keyboard ?? null,
    );
  }

  private async finish(row: FormSessionRow, text: string): Promise<void> {
    await this.editMessage(row.chat_id, row.message_id, text);
    this.cleanup(row.form_id, row.chat_id);
  }

  private cleanup(formId: string, chatId: string): void {
    this.options.forms.delete(formId);
    this.options.callbacks.deleteByRef(chatId, "form", formId);
    this.options.interactionMessages.delete(formId);
  }

  private tokenFor(row: FormSessionRow): string {
    const existing = this.options.callbacks.getByRef(row.chat_id, "form", row.form_id);
    if (existing && existing.expires_at >= Date.now()) {
      return existing.token;
    }
    const token = randomBytes(12).toString("base64url");
    this.options.callbacks.create({
      token,
      chat_id: row.chat_id,
      kind: "form",
      ref_id: row.form_id,
      payload: JSON.stringify({ sessionID: row.session_id }),
      expires_at: row.expires_at,
    });
    return token;
  }

  private async editMessage(
    chatId: string,
    messageId: number | null,
    text: string,
    replyMarkup: InlineKeyboardMarkup | null = null,
  ): Promise<void> {
    if (messageId === null) {
      return;
    }
    const chat = this.options.outbox.forChat(chatId);
    try {
      await chat.editNow(messageId, text, replyMarkup ? { replyMarkup } : {});
      if (replyMarkup === null) {
        await chat.editMarkup(messageId, null);
      }
    } catch (error) {
      if (!isMessageNotFound(error) && !isMessageNotModified(error)) {
        this.options.logger.debug("Could not edit form message", {
          messageId,
          error: errorMessage(error),
        });
      }
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send form hint", {
        chatId,
        error: errorMessage(error),
      });
    }
  }

  private async answer(callbackQueryId: string, text?: string, alert = false): Promise<void> {
    try {
      await this.options.gateway.answerCallbackQuery({
        callbackQueryId,
        ...(text ? { text } : {}),
        ...(alert ? { showAlert: true } : {}),
      });
    } catch (error) {
      this.options.logger.debug("answerCallbackQuery failed", {
        callbackQueryId,
        error: errorMessage(error),
      });
    }
  }
}

// --------------------------------------------------------------------------
// Pure helpers (exported for tests)
// --------------------------------------------------------------------------

export function isFieldApplicable(field: FormField, answers: FormAnswer): boolean {
  if (!field.when || field.when.length === 0) {
    return true;
  }
  return field.when.every((condition) => {
    const actual = answers[condition.key];
    const matches = actual === condition.value;
    return condition.op === "eq" ? matches : !matches;
  });
}

export function isFieldVisible(field: FormField, answers: FormAnswer): boolean {
  return !field.hidden && isFieldApplicable(field, answers);
}

export function isFieldAnswered(field: FormField, answers: FormAnswer): boolean {
  const value = answers[field.key];
  if (value === undefined) {
    return false;
  }
  if (field.type === "external") {
    return value === true;
  }
  if (field.type === "multiselect") {
    return Array.isArray(value) && value.length > 0;
  }
  return true;
}

export function applyDefaults(fields: readonly FormField[]): FormAnswer {
  const answers: FormAnswer = {};
  for (const field of fields) {
    if (field.type === "boolean" && field.default !== undefined) {
      answers[field.key] = field.default;
    } else if (
      (field.type === "string" || field.type === "number" || field.type === "integer") &&
      field.default !== undefined
    ) {
      answers[field.key] = field.default;
    } else if (field.type === "multiselect" && field.default && field.default.length > 0) {
      answers[field.key] = [...field.default];
    }
  }
  return answers;
}

export function nextField(loaded: LoadedForm): FormField | null {
  for (const field of loaded.fields) {
    if (!isFieldVisible(field, loaded.answers)) {
      continue;
    }
    if (loaded.skipped.has(field.key)) {
      continue;
    }
    if (isFieldAnswered(field, loaded.answers)) {
      continue;
    }
    return field;
  }
  return null;
}

export function buildAnswer(loaded: LoadedForm): FormAnswer {
  const answer: FormAnswer = {};
  for (const field of loaded.fields) {
    if (!isFieldApplicable(field, loaded.answers)) {
      continue;
    }
    const value = loaded.answers[field.key];
    if (value !== undefined) {
      answer[field.key] = value;
    }
  }
  return answer;
}

export type ParseResult =
  | { readonly ok: true; readonly value: FormValue }
  | { readonly ok: false; readonly error: string };

export function parseFieldValue(field: FormField, raw: string): ParseResult {
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, error: `${fieldLabel(field)} cannot be empty.` };
  }

  switch (field.type) {
    case "string": {
      if (field.minLength !== undefined && text.length < field.minLength) {
        return { ok: false, error: `Use at least ${field.minLength} characters.` };
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return { ok: false, error: `Use at most ${field.maxLength} characters.` };
      }
      if (field.pattern) {
        try {
          if (!new RegExp(field.pattern, "u").test(text)) {
            return { ok: false, error: "That value does not match the required pattern." };
          }
        } catch {
          // An invalid server-side pattern must not block the user.
        }
      }
      if (field.format && !matchesFormat(field.format, text)) {
        return { ok: false, error: `Expected a valid ${field.format}.` };
      }
      return { ok: true, value: text };
    }
    case "number":
    case "integer": {
      const normalized = text.replace(/,/g, ".");
      const value = Number(normalized);
      if (!Number.isFinite(value)) {
        return { ok: false, error: "Send a number." };
      }
      if (field.type === "integer" && !Number.isInteger(value)) {
        return { ok: false, error: "Send a whole number." };
      }
      if (field.minimum !== undefined && value < field.minimum) {
        return { ok: false, error: `The minimum is ${field.minimum}.` };
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return { ok: false, error: `The maximum is ${field.maximum}.` };
      }
      return { ok: true, value };
    }
    case "boolean":
      return { ok: true, value: /^(1|true|yes|y)$/i.test(text) };
    case "multiselect":
      return { ok: true, value: text };
    case "external":
      return { ok: false, error: "Open the link and tap Acknowledge." };
  }
}

function matchesFormat(format: string, text: string): boolean {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    case "uri":
      try {
        // eslint-disable-next-line no-new
        new URL(text);
        return true;
      } catch {
        return false;
      }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text));
    case "date-time":
      return !Number.isNaN(Date.parse(text));
    default:
      return true;
  }
}

function validateMultiselectCount(
  field: Extract<FormField, { type: "multiselect" }>,
  selected: readonly string[],
): string | null {
  if (field.minItems !== undefined && selected.length < field.minItems) {
    return `Select at least ${field.minItems} option${field.minItems === 1 ? "" : "s"}.`;
  }
  if (field.maxItems !== undefined && selected.length > field.maxItems) {
    return `Select at most ${field.maxItems} options.`;
  }
  return null;
}

function supportsCustom(field: FormField): boolean {
  return (field.type === "string" || field.type === "multiselect") && field.custom === true;
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

export function renderForm(
  loaded: LoadedForm,
  current: FormField | null,
): string {
  const visible = loaded.fields.filter((field) => isFieldVisible(field, loaded.answers));
  const index = current ? visible.findIndex((field) => field.key === current.key) + 1 : visible.length;
  const lines: string[] = [`📋 *Form · ${escapeBold(loaded.row.title)}*`];

  if (!current) {
    lines.push("", "_All fields are set. Submitting…_");
    return tidy(lines.join("\n"));
  }

  lines.push(`_Step ${index} of ${visible.length}_`, "");
  lines.push(`*${escapeBold(fieldLabel(current))}*${current.required ? " _(required)_" : ""}`);
  if (current.description) {
    lines.push(transformInline(truncate(current.description, 500)));
  }

  const awaiting = loaded.row.awaiting_key === current.key;

  switch (current.type) {
    case "string": {
      if (awaiting) {
        lines.push("", "✏️ Send the custom value as a message.");
      } else if (current.options && current.options.length > 0) {
        lines.push("", "Choose an option below.");
      } else {
        const hint = current.placeholder ? ` _e.g. ${escapeItalic(current.placeholder)}_` : "";
        lines.push("", `Send the value as a message.${hint}`);
      }
      break;
    }
    case "number":
    case "integer": {
      const bounds: string[] = [];
      if (current.minimum !== undefined) bounds.push(`min ${current.minimum}`);
      if (current.maximum !== undefined) bounds.push(`max ${current.maximum}`);
      lines.push(
        "",
        `Send ${current.type === "integer" ? "a whole number" : "a number"} as a message${
          bounds.length > 0 ? ` (${bounds.join(", ")})` : ""
        }.`,
      );
      break;
    }
    case "boolean":
      lines.push("", "Choose Yes or No.");
      break;
    case "multiselect": {
      const selected = readStringArray(loaded.answers[current.key]);
      const bounds: string[] = [];
      if (current.minItems !== undefined) bounds.push(`min ${current.minItems}`);
      if (current.maxItems !== undefined) bounds.push(`max ${current.maxItems}`);
      lines.push(
        "",
        awaiting
          ? "✏️ Send the custom value as a message."
          : `Select one or more${bounds.length > 0 ? ` (${bounds.join(", ")})` : ""}, then press Done.`,
      );
      if (current.custom) {
        lines.push("_Press ➕ Custom to add a value that is not listed._");
      }
      if (selected.length > 0) {
        lines.push(`Selected: ${selected.map((value) => `\`${safeCode(value)}\``).join(", ")}`);
      }
      break;
    }
    case "external":
      lines.push("", `🔗 ${safeCode(current.url)}`, "", "Open the link, then tap Acknowledge.");
      break;
  }

  const answered = visible.filter(
    (field) => field.key !== current.key && isFieldAnswered(field, loaded.answers),
  );
  if (answered.length > 0) {
    lines.push("", "_Already set:_");
    for (const field of answered.slice(0, 4)) {
      lines.push(`• ${escapeBold(fieldLabel(field))}: ${describeValue(field, loaded.answers[field.key])}`);
    }
    if (answered.length > 4) {
      lines.push(`• _…and ${answered.length - 4} more_`);
    }
  }

  lines.push("", "_This form expires in 20 minutes._");
  return tidy(lines.join("\n"));
}

type KeyboardButton =
  | { readonly text: string; readonly callback_data: string }
  | { readonly text: string; readonly url: string };
type KeyboardRows = KeyboardButton[][];

function keyboardFor(
  field: FormField,
  loaded: LoadedForm,
  token: string,
): InlineKeyboardMarkup {
  const rows: KeyboardRows = [];

  switch (field.type) {
    case "string": {
      if (field.options && field.options.length > 0) {
        rows.push(...optionRows(field.options, token, "o"));
        if (field.custom) {
          rows.push([button("➕ Custom", `f:${token}:custom`)]);
        }
      }
      break;
    }
    case "number":
    case "integer":
      break;
    case "boolean":
      rows.push([
        button("✅ Yes", `f:${token}:b:1`),
        button("❌ No", `f:${token}:b:0`),
      ]);
      break;
    case "multiselect": {
      const selected = readStringArray(loaded.answers[field.key]);
      rows.push(
        ...optionRows(
          field.options,
          token,
          "t",
          (option) => selected.includes(option.value),
        ),
      );
      if (field.custom) {
        rows.push([button("➕ Custom", `f:${token}:custom`)]);
      }
      rows.push([button("✔️ Done", `f:${token}:done`)]);
      break;
    }
    case "external":
      rows.push([
        { text: "🔗 Open link", url: field.url },
        button("✅ Acknowledge", `f:${token}:ack`),
      ]);
      break;
  }

  const tail: KeyboardButton[] = [];
  if (!(field.required ?? false)) {
    tail.push(button("⏭️ Skip", `f:${token}:skip`));
  }
  tail.push(button("⛔ Cancel", `f:${token}:cancel`));
  rows.push(tail);

  return { inline_keyboard: rows };
}

function optionRows(
  options: readonly FormOption[],
  token: string,
  action: "o" | "t",
  isSelected?: (option: FormOption) => boolean,
): KeyboardRows {
  const rows: KeyboardRows = [];
  let row: KeyboardButton[] = [];
  options.slice(0, 20).forEach((option, index) => {
    const mark = isSelected?.(option) ? "✅ " : "";
    row.push(
      button(
        `${mark}${truncate(option.label, 28)}`,
        `f:${token}:${action}:${index}`,
      ),
    );
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  });
  if (row.length > 0) {
    rows.push(row);
  }
  return rows;
}

function button(text: string, callbackData: string): { text: string; callback_data: string } {
  return { text: truncate(text, 64), callback_data: callbackData };
}

function currentField(loaded: LoadedForm): FormField | null {
  if (loaded.row.current_key) {
    const found = loaded.fields.find((field) => field.key === loaded.row.current_key);
    if (found && isFieldVisible(found, loaded.answers)) {
      return found;
    }
  }
  return nextField(loaded);
}

function awaitingKey(field: FormField | null, loaded: LoadedForm): string | null {
  if (!field) {
    return null;
  }
  if (field.type === "string" && field.options && field.options.length > 0) {
    return null;
  }
  if (field.type === "boolean" || field.type === "external" || field.type === "multiselect") {
    return null;
  }
  return field.key;
}

function describeValue(field: FormField, value: FormValue | undefined): string {
  if (value === undefined) {
    return "_not set_";
  }
  if (field.type === "multiselect") {
    return readStringArray(value).map((item) => `\`${safeCode(item)}\``).join(", ");
  }
  if (field.type === "boolean") {
    return value === true ? "Yes" : "No";
  }
  if (field.type === "external") {
    return value === true ? "Acknowledged" : "_not acknowledged_";
  }
  return `\`${safeCode(String(value))}\``;
}

function summarizeAnswer(loaded: LoadedForm): string {
  const lines: string[] = [];
  for (const field of loaded.fields) {
    if (!isFieldVisible(field, loaded.answers)) {
      continue;
    }
    const value = loaded.answers[field.key];
    if (value !== undefined) {
      lines.push(`• ${escapeBold(fieldLabel(field))}: ${describeValue(field, value)}`);
    }
  }
  return lines.slice(0, 10).join("\n");
}

function fieldLabel(field: FormField): string {
  return field.title && field.title.trim().length > 0 ? field.title.trim() : field.key;
}

function readStringArray(value: FormValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function escapeBold(value: string): string {
  return value.replace(/\*/g, "′").replace(/\n+/g, " ").trim();
}

function escapeItalic(value: string): string {
  return value.replace(/_/g, "′").replace(/\n+/g, " ").trim();
}

function safeCode(value: string): string {
  return truncate(value.replace(/`/g, "′"), 240);
}

function safeText(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), 240);
}

function safeJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeJsonObject<T extends object>(value: string): T {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}