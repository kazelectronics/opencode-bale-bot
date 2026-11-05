# Quickstart

This guide gets a stranger from a blank machine to a working Bale bot in about
ten minutes. It assumes a local OpenCode V2 server already runs on loopback.

## 1. Check Node.js

```bash
node --version
```

You need **22.13.0 or newer**. The launcher exits with code `78` and an upgrade
message on older releases because the bridge uses `node:sqlite`.

## 2. Create the Bale bot

1. Open Bale and talk to **@BotFather**.
2. Create a bot and copy the token.
3. Start a private chat with your new bot and send it any message. `setup` can
   discover your numeric Bale user ID from that message; `/id` confirms it once
   the bridge is running.

## 3. Run OpenCode

Start the OpenCode V2 server locally. The bridge talks to
`http://127.0.0.1:4096` by default. Confirm it answers:

```bash
curl -u opencode:"$OPENCODE_PASSWORD" http://127.0.0.1:4096/api/info
```

The response must include a `version` beginning with `2.`. OpenCode's default
model may be region-blocked; choose an available model in the next step.

If you do not know the OpenCode password, it is usually in
`~/.config/opencode/service.json`. `setup` and `config validate` reject a
non-loopback OpenCode URL.

## 4. Install the package

```bash
npm install --global opencode-bale-bot
opencode-bale-bot --version
```

Do not run the daemon through `npx`. The npx cache is not a stable install
location for a long-running process. `npx opencode-bale-bot@latest setup` and
`npx opencode-bale-bot@latest doctor` are fine as one-shot commands.

## 5. Configure

```bash
opencode-bale-bot setup
```

The wizard asks for:

1. the Bale bot token (input is masked);
2. your owner ID — send the bot a message when prompted, or type the ID;
3. the OpenCode URL and credentials;
4. a model from the server's `/api/model` list;
5. an agent (default `build`);
6. the project directory for new sessions;
7. the loopback health port (default `4097`, `0` disables).

It shows a redacted review, then writes
`${XDG_CONFIG_HOME:-~/.config}/opencode-bale-bot/config.json` atomically with
mode `0600`.

The owner-ID discovery reads one batch of pending Bale updates. That consumes
updates which arrived before the bridge started. The wizard warns you, checks
that no daemon is running, and always lets you enter the ID manually instead.

### Non-interactive setup

For automation, pass every value and use a secret file rather than an argument:

```bash
opencode-bale-bot setup \
  --non-interactive --yes \
  --token-file /secure/bale-token \
  --user-id 123456789 \
  --opencode-url http://127.0.0.1:4096 \
  --opencode-username opencode \
  --opencode-password-file /secure/opencode-password \
  --model provider/model-id \
  --agent build \
  --project "$HOME/project" \
  --health-port 4097
```

`--token`, `--opencode-password` are rejected: they would leak through the
process list. Use `--token-stdin` to pipe a token instead of writing a file.

## 6. Verify

```bash
opencode-bale-bot doctor
```

`doctor` checks Node, platform, the config file and its permissions, every
required value, the config/state/data directories, the daemon lock and health
endpoint, OpenCode connectivity, the selected model and agent, Bale
authentication, and the service manager. Exit code `0` means healthy.

Add `--json` for tooling. Add `--bundle` to write a redacted support bundle to
the state directory.

## 7. Run as a daemon

Linux:

```bash
opencode-bale-bot service install
```

macOS:

```bash
opencode-bale-bot service install
```

The command writes a systemd user unit or a launchd agent, enables it, and
starts it. Preview without writing with `--dry-run`.

```bash
opencode-bale-bot status
opencode-bale-bot logs --follow
```

On Linux, `service install` also attempts `loginctl enable-linger` so the unit
starts at boot. If it cannot, it prints the exact `sudo` command to run.

## 8. Talk to the bot

Open the private chat and send `/help`. The bot replies with the command
surface. Send plain text to prompt the active session; `/new` creates one first.

From here:

- `/status` — server, project, session, model, and usage
- `/model` and `/agent` — switch the current session
- `/settings` — language, progress style, dashboard, and more
- `/task` — schedule a recurring prompt

## Updating

```bash
npm install --global opencode-bale-bot@latest
opencode-bale-bot service restart
opencode-bale-bot doctor
```

## Uninstalling

```bash
opencode-bale-bot service uninstall
npm uninstall --global opencode-bale-bot
```

Add `--purge` to `service uninstall` to delete the configuration file and the
state and data directories as well. This cannot be undone.

## Next

- [Configuration reference](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [Security model](security.md)