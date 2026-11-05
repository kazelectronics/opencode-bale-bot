---
name: Bug report
about: Something does not work as documented
title: ""
labels: bug
assignees: ""
---

## What happened

A clear description of the problem.

## Expected behavior

What you expected instead.

## Steps to reproduce

1.
2.
3.

## Environment

- Bridge version (`opencode-bale-bot --version`):
- Node version (`node --version`):
- OS and version:
- Install method (global npm / npx / source):
- Service manager (systemd / launchd / foreground):

## Diagnostics

Run `opencode-bale-bot doctor` and paste the summary. If you can, run
`opencode-bale-bot doctor --bundle` and attach the bundle **after reviewing it**:
it redacts secrets, but it may still contain paths and model names.

```text

```

## Logs

Relevant lines from `opencode-bale-bot logs --lines 200`. Remove tokens, chat
IDs, prompts, and any personal data before posting.

```text

```

## Additional context

Anything else that might help.