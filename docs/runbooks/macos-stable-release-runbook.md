---
title: macOS stable release
date: 2026-08-18
type: runbook
status: maintained
---

# macOS stable release runbook (canonical)

This is the macOS-specific half of the stable release procedure. The publication
order, evidence contract, and cross-platform gates are in
[2026-08-18-cross-platform-release-publication.md](./2026-08-18-cross-platform-release-publication.md).
Do both documents in order. Placeholders: X.Y.Z = new version and P.Q.R =
previous stable version.

> Secrets (the appcast guard token, its storage location, and exact retrieval
> commands) are intentionally **not** in this file. They live in the gitignored
> docs/runbooks/release-secrets.local.md on the release machine.
>
> **Receipt boundary:** `*.dmg.release.json` is a sanitized macOS finalizer
> receipt. The guarded Sparkle publisher intentionally stores its bytes under a
> content-addressed R2 key named `release-manifest.json` so the signed updater
> subject can be read back. That narrow updater publication is separate from
> the canonical cross-platform `release-manifest.json` and general public
> evidence. Never publish credentials, signing logs, raw local paths, staging
> descriptors, or unrelated receipts to R2, GitHub, or the website.

---

## 0. Version lockstep and preflight

A version bump is **not** just package.json. Bump or regenerate all of:

1. package.json and
   packages/{accounting,identity-core,quota-analysis,telemetry-contract}/package.json
   to X.Y.Z. (apps/worker and packages/i18n have independent versions).
2. schemas/telemetry-v0.1/compatibility.schema.json to
   "packageVersion": { "const": "X.Y.Z" }.
3. The generated telemetry artifacts with npm run telemetry:generate, then
   commit generated/telemetry-v0.1-compatibility.json and
   generated/telemetry-v0.1-field-dictionary.json.
4. apps/worker/worker-configuration.d.ts if it drifts, using the repository's
   pinned Wrangler command.
5. The worker workspace copies with cd apps/worker && npm ci; they are copies,
   not symlinks, and stale copies make the worker check and bundle use old
   package versions.
6. `release-notes/X.Y.Z.md` with the reviewed user-facing release body, and a
   dated `CHANGELOG.md` entry linking to it. The entry must link the future
   GitHub Release, annotated source tag, and exact previous-tag comparison.
   Add only publicly verifiable PR/issue credits, label source-only or open
   boundaries explicitly, and move shipped items out of `Unreleased`. Do not
   reconstruct claims or attribution that were not validated.

Run the release preflight before tagging:

~~~bash
node scripts/check-release-notes.mjs
npm test
npm run codex:contract:release:check
npm run product:worker:check
npm run architecture:check
cd apps/worker && npx vitest run
~~~

Known pre-existing non-blockers are recorded in release planning documents. Do
not silently treat a new failure as one of those non-blockers. If a failure is
not on that list, it is a real failure — the 0.1.13 preflight found four that
were not, and all four were genuine.

**Read the summary line, never `$?` after a pipe.** `npm test`, and the R7
regenerator, both report failure in their output and exit non-zero, but a
trailing `| tail`, `| grep`, or `; tail` gives you the FORMATTER's status
instead. This produced a false "exit 0" over a suite with `fail 4` during the
0.1.13 preflight, and independently masked a `command not found` in another
session the same afternoon. Capture it explicitly:

~~~bash
npm test > preflight.log 2>&1; ec=$?
grep -E "^ℹ (tests|pass|fail)" preflight.log; echo "exit=$ec"
~~~

Expect `fail 0`. A green-looking terminal is not a green suite.

**The failure class to expect after a batch of merges** is a *pin* that was
never updated: a reviewed public-API list, a pinned action SHA, a byte-identity
digest, a root-workspace allowlist, or an exact `deepEqual` on an exported
policy object. These live far from whatever code changed — which is exactly why
they pass review and why suites selected for proximity to the diff cannot catch
them. Update each pin deliberately, recording in a comment which reviewed change
it blesses, and check every module surface that shares the list before editing:
in 0.1.13 the obvious one-line fix would have turned a red test green while
breaking a passing one, because a legacy module deliberately did not re-export
the new constant.

