# Troubleshooting

Start with:

```bash
opencode-bale-bot doctor
```

It reports every check with a hint. `doctor --json` is stable enough for
scripts; `doctor --bundle` writes a redacted support bundle to the state
directory.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Failure |
| `2` | Usage error |
| `3` | Not configured, or configuration is incomplete |
| `4` | The daemon is not running |
| `5` | Unhealthy: warnings, unreachable health endpoint, or not ready |
| `78` | Unsupported Node.js version |

## `ExperimentalWarning: SQLite is an experimental feature`

That warning comes from Node's `node:sqlite` module and is expected. The
installed service unit and `npm start` pass
`--disable-warning=ExperimentalWarning`; a direct `opencode-bale-bot start`
shows it once. It does not affect behavior.

## The launcher exits 78

```text
opencode-bale-bot requires Node.js 22.13.0 or newer because it uses node:sqlite.
```

Install a current Node.js release. If you use `nvm`, confirm the service points
at the same interpreter:

```bash
which node
node --version
```

`service install` writes the absolute `process.execPath` into the unit, so
re-run it after changing Node versions.

## `command not found: opencode-bale-bot`

The global npm prefix is not on `PATH`:

```bash
npm prefix --global
npm bin --global        # older npm
```

Add that `bin` directory to `PATH`, or install with a prefix already on `PATH`.

## `setup` cannot find the owner ID

- Send the bot a private message first.
- Private chats only; group messages are ignored.
- If a daemon is already running, setup will not read the update queue. Enter
  the ID manually or stop the daemon first.
- The numeric ID is also available via `/id` once the bot is reachable.

## "configuration file is readable by other users"

The config contains secrets and must be `0600`:

```bash
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/opencode-bale-bot/config.json"
chmod 700 "${XDG_CONFIG_HOME:-$HOME/.config}/opencode-bale-bot"
```

## `BALE_BOT_TOKEN is required` or `OPENCODE_MODEL is required`

Run `opencode-bale-bot config validate` to see every missing value at once,
then `setup` or `config set`. Environment variables and flags can mask a file
problem; `config list` shows the file as written.

## OpenCode connection refused or 401

```bash
curl -u opencode:"$OPENCODE_PASSWORD" http://127.0.0.1:4096/api/info
```

- Confirm the V2 server, not the TUI alone, is listening.
- Confirm the URL is loopback.
- Confirm the password. The default source is
  `~/.config/opencode/service.json`.
- A `403 RegionError` usually means the selected model is blocked. Choose a
  different model in `setup` or `config set opencode.model provider/model-id`.

## Model or agent not found

The model list comes from `GET /api/model` and the agent list from
`GET /api/agent`. Run `setup` again to pick from live values. The bridge uses
`model.modelID` for matching when the server provides it.

## Port already in use

The default health port is `4097`.

```bash
curl http://127.0.0.1:4097/health
opencode-bale-bot config set bridge.healthPort 4098
```

Or disable the endpoint with `bridge.healthPort = 0`. `/health/ready` returns
`503` until OpenCode answers and the Bale poller is running; that is expected
during startup.

## "the bridge is not running" but the process exists

`status` and `stop` use the lock file plus a health probe. Possible causes:

- The process was started with a different config or `XDG_STATE_HOME`, so it
  wrote a different lock.
- The PID was reused; `stop` refuses to signal a process whose start time or
  instance token does not match.
- The health port is occupied by another program.

Inspect the paths with `opencode-bale-bot config path` and
`opencode-bale-bot status --json`. A genuinely stale lock is removed by
`opencode-bale-bot stop`, which only deletes it when the recorded PID is dead.

## Service install issues

Preview first:

```bash
opencode-bale-bot service install --dry-run
```

Linux:

```bash
systemctl --user status opencode-bale-bot
journalctl --user -u opencode-bale-bot -n 200 --no-pager
```

- `systemd user services are not available in this session` — log in with a
  user session, then start the unit.
- To start at boot, enable lingering:
  `sudo loginctl enable-linger "$USER"`.
- `--no-enable` writes and starts without enabling; `--no-start` only writes.
- An existing unit is not replaced unless you pass `--force`.

macOS:

```bash
launchctl print "gui/$UID/com.opencode-bale-bot"
tail -n 200 "${XDG_STATE_HOME:-$HOME/.local/state}/opencode-bale-bot/daemon.err.log"
```

If `launchctl bootstrap` failed, run `service install --force` after fixing the
error it reported.

## Logs

```bash
opencode-bale-bot logs --lines 200
opencode-bale-bot logs --follow
```

With a systemd unit the command reads the journal. Otherwise it tails
`bridge.log` in the state directory. Set `bridge.logLevel = "debug"` for more
detail, and remember that Bale/OpenCode content in logs may be sensitive.

## The bot replies but nothing reaches OpenCode

- `/status` shows the bound session and whether it is busy.
- `/new` creates a session in the configured project.
- `/follow` attaches a session started in the TUI.
- A `409 SessionBusyError` means a run is already active; queue or `/abort`.

## Bale formatting or length problems

Bale has no `parse_mode`; the bridge sends plain text with a small Markdown
subset. Long answers and code are uploaded as documents. If an edit is rejected
with `429`, the outbox backs off automatically. The dashboard is edited in
place rather than pinned because Bale rejects `pinChatMessage` for private
chats on the public API.

## Upgrading

```bash
npm install --global opencode-bale-bot@latest
opencode-bale-bot doctor
opencode-bale-bot service restart
```

If a newer release refuses an old `configVersion`, the message names the file
and the supported version. Re-run `setup` to write the current schema.

## Collecting a support bundle

```bash
opencode-bale-bot doctor --bundle
```

The bundle is written to the state directory with mode `0600`. It contains the
report, the redacted config, and no raw token or password. Review it before
posting it in an issue; it may still contain paths and model names.