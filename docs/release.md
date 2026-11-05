# Release runbook

Maintainers only. This is the path from a green working tree to a published npm
package and a GitHub release.

## One-time setup

1. **Confirm the npm name is still free.**

   ```bash
   npm view opencode-bale-bot version
   ```

   A `404`/`E404` means the name is unclaimed. A version number means it is
   taken; stop and choose a scoped name instead.

2. **Create an npm automation token** with publish access to the package. Do not
   use a password or a token with broader access than necessary.

3. **Add the token to GitHub** as the repository secret `NPM_TOKEN`
   (Settings → Secrets and variables → Actions).

4. **Make the repository public.** Before changing visibility, scan the full
   history for tokens, personal paths, and identifiers. If anything sensitive is
   present, rewrite the history or start a fresh public history first. npm
   provenance is verifiable when the source repository is public, and public
   repositories get free standard GitHub Actions runners.

5. **Confirm the legal files** are current: `LICENSE`, `THIRD_PARTY_NOTICES.md`,
   and the clause-3 acknowledgement.

## Versioning

- Use semantic versioning. `0.x` releases may still change configuration.
- Update `CHANGELOG.md` with the release's user-facing changes.
- Update `package.json` `version`. The git tag must match exactly, without the
  leading `v` in `package.json`.

## Preflight

From a clean checkout:

```bash
git status --short          # nothing unexpected
npm ci
npm run verify
npm ci --dry-run
npm audit --omit=dev
```

`verify` runs the typecheck, unit tests, build, pack guard, docs link check,
license check, and the end-to-end test. Then inspect the artifact:

```bash
TARBALL=$(npm pack --silent)
tar -tzf "$TARBALL" | head -40
tar -tzf "$TARBALL" | grep -E '\.map$' && echo "source maps found" && exit 1
rm -f "$TARBALL"
```

Confirm the tarball contains `bin/`, `dist/`, `LICENSE`, `README.md`, and
`THIRD_PARTY_NOTICES.md`, and does not contain `src/`, `tests/`, `docs/`,
`.env`, or any database.

Complete the platform matrix in [testing.md](testing.md) on Linux and macOS, or
confirm that the latest `E2E` workflow run on both operating systems is green.

## Publish

1. Commit the release changes and push `main`. Wait for `CI` and `E2E` to pass.
2. Create and push the tag:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

3. The `Release` workflow:

   - verifies the tag matches `package.json`;
   - runs the typecheck, unit tests, build, pack guard, and end-to-end test;
   - publishes with `--provenance --access public`;
   - creates a GitHub release.

4. To exercise the pipeline without publishing, open **Actions → Release → Run
   workflow** and leave `dry_run` enabled. A manual dry run does not need a tag.

If the workflow fails before `npm publish`, fix the problem and re-run it. Do not
create a second version just to retry a failed preflight.

## Verify the published package

```bash
npm view opencode-bale-bot version
npm view opencode-bale-bot dist-tags
npm audit signatures
```

Then install from the registry in a temporary prefix, not from the working tree:

```bash
PREFIX=$(mktemp -d)
npm install --global --prefix "$PREFIX" opencode-bale-bot@latest
"$PREFIX/bin/opencode-bale-bot" --version
"$PREFIX/bin/opencode-bale-bot" --help > /dev/null
rm -rf "$PREFIX"
```

Check that the published version matches the tag and the changelog. Open the
GitHub release and confirm the source link and provenance are present.

## If something is wrong

- **Wrong metadata, docs, or a non-code problem:** publish a patch release.
- **A broken release that users may install:** deprecate it immediately:

  ```bash
  npm deprecate opencode-bale-bot@0.1.0 "Broken release; use 0.1.1"
  ```

- **Unpublish:** npm only allows unpublishing within 72 hours, and only when the
  package has no dependents. Prefer deprecating and publishing a fix. Unpublishing
  a version that users may already have installed is a last resort.
- **Compromised token:** revoke it in npm, rotate the `NPM_TOKEN` secret, and
  publish a security note.

## Release checklist

- [ ] npm name checked
- [ ] `NPM_TOKEN` present and scoped to publish
- [ ] repository is public
- [ ] repository history scanned for secrets and personal identifiers
- [ ] `CHANGELOG.md` updated for the release version
- [ ] `npm ci` and `npm run verify` pass locally
- [ ] `npm ci --dry-run` passes
- [ ] tarball contents inspected; no source maps, secrets, or source
- [ ] Linux manual matrix complete
- [ ] macOS manual matrix complete
- [ ] `CI` and `E2E` green on `main`
- [ ] tag pushed and `Release` green
- [ ] registry install checked in a temporary prefix
- [ ] GitHub release and provenance verified