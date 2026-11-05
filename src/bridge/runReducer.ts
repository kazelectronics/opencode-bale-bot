import type { Logger } from "../logger.js";
import type { FormField, OpenCodeEvent } from "../opencode/types.js";
import type { RunUsage } from "../renderer.js";

export type RunStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "waiting_form"
  | "succeeded"
  | "failed"
  | "interrupted";

export interface ToolActivity {
  readonly name: string;
  readonly detail?: string;
  readonly status: "running" | "done" | "failed";
}

export interface PermissionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly save?: readonly string[];
  readonly message?: string;
}

export interface FormRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly title: string;
  readonly fields: readonly FormField[];
}

export interface CompactionState {
  readonly status: "running" | "succeeded" | "failed";
  readonly text?: string;
  readonly error?: string;
}

export interface RunSnapshot {
  readonly sessionID: string;
  readonly chatId: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly text: string;
  readonly usage: RunUsage | null;
  readonly error: string | null;
  readonly outcome: "succeeded" | "failed" | "interrupted" | null;
  readonly model: string | null;
  readonly tool: ToolActivity | null;
  readonly queued: string | null;
  readonly compaction: CompactionState | null;
  readonly stepCount: number;
  readonly reasoning: string;
}

export interface RunReducerOptions {
  readonly logger: Logger;
  readonly onUpdate?: (snapshot: RunSnapshot) => void;
  readonly onTerminal?: (snapshot: RunSnapshot) => void;
  readonly onPermission?: (request: PermissionRequest, snapshot: RunSnapshot) => void;
  readonly onForm?: (form: FormRequest, snapshot: RunSnapshot) => void;
}

interface RunState {
  sessionID: string;
  chatId: string;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
  parts: string[];
  current: string;
  usage: RunUsage | null;
  error: string | null;
  outcome: "succeeded" | "failed" | "interrupted" | null;
  model: string | null;
  tool: ToolActivity | null;
  queued: string | null;
  compaction: CompactionState | null;
  stepCount: number;
  reasoningParts: string[];
  reasoningCurrent: string;
  finalized: boolean;
  textOpen: boolean;
}

const TERMINAL_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

export class RunReducer {
  private readonly runs = new Map<string, RunState>();
  private readonly options: RunReducerOptions;

  constructor(options: RunReducerOptions) {
    this.options = options;
  }

  get(sessionID: string): RunSnapshot | null {
    const state = this.runs.get(sessionID);
    return state ? snapshotOf(state) : null;
  }

  all(): RunSnapshot[] {
    return [...this.runs.values()].map(snapshotOf);
  }

  remove(sessionID: string): void {
    this.runs.delete(sessionID);
  }

