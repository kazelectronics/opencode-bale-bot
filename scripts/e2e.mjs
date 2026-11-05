#!/usr/bin/env node
/**
 * End-to-end smoke test for the public product contract.
 *
 * It starts a mock Bale API and a mock OpenCode server, runs the real CLI
 * (setup, doctor, start, status, stop), sends one /help update, and asserts a
 * reply was produced. CI runs this after `npm run build`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "dist", "cli.js");
const token = "123456:test-token";
const userId = "123456789";

const logs = [];
const sentMessages = [];
let deliveredUpdate = false;

function log(message) {
  logs.push(message);
  process.stdout.write(`${message}\n`);
}

function json(response, body, status = 200) {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(text);
}

function readBody(request) {
  return new Promise((resolvePromise) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      if (!data) {
        resolvePromise({});
        return;
      }
      const contentType = String(request.headers["content-type"] ?? "");
      if (contentType.includes("application/x-www-form-urlencoded")) {
        resolvePromise(Object.fromEntries(new URLSearchParams(data).entries()));
        return;
      }
      try {
        resolvePromise(JSON.parse(data));
      } catch {
        resolvePromise({});
      }
    });
  });
}

function parseParams(request, body) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const params = Object.fromEntries(url.searchParams.entries());
  return { ...params, ...body };
}

async function startBaleMock() {
  const server = createServer(async (request, response) => {
    const path = (request.url ?? "").split("?")[0];
    const body = await readBody(request);
    const params = parseParams(request, body);

    if (path.endsWith("/getMe")) {
      json(response, {
        ok: true,
        result: { id: 999, is_bot: true, first_name: "Mock bridge", username: "mock_bridge_bot" },
      });
      return;
    }
    if (path.endsWith("/deleteWebhook")) {
      json(response, { ok: true, result: true });
      return;
    }
    if (path.endsWith("/getUpdates")) {
      const offset = Number(params.offset ?? 0);
      if (offset === -1 || deliveredUpdate) {
        json(response, { ok: true, result: [] });
        return;
      }
      deliveredUpdate = true;
      json(response, {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 1,
              date: Math.floor(Date.now() / 1000),
              from: { id: Number(userId), is_bot: false, first_name: "Owner" },
              chat: { id: Number(userId), type: "private" },
              text: "/help",
            },
          },
        ],
      });
      return;
    }
    if (path.endsWith("/sendMessage")) {
      sentMessages.push(params);
      json(response, {
        ok: true,
        result: {
          message_id: 10,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(userId), type: "private" },
          text: params.text ?? "",
        },
      });
      return;
    }
    if (path.endsWith("/sendChatAction") || path.endsWith("/editMessageText")) {
      json(response, { ok: true, result: true });
      return;
    }
    if (path.endsWith("/answerCallbackQuery")) {
      json(response, { ok: true, result: true });
      return;
    }
    json(response, { ok: true, result: true });
  });
  await listen(server);
  return server;
}

async function startOpenCodeMock() {
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === "/api/info") {
      json(response, { version: "2.2.5" });
      return;
    }
    if (path === "/openapi.json") {
      json(response, { paths: {} });
      return;
    }
    if (path === "/api/model") {
      json(response, [
        { id: "model", modelID: "model", providerID: "provider", name: "Mock", enabled: true },
      ]);
      return;
    }
    if (path === "/api/agent") {
      json(response, [{ id: "build", name: "Build", mode: "primary", hidden: false }]);
      return;
    }
    if (path === "/api/event") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-store");
      response.write(": mock\n\n");
      return;
    }
    if (path === "/api/session/active") {
      json(response, []);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await listen(server);
  return server;
}

function listen(server) {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
}

function portOf(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no server address");
  }
  return address.port;
}

async function freePort() {
  const server = createServer();
  const port = await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise(address && typeof address !== "string" ? address.port : 0);
    });
  });
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

async function waitFor(description, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function runCli(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function main() {
  if (!existsSync(cli)) {
    throw new Error(`${cli} is missing; run npm run build first`);
  }

  const bale = await startBaleMock();
  const opencode = await startOpenCodeMock();
  const balePort = portOf(bale);
  const opencodePort = portOf(opencode);
  const healthPort = await freePort();

  const home = mkdtempSync(join(tmpdir(), "opencode-bale-e2e-"));
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const tokenFile = join(home, "token.txt");
  const passwordFile = join(home, "password.txt");
  const configPath = join(home, "config.json");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  writeFileSync(passwordFile, "opencode-password\n", { mode: 0o600 });

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    BALE_API_BASE_URL: `http://127.0.0.1:${balePort}/bot`,
  };

  log(`Setup: ${configPath}`);
  const setup = await runCli(
    [
      "setup",
      "--non-interactive",
      "--config",
      configPath,
      "--token-file",
      tokenFile,
      "--user-id",
      userId,
      "--opencode-url",
      `http://127.0.0.1:${opencodePort}`,
      "--opencode-username",
      "opencode",
      "--opencode-password-file",
      passwordFile,
      "--model",
      "provider/model",
      "--agent",
      "build",
      "--project",
      project,
      "--health-port",
      String(healthPort),
    ],
    env,
  );
  if (setup.status !== 0) {
    throw new Error(`setup failed (${setup.status}): ${setup.stdout}\n${setup.stderr}`);
  }
  log("Setup: ok");

  const doctor = await runCli(["doctor", "--config", configPath, "--json"], env);
  if (doctor.status !== 0) {
    throw new Error(`doctor failed (${doctor.status}): ${doctor.stdout}\n${doctor.stderr}`);
  }
  log("Doctor: ok");

  const daemonLogs = [];
  const daemon = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", cli, "start", "--config", configPath],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  daemon.stdout.on("data", (chunk) => daemonLogs.push(chunk.toString()));
  daemon.stderr.on("data", (chunk) => daemonLogs.push(chunk.toString()));

  try {
    await waitFor("the health endpoint", async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${healthPort}/health/live`, {
          signal: AbortSignal.timeout(1_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    });
    log("Health: ok");

    await waitFor("the daemon to become ready", async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${healthPort}/health/ready`, {
          signal: AbortSignal.timeout(1_000),
        });
        const body = await response.json();
        return body.pollerRunning === true && body.opencodeReachable === true;
      } catch {
        return false;
      }
    });
    log("Ready: ok");

    const status = await runCli(["status", "--config", configPath, "--json"], env);
    if (status.status !== 0) {
      throw new Error(`status failed (${status.status}): ${status.stdout}\n${status.stderr}`);
    }
    const statusBody = JSON.parse(status.stdout);
    if (statusBody.pid !== daemon.pid) {
      throw new Error(`status pid ${statusBody.pid} does not match daemon pid ${daemon.pid}`);
    }
    log("Status: ok");

    await waitFor("a /help reply", () => sentMessages.length > 0, 25_000);
    log(`Reply: ${sentMessages[0].text.split("\n")[0]}`);

    daemon.kill("SIGTERM");
    const exitCode = await new Promise((resolvePromise) => {
      daemon.once("exit", (code) => resolvePromise(code));
      setTimeout(() => resolvePromise(null), 20_000);
    });
    if (exitCode !== 0) {
      throw new Error(`daemon exited with ${exitCode}`);
    }
    if (existsSync(join(home, ".local", "state", "opencode-bale-bot", "bridge.lock"))) {
      throw new Error("the lock file was not removed on shutdown");
    }
    log("Shutdown: ok");
  } catch (error) {
    process.stderr.write(`\nDaemon logs:\n${daemonLogs.join("")}\n`);
    throw error;
  } finally {
    daemon.kill("SIGKILL");
    bale.closeAllConnections?.();
    opencode.closeAllConnections?.();
    bale.close();
    opencode.close();
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.opencode.password) {
    throw new Error("the OpenCode password was stored inline even though a file was supplied");
  }
  log("E2E: all checks passed");
}

main().catch((error) => {
  process.stderr.write(`E2E failed: ${error.stack ?? error.message}\n`);
  process.exit(1);
});