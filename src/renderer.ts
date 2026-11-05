/**
 * Bale Markdown renderer.
 *
 * Bale parses every message as Markdown and has no parse_mode. Live behavior
 * confirms fenced code, bold, italic, inline code, and links. This module
 * converts agent Markdown into that subset and neutralizes anything that could
 * be misread as markup. It does not rely on backslash escapes.
 */

const FENCE = "```";

interface TextSegment {
  readonly kind: "text";
  readonly text: string;
}

interface CodeSegment {
  readonly kind: "code";
  readonly language: string;
  readonly code: string;
  readonly closed: boolean;
}

type Segment = TextSegment | CodeSegment;

export interface FinalRenderOptions {
  readonly markdown: string;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly error?: string;
  readonly model?: string;
  readonly durationMs?: number;
  readonly usage?: RunUsage;
  readonly limit: number;
  readonly sessionId?: string;
  readonly now?: Date;
  /** When false, the run footer is omitted. */
  readonly showFooter?: boolean;
}

export interface RunUsage {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

export type RenderedFinal =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "document";
      readonly text: string;
      readonly caption: string;
      readonly filename: string;
      readonly mimeType: string;
    };

export interface LiveRenderOptions {
  readonly limit: number;
  readonly workingLabel?: string;
  readonly activity?: string;
}

export function splitFences(input: string): Segment[] {
  const text = input.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let buffer: string[] = [];

  const flushText = (): void => {
    if (buffer.length > 0) {
      segments.push({ kind: "text", text: buffer.join("\n") });
      buffer = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const open = /^ {0,3}```(.*)$/.exec(line);
    if (!open) {
      buffer.push(line);
      continue;
    }

    flushText();
    const language = (open[1] ?? "").trim();
    const codeLines: string[] = [];
    let closed = false;
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const current = lines[cursor] ?? "";
      if (/^ {0,3}```[ \t]*$/.test(current)) {
        closed = true;
        break;
      }
      codeLines.push(current);
    }
    segments.push({
      kind: "code",
      language,
      code: codeLines.join("\n"),
      closed,
    });
    index = cursor;
  }

  flushText();
  return segments;
}

