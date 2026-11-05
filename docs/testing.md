# Testing and platform verification

This page has two parts: the automated checks that must pass for every change,
and the manual Linux/macOS pass required before a release.

Use a dedicated test bot, a throwaway OpenCode project, and an isolated home
directory. Do not test against a bot or daemon that you rely on.

## Automated checks

From a clean checkout:

```bash
npm ci
npm run verify
```

`verify` runs, in order:

| Step | Command | What it proves |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | The TypeScript surface compiles |
| Unit tests | `npm test` | Pure and stateful behavior |
| Build | `npm run build` | `dist/` is produced without source maps |
| Pack guard | `npm run pack:check` | The tarball contains only public files |
| Docs links | `npm run docs:check` | Every relative Markdown link resolves |
| Licenses | `npm run licenses:check` | Every runtime dependency has an allowed license |
| End-to-end | `npm run test:e2e` | Setup, doctor, daemon, a real `/help` reply, and shutdown against mock Bale/OpenCode servers |

The end-to-end test uses temporary directories and ephemeral ports. It needs no
network access and no real Bale token.

Additional checks:

```bash
npm ci --dry-run                 # package.json and package-lock.json agree
npm audit --omit=dev             # no known runtime advisories (needs network)
npm pack --silent                # tarball name only; prepack builds and checks
find dist -name '*.map'          # must print nothing
```

CI also runs the unit suite on Node 22.13, 22.x, and 24.x, audits runtime
dependencies, verifies that an old Node exits `78`, installs the tarball into a
temporary prefix, and runs the end-to-end test on Ubuntu and macOS.

## Isolated manual environment

Create a disposable home so the test cannot read or write your real config,
database, or logs:

```bash
export TESTROOT=$(mktemp -d)
export REAL_HOME="$HOME"
export HOME="$TESTROOT/home"
export XDG_CONFIG_HOME="$TESTROOT/config"
export XDG_STATE_HOME="$TESTROOT/state"
export XDG_DATA_HOME="$TESTROOT/data"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME"
```

Use a separate shell for the test. When it is over, run `rm -rf "$TESTROOT"`.

If another bridge is already running, use a different `bridge.healthPort` in
the test config (for example `4098`) and use that port in the health checks.

### Service tests and the real unit path

The CLI writes the systemd unit under `$XDG_CONFIG_HOME/systemd/user`, but
`systemctl --user` loads units from the user manager's own search path, not from
the environment of the shell that calls it. Changing `XDG_CONFIG_HOME` in a test
shell therefore does **not** make the unit visible to the manager.

For service tests, use one of these setups:

- **Preferred:** a disposable VM or a separate Linux/macOS user account, where
  the real unit path and GUI/launchd session are already disposable.
- On your normal account, install the test unit in the real manager path, keep
  its runtime state and data isolated with a drop-in, and remove both afterward.
  Do not reuse a unit name or bot token that another running bridge uses.

For the drop-in approach on Linux, override the test `HOME` for the install so
the unit lands in the real `~/.config/systemd/user`:

```bash
UNIT_DIR="$REAL_HOME/.config/systemd/user/opencode-bale-bot.service.d"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/test-env.conf" <<EOF
[Service]
Environment=XDG_STATE_HOME=$TESTROOT/state
Environment=XDG_DATA_HOME=$TESTROOT/data
EOF

HOME="$REAL_HOME" XDG_CONFIG_HOME="$REAL_HOME/.config" \
  XDG_STATE_HOME="$TESTROOT/state" XDG_DATA_HOME="$TESTROOT/data" \
  opencode-bale-bot service install \
  --config "$TESTROOT/config/opencode-bale-bot/config.json"
```

The unit records that config path at install time, and the drop-in keeps logs,
database, lock, and attachments under `$TESTROOT`. `service install` also
attempts to enable lingering so the unit can start at boot.

Use the same real `HOME` and test state/data for `status`, `logs`, `restart`,
and uninstall; otherwise the CLI looks at the real state or a different unit:

```bash
HOME="$REAL_HOME" XDG_CONFIG_HOME="$REAL_HOME/.config" \
  XDG_STATE_HOME="$TESTROOT/state" XDG_DATA_HOME="$TESTROOT/data" \
  opencode-bale-bot --config "$TESTROOT/config/opencode-bale-bot/config.json" \
  status
```

After the test, uninstall and remove the drop-in and test tree:

```bash
HOME="$REAL_HOME" XDG_CONFIG_HOME="$REAL_HOME/.config" \
  XDG_STATE_HOME="$TESTROOT/state" XDG_DATA_HOME="$TESTROOT/data" \
  opencode-bale-bot service uninstall --purge \
  --config "$TESTROOT/config/opencode-bale-bot/config.json"
rm -rf "$UNIT_DIR" "$TESTROOT"
```

launchd agents are written to `~/Library/LaunchAgents` and bootstrapped into
`gui/$UID`. The `XDG_*` variables do not redirect that path, so use a
disposable macOS user or VM for the service test.

## Install the artifact under test

Test the tarball, not the source tree:

```bash
TARBALL=$(npm pack --silent)
PREFIX="$TESTROOT/prefix"
npm install --global --prefix "$PREFIX" "./$TARBALL"
export PATH="$PREFIX/bin:$PATH"
opencode-bale-bot --version
opencode-bale-bot --help
```

Expected:

- `--version` prints `opencode-bale-bot <version>`.
- `--help` prints usage and exits `0`.
- On Node older than 22.13, the launcher prints the Node requirement and exits
  `78`.

## Linux manual matrix

