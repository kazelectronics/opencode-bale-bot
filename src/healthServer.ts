import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { HealthState } from "./health.js";
import { errorMessage, type Logger } from "./logger.js";

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly health: HealthState;
  readonly logger: Logger;
}

export interface HealthServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Loopback-only readiness endpoints. There is intentionally no write surface:
 * `GET /health`, `/health/live`, and `/health/ready` only read `HealthState`.
 */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const { host, health, logger } = options;
  const server = createServer((request, response) => {
    try {
      handle(request, response, health);
    } catch (error) {
      logger.warn("Health request failed", { error: errorMessage(error) });
      if (!response.headersSent) {
        writeJson(response, 500, { status: "error", error: "internal error" });
      } else {
        response.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, host);
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? options.port;
  logger.info("Health endpoint listening", {
    url: `http://${formatHost(host)}:${port}`,
    endpoints: ["/health", "/health/live", "/health/ready"],
  });

  return {
    host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Do not keep the event loop alive for idle keep-alive sockets.
        server.closeAllConnections?.();
      }),
  };
}

function handle(request: IncomingMessage, response: ServerResponse, health: HealthState): void {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    writeJson(response, 405, { status: "method_not_allowed" }, method === "HEAD");
    return;
  }

  const path = (request.url ?? "/").split("?")[0] ?? "/";
  const snapshot = health.snapshot();
  const body = {
    status: health.isReady() ? "ok" : "degraded",
    ready: health.isReady(),
    uptimeSeconds: Math.round((Date.now() - snapshot.startedAt) / 1_000),
    ...snapshot,
  };

  if (path === "/health/live" || path === "/livez") {
    writeJson(
      response,
      200,
      {
        status: "ok",
        uptimeSeconds: body.uptimeSeconds,
        pid: process.pid,
      },
      method === "HEAD",
    );
    return;
  }

  if (path === "/health/ready" || path === "/readyz") {
    writeJson(response, health.isReady() ? 200 : 503, body, method === "HEAD");
    return;
  }

  if (path === "/health" || path === "/healthz" || path === "/") {
    writeJson(response, 200, body, method === "HEAD");
    return;
  }

  writeJson(response, 404, { status: "not_found" }, method === "HEAD");
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headOnly = false,
): void {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(text));
  if (headOnly) {
    response.end();
    return;
  }
  response.end(text);
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}