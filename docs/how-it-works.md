# How it works

This page describes what the bridge does at runtime and how its parts fit
together. For installation, see [quickstart.md](quickstart.md); for every
configuration key, see [configuration.md](configuration.md).

## Message flow

The bridge is a single foreground process on the same machine as OpenCode:

```
Bale user
   │  HTTPS long polling
   ▼
BaleGateway ──► UpdateRouter ──► commands and callbacks
   ▲                  │
   │ send/edit        ▼
Outbox ◄── Renderer ◄── Chat state and SQLite
   ▲                        │
   │                        ▼
   └────────────── OpenCode V2 client
                         REST + SSE
                            │
                            ▼
              OpenCode server on 127.0.0.1
```

A message or button press becomes one of:

- a command such as `/status` or `/sessions`;
- a callback action from an inline button;
- a prompt sent to the active OpenCode session;
- an answer to a pending permission or form;
- an ignored update.

Each private chat is bound to one active OpenCode session. OpenCode remains the
source of truth for session content; the bridge stores only the chat binding and
UI state.

## Components

| Component | Responsibility |
| --- | --- |
| `BaleGateway` | Bale token, long polling, request serialization, typed errors, retry-after handling, token redaction, update deduplication |
| `UpdateRouter` | Owner/private-chat checks, update classification, callback-token validation, routing to commands or prompts |
| `SessionRegistry` | Chat-to-session binding, project directory, model/agent overrides, delivery mode, live message ID, follow mode |
| `OpenCodeGateway` | REST client with Basic auth, one SSE subscription, reconnect loop, error mapping |
| `RunReducer` | Per-session run state: idle, running, waiting for permission, waiting for form, interrupted, failed |
| `Outbox` | One serialized queue per chat; coalesces stream edits, preserves order, handles 429s and final edits |
| `Renderer` | Converts agent output to plain-text-first messages, splits long output, turns very long output into documents, adds a model/token footer |
| `InteractionManager` | Permission buttons and queued-prompt cancellation |
| `FormManager` | One edited message per form, inline buttons plus free-text fields, 20-minute expiry |
| `MenuManager` | Model and agent lists, compaction actions |
| `AttachmentService` | Incoming Bale files, downloaded and passed to OpenCode |
| `FileBrowser`, `CatalogManager`, `HistoryManager` | Project files, agents/commands/skills, revert and fork |
| `ProjectManager`, `WatchManager` | Project and worktree switching, background session notifications |
| `SettingsManager`, `DashboardManager` | Per-chat settings, pinned status dashboard |
| `TaskManager` | One-off, interval, and daily prompts |
| `OpenCodeMonitor`, `ServerControl` | Health polling and optional automatic OpenCode restart |
| `HealthServer` | Loopback `/health/live` and `/health/ready` endpoints |

## Running a prompt

1. The poller receives an update and the router accepts it as a prompt.
2. The bridge sends the prompt to OpenCode and records the deterministic message
   ID, so a retry cannot duplicate it.
3. OpenCode streams `session.step.*`, `text.delta`, permission, and form events
   over SSE.
4. The run reducer accumulates text and tool state.
5. The outbox edits one live Bale message on a throttle (1.5 seconds by default)
   and sends a final edit when the run ends.
6. A `session.execution.succeeded`, `.failed`, or `.interrupted` event ends the
   run. A REST read of the session is the fallback if the terminal event is
   missed.

While a permission or form is open, unrelated text is not accepted as a new
prompt. The bridge resolves the request through the OpenCode API, answers the
Bale callback immediately, then edits the original message to show the result.

## Bale behavior

- All text is parsed as Markdown; `parse_mode` does not exist.
- Agent output is rendered plain-text-first. Code fences are kept intact, and
  long output is sent as a `.md` or `.txt` document.
- Bale allows 4096 characters per message; chunking happens below that limit.
- `429` responses pause the chat's outbox for the server-provided retry delay.
- The bridge uses long polling, so it needs no inbound ports, public hostname,
  or TLS certificate.
- Only one bridge process may poll a bot token at a time. A local instance lock
  enforces this.

## State

SQLite runs in WAL mode under the data directory. The main tables are:

| Table | Purpose |
| --- | --- |
| `meta` | Polling offset, schema version, bot ID |
| `chats` | Active session, project directory, model, agent, delivery mode, live message ID |
| `chat_settings` | Locale, progress style, visibility, pinned dashboard, queue behavior |
| `callback_tokens` | Short-lived, chat-bound tokens for inline buttons |
| `form_sessions` | Active form, fields, answers, current field, expiry |
| `processed_updates` | Deduplication of Bale update IDs |
| `prompt_ids` | Idempotent OpenCode message IDs and inbox keys |
| `interaction_messages` | Messages the bridge may edit after a restart |
| `watched_sessions` | Sessions followed in the background |
| `scheduled_tasks` | Prompt schedules, run state, and last result |

OpenCode is authoritative for conversations and diffs; the database only holds
bridge state. The database is created and migrated automatically on startup.

## Reliability

- The polling offset is saved after each processed update.
- The first poll skips the stale update backlog instead of replaying it.
- The SSE subscription reconnects with backoff and resyncs from REST.
- The outbox retries an operation after a rate limit and never drops the final
  edit.
- Shutdown stops polling, flushes the outbox, closes SSE, and closes SQLite.
- Logs go to stdout and, by default, a size-rotated file in the state directory.
- `/health/live` reports process liveness; `/health/ready` also checks OpenCode
  and the poller.
- Automatic OpenCode restart is opt-in, requires a start command, and backs off
  exponentially. `/opencode_stop` suppresses it until `/opencode_start`.
- Scheduled tasks claim their row atomically, never overlap, and recover an
  interrupted run at startup.

## Security boundaries

- One allowed Bale user ID, in a private chat.
- The health endpoint is loopback-only and read-only.
- The OpenCode server is expected on loopback and guarded by a password.
- The bot can control OpenCode but cannot run arbitrary shell commands itself;
  OpenCode's permission system governs agent actions.
- Callback tokens are random, chat-bound, and expire.
- Destructive actions ask for confirmation.
- The Bale token and OpenCode password are redacted from logs and errors.

For the threat model and limitations, see [security.md](security.md).