Run on a normal desktop or VM with a systemd **user** session. A container or an
SSH session without a user bus cannot install the user unit.

| # | Check | Command | Expected |
| --- | --- | --- | --- |
| 1 | Node gate | `node --version` | 22.13 or newer |
| 2 | Setup | `opencode-bale-bot setup` | Writes `config.json` with mode `0600` |
| 3 | Doctor | `opencode-bale-bot doctor` | Exit `0`, every check `ok` or an explained `warn` |
| 4 | Unit preview | `opencode-bale-bot service install --dry-run` | Prints the unit; writes nothing |
| 5 | Unit install | `opencode-bale-bot service install` | Unit enabled and started |
| 6 | Unit status | `systemctl --user status opencode-bale-bot` | `active (running)` |
| 7 | Health | `curl 127.0.0.1:<port>/health/ready` | HTTP `200` and `ready: true` |
| 8 | Bot reply | Send `/help` to the bot | A reply arrives |
| 9 | Logs | `opencode-bale-bot logs --lines 50` | Journal lines, no secrets |
| 10 | Restart | `opencode-bale-bot service restart` | New PID, bot still replies |
| 11 | Crash recovery | `kill -9 <pid>` | systemd restarts the unit |
| 12 | Boot start | Reboot or log out and back in | Unit starts without a manual command |
| 13 | Uninstall | `opencode-bale-bot service uninstall` | Unit stopped and removed |
| 14 | Purge | `opencode-bale-bot service uninstall --purge` | Config file, state, and data removed |

Notes:

- Use the health port from the test config; the default is `4097`.
- `service install` attempts `loginctl enable-linger "$USER"`. If it cannot, run
  the printed `sudo loginctl enable-linger "$USER"` command and repeat check 12.
- If `systemctl --user` reports “Failed to connect to bus”, you are not in a
  user session; the unit cannot be tested from that shell.
- `journalctl --user -u opencode-bale-bot -n 200 --no-pager` is the quickest
  place to inspect a failed start.
- If you used the drop-in from the isolated-environment section, remove
  `~/.config/systemd/user/opencode-bale-bot.service.d` after check 14.

## macOS manual matrix

Run on a normal user account, not a root shell. launchd agents load into
`gui/$UID`.

| # | Check | Command | Expected |
| --- | --- | --- | --- |
| 1 | Node gate | `node --version` | 22.13 or newer |
| 2 | Setup | `opencode-bale-bot setup` | Writes `config.json` with mode `0600` |
| 3 | Doctor | `opencode-bale-bot doctor` | Exit `0`; service check may warn before install |
| 4 | Plist preview | `opencode-bale-bot service install --dry-run` | Prints `com.opencode-bale-bot.plist` |
| 5 | Install | `opencode-bale-bot service install` | Plist written and bootstrapped |
| 6 | Status | `launchctl print "gui/$UID/com.opencode-bale-bot"` | State `running` |
| 7 | Health | `curl 127.0.0.1:<port>/health/ready` | HTTP `200` and `ready: true` |
| 8 | Bot reply | Send `/help` to the bot | A reply arrives |
| 9 | Logs | `opencode-bale-bot logs --lines 50` | Tails `bridge.log` or the launchd log |
| 10 | Restart | `opencode-bale-bot service restart` | New PID, bot still replies |
| 11 | Crash recovery | `kill -9 <pid>` | `KeepAlive` restarts the agent |
| 12 | Login start | Log out and back in | Agent starts automatically |
| 13 | Uninstall | `opencode-bale-bot service uninstall` | Agent booted out and plist removed |
| 14 | Purge | `opencode-bale-bot service uninstall --purge` | Config file, state, and data removed |

If `launchctl bootstrap` fails, inspect the error, fix it, then retry with
`opencode-bale-bot service install --force`. The launchd logs are
`<state>/daemon.out.log` and `<state>/daemon.err.log`.

## Failure-path checks

Run these once per release on either platform:

```bash
# Missing configuration
HOME=$TESTROOT/empty opencode-bale-bot doctor --json; echo $?    # 3

# Not running
HOME=$TESTROOT/empty opencode-bale-bot status --json; echo $?    # 4

# Invalid JSON
printf '{ nope' > "$XDG_CONFIG_HOME/opencode-bale-bot/config.json"
chmod 600 "$XDG_CONFIG_HOME/opencode-bale-bot/config.json"
opencode-bale-bot config validate; echo $?                       # 3, one clear error

# Wrong permissions
chmod 644 "$XDG_CONFIG_HOME/opencode-bale-bot/config.json"
opencode-bale-bot config validate; echo $?                       # 3, chmod hint

# Non-loopback OpenCode URL
opencode-bale-bot config set opencode.url http://192.0.2.10:4096
opencode-bale-bot config validate; echo $?                       # 3, loopback error
```

Also confirm that `opencode-bale-bot config list` and `doctor --bundle` redact
the bot token and OpenCode password.

## Upgrade check

```bash
npm install --global opencode-bale-bot@latest
opencode-bale-bot doctor
opencode-bale-bot service restart
opencode-bale-bot status
```

If a release changes `configVersion`, `doctor` must name the file and the
supported version. Re-run `setup` in a copy of the config first.

## Recording a platform pass

Attach the following to the release issue:

- bridge version and Node version;
- OS and version, and the service manager;
- `opencode-bale-bot doctor --json`;
- the completed table above, with any deviation explained;
- relevant log lines with tokens, chat IDs, prompts, and local paths removed.

Do not attach `.env`, `.bale-token`, the full config, or an unreviewed support
bundle.