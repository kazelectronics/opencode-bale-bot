import { describe, expect, it } from "vitest";

import { SseParser } from "../src/opencode/events.js";

describe("SseParser", () => {
  it("parses a complete frame", () => {
    const parser = new SseParser();
    const frames = parser.push('event: message\ndata: {"type":"x"}\n\n');
    expect(frames).toEqual([{ event: "message", data: '{"type":"x"}' }]);
  });

  it("waits for the frame terminator across chunks", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"type":"ses')).toEqual([]);
    expect(parser.push('sion.text.delta"}\n')).toEqual([]);
    expect(parser.push("\n")).toEqual([
      { data: '{"type":"session.text.delta"}' },
    ]);
  });

  it("skips heartbeat comments", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
    expect(parser.push(": keep-alive\n\ndata: {}\n\n")).toEqual([{ data: "{}" }]);
  });

  it("joins multiple data lines with a newline", () => {
    const parser = new SseParser();
    const frames = parser.push("data: line one\ndata: line two\n\n");
    expect(frames).toEqual([{ data: "line one\nline two" }]);
  });

  it("handles CRLF terminators and ids", () => {
    const parser = new SseParser();
    const frames = parser.push('id: 7\r\ndata: {"ok":true}\r\n\r\n');
    expect(frames).toEqual([{ id: "7", data: '{"ok":true}' }]);
  });

  it("parses several frames from one chunk", () => {
    const parser = new SseParser();
    const frames = parser.push("data: 1\n\ndata: 2\n\n");
    expect(frames.map((frame) => frame.data)).toEqual(["1", "2"]);
  });

  it("ignores frames without data", () => {
    const parser = new SseParser();
    expect(parser.push("event: ping\n\n")).toEqual([]);
  });
});