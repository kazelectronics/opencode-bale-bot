import { describe, expect, it } from "vitest";

import { parseMenuCallback } from "../src/bridge/menus.js";

describe("parseMenuCallback", () => {
  it("parses model, agent, and follow buttons", () => {
    expect(parseMenuCallback("m:tok")).toEqual({ kind: "model", token: "tok" });
    expect(parseMenuCallback("a:tok")).toEqual({ kind: "agent", token: "tok" });
    expect(parseMenuCallback("fo:tok:y")).toEqual({
      kind: "follow",
      token: "tok",
      follow: true,
    });
    expect(parseMenuCallback("fo:tok:n")).toEqual({
      kind: "follow",
      token: "tok",
      follow: false,
    });
  });

  it("rejects malformed data and other prefixes", () => {
    expect(parseMenuCallback(undefined)).toBeNull();
    expect(parseMenuCallback("")).toBeNull();
    expect(parseMenuCallback("f:tok:o:1")).toBeNull();
    expect(parseMenuCallback("perm:tok:once")).toBeNull();
    expect(parseMenuCallback("m:")).toBeNull();
    expect(parseMenuCallback("fo:tok")).toBeNull();
    expect(parseMenuCallback("fo:tok:x")).toBeNull();
    expect(parseMenuCallback("q:tok")).toBeNull();
  });
});