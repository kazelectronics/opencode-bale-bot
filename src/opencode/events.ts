import { errorMessage, type Logger } from "../logger.js";
import { backoffDelay, sleep } from "../util.js";
import type { OpenCodeEvent } from "./types.js";

export interface SseFrame {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
}

/** Incremental SSE parser. Comments (heartbeats) are skipped. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    while (true) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
      if (!match || match.index === undefined) {
        break;
      }
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = parseFrame(raw);
      if (frame) {
        frames.push(frame);
      }
    }

    return frames;
  }
}

function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split(/\r\n|\n|\r/);
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  let hasData = false;

  for (const line of lines) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "event":
        event = value;
        break;
      case "id":
        id = value;
        break;
      case "data":
        data.push(value);
        hasData = true;
        break;
      default:
        break;
    }
  }

  if (!hasData) {
    return null;
  }
  return {
    ...(event ? { event } : {}),
    data: data.join("\n"),
    ...(id ? { id } : {}),
  };
}

export interface EventStreamOptions {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly logger: Logger;
  readonly onEvent: (event: OpenCodeEvent) => void;
  readonly onConnectionChange?: (connected: boolean, reconnected: boolean) => void;
  readonly signal?: AbortSignal;
}

export class OpenCodeEventStream {
  private readonly options: EventStreamOptions;
  private readonly controller = new AbortController();
  private connected = false;
  private stopped = false;
  private attempt = 0;
  private hasConnected = false;
  private lastEventAt: number | null = null;

  constructor(options: EventStreamOptions) {
    this.options = options;
    if (options.signal) {
      if (options.signal.aborted) {
        this.stop();
      } else {
        options.signal.addEventListener("abort", () => this.stop(), { once: true });
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  lastEventTimestamp(): number | null {
    return this.lastEventAt;
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.consume();
        if (!this.stopped) {
          this.setConnected(false);
          this.options.logger.warn("OpenCode event stream ended; reconnecting");
        }
      } catch (error) {
        if (this.stopped) {
          break;
        }
        this.setConnected(false);
        this.attempt += 1;
        const delay = backoffDelay(this.attempt);
        this.options.logger.warn("OpenCode event stream error", {
          error: errorMessage(error),
          retryInMs: delay,
        });
        try {
          await sleep(delay, this.controller.signal);
        } catch {
          break;
        }
        continue;
      }

      if (this.stopped) {
        break;
      }
      this.attempt += 1;
      try {
        await sleep(backoffDelay(this.attempt), this.controller.signal);
      } catch {
        break;
      }
    }
    this.setConnected(false);
  }

  private async consume(): Promise<void> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/api/event`;
    const auth = `Basic ${Buffer.from(
      `${this.options.username}:${this.options.password}`,
    ).toString("base64")}`;

    const response = await fetch(url, {
      headers: {
        authorization: auth,
        accept: "text/event-stream",
        "cache-control": "no-cache",
      },
      signal: this.controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`SSE connection failed: HTTP ${response.status} ${body.slice(0, 300)}`);
    }
    if (!response.body) {
      throw new Error("SSE connection failed: empty body");
    }

    const reconnected = this.hasConnected;
    this.hasConnected = true;
    this.attempt = 0;
    this.setConnected(true, reconnected);
    this.options.logger.info("OpenCode event stream connected", { reconnected });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();

    while (!this.stopped) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      for (const frame of parser.push(chunk)) {
        this.handleFrame(frame);
      }
    }
  }

  private handleFrame(frame: SseFrame): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      this.options.logger.debug("Ignoring non-JSON SSE frame", {
        event: frame.event,
        length: frame.data.length,
      });
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const event = parsed as OpenCodeEvent;
    if (typeof event.type !== "string") {
      this.options.logger.debug("Ignoring SSE frame without a type", { frameEvent: frame.event });
      return;
    }
    this.lastEventAt = Date.now();
    this.options.onEvent(event);
  }

  private setConnected(connected: boolean, reconnected = false): void {
    if (this.connected === connected) {
      return;
    }
    this.connected = connected;
    try {
      this.options.onConnectionChange?.(connected, reconnected);
    } catch (error) {
      this.options.logger.warn("Connection callback failed", { error: errorMessage(error) });
    }
  }
}