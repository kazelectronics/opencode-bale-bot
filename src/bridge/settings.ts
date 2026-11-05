import type { InlineKeyboardMarkup } from "@erfanvahabpour/bale-bot-sdk";

import type { Config } from "../config.js";
import type { ChatRepo, ChatRow, SettingsRepo, ChatSettings } from "../db.js";
import {
  LOCALES,
  LOCALE_LABELS,
  isLocale,
  normalizeLocale,
  t,
  type Locale,
  type MessageKey,
  type MessageParams,
} from "../i18n.js";
import { errorMessage, type Logger } from "../logger.js";
import type { BaleGateway } from "../bale/gateway.js";
import type { Outbox } from "../bale/outbox.js";
import { answerCallback } from "./ui.js";

export interface SettingsDashboardHooks {
  enable(chat: ChatRow): Promise<void>;
  disable(chat: ChatRow): Promise<void>;
}

export interface SettingsManagerOptions {
  readonly gateway: BaleGateway;
  readonly chats: ChatRepo;
  readonly settings: SettingsRepo;
  readonly config: Config;
  readonly outbox: Outbox;
  readonly logger: Logger;
}

export type SettingsCallback =
  | { readonly kind: "language"; readonly locale: Locale }
  | { readonly kind: "progress" }
  | { readonly kind: "thinking" }
  | { readonly kind: "footer" }
  | { readonly kind: "dashboard" }
  | { readonly kind: "diff" }
  | { readonly kind: "queue" }
  | { readonly kind: "reset" };

export function parseSettingsCallback(data: string | undefined): SettingsCallback | null {
  if (!data || !data.startsWith("set:")) {
    return null;
  }
  const parts = data.split(":");
  const action = parts[1] ?? "";
  if (action === "l") {
    const locale = parts[2] ?? "";
    return isLocale(locale) ? { kind: "language", locale } : null;
  }
  if (action === "p") return { kind: "progress" };
  if (action === "t") return { kind: "thinking" };
  if (action === "f") return { kind: "footer" };
  if (action === "d") return { kind: "dashboard" };
  if (action === "x") return { kind: "diff" };
  if (action === "q") return { kind: "queue" };
  if (action === "r") return { kind: "reset" };
  return null;
}

export class SettingsManager {
  private readonly options: SettingsManagerOptions;
  private dashboard: SettingsDashboardHooks | null = null;

  constructor(options: SettingsManagerOptions) {
    this.options = options;
  }

  setDashboard(hooks: SettingsDashboardHooks | null): void {
    this.dashboard = hooks;
  }

  settingsFor(chatId: string): ChatSettings {
    return this.options.settings.get(chatId);
  }

  locale(chatId: string): Locale {
    return normalizeLocale(this.options.settings.get(chatId).locale);
  }

  t(chatId: string, key: MessageKey, params?: MessageParams): string {
    return t(this.locale(chatId), key, params);
  }

  /** Queue behavior: a per-chat override, otherwise the chat's delivery mode. */
  queueBehavior(chat: ChatRow): "queue" | "steer" {
    const stored = this.options.settings.get(chat.chat_id).queue_behavior;
    if (stored) {
      return stored;
    }
    return chat.delivery === "steer" ? "steer" : "queue";
  }

  async show(chat: ChatRow, messageId?: number): Promise<void> {
    const text = this.render(chat);
    const keyboard = this.keyboard(chat);
    const outbox = this.options.outbox.forChat(chat.chat_id);
    if (messageId !== undefined) {
      const edited = await outbox.editNow(messageId, text, { replyMarkup: keyboard });
      if (edited) {
        return;
      }
    }
    try {
      await outbox.send(text, { replyMarkup: keyboard });
    } catch (error) {
      this.options.logger.warn("Could not send the settings panel", {
        chatId: chat.chat_id,
        error: errorMessage(error),
      });
    }
  }

  async language(chat: ChatRow, argument?: string): Promise<void> {
    if (!argument) {
      const list = LOCALES.join("|");
      await this.reply(chat.chat_id, t(this.locale(chat.chat_id), "language.usage", { locales: list }));
      return;
    }
    const value = argument.trim().toLowerCase();
    if (!isLocale(value)) {
      const list = LOCALES.join("|");
      await this.reply(chat.chat_id, t(this.locale(chat.chat_id), "language.usage", { locales: list }));
      return;
    }
    this.options.settings.patch(chat.chat_id, { locale: value });
    await this.reply(
      chat.chat_id,
      t(value, "language.set", { language: LOCALE_LABELS[value] }),
    );
  }