## 1. Exact source and protected tag

The macOS finalizer requires an empty tree (including untracked files) and an
exact annotated tag. The tag must identify the reviewed release commit and be
protected by the repository's version-tag rules.

The sole historical exception is the pre-policy `v0.1.10` published ref. It is
a protected lightweight tag at
`3b3a852abad643095c296550a827ed448b3720fa`, while the v0.1.10
version-bump source is `151adec996c9a0f621819f89777ac5a05f1df8b6`. The release
documentation checker accepts only that exact pair and reports it separately
from annotated tags. This closed exception does not authorize another
lightweight tag: every new stable tag must remain annotated and protected.

~~~bash
git status --porcelain=v1 --untracked-files=all   # must print nothing
git describe --exact-match --tags HEAD             # must print vX.Y.Z
git tag -a vX.Y.Z <reviewed-commit> -m "TiboTattle X.Y.Z ..."
git push origin vX.Y.Z
~~~

Do not sign from a branch that is ahead of or different from the tag. The
source identity later recorded in the release evidence descriptor must be the
same version, tag, commit, and repository URL.
The stable release gate accepts only the exact annotated `vX.Y.Z` tag for the
bundle's short version. An internal-dogfood source tag, lightweight tag, tag
alias, dirty checkout, or second matching stable version tag is not a stable
release source.

## 2. Build, sign, notarize, staple, and freeze the DMG

--external-distribution is refused by the build CLI by design. Drive the
release through release-macos-app --prepare-candidate. Delete only a stale,
known candidate directory first; the finalizer refuses a non-fresh output.
The exact Developer ID and notary-profile values are in
docs/runbooks/release-secrets.local.md; the Sparkle public key is public by
design.

~~~bash
rm -rf .release-build/macos-production
export USAGE_MONITOR_DEVELOPER_ID_APPLICATION="Developer ID Application: … (…)"
export USAGE_MONITOR_NOTARY_PROFILE="…"
export USAGE_MONITOR_BUNDLE_VERSION="1024"
export USAGE_MONITOR_SPARKLE_FRAMEWORK=".release-deps/Sparkle.framework"
export USAGE_MONITOR_SPARKLE_APPCAST_URL="https://updates.tibotattle.com/appcast.xml"
export USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY="jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw="

node scripts/release-macos-app.js \
  --app ".release-build/macos-production/TiboTattle.app" \
  --channel stable \
  --prepare-candidate \
  --previous-stable-manifest "<path to P.Q.R .release.json>"
~~~

For the 0.1.17 stable release, `CFBundleShortVersionString` remains `0.1.17`
and the owner-reviewed signed `CFBundleVersion` is exactly `1024`. It follows
the isolated 0.1.17 dogfood allocation `1023` and the last shared-identity
dogfood build `1022`. The checked-in allocation is authoritative; the
`USAGE_MONITOR_BUNDLE_VERSION` value above is only an exact assertion and
cannot select or override a different build. A future stable version must add
and test a new monotonic channel allocation before the release path will run.
The separate `TiboTattle Preview.app` identity may use the deterministic
preview epoch (`2000.1.17` for 0.1.17); it does not participate in stable
Sparkle ordering.

Codesign may prompt for Keychain access once; choose **Always Allow** on the
release machine. The finalizer validates Developer ID signing, hardened
runtime, notarization, stapling, Gatekeeper, and clean installation. It emits
the final arm64 DMG at:

~~~text
.release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg
~~~

Read the minimum OS out of the bundle now, and use only this value afterwards:

~~~bash
/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" \
  .release-build/macos-production/TiboTattle.app/Contents/Info.plist
~~~

It is typed by hand in two places later — the "Requires macOS N or later" line
in `release-notes/X.Y.Z.md`, and `--minimum-macos` in the release-site command
of step 7 — and neither is checked against the bundle by any test. The 0.1.13
notes shipped "macOS 13" against a bundle declaring 14.0 and were caught only
because the evidence descriptor was filled from the artifact rather than from a
previous release's template. Get this wrong in the low direction and a reader
on an unsupported macOS downloads an app that cannot launch, then reports the
app as broken rather than themselves as unsupported. Copy the number from the
command above into both places; never carry it forward from a template.

