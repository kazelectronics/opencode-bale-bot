import type { Logger } from "../logger.js";
import type {
  ActiveSessions,
  CommandRunInput,
  CreateSessionInput,
  FileDiffInfo,
  FileSystemEntry,
  FormDetail,
  FormInfo,
  InboxItem,
  McpServerInfo,
  OpenCodeAgentInfo,
  OpenCodeCommandInfo,
  OpenCodeInfo,
  OpenCodeMessage,
  OpenCodeMessagesResponse,
  OpenCodeModelInfo,
  OpenCodeSession,
  OpenCodeSessionMessage,
  OpenCodeSkillInfo,
  PermissionReply,
  ProjectInfo,
  PromptInput,
  SessionRevert,
  VcsFileStatus,
  VcsInfo,
  WorktreeInfo,
} from "./types.js";

export class OpenCodeError extends Error {
  readonly status: number;
  readonly tag: string | null;
  readonly body: unknown;

  constructor(message: string, options: { status: number; tag?: string | null; body?: unknown }) {
    super(message);
    this.name = "OpenCodeError";
    this.status = options.status;
    this.tag = options.tag ?? null;
    this.body = options.body;
  }
}

export interface OpenCodeClientOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  readonly logger: Logger;
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
  readonly unwrap?: boolean;
  readonly timeoutMs?: number;
}

const REQUIRED_PATHS = [
  "/api/info",
  "/api/session",
  "/api/session/active",
  "/api/session/{sessionID}",
  "/api/session/{sessionID}/prompt",
  "/api/session/{sessionID}/interrupt",
  "/api/session/{sessionID}/message",
  "/api/session/{sessionID}/permission/{requestID}/reply",
  "/api/session/{sessionID}/form/{formID}/reply",
  "/api/session/{sessionID}/inbox",
  "/api/session/{sessionID}/compact",
  "/api/session/{sessionID}/model",
  "/api/session/{sessionID}/agent",
  "/api/model",
  "/api/agent",
  "/api/event",
  "/api/command",
  "/api/session/{sessionID}/command",
  "/api/skill",
  "/api/experimental/session/{sessionID}/skill",
  "/api/fs/list",
  "/api/fs/find",
  "/api/fs/read/*",
  "/api/session/{sessionID}/diff",
  "/api/session/{sessionID}/fork",
  "/api/session/{sessionID}/revert/stage",
  "/api/session/{sessionID}/revert/commit",
  "/api/session/{sessionID}/revert",
  "/api/session/{sessionID}/message/{messageID}",
  "/api/session/{sessionID}/move",
  "/api/project",
  "/api/worktree",
  "/api/vcs",
  "/api/vcs/diff",
  "/api/vcs/status",
  "/api/vcs/branch",
  "/api/mcp",
  "/api/session/{sessionID}/context",
] as const;

