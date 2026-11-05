import type { Config } from "../config.js";
import type { ChatPatch, ChatRepo, ChatRow } from "../db.js";
import type { Logger } from "../logger.js";
import { OpenCodeError, type OpenCodeClient } from "../opencode/client.js";
import type { OpenCodeSession } from "../opencode/types.js";
import { describeOpenCodeError } from "./errors.js";

/** Minimal interface so the session service can register background watches. */
export interface SessionWatcher {
  watch(chatId: string, sessionId: string, title: string | null): void;
}

export class SessionService {
  private readonly bridgeSessions = new Set<string>();
  private watcher: SessionWatcher | null;

  constructor(
    private readonly client: OpenCodeClient,
    private readonly chats: ChatRepo,
    private readonly config: Config,
    private readonly logger: Logger,
    watcher?: SessionWatcher,
  ) {
    this.watcher = watcher ?? null;
  }

  setWatcher(watcher: SessionWatcher | null): void {
    this.watcher = watcher;
  }

  async ensureSession(chat: ChatRow): Promise<OpenCodeSession> {
    if (chat.active_session_id) {
      try {
        return await this.client.getSession(chat.active_session_id);
      } catch (error) {
        if (error instanceof OpenCodeError && error.status === 404) {
          this.logger.warn("Bound session no longer exists; creating a new one", {
            sessionId: chat.active_session_id,
          });
          this.chats.setActiveSession(chat.chat_id, null);
        } else {
          throw error;
        }
      }
    }
    return this.createSession({ ...chat, active_session_id: null });
  }

  async createSession(chat: ChatRow, title?: string): Promise<OpenCodeSession> {
    const sessionTitle =
      title && title.trim().length > 0
        ? title.trim()
        : `${this.config.bridge.sessionTitlePrefix} · ${formatStamp(new Date())}`;
    const model =
      chat.model_provider && chat.model_id
        ? { providerID: chat.model_provider, id: chat.model_id }
        : this.config.opencode.model;
    const agent = chat.agent ?? this.config.opencode.agent;
    const directory = chat.project_directory ?? this.config.opencode.projectDirectory;

    const session = await this.client.createSession({
      title: sessionTitle,
      directory,
      model,
      agent,
    });
    this.bridgeSessions.add(session.id);
    this.chats.setActiveSession(chat.chat_id, session.id);
    this.chats.update(chat.chat_id, { projectDirectory: directory });
    this.watcher?.watch(chat.chat_id, session.id, session.title ?? null);
    this.logger.info("Created OpenCode session", {
      sessionId: session.id,
      chatId: chat.chat_id,
      directory,
      model: `${model.providerID}/${model.id}`,
    });
    return session;
  }

  async attach(chat: ChatRow, sessionId: string): Promise<OpenCodeSession> {
    const session = await this.client.getSession(sessionId);
    this.chats.setActiveSession(chat.chat_id, session.id);
    const patch: ChatPatch = {};
    if (session.location?.directory) {
      patch.projectDirectory = session.location.directory;
    }
    if (session.model) {
      patch.modelProvider = session.model.providerID;
      patch.modelId = session.model.id;
    }
    if (session.agent) {
      patch.agent = session.agent;
    }
    if (Object.keys(patch).length > 0) {
      this.chats.update(chat.chat_id, patch);
    }
    this.watcher?.watch(chat.chat_id, session.id, session.title ?? null);
    this.logger.info("Attached chat to session", {
      chatId: chat.chat_id,
      sessionId: session.id,
    });
    return session;
  }

  async detach(chat: ChatRow): Promise<void> {
    this.chats.setActiveSession(chat.chat_id, null);
    this.chats.setLiveMessage(chat.chat_id, null);
  }

  createdByBridge(sessionId: string): boolean {
    return this.bridgeSessions.has(sessionId);
  }

  describeError(error: unknown): string {
    return describeOpenCodeError(error);
  }
}

export function formatStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}