At this point the DMG is the final subject. Record its SHA-256 and freeze the
bytes. Do not re-sign, repackage, compress, mount-and-edit, or otherwise mutate
the DMG after this point. Any mutation requires restarting this section and all
following evidence steps.

The local macOS finalizer's sanitized *.dmg.release.json updater receipt is useful for
local/site validation, but it is **not** a GitHub build attestation. A local
checkout cannot honestly claim that GitHub Actions built these bytes. Do not
create a fake Sigstore bundle, copy a local receipt into an attestation field,
or describe this local output as source-to-binary proven. A genuine GitHub
artifact attestation can only be made by the protected GitHub native finalizer
after that trusted workflow has built and finalized the exact bytes from the
checked-out source. Merely receiving a locally built DMG and attesting its
digest does not establish source-to-binary provenance; see the cross-platform
publication runbook.

## 3. Generate the signed updater metadata, without publishing it

Generate the complete Sparkle appcast while the DMG is frozen. Appcast
generation signs the feed metadata; it must not alter the DMG.

~~~bash
npm run product:macos:appcast -- \
  --channel stable \
  --app ".release-build/macos-production/TiboTattle.app" \
  --dmg ".release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --bundle-version "X.Y.Z" \
  --sparkle-public-ed-key "jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw="
~~~

This uses the pinned generate_appcast and embeds the feed signature required by
the installed client's SURequireSignedFeed=true. A hand-built minimal appcast
is not a valid updater subject.

Do **not** run the publishing command yet. The appcast is carried as updater
metadata in the release evidence descriptor and is published only after the
draft release has been freshly downloaded and verified.

## 4. Native finalizer evidence and the public manifest

Every official macOS artifact is represented by a v1 manifest entry. Its
`sbom` and `provenance` fields may be `null`; if `sbom` is non-null, its
`attestation` field is required and may also be `null`. `null` explicitly means
that the corresponding evidence was not published. For an artifact claiming
the attested v1 profile/path, the protected GitHub native finalizer must
produce, for this exact frozen DMG subject:

- an SPDX JSON SBOM;
- a Sigstore provenance bundle;
- a Sigstore SBOM-attestation bundle;
- the final release-evidence descriptor naming those files and the
  source/tag identity; and
- updater metadata for this direct-download subject.

The checked-in attestation action and its required permissions are specified in
[2026-08-18-cross-platform-release-publication.md](./2026-08-18-cross-platform-release-publication.md).
The finalizer must run the action against final bytes after signing,
notarization, stapling, packaging, and timestamp operations are complete. A
post-attestation mutation invalidates the evidence and requires a new finalizer
run.

If the protected finalizer has not produced and cryptographically verified all
three evidence files, do not claim the attested v1 profile/path. The existing
local macOS route may still publish a v1 manifest with explicit `null` evidence
fields and carry native signing and checksum evidence for its exact DMG, but it
must not be described as source-to-binary attested. That provenance claim is
valid only when a trusted hosted workflow generated/finalized and verified the
exact final bytes.

For the attested v1 profile/path, invoke the checked-in composite exactly once
for this frozen DMG. It derives signer identity from the trusted hosted job
context; the caller passes no signer fields. It runs both pinned
`actions/attest` steps (SLSA provenance and the SPDX `sbom.attestation`) and
preserves artifact-specific bundle names; do not add a second caller step:

~~~yaml
- name: Attest the frozen final subject
  id: attest
  uses: ./.github/actions/attest-release-artifact
  with:
    artifact-path: <final-artifact>
    sbom-path: <artifact.spdx.json>
    evidence-directory: <evidence-directory>
    release-descriptor-path: <release-evidence-input.json>
~~~