  handle(event: OpenCodeEvent, chatId: string): RunSnapshot | null {
    const sessionID = extractSessionID(event);
    if (!sessionID) {
      return null;
    }

    let state = this.runs.get(sessionID);
    if (!state) {
      state = freshState(sessionID, chatId);
      this.runs.set(sessionID, state);
    }
    state.chatId = chatId;
    state.updatedAt = Date.now();

    const data = event.data ?? {};
    const type = event.type;

    switch (type) {
      case "session.execution.started": {
        if (state.finalized) {
          state = freshState(sessionID, chatId);
          this.runs.set(sessionID, state);
        }
        state.status = "running";
        state.startedAt = Date.now();
        state.updatedAt = state.startedAt;
        state.error = null;
        state.outcome = null;
        state.compaction = null;
        state.reasoningParts = [];
        state.reasoningCurrent = "";
        state.finalized = false;
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.text.started": {
        if (state.current.trim().length > 0) {
          state.parts.push(state.current);
        }
        state.current = "";
        state.textOpen = true;
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.text.delta": {
        const delta = typeof data.delta === "string" ? data.delta : "";
        if (delta) {
          state.current += delta;
          this.emitUpdate(state);
        }
        return snapshotOf(state);
      }

      case "session.text.ended": {
        const text = typeof data.text === "string" ? data.text : state.current;
        state.current = text;
        state.textOpen = false;
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.reasoning.started": {
        if (state.reasoningCurrent.trim().length > 0) {
          state.reasoningParts.push(state.reasoningCurrent);
        }
        state.reasoningCurrent = "";
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.reasoning.delta": {
        const delta = typeof data.delta === "string" ? data.delta : "";
        if (delta) {
          state.reasoningCurrent += delta;
          this.emitUpdate(state);
        }
        return snapshotOf(state);
      }

      case "session.reasoning.ended": {
        const text = typeof data.text === "string" ? data.text : state.reasoningCurrent;
        state.reasoningCurrent = text;
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.tool.input.started": {
        state.tool = {
          name: typeof data.name === "string" ? data.name : "tool",
          status: "running",
        };
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.tool.called": {
        state.tool = {
          name: typeof data.name === "string" ? data.name : "tool",
          detail: describeToolInput(data.input),
          status: "running",
        };
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.tool.progress": {
        if (state.tool) {
          state.tool = { ...state.tool, status: "running" };
        }
        return snapshotOf(state);
      }

      case "session.tool.success": {
        if (state.tool) {
          state.tool = { ...state.tool, status: "done" };
        }
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.tool.failed": {
        if (state.tool) {
          state.tool = {
            ...state.tool,
            status: "failed",
            detail: typeof data.error === "string" ? data.error : state.tool.detail,
          };
        }
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.step.started": {
        state.stepCount += 1;
        const model = data.model;
        if (model && typeof model === "object") {
          const record = model as Record<string, unknown>;
          if (typeof record.providerID === "string" && typeof record.id === "string") {
            state.model = `${record.providerID}/${record.id}`;
          }
        }
        state.status = "running";
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.step.ended": {
        state.usage = readUsage(data);
        return snapshotOf(state);
      }

      case "session.usage.updated": {
        state.usage = readUsage(data) ?? state.usage;
        return snapshotOf(state);
      }

      case "session.retry.scheduled": {
        const message = typeof data.message === "string" ? data.message : "Retrying provider";
        state.tool = { name: "retry", detail: message, status: "running" };
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.step.failed": {
        const error = readEventError(data);
        if (error?.type === "aborted") {
          return snapshotOf(state);
        }
        if (error?.message) {
          state.error = error.message;
        }
        return snapshotOf(state);
      }

      case "session.compaction.started": {
        state.compaction = { status: "running" };
        state.status = "running";
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.compaction.delta": {
        const delta = typeof data.text === "string" ? data.text : "";
        if (delta && state.compaction?.status === "running") {
          state.compaction = {
            ...state.compaction,
            text: `${state.compaction.text ?? ""}${delta}`,
          };
        }
        return snapshotOf(state);
      }

      case "session.compaction.ended": {
        state.compaction = {
          status: "succeeded",
          ...(typeof data.text === "string" ? { text: data.text } : {}),
        };
        state.usage = readUsage(data) ?? state.usage;
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.compaction.failed": {
        const error = readEventError({ error: data.error });
        state.compaction = {
          status: "failed",
          ...(error?.message ? { error: error.message } : {}),
        };
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.execution.succeeded":
        return this.finalize(state, "succeeded", null);

      case "session.execution.failed": {
        const error = readEventError(data) ?? readEventError({ error: data.error });
        return this.finalize(state, "failed", error?.message ?? state.error ?? "Run failed");
      }

      case "session.execution.interrupted":
        return this.finalize(state, "interrupted", null);

      case "session.inbox.enqueued": {
        state.queued = typeof data.inboxID === "string" ? data.inboxID : "queued";
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "session.inbox.delivered":
      case "session.inbox.cancelled": {
        state.queued = null;
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "permission.asked": {
        const request = extractPermission(data, sessionID);
        if (!request) {
          this.options.logger.warn("Could not parse permission request", { data });
          return snapshotOf(state);
        }
        state.status = "waiting_permission";
        this.emitUpdate(state);
        this.options.onPermission?.(request, snapshotOf(state));
        return snapshotOf(state);
      }

      case "permission.replied":
      case "permission.rejected": {
        if (state.status === "waiting_permission") {
          state.status = "running";
        }
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      case "form.created": {
        const form = extractForm(data, sessionID);
        if (!form) {
          this.options.logger.warn("Could not parse form request", { data });
          return snapshotOf(state);
        }
        state.status = "waiting_form";
        this.emitUpdate(state);
        this.options.onForm?.(form, snapshotOf(state));
        return snapshotOf(state);
      }

      case "form.replied":
      case "form.cancelled": {
        if (state.status === "waiting_form") {
          state.status = "running";
        }
        this.emitUpdate(state);
        return snapshotOf(state);
      }

      default:
        return TERMINAL_EVENTS.has(type) ? snapshotOf(state) : null;
    }
  }

  private finalize(
    state: RunState,
    outcome: "succeeded" | "failed" | "interrupted",
    error: string | null,
  ): RunSnapshot {
    if (state.finalized) {
      return snapshotOf(state);
    }
    state.finalized = true;
    state.outcome = outcome;
    state.status = outcome;
    state.error = error ?? state.error;
    state.queued = null;
    if (outcome === "failed") {
      state.tool = state.tool ? { ...state.tool, status: "failed" } : state.tool;
    }
    if (state.current.trim().length > 0) {
      state.parts.push(state.current);
      state.current = "";
    }
    state.updatedAt = Date.now();
    const snapshot = snapshotOf(state);
    this.options.onTerminal?.(snapshot);
    return snapshot;
  }

  private emitUpdate(state: RunState): void {
    this.options.onUpdate?.(snapshotOf(state));
  }
}

function freshState(sessionID: string, chatId: string): RunState {
  const now = Date.now();
  return {
    sessionID,
    chatId,
    status: "idle",
    startedAt: now,
    updatedAt: now,
    parts: [],
    current: "",
    usage: null,
    error: null,
    outcome: null,
    model: null,
    tool: null,
    queued: null,
    compaction: null,
    stepCount: 0,
    reasoningParts: [],
    reasoningCurrent: "",
    finalized: false,
    textOpen: false,
  };
}

function snapshotOf(state: RunState): RunSnapshot {
  return {
    sessionID: state.sessionID,
    chatId: state.chatId,
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    text: [...state.parts, state.current].filter((part) => part.trim().length > 0).join("\n\n"),
    usage: state.usage,
    error: state.error,
    outcome: state.outcome,
    model: state.model,
    tool: state.tool,
    queued: state.queued,
    compaction: state.compaction,
    stepCount: state.stepCount,
    reasoning: [...state.reasoningParts, state.reasoningCurrent]
      .filter((part) => part.trim().length > 0)
      .join("\n\n"),
  };
}

export function extractSessionID(event: OpenCodeEvent): string | null {
  const data = event.data;
  if (data && typeof data.sessionID === "string") {
    return data.sessionID;
  }
  if (data) {
    for (const key of ["form", "request", "permission"] as const) {
      const nested = data[key];
      if (
        nested &&
        typeof nested === "object" &&
        typeof (nested as Record<string, unknown>).sessionID === "string"
      ) {
        return (nested as Record<string, unknown>).sessionID as string;
      }
    }
  }
  const record = event as unknown as Record<string, unknown>;
  if (typeof record.sessionID === "string") {
    return record.sessionID;
  }
  return null;
}

export function extractPermission(
  data: Record<string, unknown>,
  fallbackSessionID: string,
): PermissionRequest | null {
  const candidate =
    (data.request as Record<string, unknown> | undefined) ??
    (data.permission as Record<string, unknown> | undefined) ??
    data;
  const id = typeof candidate.id === "string" ? candidate.id : null;
  if (!id || !id.startsWith("per")) {
    return null;
  }
  const sessionID =
    typeof candidate.sessionID === "string" ? candidate.sessionID : fallbackSessionID;
  const resources = Array.isArray(candidate.resources)
    ? candidate.resources.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id,
    sessionID,
    action: typeof candidate.action === "string" ? candidate.action : "action",
    resources,
    ...(Array.isArray(candidate.save)
      ? {
          save: candidate.save.filter((item): item is string => typeof item === "string"),
        }
      : {}),
    ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
  };
}

export function extractForm(
  data: Record<string, unknown>,
  fallbackSessionID: string,
): FormRequest | null {
  const candidate =
    (data.form as Record<string, unknown> | undefined) ??
    (data.request as Record<string, unknown> | undefined) ??
    data;
  const id = typeof candidate.id === "string" ? candidate.id : null;
  if (!id || !id.startsWith("frm_")) {
    return null;
  }
  return {
    id,
    sessionID:
      typeof candidate.sessionID === "string" ? candidate.sessionID : fallbackSessionID,
    title: typeof candidate.title === "string" ? candidate.title : "Form",
    fields: Array.isArray(candidate.fields) ? (candidate.fields as FormField[]) : [],
  };
}

function readUsage(data: Record<string, unknown>): RunUsage | null {
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== "object") {
    return null;
  }
  const record = tokens as Record<string, unknown>;
  const cache = (record.cache ?? {}) as Record<string, unknown>;
  return {
    input: asNumber(record.input),
    output: asNumber(record.output),
    reasoning: asNumber(record.reasoning),
    cacheRead: asNumber(cache.read),
    cacheWrite: asNumber(cache.write),
    cost: asNumber(data.cost),
  };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readEventError(data: Record<string, unknown>): { type?: string; message?: string } | null {
  let candidate: unknown = data.error ?? data;
  if (candidate && typeof candidate === "object" && "error" in candidate) {
    candidate = (candidate as Record<string, unknown>).error;
  }
  if (!candidate || typeof candidate !== "object") {
    if (typeof candidate === "string") {
      return { message: candidate };
    }
    return null;
  }
  const record = candidate as Record<string, unknown>;
  return {
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

function describeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of ["command", "description", "path", "filePath", "file_path", "pattern", "query", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim().slice(0, 160);
    }
  }
  return undefined;
}