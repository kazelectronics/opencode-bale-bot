# Changelog

## 0.1.0 — Initial release

Initial public release.

### Added

- A Bale Messenger bridge for a local OpenCode V2 server. It uses Bale long
  polling, so it needs no inbound ports, public hostname, or TLS certificate.
- One private Bale chat bound to one OpenCode session, with throttled streaming
  edits and file delivery for long output and code.
- Chat commands for status, sessions, models, agents, compaction, aborting
  runs, file browsing, diffs, message history, revert, fork, project commands,
  and skills.
- Inline permission and form buttons, queued prompt cancellation, and
  following sessions started in the OpenCode TUI.
- File attachments, project and worktree switching, background session
  watches, and scheduled recurring prompts.
- The `setup`, `doctor`, `status`, `logs`, and `config` CLI commands.
- systemd user units on Linux and launchd agents on macOS, with crash
  recovery and log rotation.
- Loopback health endpoints and optional automatic OpenCode restarts.
- SQLite persistence for polling offsets, chat/session bindings, callback
  tokens, and pending interactions.