Once those files are present in one staging directory, generate the canonical
public manifest with the repository's actual offline CLI. For the attested v1
path, consume the composite's machine-generated outputs:
`steps.attest.outputs.enriched-release-descriptor-path` and
`steps.attest.outputs.enriched-release-descriptor-base-dir`. The first is the
descriptor passed to `--input`; the second is passed to `--base-dir`. Do not
hand-author bundle, signer, predicate, builder, run, or runner metadata. If the
outputs are absent, stop publication. For a native/checksum-only local path,
use the original staging descriptor and its staging directory instead.
Descriptor paths are resolved relative to `--base-dir` and are never serialized
as absolute operator paths.

~~~bash
RELEASE_DIR="$PWD/.release-build/macos-release"
# For the protected attested path, these values come from the composite action:
# steps.attest.outputs.enriched-release-descriptor-path and
# steps.attest.outputs.enriched-release-descriptor-base-dir.
EVIDENCE_INPUT="<steps.attest.outputs.enriched-release-descriptor-path>"
EVIDENCE_BASE_DIR="<steps.attest.outputs.enriched-release-descriptor-base-dir>"
RELEASE_MANIFEST="$RELEASE_DIR/release-manifest.json"
SHA256SUMS="$RELEASE_DIR/SHA256SUMS"

npm run release:evidence:generate -- \
  --input "$EVIDENCE_INPUT" \
  --base-dir "$EVIDENCE_BASE_DIR" \
  --output "$RELEASE_MANIFEST" \
  --sha256sums "$SHA256SUMS"

npm run release:evidence:validate -- \
  --manifest "$RELEASE_MANIFEST" \
  --artifacts-dir "$RELEASE_DIR" \
  --sha256sums "$SHA256SUMS"
~~~

The generator recomputes every supplied final-file digest and requires any
non-null SBOM, `sbom.attestation`, and provenance subject digests to equal the
DMG digest. It always emits the v1 evidence keys; explicit `null` values are
valid for a native/checksum-only path. It also requires the platform assurances
and updater contract for macOS/direct. Treat a supplied-but-invalid value as a
release stop. The canonical manifest, any non-null SBOM, and any non-null
artifact-specific bundles are GitHub release assets; the descriptor itself may
contain local paths and should remain staging input.

## 5. Draft GitHub release and verify it before publication

Create a **draft** release and upload only public release assets. Every macOS
direct subject includes the final DMG, `release-manifest.json`, `SHA256SUMS`,
`verify-release.md`, **and `appcast.xml`**. For the attested v1 profile/path,
also upload the SPDX SBOM and both artifact-specific Sigstore bundles; for a
native/checksum-only path, keep those manifest fields `null` and do not upload
placeholder bundles. Do not upload the sanitized Sparkle receipt, local
descriptor, credentials, or a staging directory as general GitHub evidence.

`appcast.xml` is not optional here, and leaving it out is not a cosmetic
omission. Whenever `updater.enabled` is true, the manifest records the appcast
as the updater subject and `SHA256SUMS` carries its digest, so a release
without it fails the verification this repository itself documents:

~~~text
RELEASE_EVIDENCE_FILE_UNAVAILABLE: ... updater metadata is missing ...
~~~

A plain `shasum -a 256 -c SHA256SUMS` also reports a FAILED line. This is the
same bytes published to R2 in step 7 — publishing it here makes the GitHub
release self-verifying rather than dependent on the feed host. Verified on
0.1.13: with the four-asset set the documented `release:evidence:validate` run
against a fresh `gh release download` exits 1; adding `appcast.xml` makes the
identical command return `RELEASE_EVIDENCE_VALID`.

Note that 0.1.11 and 0.1.12 published the DMG alone, so 0.1.13 is the first
release to carry the evidence assets at all. Do not treat an older release's
asset list as the reference.

### Gate: never enumerate the asset list by hand again

The defect above was not really a missing file. It was two lists that had to
agree by hand — what `SHA256SUMS` carries digests for, and what actually gets
uploaded — diverging silently until somebody walked the documented path. Run
this against the draft instead of trusting the prose above:

