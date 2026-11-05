export interface HealthSnapshot {
  readonly pid: number;
  readonly instance: string;
  readonly version: string;
  readonly startedAt: number;
  readonly botId: string | null;
  readonly botUsername: string | null;
  readonly opencodeVersion: string | null;
  readonly opencodeUrl: string;
  readonly opencodeReachable: boolean | null;
  readonly opencodeCheckedAt: number | null;
  readonly opencodeError: string | null;
  readonly restarting: boolean;
  readonly restartCount: number;
  readonly sseConnected: boolean;
  readonly sseLastEventAt: number | null;
  readonly pollerRunning: boolean;
  readonly lastPollAt: number | null;
  readonly lastUpdateAt: number | null;
  readonly pollerError: string | null;
  readonly tasksActive: number;
  readonly tasksRunning: number;
}

export class HealthState {
  readonly pid = process.pid;
  readonly instance: string;
  readonly version: string;
  readonly startedAt = Date.now();
  botId: string | null = null;
  botUsername: string | null = null;
  opencodeVersion: string | null = null;
  readonly opencodeUrl: string;
  opencodeReachable: boolean | null = null;
  opencodeCheckedAt: number | null = null;
  opencodeError: string | null = null;
  restarting = false;
  restartCount = 0;
  sseConnected = false;
  sseLastEventAt: number | null = null;
  pollerRunning = false;
  lastPollAt: number | null = null;
  lastUpdateAt: number | null = null;
  pollerError: string | null = null;
  tasksActive = 0;
  tasksRunning = 0;

  constructor(
    opencodeUrl: string,
    options: { readonly instance?: string; readonly version?: string } = {},
  ) {
    this.opencodeUrl = opencodeUrl;
    this.instance = options.instance ?? "";
    this.version = options.version ?? "";
  }

  setOpenCode(ok: boolean, options: { version?: string | null; error?: string | null } = {}): void {
    this.opencodeReachable = ok;
    this.opencodeCheckedAt = Date.now();
    if (ok) {
      this.opencodeError = null;
      if (options.version) {
        this.opencodeVersion = options.version;
      }
    } else {
      this.opencodeError = options.error ?? "unreachable";
    }
  }

  /**
   * Ready means the bridge can accept and execute prompts: OpenCode answers and
   * the Bale poller is consuming updates. SSE is reported but not required,
   * because the bridge resyncs over REST.
   */
  isReady(): boolean {
    return this.opencodeReachable === true && this.pollerRunning;
  }

  snapshot(): HealthSnapshot {
    return {
      pid: this.pid,
      instance: this.instance,
      version: this.version,
      startedAt: this.startedAt,
      botId: this.botId,
      botUsername: this.botUsername,
      opencodeVersion: this.opencodeVersion,
      opencodeUrl: this.opencodeUrl,
      opencodeReachable: this.opencodeReachable,
      opencodeCheckedAt: this.opencodeCheckedAt,
      opencodeError: this.opencodeError,
      restarting: this.restarting,
      restartCount: this.restartCount,
      sseConnected: this.sseConnected,
      sseLastEventAt: this.sseLastEventAt,
      pollerRunning: this.pollerRunning,
      lastPollAt: this.lastPollAt,
      lastUpdateAt: this.lastUpdateAt,
      pollerError: this.pollerError,
      tasksActive: this.tasksActive,
      tasksRunning: this.tasksRunning,
    };
  }
}