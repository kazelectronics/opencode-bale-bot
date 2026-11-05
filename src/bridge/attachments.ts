import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Message } from "@erfanvahabpour/bale-bot-sdk";

import type { BaleGateway } from "../bale/gateway.js";
import type { Config } from "../config.js";
import { errorMessage, type Logger } from "../logger.js";
import type { PromptFileAttachment } from "../opencode/types.js";

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface DownloadedAttachment {
  readonly file: PromptFileAttachment;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
}

export interface AttachmentServiceOptions {
  readonly gateway: BaleGateway;
  readonly config: Config;
  readonly logger: Logger;
}

interface MediaSource {
  readonly fileId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly fileSize?: number;
}

export class AttachmentService {
  private readonly options: AttachmentServiceOptions;

  constructor(options: AttachmentServiceOptions) {
    this.options = options;
  }

  mediaFromMessage(message: Message): MediaSource | null {
    if (message.document) {
      const document = message.document;
      return {
        fileId: document.file_id,
        filename: document.file_name ?? `document-${message.message_id}`,
        mimeType: document.mime_type ?? "application/octet-stream",
        ...(document.file_size !== undefined ? { fileSize: document.file_size } : {}),
      };
    }

    if (message.photo && message.photo.length > 0) {
      const largest = [...message.photo].sort(
        (a, b) =>
          b.width * b.height - a.width * a.height ||
          (b.file_size ?? 0) - (a.file_size ?? 0),
      )[0];
      if (largest) {
        return {
          fileId: largest.file_id,
          filename: `photo-${message.message_id}.jpg`,
          mimeType: "image/jpeg",
          ...(largest.file_size !== undefined ? { fileSize: largest.file_size } : {}),
        };
      }
    }

    if (message.audio) {
      return {
        fileId: message.audio.file_id,
        filename: message.audio.file_name ?? `audio-${message.message_id}.mp3`,
        mimeType: message.audio.mime_type ?? "audio/mpeg",
        ...(message.audio.file_size !== undefined ? { fileSize: message.audio.file_size } : {}),
      };
    }

    if (message.voice) {
      return {
        fileId: message.voice.file_id,
        filename: `voice-${message.message_id}.ogg`,
        mimeType: message.voice.mime_type ?? "audio/ogg",
        ...(message.voice.file_size !== undefined ? { fileSize: message.voice.file_size } : {}),
      };
    }

    if (message.video) {
      return {
        fileId: message.video.file_id,
        filename: message.video.file_name ?? `video-${message.message_id}.mp4`,
        mimeType: message.video.mime_type ?? "video/mp4",
        ...(message.video.file_size !== undefined ? { fileSize: message.video.file_size } : {}),
      };
    }

    return null;
  }

  hasMedia(message: Message): boolean {
    return this.mediaFromMessage(message) !== null;
  }

  async download(
    message: Message,
    updateId: number,
  ): Promise<DownloadedAttachment> {
    const media = this.mediaFromMessage(message);
    if (!media) {
      throw new AttachmentError("This message has no downloadable attachment.");
    }

    const maxBytes = this.options.config.bridge.attachmentMaxBytes;
    if (media.fileSize !== undefined && media.fileSize > maxBytes) {
      throw new AttachmentError(
        `The attachment is ${formatBytes(media.fileSize)}; the limit is ${formatBytes(maxBytes)}.`,
      );
    }

    let downloaded;
    try {
      downloaded = await this.options.gateway.getFile(media.fileId);
    } catch (error) {
      this.options.logger.warn("Attachment download failed", {
        fileId: media.fileId,
        error: errorMessage(error),
      });
      throw new AttachmentError("Could not download that attachment from Bale.");
    }

    if (downloaded.content.length === 0) {
      throw new AttachmentError("The attachment is empty.");
    }
    if (downloaded.content.length > maxBytes) {
      throw new AttachmentError(
        `The attachment is ${formatBytes(downloaded.content.length)}; the limit is ${formatBytes(maxBytes)}.`,
      );
    }

    const directory = this.options.config.bridge.attachmentDir;
    await mkdir(directory, { recursive: true });
    const filename = uniqueFilename(media.filename, media.mimeType, updateId);
    const path = join(directory, filename);
    await writeFile(path, downloaded.content, { mode: 0o600 });

    return {
      file: {
        uri: pathToFileURL(path).href,
        name: safeDisplayName(media.filename, media.mimeType),
        description: "Uploaded from Bale",
      },
      filename,
      mimeType: media.mimeType,
      bytes: downloaded.content.length,
    };
  }

  /** Deletes attachment files older than the configured TTL. */
  async prune(now = Date.now()): Promise<number> {
    const directory = this.options.config.bridge.attachmentDir;
    const cutoff = now - this.options.config.bridge.attachmentTtlMs;
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      try {
        const info = await stat(path);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await unlink(path);
          removed += 1;
        }
      } catch (error) {
        this.options.logger.debug("Could not inspect an attachment for pruning", {
          path,
          error: errorMessage(error),
        });
      }
    }
    return removed;
  }
}

function uniqueFilename(original: string, mimeType: string, updateId: number): string {
  const safe = safeDisplayName(original, mimeType);
  const extension = extname(safe);
  const stem = (extension ? safe.slice(0, -extension.length) : safe)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  const suffix = randomBytes(4).toString("hex");
  return `${updateId}-${stem || "attachment"}-${suffix}${extension.toLowerCase()}`;
}

function safeDisplayName(original: string, mimeType: string): string {
  const base = basename(original.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (base.length > 0) {
    return base.slice(0, 120);
  }
  return `attachment${extensionForMime(mimeType)}`;
}

export function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "text/csv":
      return ".csv";
    case "application/json":
      return ".json";
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    default:
      return "";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentPromptText(caption: string | undefined, filename: string): string {
  const trimmed = caption?.trim();
  if (trimmed) {
    return trimmed;
  }
  return `Please look at the attached file \`${filename}\`.`;
}