# Configuration

The bridge reads one JSON file, optionally overridden by environment variables
and command-line flags.

## Location

| Purpose | Default | Override |
| --- | --- | --- |
| Config | `${XDG_CONFIG_HOME:-~/.config}/opencode-bale-bot/config.json` | `--config`, `OPENCODE_BALE_CONFIG` |
| State | `${XDG_STATE_HOME:-~/.local/state}/opencode-bale-bot/` | `OPENCODE_BALE_STATE_DIR` |
| Data | `${XDG_DATA_HOME:-~/.local/share}/opencode-bale-bot/` | `OPENCODE_BALE_DATA_DIR` |
| Database | `<data>/bridge.sqlite` | `BRIDGE_DB_PATH` |
| Lock | `<state>/bridge.lock` | `BRIDGE_LOCK_PATH` |
| Attachments | `<data>/attachments/` | `BRIDGE_ATTACHMENT_DIR` |
| Log | `<state>/bridge.log` | `BRIDGE_LOG_FILE` |

Paths never depend on the current working directory. Relative values in the
config file resolve against the config file's directory; relative environment
values resolve against the current directory; `~` expands to the home
directory.

Print the effective paths:

```bash
opencode-bale-bot config path
opencode-bale-bot config list --json
```

## Precedence

1. command-line flag (`--config`, `--health-port`, and the setup flags)
2. environment variable
3. config file
4. built-in default

## File format

```json
{
  "configVersion": 1,
  "bale": {
    "token": "123456:secret",
    "baseUrl": "https://tapi.bale.ai/bot",
    "allowedUserId": "123456789",
    "pollTimeoutSec": 30,
    "pollLimit": 50
  },
  "opencode": {
    "url": "http://127.0.0.1:4096",
    "username": "opencode",
    "passwordFile": "/home/you/.config/opencode/service.json",
    "model": { "providerID": "provider", "id": "model-id" },
    "agent": "build",
    "projectDirectory": "/home/you/project",
    "timeoutMs": 60000
  },
  "bridge": {
    "healthHost": "127.0.0.1",
    "healthPort": 4097,
    "logLevel": "info"
  }
}
```

`model` accepts either `"provider/model-id"` or the two-field object above.
`allowedUserId` accepts a string or a number.

The file must be owned by you and not readable by other users. A file with a
mode looser than `0600` is refused with the exact `chmod` command to fix it.
Unknown keys are reported as warnings, not failures, so a config written by a
newer release does not stop an older one silently.

Version `1` is current. A newer `configVersion` is refused with an upgrade hint.

## Keys

### Bale

| File key | Environment | Default | Notes |
| --- | --- | --- | --- |
| `bale.token` | `BALE_BOT_TOKEN` | — | Required unless `tokenFile` |
| `bale.tokenFile` | `BALE_BOT_TOKEN_FILE` | — | File containing the token |
| `bale.baseUrl` | `BALE_API_BASE_URL` | `https://tapi.bale.ai/bot` | `/bot` appended if missing |
| `bale.allowedUserId` | `BALE_ALLOWED_USER_ID` | — | Required numeric user ID |
| `bale.pollTimeoutSec` | `BALE_POLL_TIMEOUT_SEC` | `30` | 1–120 |
| `bale.pollLimit` | `BALE_POLL_LIMIT` | `50` | 1–100 |

### OpenCode