export function renderCodeBlock(segment: CodeSegment): string {
  const longest = longestBacktickRun(segment.code);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${segment.language}\n${segment.code}\n${fence}`;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

export function renderMarkdown(input: string): string {
  const segments = splitFences(input);
  const rendered: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "code") {
      rendered.push(renderCodeBlock(segment));
    } else {
      rendered.push(renderTextBlock(segment.text));
    }
  }
  return tidy(rendered.join("\n\n"));
}

function renderTextBlock(text: string): string {
  const cleaned = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "");
  const lines = cleaned.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    output.push(renderLine(line));
  }
  return output.join("\n");
}

function renderLine(line: string): string {
  const trimmed = line.trim();

  if (trimmed === "") {
    return "";
  }

  // Drop Markdown table separator rows.
  if (isTableSeparator(trimmed)) {
    return "";
  }

  if (isHorizontalRule(trimmed)) {
    return "────────";
  }

  const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
  if (heading) {
    const content = transformInline((heading[2] ?? "").trim());
    return content ? `*${content}*` : "";
  }

  const quote = /^(>+)\s?(.*)$/.exec(line);
  if (quote) {
    const depth = Math.min(2, (quote[1] ?? ">").length);
    const marker = depth > 1 ? "»" : "›";
    return `${marker} ${transformInline(quote[2] ?? "")}`;
  }

  if (isTableRow(trimmed)) {
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => transformInline(cell.trim()))
      .filter((cell) => cell.length > 0);
    return cells.join(" · ");
  }

  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) {
    const checked = (task[2] ?? "").toLowerCase() === "x";
    return `${task[1] ?? ""}${checked ? "☑" : "☐"} ${transformInline(task[3] ?? "")}`;
  }

  const list = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (list) {
    return `${list[1] ?? ""}• ${transformInline(list[2] ?? "")}`;
  }

  return transformInline(line);
}

function isTableSeparator(line: string): boolean {
  return /^\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(line) && /[-:]/.test(line);
}

function isTableRow(line: string): boolean {
  return line.includes("|") && (line.startsWith("|") || line.includes(" | "));
}

function isHorizontalRule(line: string): boolean {
  return /^([-*_])(?:\s*\1){2,}$/.test(line);
}

type Token =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "plain"; readonly value: string };

/**
 * Converts inline Markdown into Bale's supported subset. Literal asterisks and
 * underscores that are not valid emphasis are wrapped in inline code.
 */
export function transformInline(input: string, depth = 0): string {
  if (depth > 4) {
    return escapePlain(input);
  }

  const tokens: Token[] = [];
  let plain = "";
  let index = 0;

  const pushPlain = (value: string): void => {
    plain += value;
  };
  const flushPlain = (): void => {
    if (plain.length > 0) {
      tokens.push({ kind: "plain", value: plain });
      plain = "";
    }
  };
  const pushLiteral = (value: string): void => {
    flushPlain();
    tokens.push({ kind: "literal", value });
  };

  while (index < input.length) {
    const char = input[index] ?? "";

    // Dunder identifiers such as __init__ and __name__ would otherwise be read
    // as bold by Bale. Wrap them in inline code so they render literally.
    if (char === "_" && input.startsWith("__", index) && !isWordChar(input[index - 1])) {
      const dunder = /^__[A-Za-z0-9_]*__/.exec(input.slice(index));
      if (dunder) {
        pushLiteral(`\`${dunder[0]}\``);
        index += dunder[0].length;
        continue;
      }
    }

    if (char === "`") {
      const runLength = countRun(input, index, "`");
      const run = "`".repeat(runLength);
      const close = input.indexOf(run, index + runLength);
      if (close >= 0) {
        pushLiteral(input.slice(index, close + runLength));
        index = close + runLength;
        continue;
      }
      // An unmatched backtick would open a code span in Bale. Use a prime.
      pushPlain("′");
      index += runLength;
      continue;
    }

    if (char === "!" && input[index + 1] === "[") {
      const image = readLink(input, index + 1);
      if (image) {
        const label = transformInline(image.label, depth + 1);
        const value = /^https?:\/\//i.test(image.url)
          ? `${label} (${image.url})`
          : label || image.url;
        pushPlain(value);
        index = image.end;
        continue;
      }
    }

    if (char === "[") {
      const link = readLink(input, index);
      if (link) {
        if (/^https?:\/\//i.test(link.url)) {
          const label = link.label.length > 0 ? link.label : link.url;
          pushLiteral(`[${label}](${link.url})`);
        } else {
          pushPlain(link.label || link.url);
        }
        index = link.end;
        continue;
      }
    }

    if (input.startsWith("**", index)) {
      const close = findEmphasisClose(input, index + 2, "**");
      if (close > index + 2) {
        const inner = input.slice(index + 2, close);
        if (!inner.includes("\n")) {
          pushLiteral(`*${transformInline(inner, depth + 1)}*`);
          index = close + 2;
          continue;
        }
      }
    }

    if (input.startsWith("__", index)) {
      const prev = input[index - 1];
      if (!isWordChar(prev)) {
        const close = findEmphasisClose(input, index + 2, "__", true);
        if (close > index + 2) {
          const inner = input.slice(index + 2, close);
          // Dunder identifiers such as __init__ and __name__ are far more
          // common in agent output than double-underscore bold. Only convert
          // when the content clearly reads as prose.
          if (!inner.includes("\n") && /\s/.test(inner)) {
            pushLiteral(`*${transformInline(inner, depth + 1)}*`);
            index = close + 2;
            continue;
          }
        }
      }
    }

    if (char === "*") {
      const close = findEmphasisClose(input, index + 1, "*");
      if (close > index + 1 && !isWordChar(input[index - 1])) {
        const inner = input.slice(index + 1, close);
        if (!inner.includes("\n")) {
          pushLiteral(`*${transformInline(inner, depth + 1)}*`);
          index = close + 1;
          continue;
        }
      }
    }

    if (char === "_") {
      const close = findEmphasisClose(input, index + 1, "_", true);
      if (close > index + 1 && !isWordChar(input[index - 1])) {
        const inner = input.slice(index + 1, close);
        if (!inner.includes("\n")) {
          pushLiteral(`_${transformInline(inner, depth + 1)}_`);
          index = close + 1;
          continue;
        }
      }
    }

    pushPlain(char);
    index += 1;
  }

  flushPlain();
  return tokens
    .map((token) => (token.kind === "literal" ? token.value : escapePlain(token.value)))
    .join("");
}

function findEmphasisClose(
  input: string,
  from: number,
  delimiter: string,
  avoidWordEnd = false,
): number {
  let cursor = from;
  while (cursor < input.length) {
    const found = input.indexOf(delimiter, cursor);
    if (found < 0) {
      return -1;
    }
    const prev = input[found - 1];
    const next = input[found + delimiter.length];
    if (prev !== undefined && !/\s/.test(prev) && !isWordChar(next)) {
      if (!avoidWordEnd || !isWordChar(next)) {
        return found;
      }
    }
    cursor = found + 1;
  }
  return -1;
}

function readLink(
  input: string,
  start: number,
): { label: string; url: string; end: number } | null {
  if (input[start] !== "[") {
    return null;
  }
  const labelEnd = input.indexOf("]", start + 1);
  if (labelEnd < 0 || input[labelEnd + 1] !== "(") {
    return null;
  }
  const urlEnd = input.indexOf(")", labelEnd + 2);
  if (urlEnd < 0) {
    return null;
  }
  const label = input.slice(start + 1, labelEnd);
  const url = input.slice(labelEnd + 2, urlEnd).trim();
  if (!url) {
    return null;
  }
  return { label, url, end: urlEnd + 1 };
}

