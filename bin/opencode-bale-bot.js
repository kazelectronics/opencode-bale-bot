#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE = [22, 13, 0];
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

/**
 * Compare a Node version string against MIN_NODE.
 * Returns -1, 0, or 1.
 */
function compareNodeVersion(version) {
  const parts = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    const current = Number.isFinite(parts[index]) ? parts[index] : 0;
    const minimum = MIN_NODE[index];
    if (current > minimum) {
      return 1;
    }
    if (current < minimum) {
      return -1;
    }
  }
  return 0;
}

if (compareNodeVersion(process.versions.node) < 0) {
  process.stderr.write(
    `opencode-bale-bot requires Node.js ${MIN_NODE.join(".")} or newer because it uses node:sqlite.\n` +
      `You are running ${process.versions.node}. Install a current Node.js release from https://nodejs.org/ and try again.\n`,
  );
  process.exit(78);
}

const argv = process.argv.slice(2);
const command = argv[0];

if (command === "--version" || command === "-v" || command === "version") {
  process.stdout.write(`${pkg.name} ${pkg.version}\n`);
  process.exit(0);
}

// Load the CLI only after the version gate. dist/cli.js imports node:sqlite, so
// the check above must run before this dynamic import.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (caught) => {
    // A closed pipe (`... logs | head`) is not an error.
    if (caught && caught.code === "EPIPE") {
      process.exit(0);
    }
    throw caught;
  });
}

let runCli;
try {
  ({ runCli } = await import("../dist/cli.js"));
} catch (error) {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    process.stderr.write(
      "The compiled CLI is missing. Run `npm run build` in the package directory, or reinstall opencode-bale-bot.\n",
    );
    process.exit(1);
  }
  throw error;
}

process.exitCode = await runCli(argv);