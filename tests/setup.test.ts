import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runDoctor } from "../src/doctor.js";
import { runSetup } from "../src/setup.js";
import { EXIT } from "../src/exit.js";

const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeAllConnections?.();
        }),
    ),
  );
});

function json(response: import("node:http").ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(text);
}

async function startBaleMock(): Promise<number> {
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    if (path.endsWith("/getMe")) {
      json(response, {
        ok: true,
        result: { id: 42, is_bot: true, first_name: "Bridge", username: "bridge_bot" },
      });
      return;
    }
    if (path.includes("/getUpdates")) {
      json(response, { ok: true, result: [] });
      return;
    }
    json(response, { ok: true, result: true });
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  return address.port;
}

async function startOpenCodeMock(): Promise<number> {
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === "/api/info") {
      json(response, { version: "2.2.5" });
      return;
    }
    if (path === "/api/model") {
      json(response, [
        {
          id: "model",
          modelID: "model",
          providerID: "provider",
          name: "Mock model",
          enabled: true,
        },
      ]);
      return;
    }
    if (path === "/api/agent") {
      json(response, [{ id: "build", name: "Build", mode: "primary", hidden: false }]);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no address");
  }
  return address.port;
}

describe("setup and doctor integration", () => {
  it("configures non-interactively and passes doctor against mock servers", async () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-setup-"));
    const project = join(home, "project");
    const tokenFile = join(home, "token.txt");
    const passwordFile = join(home, "password.txt");
    const configPath = join(home, "config.json");
    writeFileSync(tokenFile, "123:secret\n", { mode: 0o600 });
    writeFileSync(passwordFile, "pw\n", { mode: 0o600 });
    mkdirSync(project, { recursive: true });

    const balePort = await startBaleMock();
    const opencodePort = await startOpenCodeMock();

    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv("XDG_STATE_HOME", join(home, ".local", "state"));
    vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"));
    vi.stubEnv("BALE_API_BASE_URL", `http://127.0.0.1:${balePort}/bot`);

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const setupCode = await runSetup({
      flags: {
        config: configPath,
        "non-interactive": true,
        "token-file": tokenFile,
        "user-id": "123456789",
        "opencode-url": `http://127.0.0.1:${opencodePort}`,
        "opencode-username": "opencode",
        "opencode-password-file": passwordFile,
        model: "provider/model",
        agent: "build",
        project,
        "health-port": "0",
      },
    });
    expect(setupCode).toBe(EXIT.OK);

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      configVersion: number;
      bale: { tokenFile: string; allowedUserId: string; baseUrl: string };
      opencode: { model: string; agent: string; passwordFile: string };
      bridge: { healthPort: number };
    };
    expect(config.configVersion).toBe(1);
    expect(config.bale.tokenFile).toBe(tokenFile);
    expect(config.bale.allowedUserId).toBe("123456789");
    expect(config.bale.baseUrl).toBe(`http://127.0.0.1:${balePort}/bot`);
    expect(config.opencode.model).toBe("provider/model");
    expect(config.opencode.passwordFile).toBe(passwordFile);
    expect(config.bridge.healthPort).toBe(0);

    const doctorCode = await runDoctor({ flags: { config: configPath, json: true } });
    expect(doctorCode).toBe(EXIT.OK);
  });
});