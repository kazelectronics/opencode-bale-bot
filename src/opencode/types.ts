export interface OpenCodeInfo {
  readonly version: string;
  readonly pid?: number;
  readonly hostname?: string;
  readonly urls?: readonly string[];
  readonly paths?: { readonly tmp?: string };
  readonly capabilities?: Record<string, unknown>;
}

export interface OpenCodeTokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}

export interface OpenCodeModelRef {
  readonly id: string;
  readonly providerID: string;
  readonly variant?: string;
}

export interface OpenCodeSession {
  readonly id: string;
  readonly projectID: string;
  readonly title: string;
  readonly agent?: string;
  readonly model?: OpenCodeModelRef;
  readonly cost: number;
  readonly tokens: OpenCodeTokens;
  readonly outcome?: "succeeded" | "failed" | "interrupted" | null;
  readonly time: {
    readonly created: number;
    readonly updated: number;
    readonly busy?: number;
    readonly idle?: number;
    readonly viewed?: number;
  };
  readonly location?: { readonly directory?: string };
}

export interface OpenCodeMessage {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly time?: { readonly created?: number; readonly completed?: number };
  readonly delivery?: string;
  readonly [key: string]: unknown;
}

export interface OpenCodeEvent {
  readonly id?: string;
  readonly created?: number;
  readonly type: string;
  readonly data?: Record<string, unknown>;
  readonly location?: Record<string, unknown>;
  readonly durable?: Record<string, unknown>;
}

export interface PromptMention {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type PromptFileSource =
  | { readonly type: "inline" }
  | { readonly type: "uri"; readonly uri: string };

export interface PromptFileAttachment {
  readonly uri: string;
  readonly source?: PromptFileSource;
  readonly name?: string;
  readonly description?: string;
  readonly mention?: PromptMention;
}

export interface PromptAgentAttachment {
  readonly name: string;
  readonly mention?: PromptMention;
}

export interface PromptSkillAttachment {
  readonly id: string;
  readonly mention?: PromptMention;
}

export interface PromptInput {
  readonly text: string;
  readonly id?: string;
  readonly files?: readonly PromptFileAttachment[];
  readonly agents?: readonly PromptAgentAttachment[];
  readonly skills?: readonly PromptSkillAttachment[];
  readonly delivery?: "queue" | "steer";
  readonly resume?: boolean;
}

export interface CommandRunInput {
  readonly name: string;
  readonly text: string;
  readonly files?: readonly PromptFileAttachment[];
  readonly agents?: readonly PromptAgentAttachment[];
  readonly skills?: readonly PromptSkillAttachment[];
  readonly delivery?: "queue" | "steer";
}

export interface OpenCodeCommandInfo {
  readonly name: string;
  readonly description?: string;
}

export interface OpenCodeSkillInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly autoinvoke?: boolean;
  readonly path: string;
  readonly content?: string;
}

export interface FileSystemEntry {
  readonly path: string;
  readonly type: "file" | "directory";
}

export interface FileDiffInfo {
  readonly file: string;
  readonly patch: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status: "added" | "deleted" | "modified";
  readonly more?: boolean;
}

export interface VcsInfo {
  readonly provider?: string;
  readonly branch: {
    readonly current?: string;
    readonly default?: string;
  };
}

export interface VcsFileStatus {
  readonly file: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status: "added" | "deleted" | "modified";
}

export interface ProjectInfo {
  readonly id: string;
  readonly canonical: string;
  readonly name?: string;
  readonly vcs?: string;
  readonly time: { readonly created: number; readonly updated: number };
}

export interface WorktreeInfo {
  readonly directory: string;
  readonly strategy?: string;
}

export interface SessionRevert {
  readonly messageID: string;
  readonly partID?: string;
  readonly snapshot?: string;
  readonly files?: readonly FileDiffInfo[];
}