export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
  }

  async info(): Promise<OpenCodeInfo> {
    return this.request<OpenCodeInfo>("/api/info", { unwrap: false });
  }

  async checkContract(): Promise<readonly string[]> {
    try {
      const spec = await this.request<{ paths?: Record<string, unknown> }>("/openapi.json", {
        unwrap: false,
      });
      const paths = spec.paths ?? {};
      return REQUIRED_PATHS.filter((path) => !(path in paths));
    } catch (error) {
      this.logger.warn("OpenCode contract check failed", { error });
      return [];
    }
  }

  async listSessions(): Promise<readonly OpenCodeSession[]> {
    return this.request<readonly OpenCodeSession[]>("/api/session");
  }

  async getSession(sessionId: string): Promise<OpenCodeSession> {
    return this.request<OpenCodeSession>(`/api/session/${encodeURIComponent(sessionId)}`);
  }

  async createSession(input: CreateSessionInput): Promise<OpenCodeSession> {
    return this.request<OpenCodeSession>("/api/session", {
      method: "POST",
      body: {
        title: input.title,
        location: { directory: input.directory },
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      },
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      unwrap: false,
    });
  }

  async listMessages(sessionId: string): Promise<readonly OpenCodeMessage[]> {
    return this.request<readonly OpenCodeMessage[]>(
      `/api/session/${encodeURIComponent(sessionId)}/message`,
    );
  }

  async prompt(sessionId: string, input: PromptInput): Promise<OpenCodeMessage> {
    return this.request<OpenCodeMessage>(
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: "POST",
        body: {
          ...(input.id ? { id: input.id } : {}),
          text: input.text,
          ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
          ...(input.agents && input.agents.length > 0 ? { agents: input.agents } : {}),
          ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
          ...(input.delivery ? { delivery: input.delivery } : {}),
          ...(input.resume !== undefined ? { resume: input.resume } : {}),
        },
      },
    );
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const response = await this.request<{ interrupted?: boolean }>(
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST", body: {}, unwrap: false },
    );
    return response.interrupted === true;
  }

  async compact(sessionId: string): Promise<{ id: string; delivery?: string }> {
    return this.request<{ id: string; delivery?: string }>(
      `/api/session/${encodeURIComponent(sessionId)}/compact`,
      { method: "POST", body: {} },
    );
  }

  async listModels(): Promise<readonly OpenCodeModelInfo[]> {
    return this.request<readonly OpenCodeModelInfo[]>("/api/model");
  }

  async listAgents(): Promise<readonly OpenCodeAgentInfo[]> {
    return this.request<readonly OpenCodeAgentInfo[]>("/api/agent");
  }

  /** Active context messages: everything after the last compaction. */
  async sessionContext(sessionId: string): Promise<readonly OpenCodeSessionMessage[]> {
    return this.request<readonly OpenCodeSessionMessage[]>(
      `/api/session/${encodeURIComponent(sessionId)}/context`,
    );
  }

  async listMcpServers(directory: string): Promise<readonly McpServerInfo[]> {
    return this.request<readonly McpServerInfo[]>(`/api/mcp?${locationQuery(directory)}`);
  }

  async connectMcp(server: string, directory: string): Promise<void> {
    await this.request<unknown>(
      `/api/experimental/mcp/${encodeURIComponent(server)}/connect?${locationQuery(directory)}`,
      { method: "POST", body: {}, unwrap: false },
    );
  }

  async disconnectMcp(server: string, directory: string): Promise<void> {
    await this.request<unknown>(
      `/api/experimental/mcp/${encodeURIComponent(server)}/disconnect?${locationQuery(directory)}`,
      { method: "POST", body: {}, unwrap: false },
    );
  }

  /** Shut down and rebuild every loaded location. */
  async reloadConfig(): Promise<void> {
    await this.request<unknown>("/api/location/reload", {
      method: "POST",
      body: {},
      unwrap: false,
      timeoutMs: 60_000,
    });
  }

  async switchModel(
    sessionId: string,
    model: { providerID: string; id: string; variant?: string },
  ): Promise<void> {
    await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      body: {
        model: {
          providerID: model.providerID,
          id: model.id,
          ...(model.variant ? { variant: model.variant } : {}),
        },
      },
      unwrap: false,
    });
  }

  async switchAgent(sessionId: string, agent: string): Promise<void> {
    await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/agent`, {
      method: "POST",
      body: { agent },
      unwrap: false,
    });
  }

  async listForms(sessionId: string): Promise<readonly FormInfo[]> {
    return this.request<readonly FormInfo[]>(
      `/api/session/${encodeURIComponent(sessionId)}/form`,
    );
  }

  async getForm(sessionId: string, formId: string): Promise<FormDetail> {
    return this.request<FormDetail>(
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`,
    );
  }

  async cancelForm(sessionId: string, formId: string): Promise<void> {
    await this.request<unknown>(
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`,
      { method: "DELETE", unwrap: false },
    );
  }

  async listInbox(sessionId: string): Promise<readonly InboxItem[]> {
    return this.request<readonly InboxItem[]>(
      `/api/session/${encodeURIComponent(sessionId)}/inbox`,
    );
  }

  async cancelInbox(sessionId: string, inboxId: string): Promise<void> {
    await this.request<unknown>(
      `/api/session/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
      { method: "DELETE", unwrap: false },
    );
  }

  async permissionReply(
    sessionId: string,
    requestId: string,
    reply: PermissionReply,
  ): Promise<void> {
    await this.request<unknown>(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: {
          decision: reply.decision,
          ...(reply.message ? { message: reply.message } : {}),
        },
        unwrap: false,
      },
    );
  }

  async formReply(
    sessionId: string,
    formId: string,
    answer: Record<string, unknown>,
  ): Promise<void> {
    await this.request<unknown>(
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
      { method: "POST", body: { answer }, unwrap: false },
    );
  }

  async activeSessions(): Promise<ActiveSessions> {
    return this.request<ActiveSessions>("/api/session/active");
  }

  async getMessages(
    sessionId: string,
    options: { limit?: number; order?: "asc" | "desc"; cursor?: string; type?: string } = {},
  ): Promise<OpenCodeMessagesResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.order) params.set("order", options.order);
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.type) params.set("type", options.type);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<OpenCodeMessagesResponse>(
      `/api/session/${encodeURIComponent(sessionId)}/message${query}`,
      { unwrap: false },
    );
  }

  async getMessage(sessionId: string, messageId: string): Promise<OpenCodeSessionMessage> {
    return this.request<OpenCodeSessionMessage>(
      `/api/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
    );
  }

  async listCommands(directory: string): Promise<readonly OpenCodeCommandInfo[]> {
    return this.request<readonly OpenCodeCommandInfo[]>(
      `/api/command?${locationQuery(directory)}`,
    );
  }

  async runCommand(sessionId: string, input: CommandRunInput): Promise<void> {
    await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/command`, {
      method: "POST",
      body: {
        name: input.name,
        text: input.text,
        ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
        ...(input.agents && input.agents.length > 0 ? { agents: input.agents } : {}),
        ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
        ...(input.delivery ? { delivery: input.delivery } : {}),
      },
      unwrap: false,
    });
  }

  async listSkills(directory: string): Promise<readonly OpenCodeSkillInfo[]> {
    return this.request<readonly OpenCodeSkillInfo[]>(`/api/skill?${locationQuery(directory)}`);
  }

  async activateSkill(sessionId: string, id: string, resume?: boolean): Promise<void> {
    await this.request<unknown>(
      `/api/experimental/session/${encodeURIComponent(sessionId)}/skill`,
      {
        method: "POST",
        body: { id, ...(resume !== undefined ? { resume } : {}) },
        unwrap: false,
      },
    );
  }

  async listDirectory(
    directory: string,
    path = ".",
  ): Promise<readonly FileSystemEntry[]> {
    const params = new URLSearchParams(locationQuery(directory));
    params.set("path", path);
    return this.request<readonly FileSystemEntry[]>(`/api/fs/list?${params.toString()}`);
  }

  async findFiles(
    directory: string,
    query: string,
    options: { type?: "file" | "directory"; limit?: number } = {},
  ): Promise<readonly FileSystemEntry[]> {
    const params = new URLSearchParams(locationQuery(directory));
    params.set("query", query);
    if (options.type) params.set("type", options.type);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    return this.request<readonly FileSystemEntry[]>(`/api/fs/find?${params.toString()}`);
  }

  async readFile(
    directory: string,
    path: string,
  ): Promise<{ content: Buffer; contentType: string }> {
    const encoded = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return this.requestBuffer(
      `/api/fs/read/${encoded}?${locationQuery(directory)}`,
    );
  }

  async sessionDiff(
    sessionId: string,
    options: { from?: string; to?: string; context?: number } = {},
  ): Promise<readonly FileDiffInfo[]> {
    const params = new URLSearchParams();
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    if (options.context !== undefined) params.set("context", String(options.context));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<readonly FileDiffInfo[]>(
      `/api/session/${encodeURIComponent(sessionId)}/diff${query}`,
    );
  }

  async vcsInfo(directory: string): Promise<VcsInfo> {
    return this.request<VcsInfo>(`/api/vcs?${locationQuery(directory)}`);
  }

  async vcsStatus(directory: string): Promise<readonly VcsFileStatus[]> {
    return this.request<readonly VcsFileStatus[]>(
      `/api/vcs/status?${locationQuery(directory)}`,
    );
  }

  async vcsDiff(
    directory: string,
    options: {
      mode: "working" | "branch" | "committed";
      base?: string;
      context?: number;
      untracked?: "files" | "folders";
    },
  ): Promise<readonly FileDiffInfo[]> {
    const params = new URLSearchParams(locationQuery(directory));
    params.set("mode", options.mode);
    if (options.base) params.set("base", options.base);
    if (options.context !== undefined) params.set("context", String(options.context));
    if (options.untracked) params.set("untracked", options.untracked);
    return this.request<readonly FileDiffInfo[]>(`/api/vcs/diff?${params.toString()}`);
  }

  async vcsBranches(directory: string, search?: string): Promise<readonly string[]> {
    const params = new URLSearchParams(locationQuery(directory));
    if (search) params.set("search", search);
    return this.request<readonly string[]>(`/api/vcs/branch?${params.toString()}`);
  }

  async stageRevert(
    sessionId: string,
    messageId: string,
    files = true,
  ): Promise<SessionRevert> {
    return this.request<SessionRevert>(
      `/api/session/${encodeURIComponent(sessionId)}/revert/stage`,
      {
        method: "POST",
        body: { messageID: messageId, files },
      },
    );
  }

  async commitRevert(sessionId: string): Promise<void> {
    await this.request<unknown>(
      `/api/session/${encodeURIComponent(sessionId)}/revert/commit`,
      { method: "POST", body: {}, unwrap: false },
    );
  }

  async clearRevert(sessionId: string): Promise<void> {
    await this.request<unknown>(
      `/api/session/${encodeURIComponent(sessionId)}/revert`,
      { method: "DELETE", unwrap: false },
    );
  }

  async forkSession(sessionId: string, before?: string): Promise<OpenCodeSession> {
    return this.request<OpenCodeSession>(
      `/api/session/${encodeURIComponent(sessionId)}/fork`,
      { method: "POST", body: before ? { before } : {} },
    );
  }

  async listProjects(archived = false): Promise<readonly ProjectInfo[]> {
    return this.request<readonly ProjectInfo[]>(
      `/api/project?archived=${archived ? "true" : "false"}`,
      { unwrap: false },
    );
  }

  async listWorktrees(projectId: string): Promise<readonly WorktreeInfo[]> {
    return this.request<readonly WorktreeInfo[]>(
      `/api/worktree?projectID=${encodeURIComponent(projectId)}`,
      { unwrap: false },
    );
  }

  async createWorktree(input: {
    projectID: string;
    name?: string;
    branch?: string;
    directory?: string;
  }): Promise<WorktreeInfo> {
    return this.request<WorktreeInfo>("/api/worktree", {
      method: "POST",
      body: input,
      unwrap: false,
    });
  }

  async removeWorktree(input: {
    projectID: string;
    directory: string;
    force: boolean;
  }): Promise<void> {
    await this.request<unknown>("/api/worktree", {
      method: "DELETE",
      body: input,
      unwrap: false,
    });
  }

  async moveSession(sessionId: string, directory: string): Promise<void> {
    await this.request<unknown>(`/api/session/${encodeURIComponent(sessionId)}/move`, {
      method: "POST",
      body: { directory },
      unwrap: false,
    });
  }

  async backgroundSession(sessionId: string): Promise<void> {
    await this.request<unknown>(
      `/api/session/${encodeURIComponent(sessionId)}/background`,
      { method: "POST", body: {}, unwrap: false },
    );
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = {
      authorization: this.authHeader,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new OpenCodeError(`Cannot reach OpenCode at ${this.baseUrl}: ${(error as Error).message}`, {
        status: 0,
        body: error,
      });
    }

    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      throw toOpenCodeError(response.status, parsed, text);
    }

    if (options.unwrap === false) {
      return parsed as T;
    }
    return unwrapData<T>(parsed);
  }

  private async requestBuffer(
    path: string,
  ): Promise<{ content: Buffer; contentType: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { authorization: this.authHeader },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new OpenCodeError(`Cannot reach OpenCode at ${this.baseUrl}: ${(error as Error).message}`, {
        status: 0,
        body: error,
      });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw toOpenCodeError(response.status, parseJson(bytes.toString("utf8")), bytes.toString("utf8"));
    }
    return {
      content: bytes,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }
}

function locationQuery(directory: string): string {
  return new URLSearchParams({ "location[directory]": directory }).toString();
}

function parseJson(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unwrapData<T>(value: unknown): T {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data;
  }
  return value as T;
}

function toOpenCodeError(status: number, parsed: unknown, raw: string): OpenCodeError {
  let tag: string | null = null;
  let message = `OpenCode request failed with HTTP ${status}`;

  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (typeof record._tag === "string") {
      tag = record._tag;
    }
    if (typeof record.message === "string" && record.message.length > 0) {
      message = record.message;
    } else if (typeof record.type === "string") {
      tag = record.type;
      const nested = record.error;
      if (nested && typeof nested === "object") {
        const nestedRecord = nested as Record<string, unknown>;
        if (typeof nestedRecord.message === "string") {
          message = nestedRecord.message;
        }
        if (typeof nestedRecord.type === "string") {
          tag = nestedRecord.type;
        }
      }
    }
  } else if (typeof parsed === "string" && parsed.trim().length > 0) {
    message = parsed.trim().slice(0, 500);
  } else if (raw.trim().length > 0) {
    message = raw.trim().slice(0, 500);
  }

  return new OpenCodeError(message, { status, tag, body: parsed });
}