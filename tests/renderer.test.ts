import { describe, expect, it } from "vitest";

import {
  renderFinal,
  renderLive,
  renderMarkdown,
  splitFences,
  transformInline,
  type RunUsage,
} from "../src/renderer.js";

const usage: RunUsage = {
  input: 3_503,
  output: 491,
  reasoning: 68,
  cacheRead: 5_120,
  cacheWrite: 0,
  cost: 0,
};

describe("renderMarkdown", () => {
  it("converts double Markdown emphasis to Bale emphasis", () => {
    expect(renderMarkdown("**bold** and __also bold__")).toBe("*bold* and *also bold*");
  });

  it("keeps single emphasis", () => {
    expect(renderMarkdown("a *bold* b and a _italic_ b")).toBe("a *bold* b and a _italic_ b");
  });

  it("does not italicise underscores inside words", () => {
    expect(renderMarkdown("snake_case_name stays literal")).toBe("snake_case_name stays literal");
  });

  it("wraps stray asterisks in inline code", () => {
    expect(renderMarkdown("2*3*4")).toBe("`2*3*4`");
  });

  it("preserves fenced code verbatim", () => {
    const input = "before\n```js\nconst a_b = 1 * 2;\nconsole.log(a_b);\n```\nafter";
    const output = renderMarkdown(input);
    expect(output).toContain("```js\nconst a_b = 1 * 2;\nconsole.log(a_b);\n```");
  });

  it("preserves inline code", () => {
    expect(renderMarkdown("use `const x = 1;` here")).toBe("use `const x = 1;` here");
  });

  it("preserves http links", () => {
    expect(renderMarkdown("[OpenCode docs](https://opencode.ai/docs/)")).toBe(
      "[OpenCode docs](https://opencode.ai/docs/)",
    );
  });

  it("flattens non-http links", () => {
    expect(renderMarkdown("[file](file:///etc/passwd)")).toBe("file");
  });

  it("converts headings to bold", () => {
    expect(renderMarkdown("## Summary")).toBe("*Summary*");
  });

  it("flattens tables", () => {
    const input = "| Name | Value |\n| --- | --- |\n| a | 1 |";
    expect(renderMarkdown(input)).toBe("Name · Value\n\na · 1");
  });

  it("converts star bullets so they cannot open emphasis", () => {
    expect(renderMarkdown("* first\n* second")).toBe("• first\n• second");
  });

  it("strips HTML tags but keeps the text", () => {
    expect(renderMarkdown("hello <b>world</b><br>next")).toBe("hello world\nnext");
  });

  it("uses a longer fence when the code contains backticks", () => {
    const output = renderMarkdown("````\n```\n```");
    expect(output.startsWith("````")).toBe(true);
  });
});

describe("transformInline", () => {
  it("leaves no unmatched backtick", () => {
    expect(transformInline("a ` b")).toBe("a ′ b");
  });

  it("does not treat edge underscores as emphasis when there is no pair", () => {
    expect(transformInline("__init__")).toBe("`__init__`");
  });
});

describe("splitFences", () => {
  it("marks an unclosed fence as open", () => {
    const segments = splitFences("hello\n```js\nconst x = 1;");
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({ kind: "code", closed: false });
  });
});

describe("renderLive", () => {
  it("shows a working label with an activity", () => {
    expect(renderLive("", { limit: 100, activity: "⏳ shell · ls" })).toBe(
      "⏳ Working…\n_⏳ shell · ls_",
    );
  });

  it("hides a partial code block", () => {
    const output = renderLive("hello\n```js\nconst x = 1;", { limit: 500 });
    expect(output).not.toContain("const x = 1;");
    expect(output).toContain("writing code");
  });

  it("renders completed text", () => {
    expect(renderLive("**done**", { limit: 500 })).toBe("*done*");
  });

  it("keeps the tail of long output", () => {
    const input = `${"a".repeat(200)}\n${"b".repeat(200)}`;
    const output = renderLive(input, { limit: 100 });
    expect(output.startsWith("…")).toBe(true);
    expect(output.length).toBeLessThanOrEqual(100);
  });
});

describe("renderFinal", () => {
  it("appends a footer to a short answer", () => {
    const output = renderFinal({
      markdown: "**hello**",
      outcome: "succeeded",
      model: "bailian-cli/deepseek-v4.1-flash-1017",
      durationMs: 4_200,
      usage,
      limit: 3_900,
    });
    expect(output.kind).toBe("text");
    if (output.kind === "text") {
      expect(output.text).toContain("*hello*");
      expect(output.text).toContain("bailian-cli/deepseek-v4.1-flash-1017");
      expect(output.text).toContain("3.5k in / 491 out");
      expect(output.text).toContain("68 reasoning");
      expect(output.text).toContain("$0");
      expect(output.text).toContain("4.2s");
    }
  });

  it("uses a document for long output", () => {
    const output = renderFinal({
      markdown: "x".repeat(4_000),
      outcome: "succeeded",
      limit: 3_900,
      sessionId: "ses_abc123456789",
      now: new Date("2026-11-05T12:00:00Z"),
    });
    expect(output.kind).toBe("document");
    if (output.kind === "document") {
      expect(output.filename).toBe("opencode-23456789-20261105-120000.md");
      expect(output.mimeType).toContain("text/markdown");
      expect(output.caption).toContain("4,000");
    }
  });

  it("reports failed runs", () => {
    const output = renderFinal({
      markdown: "",
      outcome: "failed",
      error: "RegionError: this model is not available",
      limit: 3_900,
    });
    expect(output.kind).toBe("text");
    if (output.kind === "text") {
      expect(output.text).toContain("Run failed");
      expect(output.text).toContain("RegionError");
    }
  });

  it("reports interrupted runs", () => {
    const output = renderFinal({
      markdown: "partial answer",
      outcome: "interrupted",
      limit: 3_900,
    });
    expect(output.kind).toBe("text");
    if (output.kind === "text") {
      expect(output.text).toContain("Stopped");
      expect(output.text).toContain("partial answer");
    }
  });
});