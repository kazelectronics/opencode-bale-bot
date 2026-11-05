import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface RotatingFileSinkOptions {
  readonly path: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
}

/**
 * Small synchronous append-only log sink with size-based rotation.
 *
 * The bridge emits one line at a time, so synchronous writes keep rotation
 * simple and atomic from the process's point of view. `maxFiles` counts the
 * current file, so `maxFiles: 5` keeps `bridge.log` plus `.1` … `.4`.
 */
export class RotatingFileSink {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private fd: number | null = null;
  private size = 0;
  private broken = false;

  constructor(options: RotatingFileSinkOptions) {
    this.path = options.path;
    this.maxBytes = Math.max(1, options.maxBytes);
    this.maxFiles = Math.max(1, options.maxFiles);
    mkdirSync(dirname(this.path), { recursive: true });
    this.open();
  }

  write(line: string): void {
    if (this.broken) {
      return;
    }
    const payload = `${line}\n`;
    const bytes = Buffer.byteLength(payload);
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        this.rotate();
      }
      if (this.fd === null) {
        this.open();
      }
      writeSync(this.fd as number, payload);
      this.size += bytes;
    } catch (error) {
      // Logging must never take the bridge down. Report once and stop writing
      // to the file; stdout still receives every line.
      this.broken = true;
      this.closeQuietly();
      process.stderr.write(
        `log file disabled after a write error (${this.path}): ${(error as Error).message}\n`,
      );
    }
  }

  close(): void {
    this.closeQuietly();
  }

  private open(): void {
    const fd = openSync(this.path, "a", 0o600);
    this.fd = fd;
    try {
      this.size = fstatSync(fd).size;
    } catch {
      this.size = 0;
    }
  }

  private rotate(): void {
    this.closeQuietly();
    const backups = this.maxFiles - 1;
    try {
      if (backups <= 0) {
        rmSync(this.path, { force: true });
      } else {
        rmSync(`${this.path}.${backups}`, { force: true });
        for (let index = backups - 1; index >= 1; index -= 1) {
          const from = `${this.path}.${index}`;
          if (existsSync(from)) {
            renameSync(from, `${this.path}.${index + 1}`);
          }
        }
        if (existsSync(this.path)) {
          renameSync(this.path, `${this.path}.1`);
        }
      }
    } finally {
      this.open();
    }
  }

  private closeQuietly(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed
      }
      this.fd = null;
    }
  }
}