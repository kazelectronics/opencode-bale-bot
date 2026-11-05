# Security model

The bridge is a local-first relay between one Bale private chat and one local
OpenCode V2 server. It is not a multi-tenant service and is not designed to be
exposed to the internet.

## Trust boundaries

```
Bale cloud  ──HTTPS long poll──►  bridge  ──loopback HTTP──►  OpenCode server
                                     │
                                     └── SQLite + logs + attachments on disk
```

- **Bale is untrusted input.** Every message, callback, attachment, and file
  name is treated as data. Only the configured owner's private chat is obeyed.
- **OpenCode is local and trusted to enforce its own permissions.** The bridge
  never runs arbitrary shell commands from Bale; it asks OpenCode, whose
  permission system decides.
- **The local user is trusted.** Anyone who can read the config, state, or data
  files already controls the machine.

## Authentication and authorization

- `bale.allowedUserId` is a single numeric Bale user ID. Updates from any other
  user, and from non-private chats, are ignored.
- The Bale bot token is the only credential for the Bale side. It is sent in
  the URL path by the Bale API and is redacted from logs.
- OpenCode uses HTTP Basic auth over loopback.
- Callback buttons carry short random tokens bound to a chat and an expiry;
  they are not user IDs or secrets.

## Secret storage

- The config file is written atomically with mode `0600`; its directory is
  `0700`.
- A config file readable by group or others is refused, with a `chmod` hint.
- `bale.tokenFile` and `opencode.passwordFile` are supported so secrets can
  live in a secret manager or a separate `0600` file.
- `--token` and `--opencode-password` are rejected because argv is visible in
  the process list and shell history. Use `--token-stdin`, a file, or the
  interactive prompt.
- Logs redact the token, the OpenCode password, and token-bearing URL paths.
  `config list`, `config get`, and `doctor --bundle` redact them too.

## Network exposure

- OpenCode must be a loopback URL. `setup` rejects anything else.
- The health endpoint binds to a loopback host (`127.0.0.1`, `::1`, or
  `localhost`) on port `4097` by default. It has read-only endpoints; `0`
  disables it entirely.
- There is no inbound webhook, no public TLS listener, and no telemetry.
- The service unit sets `NoNewPrivileges=true`, `PrivateTmp=true`, and
  `UMask=0077`.

## Data at rest

- SQLite stores chat/session bindings, the polling offset, callback tokens, form
  state, and scheduled tasks in the XDG data directory.
- Attachments are written to the data directory, size-checked, and pruned after
  a configurable TTL. They are passed to OpenCode and are not re-served publicly.
- Logs can contain prompts, replies, file names, and paths. Treat them as
  sensitive. Raise the level to `debug` only while diagnosing.

## Destructive actions

Reverts, forks, task deletion, project/worktree changes, and service removal
require explicit confirmation in the chat or on the command line. `stop`
verifies both the PID and the process start token (or the health instance token)
before signalling, so a reused PID cannot be killed by mistake.

## Known limitations

- One Bale chat maps to one active OpenCode session at a time.
- The bridge trusts the local OpenCode server completely.
- Windows is not supported natively; WSL2 is the documented path.
- The health endpoint has no authentication, by design, because it is
  loopback-only. Do not bind it to a non-loopback interface.
- The SDK dependency is BSD-4-Clause; see
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Reporting a vulnerability

Do not open a public issue. Follow [SECURITY.md](../SECURITY.md).