| File key | Environment | Default | Notes |
| --- | --- | --- | --- |
| `opencode.url` | `OPENCODE_URL` | `http://127.0.0.1:4096` | Must be loopback |
| `opencode.username` | `OPENCODE_USERNAME` | `opencode` | Basic-auth user |
| `opencode.password` | `OPENCODE_PASSWORD` | — | Prefer a file |
| `opencode.passwordFile` | `OPENCODE_PASSWORD_FILE` | `~/.config/opencode/service.json` | JSON or raw text |
| `opencode.model` | `OPENCODE_MODEL` | — | `provider/model-id` |
| `opencode.agent` | `OPENCODE_AGENT` | `build` | Agent for new sessions |
| `opencode.projectDirectory` | `PROJECT_DIRECTORY` | `$HOME` | Must exist |
| `opencode.timeoutMs` | `OPENCODE_TIMEOUT_MS` | `60000` | 1 s–10 min |
| `opencode.startCommand` | `OPENCODE_START_COMMAND` | — | Used by `/opencode_start` |
| `opencode.stopCommand` | `OPENCODE_STOP_COMMAND` | — | Used by `/opencode_stop` |
| `opencode.autoRestart` | `OPENCODE_AUTO_RESTART` | `false` | Needs a start command |
| `opencode.healthCheckMs` | `OPENCODE_HEALTH_CHECK_MS` | `30000` | Reachability probe |
| `opencode.restartFailures` | `OPENCODE_RESTART_FAILURES` | `2` | Consecutive failures |
| `opencode.restartCooldownMs` | `OPENCODE_RESTART_COOLDOWN_MS` | `300000` | Initial backoff |
| `opencode.restartMaxCooldownMs` | `OPENCODE_RESTART_MAX_COOLDOWN_MS` | `3600000` | Maximum backoff |
| `opencode.restartTimeoutMs` | `OPENCODE_RESTART_TIMEOUT_MS` | `60000` | Wait for `/api/info` |

The OpenCode URL host must be `127.0.0.1`, `[::1]`, or `localhost`. The bridge
is not designed to expose OpenCode over a network, and `config validate` rejects
anything else.

### Bridge

| File key | Environment | Default | Notes |
| --- | --- | --- | --- |
| `bridge.dbPath` | `BRIDGE_DB_PATH` | `<data>/bridge.sqlite` | SQLite WAL state |
| `bridge.lockPath` | `BRIDGE_LOCK_PATH` | `<state>/bridge.lock` | Single-instance lock |
| `bridge.editIntervalMs` | `BRIDGE_EDIT_INTERVAL_MS` | `1500` | Minimum live-edit gap |
| `bridge.liveTextLimit` | `BRIDGE_LIVE_TEXT_LIMIT` | `3900` | Under Bale's 4096 cap |
| `bridge.delivery` | `BRIDGE_DELIVERY` | `queue` | `queue` or `steer` |
| `bridge.sessionTitlePrefix` | `BRIDGE_SESSION_PREFIX` | `Bale` | New session titles |
| `bridge.attachmentDir` | `BRIDGE_ATTACHMENT_DIR` | `<data>/attachments` | Received media |
| `bridge.attachmentMaxMb` | `BRIDGE_ATTACHMENT_MAX_MB` | `15` | 1–20 |
| `bridge.attachmentTtlHours` | `BRIDGE_ATTACHMENT_TTL_HOURS` | `24` | Pruning age |
| `bridge.healthHost` | `BRIDGE_HEALTH_HOST` | `127.0.0.1` | Loopback only |
| `bridge.healthPort` | `BRIDGE_HEALTH_PORT` | `4097` | `0` disables |
| `bridge.taskTickMs` | `BRIDGE_TASK_TICK_MS` | `15000` | Scheduler sweep |
| `bridge.taskTimeoutMin` | `BRIDGE_TASK_TIMEOUT_MIN` | `30` | Per-run timeout |
| `bridge.logLevel` | `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `bridge.logFile` | `BRIDGE_LOG_FILE` | `<state>/bridge.log` | Rotated file sink |
| `bridge.logMaxMb` | `BRIDGE_LOG_MAX_MB` | `10` | Rotation size |
| `bridge.logMaxFiles` | `BRIDGE_LOG_MAX_FILES` | `5` | Current file plus backups |

## Secret handling

- Prefer `tokenFile`/`passwordFile` in the config.
- Secret files may be raw text or the JSON from OpenCode's `service.json`
  (`password` or `token` field).
- `opencode-bale-bot config set bale.token` accepts the value from `--stdin`
  and never echoes it.
- `--token` and `--opencode-password` are rejected on purpose.
- `config list`, `config get`, `doctor --bundle`, and logs redact secrets.

## Editing safely

```bash
opencode-bale-bot config set bridge.healthPort 4098
opencode-bale-bot config set bale.token --stdin < /secure/bale-token
opencode-bale-bot config validate
opencode-bale-bot config edit        # $VISUAL or $EDITOR
```

`config set` writes atomically (temp file, fsync, rename). If the resulting
file is still incomplete, the command explains what is missing and exits `3`.
Restart the service after a change:

```bash
opencode-bale-bot service restart
```