function countRun(input: string, index: number, char: string): number {
  let cursor = index;
  while (input[cursor] === char) {
    cursor += 1;
  }
  return cursor - index;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

function escapePlain(value: string): string {
  return value.replace(/\S+/g, (word) => {
    const cleaned = word.replace(/`/g, "′");
    const hasAsterisk = cleaned.includes("*");
    const hasEdgeUnderscore = cleaned.includes("_") && !/^[A-Za-z0-9_]+$/.test(cleaned);
    const hasBoldUnderscores = /^_+.*_+$/.test(cleaned);
    if (hasAsterisk || hasEdgeUnderscore || hasBoldUnderscores) {
      return `\`${cleaned}\``;
    }
    return cleaned;
  });
}

export function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Removes an unterminated code fence and its partial body. */
export function stripOpenFence(input: string): { text: string; open: boolean } {
  const segments = splitFences(input);
  const last = segments[segments.length - 1];
  if (last?.kind === "code" && !last.closed) {
    const withoutLast = segments.slice(0, -1);
    const text = withoutLast
      .map((segment) =>
        segment.kind === "code" ? renderCodeBlock(segment) : renderTextBlock(segment.text),
      )
      .join("\n\n");
    return { text: tidy(text), open: true };
  }
  return { text: input, open: false };
}

export function renderLive(markdown: string, options: LiveRenderOptions): string {
  const activity = options.activity?.trim();
  const working = `⏳ ${options.workingLabel ?? "Working"}…`;

  if (markdown.trim() === "") {
    return activity ? `${working}\n_${escapeStatus(activity)}_` : working;
  }

  const stripped = stripOpenFence(markdown);
  let rendered = renderMarkdown(stripped.text);

  if (stripped.open) {
    rendered = rendered ? `${rendered}\n\n_… writing code …_` : "⏳ Writing code…";
  }

  if (rendered.length > options.limit) {
    rendered = truncateTail(rendered, options.limit);
  }

  return rendered || working;
}

export function renderFinal(options: FinalRenderOptions): RenderedFinal {
  const body = renderMarkdown(options.markdown);
  const footer = options.showFooter === false ? "" : renderFooter(options);

  let content: string;
  if (options.outcome === "failed") {
    const message = options.error?.trim() || "Unknown error";
    content = `❌ *Run failed*\n\n${escapeStatus(message)}`;
    if (body) {
      content += `\n\n${body}`;
    }
  } else if (options.outcome === "interrupted") {
    content = body ? `⏹ *Stopped*\n\n${body}` : "⏹ *Stopped*";
  } else {
    content = body || "✅ *Done* (no text output)";
  }

  const withFooter = footer ? `${content}\n\n${footer}` : content;

  if (withFooter.length <= options.limit) {
    return { kind: "text", text: withFooter };
  }

  const now = options.now ?? new Date();
  return {
    kind: "document",
    text: `${content}\n\n${footer}`,
    caption: body
      ? `📄 Full response attached (${options.markdown.length.toLocaleString("en-US")} characters).`
      : "📄 Run output attached.",
    filename: documentFilename(options.sessionId, now),
    mimeType: "text/markdown; charset=utf-8",
  };
}

export function renderFooter(options: {
  readonly model?: string;
  readonly durationMs?: number;
  readonly usage?: RunUsage;
}): string {
  const parts: string[] = [];
  if (options.model) {
    parts.push(options.model);
  }
  if (options.usage) {
    const input = compactNumber(options.usage.input);
    const output = compactNumber(options.usage.output);
    parts.push(`${input} in / ${output} out`);
    if (options.usage.reasoning > 0) {
      parts.push(`${compactNumber(options.usage.reasoning)} reasoning`);
    }
    parts.push(formatCost(options.usage.cost));
  }
  if (options.durationMs !== undefined && options.durationMs >= 0) {
    parts.push(formatDurationShort(options.durationMs));
  }
  if (parts.length === 0) {
    return "";
  }
  return `—\n_${parts.join(" · ")}_`;
}

function documentFilename(sessionId: string | undefined, now: Date): string {
  const short = (sessionId ?? "session").replace(/^ses_/, "").slice(-8) || "session";
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "-",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  return `opencode-${short}-${stamp}.md`;
}

function truncateTail(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  let slice = text.slice(text.length - limit);
  const firstNewline = slice.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < 200) {
    slice = slice.slice(firstNewline + 1);
  }
  // Drop a leading closing fence left over from cutting into a code block.
  const fences = (slice.match(/```/g) ?? []).length;
  if (fences % 2 === 1) {
    const first = slice.indexOf("```");
    if (first >= 0) {
      const nextLine = slice.indexOf("\n", first + 3);
      slice = nextLine >= 0 ? slice.slice(nextLine + 1) : "";
    }
  }
  return `…\n${slice}`.slice(0, limit);
}

function escapeStatus(value: string): string {
  return transformInline(value.replace(/\n{3,}/g, "\n\n"));
}

function compactNumber(value: number): string {
  if (value < 1_000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost === 0) {
    return "$0";
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

function formatDurationShort(ms: number): string {
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}