export interface HealthProbe {
  readonly ok: boolean;
  readonly url: string;
  readonly status: number | null;
  readonly body: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface HealthProbeOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function healthUrl(host: string, port: number): string {
  return `http://${formatHost(host)}:${port}/health`;
}

/** Probe the loopback health endpoint without importing the daemon. */
export async function probeHealth(options: HealthProbeOptions): Promise<HealthProbe> {
  const url = healthUrl(options.host, options.port);
  const timeoutMs = options.timeoutMs ?? 1_500;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // A non-JSON body still tells us something is listening, but not what.
    }
    return {
      ok: response.ok && body !== null,
      url,
      status: response.status,
      body,
      error: body === null ? "health endpoint did not return JSON" : null,
    };
  } catch (error) {
    const name = (error as Error).name;
    const message =
      name === "AbortError" || name === "TimeoutError"
        ? `timed out after ${timeoutMs} ms`
        : (error as Error).message;
    return { ok: false, url, status: null, body: null, error: message };
  }
}