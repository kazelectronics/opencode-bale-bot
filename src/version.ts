import { readFileSync } from "node:fs";

let cached: string | null = null;

/**
 * Read the version from package.json. dist/version.js and src/version.ts are
 * both one level below the package root, so the relative URL is stable.
 */
export function packageVersion(): string {
  if (cached) {
    return cached;
  }
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}