  async handleCallback(input: {
    readonly chatId: string;
    readonly callbackQueryId: string;
    readonly data: string | undefined;
    readonly messageId?: number;
  }): Promise<void> {
    const parsed = parseSettingsCallback(input.data);
    const chat = this.options.chats.get(input.chatId);
    if (!parsed || !chat) {
      await answerCallback(
        this.options.gateway,
        input.callbackQueryId,
        "This button is no longer valid.",
        this.options.logger,
      );
      return;
    }

    const { settings, chats } = this.options;
    const current = settings.get(chat.chat_id);

    switch (parsed.kind) {
      case "language":
        settings.patch(chat.chat_id, { locale: parsed.locale });
        break;
      case "progress":
        settings.patch(chat.chat_id, {
          progress_style: current.progress_style === "normal" ? "compact" : "normal",
        });
        break;
      case "thinking":
        settings.patch(chat.chat_id, { show_thinking: !current.show_thinking });
        break;
      case "footer":
        settings.patch(chat.chat_id, { show_footer: !current.show_footer });
        break;
      case "diff":
        settings.patch(chat.chat_id, { diff_attachments: !current.diff_attachments });
        break;
      case "queue": {
        const next = this.queueBehavior(chat) === "queue" ? "steer" : "queue";
        settings.patch(chat.chat_id, { queue_behavior: next });
        chats.update(chat.chat_id, { delivery: next });
        break;
      }
      case "dashboard": {
        const enabling = !current.pinned_dashboard;
        settings.patch(chat.chat_id, { pinned_dashboard: enabling });
        if (enabling) {
          await this.dashboard?.enable(chat);
        } else {
          await this.dashboard?.disable(chat);
        }
        break;
      }
      case "reset":
        if (current.pinned_dashboard) {
          await this.dashboard?.disable(chat);
        }
        settings.reset(chat.chat_id);
        chats.update(chat.chat_id, { delivery: this.options.config.bridge.delivery });
        break;
    }

    const updated = chats.get(chat.chat_id) ?? chat;
    const nextSettings = settings.get(chat.chat_id);
    const locale = normalizeLocale(nextSettings.locale);
    const toast =
      parsed.kind === "language"
        ? t(locale, "settings.language_updated", { language: LOCALE_LABELS[parsed.locale] })
        : parsed.kind === "dashboard"
          ? t(
              locale,
              nextSettings.pinned_dashboard
                ? "settings.dashboard_on"
                : "settings.dashboard_off",
            )
          : parsed.kind === "queue"
            ? t(locale, "settings.queue_updated", {
                mode:
                  this.queueBehavior(updated) === "steer"
                    ? t(locale, "settings.queue.steer")
                    : t(locale, "settings.queue.queue"),
              })
            : parsed.kind === "reset"
              ? t(locale, "settings.reset_done")
              : t(locale, "settings.updated");
    await answerCallback(this.options.gateway, input.callbackQueryId, toast, this.options.logger);

    const text = this.render(updated);
    const keyboard = this.keyboard(updated);
    if (input.messageId !== undefined) {
      const edited = await this.options.outbox
        .forChat(updated.chat_id)
        .editNow(input.messageId, text, { replyMarkup: keyboard });
      if (edited) {
        return;
      }
    }
    try {
      await this.options.outbox.forChat(updated.chat_id).send(text, { replyMarkup: keyboard });
    } catch (error) {
      this.options.logger.warn("Could not refresh the settings panel", {
        chatId: updated.chat_id,
        error: errorMessage(error),
      });
    }
  }

  private render(chat: ChatRow): string {
    const current = this.options.settings.get(chat.chat_id);
    const locale = normalizeLocale(current.locale);
    const on = (value: boolean): string => t(locale, value ? "common.on" : "common.off");
    const queue = this.queueBehavior(chat);
    const progress =
      current.progress_style === "compact"
        ? t(locale, "settings.progress.compact")
        : t(locale, "settings.progress.normal");
    return [
      t(locale, "settings.title"),
      "",
      `_${t(locale, "settings.subtitle")}_`,
      "",
      `*${t(locale, "settings.language")}:* ${LOCALE_LABELS[locale]}`,
      `*${t(locale, "settings.progress")}:* ${progress}`,
      `*${t(locale, "settings.thinking")}:* ${on(current.show_thinking)}`,
      `*${t(locale, "settings.footer")}:* ${on(current.show_footer)}`,
      `*${t(locale, "settings.dashboard")}:* ${on(current.pinned_dashboard)}`,
      `*${t(locale, "settings.diff")}:* ${on(current.diff_attachments)}`,
      `*${t(locale, "settings.queue")}:* ${
        queue === "steer" ? t(locale, "settings.queue.steer") : t(locale, "settings.queue.queue")
      }`,
    ].join("\n");
  }

  private keyboard(chat: ChatRow): InlineKeyboardMarkup {
    const current = this.options.settings.get(chat.chat_id);
    const locale = normalizeLocale(current.locale);
    const on = (value: boolean): string => t(locale, value ? "common.on" : "common.off");
    const progress =
      current.progress_style === "compact"
        ? t(locale, "settings.progress.compact")
        : t(locale, "settings.progress.normal");
    const queue =
      this.queueBehavior(chat) === "steer"
        ? t(locale, "settings.queue.steer")
        : t(locale, "settings.queue.queue");
    return {
      inline_keyboard: [
        LOCALES.map((code) => ({
          text: `${code === locale ? "✅ " : ""}${LOCALE_LABELS[code]}`,
          callback_data: `set:l:${code}`,
        })),
        [
          { text: `${t(locale, "settings.progress")}: ${progress}`, callback_data: "set:p" },
          { text: `${t(locale, "settings.thinking")}: ${on(current.show_thinking)}`, callback_data: "set:t" },
        ],
        [
          { text: `${t(locale, "settings.footer")}: ${on(current.show_footer)}`, callback_data: "set:f" },
          { text: `${t(locale, "settings.dashboard")}: ${on(current.pinned_dashboard)}`, callback_data: "set:d" },
        ],
        [
          { text: `${t(locale, "settings.diff")}: ${on(current.diff_attachments)}`, callback_data: "set:x" },
          { text: `${t(locale, "settings.queue")}: ${queue}`, callback_data: "set:q" },
        ],
        [{ text: t(locale, "settings.reset"), callback_data: "set:r" }],
      ],
    };
  }

  private async reply(chatId: string, text: string): Promise<void> {
    try {
      await this.options.outbox.forChat(chatId).send(text);
    } catch (error) {
      this.options.logger.warn("Could not send a settings reply", {
        chatId,
        error: errorMessage(error),
      });
    }
  }
}