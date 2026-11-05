# Contributing

Thanks for helping. This is a small, opinionated project; the fastest way to get
a change merged is to keep it focused and add a test.

## Requirements

- Node.js **22.13 or newer**
- Linux or macOS
- An OpenCode **V2** server for manual testing
- A Bale bot and a private test chat for manual end-to-end checks

## Setup

```bash
git clone git@github.com:kazelectronics/opencode-bale-bot.git
cd opencode-bale-bot
npm ci
npm run verify
```

Run the daemon from source:

```bash
npm run dev
```

Create a local config with `node bin/opencode-bale-bot.js setup --config
/tmp/bale-test/config.json` rather than committing a `.env`.

## What good changes look like

- One concern per pull request.
- A test for every behavior change. Pure logic belongs in a unit test; config,
  CLI, and service behavior belongs in the existing suites.
- No secrets, personal paths, real tokens, or chat IDs in code, tests, docs, or
  fixtures.
- Match the surrounding style: small modules, explicit types on exported
  surfaces, no unnecessary dependencies.
- Update the relevant document when behavior changes. The user-facing docs are
  in `docs/`, and the README is the front door.

## Checks that must pass

```bash
npm run typecheck
npm test
npm run build
npm run pack:check
npm run docs:check
npm run licenses:check
npm run test:e2e
```

Or run all of them with `npm run verify`. The e2e script starts mock Bale and
OpenCode servers and runs the real CLI: setup, doctor, daemon start, a `/help`
reply, status, and shutdown. It needs no network access.

Before a release, also complete the platform matrix in
[docs/testing.md](docs/testing.md).

## Commit messages

Use the imperative mood and a short scope:

```text
config: reject group-readable files
service: enable lingering on install
cli: add --json to status
```

Explain the *why* in the body when the change is not obvious.

## Tests

- `tests/config.test.ts`, `tests/configFile.test.ts` — precedence, paths,
  atomic writes, permissions.
- `tests/setup.test.ts` — setup and doctor against mock servers.
- `tests/*.test.ts` — router, renderer, callbacks, forms, menus, attachments,
  outbox, database, CLI, service, and feature suites.

Do not weaken a test to make a change pass. If a test encodes the bug, fix the
test and say so in the pull request.

## Documentation

The full index is [docs/index.md](docs/index.md). The main pages are:

- `README.md` — install, commands, configuration summary, security.
- `docs/quickstart.md` — first run.
- `docs/configuration.md` — every key and environment variable.
- `docs/troubleshooting.md` — symptoms and fixes.
- `docs/security.md` — trust boundaries and limitations.
- `docs/how-it-works.md` — components, message flow, and state.
- `docs/testing.md` — automated checks and the Linux/macOS matrix.
- `docs/release.md` — npm publishing and rollback.

Run `npm run docs:check` after editing Markdown. It verifies relative links,
checks that every page in `docs/` is reachable from the index, and rejects
personal paths.

## Releasing

Maintainers only. The full runbook is [docs/release.md](docs/release.md).

In short:

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Run `npm ci && npm run verify`, then complete the Linux and macOS matrix in
   [docs/testing.md](docs/testing.md).
3. Commit and push `main`; wait for `CI` and `E2E` to pass.
4. Tag and push:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

5. The `Release` workflow verifies the tag matches `package.json`, runs the
   checks again, publishes with `--provenance --access public`, and creates a
   GitHub release. It needs an `NPM_TOKEN` repository secret with publish access
   to the `opencode-bale-bot` package.

Use `workflow_dispatch` with `dry_run` enabled to exercise the pipeline without
publishing.

## License

By contributing you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE). The Bale Bot SDK is BSD-4-Clause; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).