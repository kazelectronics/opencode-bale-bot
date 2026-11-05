#!/usr/bin/env node
/**
 * Check the licenses of production dependencies.
 *
 * The project ships under MIT, so every runtime dependency must be
 * redistributable under a permissive license. Copyleft and unknown licenses
 * fail the check; add an entry here only after reviewing the obligation.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const allowed = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-4-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
]);

const tree = JSON.parse(
  execFileSync("npm", ["ls", "--omit=dev", "--json", "--all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
);

const problems = [];
const seen = new Set();

function visit(name, node) {
  if (!node || seen.has(`${name}@${node.version}`)) {
    return;
  }
  seen.add(`${name}@${node.version}`);

  const packagePath = join("node_modules", name, "package.json");
  let license;
  try {
    license = JSON.parse(readFileSync(packagePath, "utf8")).license;
  } catch {
    problems.push(`${name}@${node.version}: package.json is unreadable`);
    return;
  }

  if (typeof license !== "string" || !allowed.has(license)) {
    problems.push(`${name}@${node.version}: license ${license ?? "(none)"} is not allowed`);
  }

  for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
    visit(childName, child);
  }
}

for (const [name, node] of Object.entries(tree.dependencies ?? {})) {
  visit(name, node);
}

if (problems.length > 0) {
  process.stderr.write("check-licenses failed:\n");
  for (const problem of problems) {
    process.stderr.write(`  - ${problem}\n`);
  }
  process.exit(1);
}

process.stdout.write(`check-licenses: ${seen.size} production package(s) checked\n`);