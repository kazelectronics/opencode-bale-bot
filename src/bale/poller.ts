import type { Update } from "@erfanvahabpour/bale-bot-sdk";

import type { MetaRepo, ProcessedUpdatesRepo, PromptIdRepo } from "../db.js";
import { errorMessage, type Logger } from "../logger.js";
import { backoffDelay, sleep } from "../util.js";
import { rateLimitDelayMs, type BaleGateway } from "./gateway.js";

export const BALE_UPDATE_OFFSET_KEY = "bale_update_offset";

export interface BalePollerOptions {
  readonly gateway: BaleGateway;
  readonly meta: MetaRepo;
  readonly processed: ProcessedUpdatesRepo;
  readonly promptIds: PromptIdRepo;
  readonly logger: Logger;
  readonly limit: number;
  readonly timeoutSec: number;
  readonly onUpdate: (update: Update) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface PollerSnapshot {
  readonly running: boolean;
  readonly offset: number;
  readonly lastPollAt: number | null;
  readonly lastUpdateAt: number | null;
  readonly lastError: string | null;
}

export class BalePoller {
  private readonly options: BalePollerOptions;
  private readonly controller = new AbortController();
  private offset = 0;
  private lastPollAt: number | null = null;
  private lastUpdateAt: number | null = null;
  private lastError: string | null = null;
  private running = false;
  private loops = 0;

  constructor(options: BalePollerOptions) {
    this.options = options;
    if (options.signal) {
      if (options.signal.aborted) {
        this.stop();
      } else {
        options.signal.addEventListener("abort", () => this.stop(), { once: true });
      }
    }
  }

  snapshot(): PollerSnapshot {
    return {
      running: this.running,
      offset: this.offset,
      lastPollAt: this.lastPollAt,
      lastUpdateAt: this.lastUpdateAt,
      lastError: this.lastError,
    };
  }

  stop(): void {
    this.controller.abort();
  }

  async run(): Promise<void> {
    const { gateway, logger, meta, processed } = this.options;
    this.running = true;

    try {
      await gateway.deleteWebhook();
      logger.info("Bale webhook removed; long polling enabled");
    } catch (error) {
      logger.warn("deleteWebhook failed; continuing with long polling", {
        error: errorMessage(error),
      });
    }

    this.offset = meta.getNumber(BALE_UPDATE_OFFSET_KEY) ?? (await this.skipBacklog());
    logger.info("Bale polling starting", { offset: this.offset });

    processed.prune();
    this.options.promptIds.prune();

    while (!this.controller.signal.aborted) {
      try {
        const updates = await gateway.getUpdates({
          offset: this.offset,
          limit: this.options.limit,
          timeout: this.options.timeoutSec,
          signal: this.controller.signal,
        });
        this.lastPollAt = Date.now();
        this.lastError = null;
        this.loops += 1;

        for (const update of updates) {
          if (this.controller.signal.aborted) {
            break;
          }
          await this.handleUpdate(update);
        }

        if (this.loops % 300 === 0) {
          processed.prune();
          this.options.promptIds.prune();
        }
      } catch (error) {
        if (this.controller.signal.aborted) {
          break;
        }
        this.lastError = errorMessage(error);
        const retryAfter = rateLimitDelayMs(error);
        const delay = retryAfter ?? backoffDelay(this.loops + 1);
        logger.warn("Bale getUpdates failed; retrying", {
          error: this.lastError,
          retryInMs: delay,
        });
        try {
          await sleep(delay, this.controller.signal);
        } catch {
          break;
        }
      }
    }

    this.running = false;
    logger.info("Bale polling stopped", { offset: this.offset });
  }

  private async handleUpdate(update: Update): Promise<void> {
    const { processed, meta, logger } = this.options;
    const updateId = update.update_id;
    if (!Number.isInteger(updateId)) {
      logger.warn("Ignoring update without a numeric update_id", { update });
      return;
    }

    if (processed.has(updateId)) {
      this.advance(updateId);
      meta.set(BALE_UPDATE_OFFSET_KEY, String(this.offset));
      return;
    }

    try {
      await this.options.onUpdate(update);
    } catch (error) {
      logger.error("Update handler failed", {
        updateId,
        type: update.type,
        error: errorMessage(error),
      });
    }

    processed.mark(updateId);
    this.lastUpdateAt = Date.now();
    this.advance(updateId);
    meta.set(BALE_UPDATE_OFFSET_KEY, String(this.offset));
  }

  private advance(updateId: number): void {
    this.offset = Math.max(this.offset, updateId + 1);
  }

  private async skipBacklog(): Promise<number> {
    const { gateway, meta, logger } = this.options;
    try {
      const tail = await gateway.getUpdates({
        offset: -1,
        limit: 1,
        timeout: 0,
        signal: this.controller.signal,
      });
      const highest = tail.reduce(
        (max, update) => Math.max(max, Number(update.update_id) || 0),
        0,
      );
      const offset = highest > 0 ? highest + 1 : 0;
      meta.set(BALE_UPDATE_OFFSET_KEY, String(offset));
      logger.info("Skipped stale Bale backlog", { offset, tailUpdates: tail.length });
      return offset;
    } catch (error) {
      logger.warn("Tail fetch failed; starting from offset 0", {
        error: errorMessage(error),
      });
      meta.set(BALE_UPDATE_OFFSET_KEY, "0");
      return 0;
    }
  }
}