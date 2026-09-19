---
title: Web-only production release lane
date: 2026-08-17
type: runbook
status: maintained
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
- The canonical message catalogue `packages/i18n/index.js`, paired with its
  regenerated browser mirror `apps/web/public/i18n.generated.js`.

It rejects every other path, including `apps/macos/`, Worker source/runtime
code, migrations, package-lock files, and deployment configuration. No other
file under `packages/` is admitted: not `packages/i18n/index.d.ts`, not the
package manifest, and no other workspace package. If `package.json` appears in
the candidate, the guard also requires every package field and unrelated script
to remain semantically unchanged; only the exact release-lane script entries are
allowed.

### Site copy changes

Site copy lives in the canonical catalogue, so a copy change edits
`packages/i18n/index.js` first, updates every shipped locale, and then
regenerates the mirror with `npm run i18n:browser:generate`. Never hand-edit
`apps/web/public/i18n.generated.js`: the generator overwrites it and the lane
refuses it. Commit both files in the same candidate.

The lane proves that pairing rather than trusting it. It refuses a candidate
that:

- changes `packages/i18n/index.js` without its regenerated mirror, or the mirror
  without a matching canonical change;
- ships a mirror that does not match the canonical source, checked by running
  the generator's own `--check` comparison against both blobs at the candidate
  commit, not by a restatement of it;
- leaves a shipped locale incomplete, checked with the i18n package's own
  exported `assertCatalogCompleteness` contract: every locale carries the exact
  canonical key set, non-blank values, and the same placeholder names;
- changes anything in `packages/i18n/index.js` other than literal top-level
  catalogue entries. Negotiation, formatting, interpolation and the completeness
  contract itself must stay byte-identical to the deployed base, so runtime code
  cannot ride along with copy.

These proofs run at both ends of the receipt: preparation cannot write a receipt
without them, and `product:web-release:deploy` repeats them before it delegates
to the production guard. A change to i18n runtime code, the package typings, or
any other workspace package is not a web-only release; take it through the
normal review and release path.

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
npm run i18n:browser:check
node apps/worker/scripts/stage-production-assets.mjs
git diff --check
git status --porcelain=v1 --untracked-files=all
```

`i18n:browser:check` covers the checked-out mirror whether or not this candidate
touched it; the lane's own proof is scoped to the candidate diff.

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

The receipt's exact `baseCommit` is forwarded as the reviewed production
predecessor. Under the shared deployment lock, live health must still name that
base before Wrangler starts. A newer deployment makes this receipt stale: merge
the intended changes onto the new base and requalify, never auto-adopt live
source or bypass the guard. Interrupted outcomes use the production operation
journal and [explicit recovery procedure](production-operations.md#guarded-deployment-wrapper).

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

## Reviewed Electron stable downloads

For a four-target normal Electron release, use the same public-site generator
with `--electron-publication-plan`, `--electron-publication-root`, and
`--electron-approved-plan-sha256`. These inputs exclude every native installer
argument. The digest is the maintained `identityDigest(plan)` of the separately
reviewed final stable publication plan; it is not the raw JSON file digest.
The artifact root contains the plan's relative local paths. Do not put either
input under the public source or inside the generated output.

The site intake consumes that approved plan independently of the website
checkout's package version. It verifies the stable origin, four targets, exact
installer names, and every bound local artifact/feed byte, then verifies each
public installer over HTTPS. It does not package, sign, notarize, publish feeds,
or reperform the separate native-trust/source review. The public site manifest
records only download metadata and verification scope, never the private plan
or its local paths. Native 0.1.18 generation remains unchanged.

Publish the exact canonical GitHub release assets before generating a production
site. Every manual download button uses the exact GitHub release URL, and the
site generator independently verifies its HTTPS bytes against the reviewed
plan digest and size. The updates.tibotattle.com origin is reserved for app
updater transport; never use its object URLs for manual website downloads.

The download section uses compact platform buttons, requirements, a discreet
checksum-copy control and accurate platform trust descriptions. It shows no
file size or migration procedure. Docs explains normal Mac replacement and
automatic retained-state transfer for 0.1.20 or later. The 0.1.21 docs also
describe native 0.1.18 Check for Updates; publish those instructions only after
the signed native journey passes and its stable Sparkle feeds are activated.
Keep the Homebrew shortcut absent until the tap points
to a qualified automatic-replacement release, rather than the older native app.

A test-injected verifier may explicitly return `published: false` for a local
preview using the frozen local bytes. Such output displays a preview warning
and records `publishedInstallersVerified: false`; it is not a production
publication receipt. The ordinary CLI always uses real HTTPS verification.

The web-only scope admits the explicit Electron intake helper/test. The
`electron.site.*` download strings are ordinary catalogue copy and follow the
canonical-then-regenerate rule above, with the same paired mirror and
completeness proofs; runtime code in that shared file still fails admission. A
local-preview manifest is refused by the web-release receipt writer.

Refresh the social share card before an Electron-mode build. It is the
og:image/twitter:image for every link preview of the site, and its headline
figure is a published estimate that moves daily, so it goes stale on its own
between releases:

```bash
npm run product:social-preview -- \
  --output "$PWD/.release-build/social-preview/social-preview.png" --replace
```

It renders the live homepage with local headless Chrome and refuses to write a
card whose allowance figure had not loaded, or whose page still advertises the
download as unavailable. Pass its absolute output path as `--social-image`.

`--social-image` accepts exactly two reviewed shapes, chosen by the PNG's own
dimensions. A 1200×630 render keeps the `summary_large_image` Twitter card, the
1200×630 Open Graph dimensions and the source-owned alt text; this is the shape
X/Twitter renders as a full-width card and is the expected input. A 1024×1024
image is the fallback for a publication with no fresh render: the generator
verifies those bytes against `tibotattle-icon.png` and emits square Open Graph
dimensions, logo alt text and a summary Twitter card, which previews only as a
small thumbnail. Every other size, a non-PNG, or an oversize file is refused, so
an older native-version screenshot still cannot reach the site. Either file must
sit outside the source and output roots. Native generation is unchanged and
always requires the 1200×630 card.

Retained-state admission uses the app's schema compatibility check;
users do not need an intermediate native version or a preserved predecessor
executable. The 0.1.19 release cannot use these automatic-upgrade instructions.


The exact public evidence controls `config/release-evidence.js`,
`schemas/release-evidence-v1/manifest.schema.json`, the descriptor/policy/output
modules under `scripts/release-evidence-*.js`, and their owning test are admitted
for release evidence compatibility. These are tooling inputs, with no app,
Worker or package-runtime imports. This does not admit deployment configuration,
app/runtime source, other configuration files or unrelated schemas.
