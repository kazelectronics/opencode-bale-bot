import type { Config } from "../config.js";
import type { ChatRepo } from "../db.js";
import type { HealthState } from "../health.js";
import { errorMessage, type Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { sleep } from "../util.js";
import type { Outbox } from "../bale/outbox.js";
import { launchDetached } from "./processControl.js";

export interface OpenCodeMonitorOptions {
  readonly client: OpenCodeClient;
  readonly health: HealthState;
  readonly chats: ChatRepo;
  readonly outbox: Outbox;
  readonly config: Config;
  readonly logger: Logger;
}

/**
 * Periodic OpenCode reachability probe. When enabled, a run of consecutive
 * failures runs `OPENCODE_START_COMMAND` and waits for `/api/info`, with
 * exponential backoff and a manual-stop override from `/opencode_stop`.
 */
export class OpenCodeMonitor {
  private readonly options: OpenCodeMonitorOptions;
  private timer: NodeJS.Timeout | null = null;
  private probing = false;
  private failures = 0;
  private manualStopped = false;
  private restarting = false;
  private backoffMs: number;
  private lastRestartAt = 0;

  constructor(options: OpenCodeMonitorOptions) {
    this.options = options;
    this.backoffMs = options.config.opencode.restartCooldownMs;
  }

  get autoRestartEnabled(): boolean {
    return (
      this.options.config.opencode.autoRestart &&
      Boolean(this.options.config.opencode.startCommand)
    );
  }

  start(): void {
    if (this.timer) {
      return;
    }
    if (this.options.config.opencode.autoRestart && !this.options.config.opencode.startCommand) {
      this.options.logger.warn(
        "OPENCODE_AUTO_RESTART is on but OPENCODE_START_COMMAND is not set; automatic restart is disabled",
      );
    }
    void this.probeNow();
    this.timer = setInterval(() => {
      void this.probeNow();
    }, this.options.config.opencode.healthCheckMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  noteManualStart(): void {
    this.manualStopped = false;
    this.failures = 0;
    this.backoffMs = this.options.config.opencode.restartCooldownMs;
  }

  noteManualStop(): void {
    this.manualStopped = true;
  }

  async probeNow(): Promise<boolean> {
    if (this.probing) {
      return this.options.health.opencodeReachable === true;
    }
    this.probing = true;
    try {
      try {
        const info = await this.options.client.info();
        this.options.health.setOpenCode(true, { version: info.version });
        if (this.failures >= this.options.config.opencode.restartFailures) {
          this.options.logger.info("OpenCode is reachable again", { version: info.version });
        }
        this.failures = 0;
        this.backoffMs = this.options.config.opencode.restartCooldownMs;
        return true;
      } catch (error) {
        const message = errorMessage(error);
        this.options.health.setOpenCode(false, { error: message });
        if (this.manualStopped) {
          this.options.logger.debug("OpenCode is stopped manually; skipping auto-restart", {
            error: message,
          });
          return false;
        }
        this.failures += 1;
        this.options.logger.warn("OpenCode health check failed", {
          failures: this.failures,
          error: message,
        });
        if (this.shouldRestart()) {
          await this.restart();
        }
        return false;
      }
    } finally {
      this.probing = false;
    }
  }

  private shouldRestart(): boolean {
    if (!this.autoRestartEnabled || this.manualStopped || this.restarting) {
      return false;
    }
    if (this.failures < this.options.config.opencode.restartFailures) {
      return false;
    }
    return Date.now() - this.lastRestartAt >= this.backoffMs;
  }

  private async restart(): Promise<void> {
    const command = this.options.config.opencode.startCommand;
    if (!command) {
      return;
    }
    this.restarting = true;
    this.lastRestartAt = Date.now();
    this.options.health.restarting = true;
    this.options.health.restartCount += 1;
    this.options.logger.warn("Restarting OpenCode after health-check failure", {
      attempt: this.options.health.restartCount,
      backoffMs: this.backoffMs,
    });
    await this.notifyAll(
      `🔄 *OpenCode is unreachable.*\n\n_Restarting automatically. The bridge will report the result here._`,
    );

    try {
      launchDetached(command, this.options.logger, "OpenCode auto-restart");
    } catch (error) {
      this.options.logger.error("Could not launch the OpenCode auto-restart command", {
        error: errorMessage(error),
      });
    }

    const deadline = Date.now() + this.options.config.opencode.restartTimeoutMs;
    let version: string | null = null;
    while (Date.now() < deadline) {
      await sleep(1_000);
      try {
        const info = await this.options.client.info();
        version = info.version;
        break;
      } catch {
        // keep polling
      }
    }

    if (version) {
      this.failures = 0;
      this.backoffMs = this.options.config.opencode.restartCooldownMs;
      this.options.health.setOpenCode(true, { version });
      this.options.logger.info("OpenCode restarted automatically", {
        version,
        attempt: this.options.health.restartCount,
      });
      await this.notifyAll(
        `✅ *OpenCode is reachable again.*\n\nVersion \`${version}\` after automatic restart.`,
      );
    } else {
      this.backoffMs = Math.min(
        this.options.config.opencode.restartMaxCooldownMs,
        this.backoffMs * 2,
      );
      this.options.logger.error("Automatic OpenCode restart failed", {
        attempt: this.options.health.restartCount,
        nextBackoffMs: this.backoffMs,
      });
      await this.notifyAll(
        `❌ *Automatic OpenCode restart failed.*\n\n_Retrying with backoff; /opencode_start can run the command manually._`,
      );
    }
    this.restarting = false;
    this.options.health.restarting = false;
  }

  private async notifyAll(text: string): Promise<void> {
    for (const chat of this.options.chats.list()) {
      try {
        await this.options.outbox.forChat(chat.chat_id).send(text);
      } catch (error) {
        this.options.logger.debug("Could not send an OpenCode lifecycle notice", {
          chatId: chat.chat_id,
          error: errorMessage(error),
        });
      }
    }
  }
}