~~~bash
comm -23 \
  <(awk '{print $2}' "$SHA256SUMS" | sort) \
  <(gh release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name' | sort)
~~~

It must print nothing. Anything it prints is an evidence entry whose bytes are
not published, which fails `release:evidence:validate` for every downloader.

Run the converse too, because subset alone cannot see an asset published with
**no** digest row — an unverifiable download, which is the worse direction:

~~~bash
comm -13 \
  <(awk '{print $2}' "$SHA256SUMS" | sort) \
  <(gh release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name' | sort) \
  | grep -vxF -e verify-release.md -e SHA256SUMS
~~~

Also must print nothing. Exactly two assets legitimately carry no digest row:
`verify-release.md`, which is guidance rather than evidence, and `SHA256SUMS`
itself, which cannot contain its own digest. Keeping that allowlist explicit is
the point — a future asset (a `.pkg`, a standalone binary) then forces a
decision, digest it or allowlist it, instead of silently defaulting to
unverifiable.

This matters beyond the appcast, because `buildSha256Sums` adds rows for **five
conditional subjects**, and only the updater one has ever been exercised:

| Row | Condition |
| --- | --- |
| `release-manifest.json` | always |
| the artifact itself | always |
| `artifact.store.receipt` | `store !== null` |
| `artifact.sbom` | `sbom !== null` |
| `artifact.sbom.attestation` | `sbom.attestation !== null` |
| `artifact.provenance` | `provenance !== null` |
| `artifact.updater.metadata` | `updater.enabled` |

Each conditional row is an independent chance to reintroduce exactly this bug
the first time that path is taken. The `comm` gate catches all of them without
anyone having to remember which flags are on.

~~~bash
TAG="vX.Y.Z"
REPO="adamallcock/tibotattle"
DMG="$RELEASE_DIR/TiboTattle-X.Y.Z-macOS-arm64.dmg"
ARTIFACT_NAME="$(basename "$DMG")"
SPDX="$RELEASE_DIR/TiboTattle-X.Y.Z-macOS-arm64.spdx.json"
SPDX_NAME="$(basename "$SPDX")"
PROVENANCE="$RELEASE_DIR/$ARTIFACT_NAME.provenance.bundle.json"
PROVENANCE_NAME="$(basename "$PROVENANCE")"
SBOM_ATTESTATION="$RELEASE_DIR/$ARTIFACT_NAME.sbom.bundle.json"
SBOM_ATTESTATION_NAME="$(basename "$SBOM_ATTESTATION")"
VERIFY_GUIDE="$PWD/docs/verify-release.md"
NOTES_FILE="./release-notes/X.Y.Z.md"
test -s "$NOTES_FILE"

gh release create "$TAG" --repo "$REPO" --verify-tag --draft \
  --title "TiboTattle X.Y.Z" --notes-file "$NOTES_FILE"
# Use this baseline upload for a native/checksum-only manifest (null evidence):
gh release upload "$TAG" --repo "$REPO" \
  "$DMG" "$RELEASE_MANIFEST" "$SHA256SUMS" "$VERIFY_GUIDE"

# For the attested v1 profile/path, use this command instead:
gh release upload "$TAG" --repo "$REPO" \
  "$DMG" "$SPDX" "$PROVENANCE" "$SBOM_ATTESTATION" \
  "$RELEASE_MANIFEST" "$SHA256SUMS" "$VERIFY_GUIDE"
~~~

Download every asset into a fresh directory. During the draft phase, verify the
local final bytes, manifest, and SHA256SUMS; do not call gh release verify or
gh release verify-asset yet because GitHub's immutable-release attestation is
created only when the draft is published.

~~~bash
VERIFY_DIR="$(mktemp -d /tmp/tibotattle-release-XXXXXX)"
gh release download "$TAG" --repo "$REPO" --dir "$VERIFY_DIR"

npm run release:evidence:validate -- \
  --manifest "$VERIFY_DIR/release-manifest.json" \
  --artifacts-dir "$VERIFY_DIR" \
  --sha256sums "$VERIFY_DIR/SHA256SUMS"
~~~

For the attested v1 profile/path only, run the two separate constrained
attestation commands below, using the repository, exact protected tag/source
commit, signer workflow, and signer digest recorded by this release. Include
`--deny-self-hosted-runners`; an unconstrained attestation is not equivalent
evidence. GitHub may not resolve a draft attestation until publication, but a
bundle or source-identity failure remains a publication gate. A draft is never
a stable release. A native/checksum-only path does not run these commands and
must retain explicit `null` evidence fields.

~~~bash
COMMIT="<40-character source commit from the release manifest>"
SIGNER_WORKFLOW="<signer workflow path from the release manifest>"
SIGNER_DIGEST="<trusted signer-workflow commit from the release manifest>"

gh attestation verify "$VERIFY_DIR/$ARTIFACT_NAME" \
  --bundle "$VERIFY_DIR/$PROVENANCE_NAME" \
  --repo "$REPO" \
  --predicate-type "https://slsa.dev/provenance/v1" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --signer-digest "$SIGNER_DIGEST" \
  --source-ref "refs/tags/$TAG" \
  --source-digest "$COMMIT" \
  --deny-self-hosted-runners

gh attestation verify "$VERIFY_DIR/$ARTIFACT_NAME" \
  --bundle "$VERIFY_DIR/$SBOM_ATTESTATION_NAME" \
  --repo "$REPO" \
  --predicate-type "https://spdx.dev/Document/v2.3" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --signer-digest "$SIGNER_DIGEST" \
  --source-ref "refs/tags/$TAG" \
  --source-digest "$COMMIT" \
  --deny-self-hosted-runners
~~~

`--bundle` reads the attestation bundle from the downloaded file instead of
fetching that bundle through the GitHub API; trusted-root resolution may still
use the normal GitHub CLI/network trust path.

## 6. Publish, read back, and verify the immutable release

After all draft assets pass fresh verification, publish and read the release
back. The repository's immutable-release setting must be enabled before the
first stable publication.

~~~bash
gh release edit "$TAG" --repo "$REPO" --draft=false
gh release view "$TAG" --repo "$REPO" \
  --json tagName,isDraft,isImmutable,assets
test "$(gh release view "$TAG" --repo "$REPO" --json tagName --jq '.tagName')" = "$TAG"
test "$(gh release view "$TAG" --repo "$REPO" --json isDraft --jq '.isDraft')" = "false"
test "$(gh release view "$TAG" --repo "$REPO" --json isImmutable --jq '.isImmutable')" = "true"
~~~

Confirm that the published UTC calendar date matches the `CHANGELOG.md`
heading, the published body matches `release-notes/X.Y.Z.md` apart from a
conventional terminal newline, and every release/tag/comparison/reference link
opens the intended public record. Do not convert a related issue into a closed
claim unless GitHub shows it closed.

Now run GitHub's release-level checks for the published release. Download every
published asset again into a new directory; never reuse the draft download for
this read-back. These are deliberately post-publication checks: gh release
verify and gh release verify-asset validate GitHub's immutable-release
attestation, not just the draft's local bytes.

~~~bash
PUBLISHED_VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tibotattle-published-release.XXXXXX")"
gh release download "$TAG" --repo "$REPO" \
  --dir "$PUBLISHED_VERIFY_DIR" --pattern "*" --clobber
npm run release:evidence:validate -- \
  --manifest "$PUBLISHED_VERIFY_DIR/release-manifest.json" \
  --artifacts-dir "$PUBLISHED_VERIFY_DIR" \
  --sha256sums "$PUBLISHED_VERIFY_DIR/SHA256SUMS"

gh release verify "$TAG" --repo "$REPO"
gh release verify-asset "$TAG" "$PUBLISHED_VERIFY_DIR/$ARTIFACT_NAME" --repo "$REPO"
gh release verify-asset "$TAG" "$PUBLISHED_VERIFY_DIR/release-manifest.json" --repo "$REPO"
gh release verify-asset "$TAG" "$PUBLISHED_VERIFY_DIR/SHA256SUMS" --repo "$REPO"
gh release verify-asset "$TAG" "$PUBLISHED_VERIFY_DIR/verify-release.md" --repo "$REPO"
~~~

For an attested v1 profile/path, also verify each published evidence asset:

~~~bash
gh release verify-asset "$TAG" "$PUBLISHED_VERIFY_DIR/$SPDX_NAME" --repo "$REPO"
gh release verify-asset "$TAG" "$PUBLISHED_VERIFY_DIR/$PROVENANCE_NAME" --repo "$REPO"
gh release verify-asset "$TAG" "$PUBLISHED_VERIFY_DIR/$SBOM_ATTESTATION_NAME" --repo "$REPO"
~~~

If any check fails, stop publication of every downstream surface and preserve
the evidence of the failed release. Do not replace an immutable release's
assets in place.

## 7. Publish update feeds and distribution surfaces last

Only after the immutable GitHub release is published and all release/asset
checks pass may the following external surfaces change:

1. publish Sparkle/R2 with the existing guarded command;
2. trigger and verify the first-party Homebrew tap updater;
3. rebuild and deploy the public website with the final DMG and its
   availability/digest metadata; the canonical release-manifest.json, any
   non-null SBOM, and any non-null artifact-specific bundles remain GitHub
   release assets; and
4. update Store or other platform metadata when that separate subject has passed
   its own native finalizer gates.

The current Sparkle command is:

~~~bash
export SPARKLE_APPCAST_GUARD_TOKEN="…"   # see release-secrets.local.md
node scripts/publish-sparkle-update.js --publish --replace-appcast --channel stable \
  --appcast "$RELEASE_DIR/appcast.xml" \
  --dmg "$DMG" \
  --release-manifest "$RELEASE_DIR/TiboTattle-X.Y.Z-macOS-arm64.dmg.release.json" \
  --previous-stable-manifest "<path to P.Q.R .release.json>" \
  --bucket tibotattle-updates \
  --sparkle-public-ed-key "jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw=" \
  --atomic-appcast-guard-endpoint "https://tibotattle.com/api/v1/internal/release/appcast" \
  --atomic-appcast-guard-token-env SPARKLE_APPCAST_GUARD_TOKEN
~~~

The sanitized `.dmg.release.json` input is intentionally published by this
command under Sparkle's immutable, content-addressed R2 `release-manifest.json`
key so the signed updater subject can be read back. That narrow updater receipt
is separate from the canonical cross-platform release evidence and from the
website's availability/digest view. Never add credentials, signing logs, raw
local paths, staging descriptors, or unrelated receipts to R2, GitHub, or the
website. Verify the live appcast, Homebrew cask, website download, and installed
older-client update path after each corresponding publication.

### How to verify a published surface: fetch bytes, hash them

Verify content by **downloading the bytes and hashing them**, not by reading a
field that says what you expect:

~~~bash
curl -s -o /tmp/live.dmg "https://updates.tibotattle.com/releases/X.Y.Z/$SHA/TiboTattle-X.Y.Z-macOS-arm64.dmg"
shasum -a 256 /tmp/live.dmg     # must equal $SHA
gh release download "$TAG" --repo "$REPO" --dir /tmp/gh --pattern '*.dmg' --clobber
shasum -a 256 /tmp/gh/*.dmg     # must equal $SHA
~~~

**A 200 from a hash-named R2 URL is evidence of publication, not of content.**
The digest in that key is a naming convention; R2 serves whatever bytes live at
the key and nothing checks they hash to the name. This is unlike a genuinely
content-addressed store (git objects, IPFS), where the retrieving side verifies
the digest against the address and a mismatch cannot return 200. Do not let the
hash in the URL talk you out of the download.

Two more traps on the reading side:

- **Cached reads.** `raw.githubusercontent.com` served a pre-update Homebrew
  cask for minutes after the tap workflow had already committed the new one.
  Read the cask through `gh api repos/<owner>/homebrew-tap/contents/Casks/<c>.rb
  --jq .content | base64 -d`, and cache-bust appcast/website reads with a query
  parameter plus `Cache-Control: no-cache`.
- **A cached negative announces itself; a cached positive does not.** A stale
  read showing the *previous version* is obviously wrong and gets caught. A
  stale read showing the right version number but a superseded build of that
  same version is indistinguishable from success. This is a live risk whenever a
  release is rebuilt mid-flight — 0.1.13 was, for the minimum-macOS fix, so two
  distinct 0.1.13 DMGs existed. Hashing the delivered bytes is what separates
  those two cases; nothing else does.

### Refresh the first-party Homebrew tap

The public [`adamallcock/homebrew-tap`](https://github.com/adamallcock/homebrew-tap)
workflow polls the latest non-draft GitHub release hourly, verifies the exact
arm64 DMG asset, updates the cask version and SHA-256, runs the cask gates, and
commits only when those values changed. It requires no cross-repository token.
For an immediate release, trigger the same workflow instead of waiting for the
next scheduled poll:

~~~bash
gh workflow run update-tibotattle.yml --repo adamallcock/homebrew-tap
gh run list --repo adamallcock/homebrew-tap \
  --workflow update-tibotattle.yml --limit 1
brew update
brew info --cask adamallcock/tap/tibotattle
~~~

The cask keeps `auto_updates true`, so installing through Homebrew does not
replace or fork the signed Sparkle update channel. Do not submit the cask to
`Homebrew/homebrew-cask` until the project satisfies Homebrew's current age and
notability requirements.

For the production website, the guarded release-site command must target
env.production's .release-build/public-release-site directory. Rebuild it
before npm --prefix apps/worker run production:deploy -- --confirm
DEPLOY_PRODUCTION; a raw Wrangler deploy does not rebuild the baked installer
metadata. See [2026-08-17-web-only-release.md](./2026-08-17-web-only-release.md)
only for an intentionally website-only change that reuses an already released
artifact.

Refresh the social share card first. It is the og:image/twitter:image for
every link preview of the site, and its headline figure is a published estimate
that moves daily, so it goes stale on its own between releases:

~~~bash
npm run product:social-preview -- \
  --output "$PWD/.release-build/social-preview/social-preview.png" --replace
~~~

It renders the live homepage with headless Chrome and refuses to write a card
whose allowance figure had not loaded, or whose page still advertises the
download as unavailable. Pass the result as `--social-image` below. Skipping
this step is what let a card reading "Public download coming soon" stay live for
months after 0.1.13 shipped: `install-cta.js` hides that string at runtime, so
visitors saw the right CTA and only link previews carried the wrong one.

The current macOS release-site operation is:

~~~bash
npm run product:release-site -- \
  --output "$PWD/.release-build/public-release-site" --replace \
  --site-url "https://tibotattle.com/" \
  --installer-path "$PWD/.release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --installer-release-manifest "$PWD/.release-build/macos-release/release-manifest.json" \
  --installer-url "https://github.com/adamallcock/tibotattle/releases/download/vX.Y.Z/TiboTattle-X.Y.Z-macOS-arm64.dmg" \
  --installer-version X.Y.Z \
  --installer-sha256 "<DMG SHA-256 from step 2>" \
  --minimum-macos 14.0 --architectures arm64 \
  --release-notes-url "https://tibotattle.com/docs.html" \
  --privacy-url "https://tibotattle.com/privacy.html" \
  --security-url "https://tibotattle.com/docs.html" \
  --support-url "https://tibotattle.com/docs.html" \
  --social-image "$ABSOLUTE_1200X630_PNG_PATH"
npm --prefix apps/worker run production:deploy -- --confirm DEPLOY_PRODUCTION
~~~

For a v1 release, the command above passes the canonical
`release-manifest.json`. The legacy `*.dmg.release.json` receipt is limited to
the v0.1.12/web-only compatibility path. In either mode, the generated site exposes only installer
availability and digest; the canonical manifest, any non-null SBOM, and any
non-null artifact-specific bundles stay on the GitHub release. The installer,
manifest/receipt, social image, and output paths must be absolute, and the
social image must stay outside the output directory.

## Owner-credential steps

The owner-only operations are Keychain/codesign/notarization, GitHub release
publication, Cloudflare/R2 publication, production deployment, and Store
submission. Secret values and the appcast guard-token provision/rotation recipe
remain in docs/runbooks/release-secrets.local.md (gitignored). Never put secret
values, credentials, signing logs, raw local paths, or staging descriptors into
a public manifest, release note, website asset, or attestation input. The
sanitized Sparkle receipt is the only deliberate R2 updater publication and is
handled by the guarded command above.
