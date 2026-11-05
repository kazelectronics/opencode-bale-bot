# Security policy

## Supported versions

The project is pre-1.0. Security fixes are released on the latest `0.x`
version. There are no maintained backports.

## Reporting a vulnerability

Please **do not** open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting:

1. Open <https://github.com/kazelectronics/opencode-bale-bot/security/advisories/new>.
2. Describe the impact, the affected version, and the smallest reproduction you
   can share.
3. Include the output of `opencode-bale-bot doctor --bundle` if it is relevant.
   It redacts the bot token and OpenCode password, but review it before sending.

You can expect an acknowledgement within a few days. Please allow time for a fix
and a release before public disclosure.

## Scope

In scope:

- leaks of the Bale bot token or OpenCode password (logs, config output, argv,
  support bundles, error messages);
- authorization bypasses that let a user other than `bale.allowedUserId`
  control the bridge;
- path traversal or arbitrary file access through attachments, `/show`, `/ls`,
  or worktrees;
- command execution that bypasses OpenCode's permission system;
- unsafe service units or predictable temp/lock files;
- dependency vulnerabilities with a practical exploit path.

Out of scope:

- the security of OpenCode itself or of the models you choose;
- Bale platform behavior, rate limits, or outages;
- running the bridge with a non-loopback OpenCode URL, a public health bind, or
  a world-readable config;
- Windows outside WSL2;
- denial of service from a local user who can already read your files.

## Safe defaults the project promises

- Config is written atomically with mode `0600`; a looser mode is refused.
- Secrets never appear in `config list`, `config get`, logs, or `doctor
  --bundle`.
- `--token` and `--opencode-password` are rejected in favor of files/stdin.
- Only the configured owner, in a private chat, is obeyed.
- The health endpoint is loopback-only and read-only.
- `stop` verifies PID start tokens or an instance token before signalling.

See [docs/security.md](docs/security.md) for the full model.