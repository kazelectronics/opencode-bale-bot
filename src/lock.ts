import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

import { packageVersion } from "./version.js";

export interface LockInfo {
  readonly pid: number;
  /** Wall-clock time (ms) when the lock was acquired. */
  readonly startedAt: number;
  /** Random token that distinguishes two runs that reused the same PID. */
  readonly instance: string;
  readonly version: string;
  /** OS process-start token used to detect PID reuse, when available. */
  readonly procStart: string | null;
}

export interface ProcessLock {
  readonly path: string;
  readonly info: LockInfo;
  release(): void;
}

export class LockError extends Error {
  readonly path: string;
  readonly pid: number | null;

  constructor(path: string, pid: number | null) {
    super(
      pid === null
        ? `Another bridge instance holds the lock at ${path}`
        : `Another bridge instance is already running (pid ${pid}) with the lock at ${path}`,
    );
    this.name = "LockError";
    this.path = path;
    this.pid = pid;
  }
}

export function readProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close === -1) {
        return null;
      }
      const fields = stat.slice(close + 2).split(" ");
      // Field 22 in proc(5); the slice above starts at field 3.
      const starttime = fields[19];
      if (!starttime) {
        return null;
      }
      let bootId = "";
      try {
        bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      } catch {
        // Not available in every container.
      }
      return `${bootId}:${starttime}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (result.status !== 0 || !result.stdout) {
      return null;
    }
    return result.stdout.trim();
  }
  return null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parse the lock file. Returns null when it is absent or unreadable. */
export function readLock(path: string): LockInfo | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "") {
      return null;
    }
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as Partial<LockInfo>;
      if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
        return null;
      }
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
        instance: typeof parsed.instance === "string" ? parsed.instance : "",
        version: typeof parsed.version === "string" ? parsed.version : "",
        procStart: typeof parsed.procStart === "string" ? parsed.procStart : null,
      };
    }
    // Legacy lock: `<pid>\n<iso timestamp>`.
    const [pidLine, timestamp] = raw.split("\n");
    const pid = Number(pidLine);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    return {
      pid,
      startedAt: timestamp ? Date.parse(timestamp) || 0 : 0,
      instance: "",
      version: "",
      procStart: null,
    };
  } catch {
    return null;
  }
}

export type LockOwnership = "valid" | "mismatch" | "unknown" | "dead";

/**
 * Decide whether a lock still belongs to the process that wrote it. A PID alone
 * is not enough: operating systems reuse PIDs. When the OS start token is
 * missing, callers should also require a health probe carrying the instance.
 */
export function verifyLockOwnership(info: LockInfo): LockOwnership {
  if (!isProcessAlive(info.pid)) {
    return "dead";
  }
  const current = readProcessStartToken(info.pid);
  if (info.procStart && current) {
    return info.procStart === current ? "valid" : "mismatch";
  }
  return "unknown";
}

export function acquireLock(path: string): ProcessLock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const tryCreate = (): ProcessLock => {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = readLock(path);
        if (existing && (existing.procStart || isProcessAlive(existing.pid))) {
          const ownership = verifyLockOwnership(existing);
          if (ownership === "valid" || ownership === "unknown") {
            throw new LockError(path, existing.pid);
          }
        }
        // Dead or reused PID: remove the stale lock and retry once.
        try {
          unlinkSync(path);
        } catch {
          // Another process may have removed it first.
        }
        return tryCreate();
      }
      throw error;
    }

    const info: LockInfo = {
      pid: process.pid,
      startedAt: Date.now(),
      instance: randomUUID(),
      version: packageVersion(),
      procStart: readProcessStartToken(process.pid),
    };
    writeFileSync(fd, `${JSON.stringify(info)}\n`);
    try {
      // Older Node versions do not fsync through writeFileSync; the lock is a
      // single small record and the rename-free create is atomic enough.
      closeSync(fd);
    } catch {
      // The write already happened.
    }
    return { path, info, release: () => releaseLock(path) };
  };

  return tryCreate();
}

/** Remove a stale lock only when the recorded process is not alive. */
export function removeStaleLock(path: string): boolean {
  const info = readLock(path);
  if (!info) {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }
  if (isProcessAlive(info.pid)) {
    return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(path: string): void {
  const info = readLock(path);
  if (info !== null && info.pid !== process.pid) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

export function lockFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}