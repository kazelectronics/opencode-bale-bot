# OpenCode Bale Bot

A Bale Messenger bridge for [OpenCode](https://opencode.ai) that lets you message,
monitor, and control a local OpenCode session from your phone.

**Status: beta.** The bridge polls Bale, binds one private chat to one OpenCode
session, streams runs with throttled edits, answers permission and form buttons,
exposes model/agent/compaction commands, cancels queued prompts, follows sessions
started in the TUI, accepts file attachments, browses and diffs the project, runs
commands and skills, rewinds or forks history, switches projects and worktrees,
reports on sessions you watch in the background, and schedules recurring
prompts. It serves loopback health endpoints, can restart OpenCode automatically,
and rotates its log file.

The bridge is **Bale-native**. It connects to the local OpenCode V2 server over
its REST API and SSE event stream, and to Bale over long polling. It does not
expose OpenCode to the internet and does not require a public webhook.

## Install Bale

You need a Bale account and the app. Download Bale for Android or iOS, or use
the web client, from the official site:

- [bale.ai](https://bale.ai) — downloads and product information
- [web.bale.ai](https://web.bale.ai) — browser client

Bale is also available through the Android and iOS links on `bale.ai`.

## Create a bot and get your user ID

1. Open a chat with **BotFather**: [ble.ir/botfather](https://ble.ir/botfather)
   (or search for `@botfather` in Bale).
2. Send `/start` or `/help` to see its commands, then `/newbot` to create a
   bot. Choose a name and a unique username. BotFather returns a token such as
   `123456789:AA...`; copy it.
3. Start a **private chat** with your new bot. The bridge ignores groups and
   channels.
4. Find your numeric Bale user ID. Open a private chat with
   [@userinfobot](https://ble.ir/userinfobot) or
   [@myidbot](https://ble.ir/myidbot), send `/start`, and copy the numeric ID it
   replies with.
5. If you prefer, send any message to your new bot before running `setup`, and
   let the wizard discover your ID from that pending update. `/id` also shows
   the ID once the bridge is running.

## Install and run

Requirements:

- Linux (systemd user unit) or macOS (launchd)
- Node.js **22.13 or newer** (`node:sqlite` is experimental but stable enough at
  that floor)
- An OpenCode **V2** server listening on loopback
- A Bale bot token and your numeric Bale user ID

```bash
npm install --global opencode-bale-bot
opencode-bale-bot setup
opencode-bale-bot doctor
opencode-bale-bot service install
opencode-bale-bot status
```

`setup` walks through the bot token, owner ID, OpenCode URL/credentials, model,
agent, project directory, and health port, then writes
`${XDG_CONFIG_HOME:-~/.config}/opencode-bale-bot/config.json` with mode `0600`.
It can discover your owner ID by reading one batch of pending Bale updates; it
always offers manual entry and refuses to touch updates while a daemon is
running.

`npx opencode-bale-bot@latest setup` and `npx opencode-bale-bot@latest doctor`
are supported one-shot commands. Do **not** run the daemon from `npx`: the
cache can be evicted under a long-running process. Install globally (or into a
stable prefix) first.

Detailed guides:

- [Quickstart](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/quickstart.md)
- [Configuration](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/configuration.md)
- [Troubleshooting](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/troubleshooting.md)
- [Security model](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/security.md)
- [How it works](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/how-it-works.md)
- [Documentation index](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/index.md)
- [Bale Bot SDK](https://github.com/ErfanVahabpour/Bale-Bot-SDK-js)

## Commands

| Command | Purpose |
| --- | --- |
| `opencode-bale-bot setup` | Interactive configuration wizard |
| `opencode-bale-bot start` | Run the daemon in the foreground |
| `opencode-bale-bot status` | Show the running instance (JSON with `--json`) |
| `opencode-bale-bot stop` | Stop the instance (`--force` escalates to SIGKILL) |
| `opencode-bale-bot restart` | Restart through the service manager |
| `opencode-bale-bot logs` | Read the service or file log (`--follow`, `--lines N`) |
| `opencode-bale-bot config list\|get\|set\|edit\|validate\|path` | Read and write configuration |
| `opencode-bale-bot service install\|uninstall\|status\|restart\|logs` | Manage the systemd unit or launchd agent |
| `opencode-bale-bot doctor` | Diagnose Node, config, directories, lock, health, OpenCode, model, agent, Bale, and the service |
| `opencode-bale-bot version` | Print the version |
| `opencode-bale-bot help [command]` | Show usage |

Global options: `--config <path>`, `--json`, `--verbose`, `--quiet`, `--yes`.

Exit codes: `0` ok, `1` failure, `2` usage, `3` not configured, `4` not
running, `5` unhealthy, `78` unsupported Node.

Configuration precedence is **CLI flag > environment variable > config file >
default**. See [docs/configuration.md](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/configuration.md) for every key and
environment override.

## How it works

The bridge runs on the same machine as OpenCode. It receives messages and button
callbacks from Bale, turns text into OpenCode prompts, streams OpenCode output
back into the chat, and lets you approve permissions, answer forms, switch
sessions/models/agents, and interrupt runs from Bale. One Bale private chat maps
to one active OpenCode session at a time.

```
Bale user
   │  HTTPS long polling: getUpdates
   ▼
[BaleGateway] ──► [UpdateRouter] ──► [Command / Callback handlers]
   ▲                    │                      │
   │ send/edit          ▼                      ▼
[Outbox + rate limiter] ◄── [Renderer] ◄── [BridgeState / SQLite]
   ▲                                           │
   │                                           ▼
   └─────────────────────────────── [OpenCodeGateway]
                                               │ REST + SSE
                                               ▼
                                 OpenCode V2 server (127.0.0.1:4096)
```

- The bridge uses Bale long polling, so it needs no inbound ports, public
  hostname, or TLS certificate.
- All text is rendered plain-text-first because Bale parses Markdown itself.
  Long output and code are sent as files.
- Polling offset, chat/session bindings, callback tokens, and pending
  interactions are stored in SQLite and survive restarts.
- The bot controls OpenCode; OpenCode's own permission system controls what the
  agent may execute. The bot has no arbitrary shell command.

See [docs/how-it-works.md](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/how-it-works.md)
for components, message flow, and state.

## Command surface

Chat commands:

| Command | Purpose |
| --- | --- |
| `/start`, `/help` | Show commands and quick actions |
| `/status` | Server, project, session, model, busy state, tokens, cost |
| `/new [title]` | Create a session in the configured project |
| `/sessions` | List recent sessions |
| `/recent` | Recent sessions across every project and worktree |
| `/switch <id or index>` | Attach to an existing session |
| `/follow [id]` | Attach a session started in the TUI (or the latest running one) |
| `/model [provider/model]` | Model menu, or switch directly |
| `/agent [id]` | Agent menu, or switch directly |
| `/compact` | Summarize the session context |
| `/abort` | Interrupt the current run |
| `/cancelform` | Dismiss a pending form |
| `/detach` | Stop following the current session |
| `/id` | Show the Bale user/chat ID for setup |
| `/ls [path]` | Browse the project with buttons |
| `/find <text>` | Search file names |
| `/show <path>` | Read a file inline or as a document |
| `/diff` | Session diff, falling back to the working tree |
| `/messages [n]` | Numbered recent messages with revert/fork buttons |
| `/revert [message-id]` | Stage a revert of messages and files |
| `/fork [message-id]` | Fork the session, optionally before a message |
| `/commands` | List project commands |
| `/run <name> [text]` | Run a command |
| `/skills` | List skills |
| `/skill <id> [text]` | Run a skill |
| `/projects` | List and switch projects |
| `/project <path>` | Switch project by path |
| `/worktree list\|new\|use\|remove` | Manage worktrees |
| `/watch [id]` | Get a notice when a session finishes |
| `/unwatch [id\|all]` | Stop watching |
| `/watching` | List watched sessions |
| `/open [id]` | Directory browser when empty; else attach a session |
| `/attach <id>` | Attach a session (alias of `/open <id>`) |
| `/settings` | Toggle language, progress style, reasoning, footer, dashboard, diffs, queue |
| `/language [en\|fa]` | Show or set the locale |
| `/context` | Context-window usage, last reply tokens/cost, compact button |
| `/queue` | List queued prompts with one-tap withdraw buttons |
| `/mcps` | List MCP servers with connect/disconnect |
| `/reload` | Reload the OpenCode configuration |
| `/opencode_start` | Run `OPENCODE_START_COMMAND`, then poll `/api/info` for 30s |
| `/opencode_stop` | Run `OPENCODE_STOP_COMMAND` and wait for it to finish |
| `/task once\|every\|daily <schedule> \| <prompt>` | Schedule a one-off or recurring prompt |
| `/tasklist` | List tasks and run, pause, resume, or delete them |

Plain text is sent to the active session. Permissions are approved with inline
buttons (`Allow once`, `Always`, `Reject`). Form fields render one step at a time:
options, booleans, acknowledgements, and multi-select use buttons, while text and
number fields consume the next message. A run's live output is edited into one
message at most once per 1.5 seconds; the final answer replaces it, and long
answers are attached as a Markdown document.

Queued prompts show a **Withdraw** button on their notice, and `/queue` lists
every waiting prompt with a numbered withdraw button. When a permission request or
form arrives for a detached session, its watchers receive the interactive
buttons (or a generic open-session notice if another chat already owns it).
`/settings` stores preferences per chat in `chat_settings`; `/language fa`
switches the panel, help, dashboard, context, queue, recent, directory browser,
and MCP screens to Persian.

> **Bale pinning caveat.** Bale's `pinChatMessage` endpoint answers HTTP 500 for
> private chats on the public API. The bridge still creates one dashboard message
> and edits it in place, but it is not pinned; the first rejected pin sends a
> one-time notice and the bridge stops retrying. The same dashboard works
> unchanged if a future Bale deployment starts accepting the call.

When the session is busy, a new prompt is queued and shown with a Cancel button
that calls `DELETE /api/session/{id}/inbox/{id}`. A session created in the TUI is
announced to unbound chats in the same project with **Follow** and **Dismiss**
buttons.

Documents, photos, audio, voice notes, and video sent to the chat are downloaded
to the XDG data directory (`${XDG_DATA_HOME:-~/.local/share}/opencode-bale-bot/attachments`),
size-checked, and passed to OpenCode as file attachments
with the caption as the prompt text. Files older than the configured TTL are
pruned. `/diff` sends the patch as a `.patch` document and summarizes the changed
files in the chat.

`/messages` numbers the messages it lists; **Revert #N** and **Fork #N** act on
that number, and a separate **Fork full conversation** button copies everything.
`/revert` is deliberately two-step: it stages the revert, shows how many files
would change, and only commits when you press **Confirm**. `/fork` copies the
conversation into a new session and moves this chat to the fork; OpenCode refuses
to fork an empty session.

Sessions bound to this chat are watched automatically. When a watched session
finishes in another chat (or with `/detach`), you get one concise notice with an
**Open session** button. The notice is debounced so a burst of terminal events
does not spam the chat.

Scheduled tasks run in a fresh session with the task's captured project, model,
and agent, so they never take over the chat's active session. A task runs at most
once at a time; if a recurring run is still in flight when the next occurrence is
due, that occurrence is skipped until the run finishes. Permissions and forms
raised by a task are delivered to the owning chat, and the finished result is
posted back with the outcome, duration, and a short preview.

The daemon serves `GET /health`, `/health/live`, and `/health/ready` on loopback
(`127.0.0.1:4097` by default). `/health/live` only proves the process is alive;
`/health/ready` returns `503` until OpenCode answers and the Bale poller is
running. Set `BRIDGE_HEALTH_PORT=0` to disable the endpoint. When
`OPENCODE_AUTO_RESTART=true` and `OPENCODE_START_COMMAND` is set, a run of failed
health checks runs the start command with backoff. `/opencode_stop` suppresses
automatic restarts until `/opencode_start` is used again.

Logs go to stdout and, by default, to a size-rotated file in the XDG state
directory. Override the path with `BRIDGE_LOG_FILE`; the file rotates by size
and keeps a bounded number of backups. stdout logging is unaffected.

## Repository layout

```
bin/                      Node-version gate and CLI launcher
src/                      Bridge daemon (TypeScript)
  bale/                   Bale gateway adapter, poller, per-chat outbox
  bridge/                 Router, commands, prompts, sessions, forms, menus,
                          attachments, files, catalogs, history, projects,
                          watches, settings, dashboard, directory browser,
                          server control, monitor, tasks, run reducer/coordinator
  opencode/               REST client, SSE parser, event stream
  cli.ts setup.ts doctor.ts service.ts daemon.ts
  config.ts configFile.ts paths.ts lock.ts healthClient.ts
  db.ts health.ts healthServer.ts i18n.ts logFile.ts logger.ts renderer.ts util.ts
tests/                    Vitest suites for the pure and stateful units
scripts/                  Pack, docs, license, and end-to-end checks
.github/workflows/        CI, e2e, and release pipelines
docs/                     User, maintainer, and API documentation
```

## Configuration

`setup` writes a JSON file at
`${XDG_CONFIG_HOME:-~/.config}/opencode-bale-bot/config.json`. State lives in
`${XDG_STATE_HOME:-~/.local/state}/opencode-bale-bot/` (lock and log), and data
lives in `${XDG_DATA_HOME:-~/.local/share}/opencode-bale-bot/` (SQLite and
attachments). Nothing is resolved from the current working directory.

```json
{
  "configVersion": 1,
  "bale": {
    "token": "123456:secret",
    "allowedUserId": "123456789"
  },
  "opencode": {
    "url": "http://127.0.0.1:4096",
    "username": "opencode",
    "passwordFile": "/home/you/.config/opencode/service.json",
    "model": "provider/model-id",
    "agent": "build",
    "projectDirectory": "/home/you/project"
  },
  "bridge": {
    "healthPort": 4097
  }
}
```

Every value can also be supplied by an environment variable; flags win over
environment, environment wins over the file, and the file wins over defaults.
The file is created atomically with mode `0600`, and a group- or
world-readable file is refused with a repair hint.

### Essential keys

| Key | Environment | Required | Default |
| --- | --- | --- | --- |
| `bale.token` / `bale.tokenFile` | `BALE_BOT_TOKEN` / `BALE_BOT_TOKEN_FILE` | yes | — |
| `bale.allowedUserId` | `BALE_ALLOWED_USER_ID` | yes | — |
| `opencode.model` | `OPENCODE_MODEL` | yes | — |
| `opencode.password` / `opencode.passwordFile` | `OPENCODE_PASSWORD` / `OPENCODE_PASSWORD_FILE` | yes | `~/.config/opencode/service.json` |
| `opencode.url` | `OPENCODE_URL` | no | `http://127.0.0.1:4096` |
| `opencode.projectDirectory` | `PROJECT_DIRECTORY` | no | `$HOME` |
| `bridge.healthPort` | `BRIDGE_HEALTH_PORT` | no | `4097` (`0` disables) |

The complete key reference, including logging, attachments, scheduled tasks,
and OpenCode auto-restart, is in
[docs/configuration.md](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/configuration.md). The commented
[`.env.example`](https://github.com/kazelectronics/opencode-bale-bot/blob/main/.env.example) lists every environment override for advanced
and container deployments.

Useful commands:

```bash
opencode-bale-bot config path
opencode-bale-bot config list
opencode-bale-bot config get opencode.model
opencode-bale-bot config set bridge.healthPort 4098
opencode-bale-bot config validate
opencode-bale-bot config edit
```

## Running

Foreground, for debugging:

```bash
opencode-bale-bot start
```

As a daemon:

```bash
opencode-bale-bot service install      # systemd user unit or launchd agent
opencode-bale-bot status
opencode-bale-bot logs --follow
opencode-bale-bot stop
```

On Linux the service is a systemd **user** unit under
`${XDG_CONFIG_HOME:-~/.config}/systemd/user/opencode-bale-bot.service`.
`service install` runs `daemon-reload`, `enable --now`, and attempts
`loginctl enable-linger` so the bridge starts at boot. If linger is unavailable,
the command prints the exact `sudo loginctl enable-linger <user>` line.

On macOS it writes `~/Library/LaunchAgents/com.opencode-bale-bot.plist`,
bootstraps it into `gui/$UID`, and uses `KeepAlive`.

`service install --dry-run` prints the unit or plist without writing it.
`service uninstall --purge` also removes the config file and the state and data
directories. `--config <path>` selects a different config file for every
command.

While the daemon runs, `curl http://127.0.0.1:4097/health/ready` tells a
supervisor whether OpenCode and Bale polling are both usable. The health
listener is loopback-only and has no write endpoints.

Windows is not supported natively. Run the bridge inside WSL2; use the Linux
instructions there.

## Development

```bash
npm install
npm run verify             # typecheck, tests, build, pack, docs, e2e
npm run dev                # tsx watch, no build step
```

The individual checks are `npm run typecheck`, `npm test`, `npm run build`,
`npm run pack:check`, `npm run docs:check`, `npm run licenses:check`, and
`npm run test:e2e`. The end-to-end test starts mock Bale and OpenCode servers,
runs the real CLI, sends `/help`, and shuts the daemon down. See [docs/testing.md](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/testing.md) for
the Linux and macOS manual matrix, and [docs/release.md](https://github.com/kazelectronics/opencode-bale-bot/blob/main/docs/release.md) for
the publish runbook.

## Security principles

- Only one whitelisted Bale user, in a private chat.
- Bind the OpenCode server to loopback; never expose it publicly.
- Redact the Bale token and OpenCode password from logs.
- Store configuration with mode `0600`; prefer secret files or stdin over
  command-line arguments and shell history.
- Callback tokens are short, random, chat-bound, and expiring.
- Destructive actions require explicit confirmation.

Report vulnerabilities privately as described in [SECURITY.md](https://github.com/kazelectronics/opencode-bale-bot/blob/main/SECURITY.md).