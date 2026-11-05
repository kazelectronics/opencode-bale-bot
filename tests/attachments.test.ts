import { mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { BaleGateway } from "../src/bale/gateway.js";
import {
  AttachmentError,
  AttachmentService,
  attachmentPromptText,
  extensionForMime,
  formatBytes,
} from "../src/bridge/attachments.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/logger.js";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function config(dir: string, maxBytes = 1_000, ttlMs = 1_000): Config {
  return {
    bridge: { attachmentDir: dir, attachmentMaxBytes: maxBytes, attachmentTtlMs: ttlMs },
  } as unknown as Config;
}

function gateway(content: Buffer, fileSize?: number): BaleGateway {
  return {
    getFile: async () => ({
      fileId: "file-1",
      filePath: "files/a.txt",
      fileSize: fileSize ?? content.length,
      content,
    }),
  } as unknown as BaleGateway;
}

function message(extra: Record<string, unknown>) {
  return {
    message_id: 7,
    date: 0,
    chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false },
    ...extra,
  } as never;
}

describe("AttachmentService.mediaFromMessage", () => {
  const service = new AttachmentService({
    gateway: gateway(Buffer.from("x")),
    config: config("/tmp"),
    logger,
  });

  it("reads documents", () => {
    expect(
      service.mediaFromMessage(
        message({
          document: { file_id: "d1", file_name: "note.txt", mime_type: "text/plain", file_size: 4 },
        }),
      ),
    ).toEqual({
      fileId: "d1",
      filename: "note.txt",
      mimeType: "text/plain",
      fileSize: 4,
    });
  });

  it("picks the largest photo", () => {
    expect(
      service.mediaFromMessage(
        message({
          photo: [
            { file_id: "small", width: 10, height: 10, file_size: 1 },
            { file_id: "large", width: 100, height: 100, file_size: 9 },
          ],
        }),
      ),
    ).toEqual({
      fileId: "large",
      filename: "photo-7.jpg",
      mimeType: "image/jpeg",
      fileSize: 9,
    });
  });

  it("reads audio, voice, and video and ignores text", () => {
    expect(service.mediaFromMessage(message({ audio: { file_id: "a" } }))?.mimeType).toBe(
      "audio/mpeg",
    );
    expect(service.mediaFromMessage(message({ voice: { file_id: "v" } }))?.mimeType).toBe(
      "audio/ogg",
    );
    expect(service.mediaFromMessage(message({ video: { file_id: "m" } }))?.mimeType).toBe(
      "video/mp4",
    );
    expect(service.mediaFromMessage(message({ text: "hello" }))).toBeNull();
    expect(service.hasMedia(message({ text: "hello" }))).toBe(false);
  });
});

describe("AttachmentService.download", () => {
  it("writes the file and returns a file attachment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-attach-"));
    const service = new AttachmentService({ gateway: gateway(Buffer.from("hello")), config: config(dir), logger });
    const downloaded = await service.download(
      message({ document: { file_id: "d1", file_name: "note.txt", mime_type: "text/plain" } }),
      7,
    );

    expect(downloaded.file.name).toBe("note.txt");
    expect(downloaded.file.uri).toMatch(/^file:\/\//);
    expect(downloaded.bytes).toBe(5);
    expect(await readFile(new URL(downloaded.file.uri), "utf8")).toBe("hello");
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("rejects oversized and empty attachments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-attach-"));
    const oversized = new AttachmentService({
      gateway: gateway(Buffer.alloc(2_000)),
      config: config(dir),
      logger,
    });
    await expect(
      oversized.download(
        message({
          document: {
            file_id: "d1",
            file_name: "big.bin",
            mime_type: "application/octet-stream",
            file_size: 5_000,
          },
        }),
        7,
      ),
    ).rejects.toBeInstanceOf(AttachmentError);

    const empty = new AttachmentService({ gateway: gateway(Buffer.alloc(0)), config: config(dir), logger });
    await expect(
      empty.download(message({ document: { file_id: "d1", file_name: "empty.txt", mime_type: "text/plain" } }), 7),
    ).rejects.toBeInstanceOf(AttachmentError);
  });

  it("prunes files older than the TTL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-attach-"));
    await writeFile(join(dir, "old.txt"), "old");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, "old.txt"), old, old);
    await writeFile(join(dir, "new.txt"), "new");

    const service = new AttachmentService({ gateway: gateway(Buffer.from("x")), config: config(dir), logger });
    expect(await service.prune()).toBe(1);
    expect(await readdir(dir)).toEqual(["new.txt"]);
  });
});

describe("attachment helpers", () => {
  it("maps common MIME types to extensions", () => {
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("text/plain; charset=utf-8")).toBe(".txt");
    expect(extensionForMime("application/json")).toBe(".json");
    expect(extensionForMime("application/octet-stream")).toBe("");
  });

  it("formats byte counts", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2_048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("uses the caption or generates a prompt", () => {
    expect(attachmentPromptText("read this", "a.txt")).toBe("read this");
    expect(attachmentPromptText("   ", "a.txt")).toBe("Please look at the attached file `a.txt`.");
  });
});