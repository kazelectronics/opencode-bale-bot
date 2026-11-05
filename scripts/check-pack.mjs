#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const problems = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function check(condition, message) {
  if (!condition) {
    problems.push(message);
  }
}

const pkgPath = join(root, "package.json");
if (!existsSync(pkgPath)) {
  process.stderr.write("check-pack: package.json is missing\n");
  process.exit(1);
}
const pkg = readJson(pkgPath);

check(pkg.private !== true, "package.json still sets private: true");
check(pkg.name === "opencode-bale-bot", `unexpected package name: ${pkg.name}`);
check(pkg.license === "MIT", `package.json license must be MIT (found ${pkg.license})`);
check(
  typeof pkg.bin === "object" && pkg.bin["opencode-bale-bot"] === "bin/opencode-bale-bot.js",
  "package.json bin must map opencode-bale-bot to bin/opencode-bale-bot.js",
);
check(Array.isArray(pkg.files) && pkg.files.length > 0, "package.json must declare files");
check(pkg.engines?.node === ">=22.13", "package.json engines.node must be >=22.13");

const required = [
  "dist/cli.js",
  "dist/daemon.js",
  "dist/index.js",
  "bin/opencode-bale-bot.js",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
];
for (const file of required) {
  check(existsSync(join(root, file)), `missing required file: ${file}`);
}

const forbidden = ["src", "tests", "spike", "deploy", "data", ".env", ".bale-token"];
for (const entry of pkg.files ?? []) {
  const normalized = String(entry).replace(/^\.\//, "");
  for (const blocked of forbidden) {
    check(
      normalized !== blocked && !normalized.startsWith(`${blocked}/`),
      `package.json files must not include ${normalized}`,
    );
  }
}

const binPath = join(root, "bin/opencode-bale-bot.js");
if (existsSync(binPath)) {
  const firstLine = readFileSync(binPath, "utf8").split("\n")[0];
  check(firstLine === "#!/usr/bin/env node", "bin/opencode-bale-bot.js needs a node shebang");
}

if (problems.length > 0) {
  process.stderr.write("check-pack failed:\n");
  for (const problem of problems) {
    process.stderr.write(`  - ${problem}\n`);
  }
  process.exit(1);
}

// Write to stderr so `npm pack --silent` output stays a clean tarball name.
process.stderr.write(`check-pack: ${pkg.name}@${pkg.version} is ready to pack\n`);