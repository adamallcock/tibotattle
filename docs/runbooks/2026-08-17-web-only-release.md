---
title: Web-only production release lane
date: 2026-08-17
type: runbook
status: active
---

# Web-only production release lane

Use this lane for a generated public-site change that must not carry a macOS
client, Worker-runtime, migration, dependency, or configuration change. It
reuses the already-published signed installer and does not create a client
version bump.

The lane is intentionally commit-bound. `product:web-release:prepare` refuses
a dirty candidate, requires the exact deployed source commit as its base, and
rejects a diff outside the approved public-site closure and release controls.
It generates the site through the normal generator, writes an ignored local
receipt, and does not push or deploy.

The public `release-site-manifest.json` carries hashes of the selected public
source closure but never a private Git SHA. The receipt at
`.release-build/web-release-receipt.json` records the candidate SHA locally;
the deploy command rechecks both before it delegates to the existing immutable
source-snapshot production guard.

## 1. Establish the source boundary

Find the full, 40-character Git commit recorded for the currently deployed
site from the prior deployment receipt or deployment log. Do not infer it from
the current branch, page contents, or a local generated directory. If the
deployed source commit cannot be established, stop and reconstruct that release
evidence before attempting a web-only deployment.

Create a clean, isolated candidate worktree from that commit. Apply only the
reviewed public-site changes, run the focused checks, and commit them. Do not
include a macOS app bump, Worker runtime change, migration, lockfile,
dependency update, or Wrangler configuration change.

`scripts/web-release-lane.js` permits these candidate paths only:

- Explicit public files under `apps/web/public/` that the release-site generator
  can serve.
- The generator, provenance/staging/deployment guards, their focused tests, and
  the release-lane runbooks.

It rejects every other path, including `apps/macos/`, Worker source/runtime
code, migrations, package-lock files, and deployment configuration. If
`package.json` appears in the candidate, the guard also requires every package
field and unrelated script to remain semantically unchanged; only the exact
release-lane script entries are allowed.

## 2. Reuse the existing installer evidence

The site builder still verifies the live HTTPS installer bytes against the
signed release manifest. Supply the already-published DMG and its matching
`.release.json` from the release archive; do not rebuild, sign, upload, tag, or
bump the macOS app. The social image must be an approved, absolute-path
1200×630 PNG outside `.release-build/public-release-site`.

```bash
DEPLOYED_SOURCE_COMMIT="<full deployed source SHA>"
RELEASED_DMG_PATH="/absolute/path/to/TiboTattle-X.Y.Z-macOS-arm64.dmg"
RELEASED_RELEASE_MANIFEST_PATH="${RELEASED_DMG_PATH}.release.json"
SOCIAL_IMAGE_PATH="/absolute/path/to/approved-1200x630.png"

npm run product:web-release:prepare -- \
  --base "$DEPLOYED_SOURCE_COMMIT" \
  --receipt "$PWD/.release-build/web-release-receipt.json" \
  --replace-receipt -- \
  --output "$PWD/.release-build/public-release-site" --replace \
  --site-url "https://tibotattle.com/" \
  --installer-path "$RELEASED_DMG_PATH" \
  --installer-release-manifest "$RELEASED_RELEASE_MANIFEST_PATH" \
  --installer-url "https://github.com/adamallcock/tibotattle/releases/download/vX.Y.Z/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --installer-version X.Y.Z \
  --installer-sha256 "<SHA-256 recorded in the signed release manifest>" \
  --minimum-macos 14.0 --architectures arm64 \
  --release-notes-url "https://tibotattle.com/docs.html" \
  --privacy-url "https://tibotattle.com/privacy.html" \
  --security-url "https://tibotattle.com/docs.html" \
  --support-url "https://tibotattle.com/docs.html" \
  --social-image "$SOCIAL_IMAGE_PATH"
```

The command writes the generated site and local receipt but makes no network
mutation. Keep both until post-deployment verification is complete. The
candidate must remain clean and at the same commit between preparation and
deployment.

## 3. Validate before asking for deployment authority

Run the focused checks from the candidate worktree:

```bash
npm run product:release-site:test
npm run product:web-release:test
node apps/worker/scripts/stage-production-assets.mjs
git diff --check
git status --porcelain=v1 --untracked-files=all
```

The final `git status` must print nothing; generated `.release-build` output is
ignored. Inspect the generated page with the normal local preview workflow and
confirm the installer version, download URL, canonical/social metadata, and
the changed public interaction. Do not treat a generated manifest from another
checkout or a previously built directory as evidence for this candidate.

## 4. Deploy only after explicit production authorization

This is the only web-only deploy entry point. It validates the receipt, repeat
checks the candidate scope, and invokes the production immutable-snapshot and
migration safeguards. It is still a Worker deployment, so it requires the
normal production credentials and explicit authorization.

```bash
npm run product:web-release:deploy -- \
  --receipt "$PWD/.release-build/web-release-receipt.json" \
  --confirm DEPLOY_PRODUCTION
```

Never substitute a raw `wrangler deploy` command: it would bypass the
web-only receipt and source-scope checks. Record the successful source commit,
receipt digest, deploy time, and live smoke-check result as the next deployed
baseline.

## Rollback

Do not deploy an old checkout directly: the scope gate deliberately requires
the candidate to descend from the current deployed base. Instead, make a new,
clean revert commit on top of the current deployed web-only source that changes
only allowed public files. Prepare and authorize it through the same lane,
reusing the same released installer evidence unless an approved client release
also changes it.

This makes each web release and rollback a short, independently reviewable
commit. Other agents can prepare their own candidates in separate worktrees;
release one candidate at a time against the latest recorded deployed base.
