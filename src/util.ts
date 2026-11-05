export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function backoffDelay(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0s";
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatRelative(timestampMs: number, now = Date.now()): string {
  const delta = now - timestampMs;
  if (!Number.isFinite(delta)) {
    return "unknown";
  }
  if (delta < 30_000) {
    return "just now";
  }
  return `${formatDuration(delta)} ago`;
}

export function truncate(value: string, max: number, suffix = "…"): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}