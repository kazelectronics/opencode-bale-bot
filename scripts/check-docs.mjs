#!/usr/bin/env node
/**
 * Check the documentation set before a release.
 *
 * - every relative Markdown link resolves;
 * - every file in docs/ is reachable from docs/index.md;
 * - required public files exist.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const root = process.cwd();
const skipDirectories = new Set(["node_modules", "dist", "data", "coverage", ".git"]);
const problems = [];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) {
        files.push(...walk(full));
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function stripCode(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function linksIn(markdown) {
  const links = [];
  const inline = /(?<!\\)!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  const reference = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm;

  for (const match of markdown.matchAll(inline)) {
    links.push(match[1]);
  }
  for (const match of markdown.matchAll(reference)) {
    links.push(match[1]);
  }
  return links;
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);
}

function resolveLink(file, rawTarget) {
  const target = rawTarget.replace(/^<|>$/g, "").replace(/#.*$/, "");
  if (target === "") {
    return null;
  }
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Keep the raw value; it will fail the existence check with a useful name.
  }
  return resolve(dirname(file), decoded);
}

const markdownFiles = walk(root);

for (const file of markdownFiles) {
  const markdown = readFileSync(file, "utf8");
  const label = relative(root, file);

  for (const raw of linksIn(stripCode(markdown))) {
    if (isExternal(raw)) {
      continue;
    }
    const target = resolveLink(file, raw);
    if (target && !existsSync(target)) {
      problems.push(`${label}: broken link ${raw}`);
    }
  }
}

const required = [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/index.md",
];
for (const file of required) {
  if (!existsSync(join(root, file))) {
    problems.push(`missing required file: ${file}`);
  }
}

const docsIndex = join(root, "docs", "index.md");
if (existsSync(docsIndex)) {
  const index = readFileSync(docsIndex, "utf8");
  for (const entry of readdirSync(join(root, "docs"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
      continue;
    }
    if (!index.includes(entry.name)) {
      problems.push(`docs/${entry.name} is not linked from docs/index.md`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write("check-docs failed:\n");
  for (const problem of problems) {
    process.stderr.write(`  - ${problem}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `check-docs: ${markdownFiles.length} Markdown files checked from ${basename(root)}\n`,
);