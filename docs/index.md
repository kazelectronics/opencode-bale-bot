# Documentation

Start with the guide that matches what you are doing.

## Install and run

- [Quickstart](quickstart.md) — from a blank machine to a working bot.
- [Configuration](configuration.md) — every file key, environment variable, and
  path.
- [Troubleshooting](troubleshooting.md) — symptoms, exit codes, and fixes.
- [Security model](security.md) — trust boundaries, secrets, and limitations.

## How it works

- [How it works](how-it-works.md) — components, message flow, state, and
  runtime behavior.

## Maintain and release

- [Testing and platform verification](testing.md) — automated checks plus the
  Linux and macOS manual matrix.
- [Release runbook](release.md) — npm publishing, verification, and rollback.

## Platform support

| Platform | Service manager | Notes |
| --- | --- | --- |
| Linux | systemd user unit | `opencode-bale-bot service install` |
| macOS | launchd agent | `opencode-bale-bot service install` |
| Windows | none | Use WSL2 and follow the Linux instructions |

## Conventions

- Paths use `${XDG_CONFIG_HOME:-~/.config}`, `${XDG_STATE_HOME:-~/.local/state}`,
  and `${XDG_DATA_HOME:-~/.local/share}`.
- Commands assume `opencode-bale-bot` is on `PATH` after a global install.
- Examples use `provider/model-id` and `/home/you` as placeholders. Replace
  them; never commit real tokens or chat IDs.