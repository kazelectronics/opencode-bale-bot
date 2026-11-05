import { spawn } from "node:child_process";

import { errorMessage, type Logger } from "../logger.js";

/** Spawn a detached shell command; failures are logged, not thrown. */
export function launchDetached(command: string, logger: Logger, label: string): void {
  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (error) => {
    logger.warn(`${label} command failed to launch`, { error: errorMessage(error) });
  });
  child.unref();
}

/** Run a shell command to completion, rejecting on a non-zero exit or timeout. */
export function runToCompletion(
  command: string,
  logger: Logger,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("command timed out"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      logger.warn(`${label} command failed`, { error: errorMessage(error) });
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGTERM") {
        resolve();
        return;
      }
      reject(new Error(`exit code ${code ?? "unknown"}`));
    });
  });
}