export interface OpenCodeMessageContent {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface OpenCodeSessionMessage {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly time?: {
    readonly created?: number;
    readonly streamed?: number;
    readonly completed?: number;
  };
  readonly content?: readonly OpenCodeMessageContent[];
  readonly files?: readonly PromptFileAttachment[];
  readonly metadata?: Record<string, unknown>;
  readonly tokens?: OpenCodeTokens | null;
  readonly cost?: number | null;
  readonly model?: OpenCodeModelRef;
  readonly finish?: string | null;
  readonly [key: string]: unknown;
}

export type McpStatusName =
  | "connected"
  | "pending"
  | "disabled"
  | "failed"
  | "needs_auth";

export interface McpServerStatus {
  readonly status: McpStatusName;
  readonly error?: string;
}

export interface McpServerInfo {
  readonly name: string;
  readonly status: McpServerStatus;
  readonly title?: string;
  readonly integrationID?: string;
}

export interface OpenCodeMessagesResponse {
  readonly data: readonly OpenCodeSessionMessage[];
  readonly cursor: {
    readonly previous: string | null;
    readonly next: string | null;
  };
}

export interface PermissionReply {
  readonly decision: "once" | "always" | "reject";
  readonly message?: string;
}

export interface CreateSessionInput {
  readonly title: string;
  readonly directory: string;
  readonly model?: { readonly providerID: string; readonly id: string };
  readonly agent?: string;
}

export interface ActiveSessions {
  readonly [sessionId: string]: { readonly type: string } | undefined;
}

export interface OpenCodeModelInfo {
  readonly id: string;
  readonly modelID: string;
  readonly providerID: string;
  readonly type?: string;
  readonly name: string;
  readonly status?: "alpha" | "beta" | "deprecated" | "active";
  readonly enabled: boolean;
  readonly variants?: readonly { readonly id: string }[];
  readonly cost?: readonly { readonly input: number; readonly output: number }[] | null;
  readonly limit?: { readonly context: number; readonly output: number };
}

export interface OpenCodeAgentInfo {
  readonly id: string;
  readonly name: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden: boolean;
  readonly description?: string;
  readonly model?: OpenCodeModelRef;
}

export interface FormWhen {
  readonly key: string;
  readonly op: "eq" | "neq";
  readonly value: string | number | boolean;
}

export interface FormOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface FormFieldBase {
  readonly key: string;
  readonly title?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly hidden?: boolean;
  readonly when?: readonly FormWhen[];
}

export interface FormStringField extends FormFieldBase {
  readonly type: "string";
  readonly options?: readonly FormOption[];
  readonly custom?: boolean;
  readonly default?: string;
  readonly placeholder?: string;
  readonly format?: "email" | "uri" | "date" | "date-time";
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
}

export interface FormNumberField extends FormFieldBase {
  readonly type: "number" | "integer";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
}

export interface FormBooleanField extends FormFieldBase {
  readonly type: "boolean";
  readonly default?: boolean;
}

export interface FormMultiselectField extends FormFieldBase {
  readonly type: "multiselect";
  readonly options: readonly FormOption[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly custom?: boolean;
  readonly default?: readonly string[];
}

export interface FormExternalField extends FormFieldBase {
  readonly type: "external";
  readonly url: string;
}

export type FormField =
  | FormStringField
  | FormNumberField
  | FormBooleanField
  | FormMultiselectField
  | FormExternalField;

export type FormValue = string | number | boolean | readonly string[];

export type FormAnswer = Record<string, FormValue>;

export interface FormInfo {
  readonly id: string;
  readonly sessionID: string;
  readonly title: string;
  readonly metadata?: Record<string, unknown>;
  readonly fields: readonly FormField[];
}

export type FormState =
  | { readonly status: "pending" }
  | { readonly status: "answered"; readonly answer: FormAnswer }
  | { readonly status: "cancelled"; readonly message?: string };

export interface FormDetail extends FormInfo {
  readonly state: FormState;
}

export interface InboxItem {
  readonly id: string;
  readonly sessionID: string;
  readonly time: { readonly created: number };
  readonly type: string;
  readonly delivery: "queue" | "steer";
  readonly payload?: { readonly text?: string; readonly [key: string]: unknown };
}