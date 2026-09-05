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

## Separate Apple silicon and Intel candidates

The 0.1.18 working candidate adds a separate Intel lane; it is not a public
support declaration. The published 0.1.17 release is immutable and remains
unchanged. Follow the [Intel qualification plan](../plans/2026-09-03-macos-intel-release.md)
before publishing Intel, with the owner's explicit
[0.1.18-only manual qualification waiver](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md).
That release decision accepts missing physical evidence; it does not establish
that the waived tests passed. Both installers must come from the same
frozen annotated tag and source commit and enter the draft release before it
is made immutable. Never append a later source build under an older tag.

| Target | CLI architecture | Native slices | Stable feed | Immutable prefix |
|---|---|---|---|---|
| Apple silicon | `arm64` (default) | exactly `arm64` | `/appcast.xml` | `releases` |
| Intel | `x64` | exactly `x86_64` | `/intel/appcast.xml` | `intel/releases` |

Both stable feeds use the existing stable update origin, bucket and trusted
public key. Dogfood retains its independent origin/bucket/key; Intel dogfood
uses `/internal-dogfood/intel/appcast.xml` and `internal-dogfood/intel/releases`.
Intel Preview uses `/preview/intel/appcast.xml`. Native runtime checks the
compiled architecture's exact feed path. The publishing guard authenticates
requests before selecting its allowlisted architecture target; compare-and-swap
operates on that target's appcast key. Deploy the updated guard through the
normal protected deployment gate before attempting Intel publication.

Build on macOS ARM with Node 26.2.0. Supply `--architecture x64` and
`--node-runtime <verified-node-v26.2.0-darwin-x64>/bin/node` to the builder and
release CLI. The official runtime's adjacent `LICENSE` must also be present;
both input and private staged copies are pinned and verified before execution.
Use distinct app/output directories per architecture. The packaging, installer
validation, appcast and publication commands accept `--architecture x64`; use
`TiboTattle-X.Y.Z-macOS-x64.dmg` for the Intel final artifact. ARM filenames
and default CLI behavior are unchanged. Universal binaries are not accepted.

The corrected combined Astra/Intel 0.1.18 RC3 allocations are dogfood `1025.2`
and stable `1026` for both architectures, above signed RC2 `1025.1`, earlier
Intel RC1 `1025`, and 0.1.17 stable `1024`. Preserve RC1/RC2 artifacts and
receipts; neither prior build may be reused for the corrected source.
Allocation is not a qualification receipt. A first Intel
stable release has no previous Intel installation:
use the existing explicit owner-only `--stable-bootstrap` flow, never an ARM
receipt as Intel prior-release or rollback evidence. The current stable key
must still match the authenticated publishing guard. Later Intel releases
require a previous Intel manifest and preserve that lane's key and ordering.

Sign/finalize/validate each architecture independently. Preserve unique filenames
for both appcast evidence files in the flat public manifest, even though each
live feed ends in `appcast.xml`. Each artifact has its own checksum, native
assurances and any SBOM/attestation evidence. Do not copy ARM evidence into an
Intel entry. Cross-compilation, Rosetta and ad-hoc packaging do not qualify
physical Intel clean install, login items, silent Keychain access or A-to-B
signed update installation.

The installed Login Item gate accepts explicit `--architecture` and `--channel`
selection and requires the v2 [manual rehearsal receipt](../decisions/2026-08-03-macos-login-item-lifecycle-decision.md#2026-09-04-two-architecture-receipt-amendment).
It binds the inspected app's architecture, channel, source commit and normalized
payload alongside version identity. Native hardware, supported macOS and
non-Rosetta execution remain human observations; neither old v1 receipts nor an
ARM rehearsal can qualify Intel. The payload binding is not a final-DMG digest
and does not replace independent artifact/signature checks.

For 0.1.18 only, the owner waived the disposable clean-profile/manual Login Item
matrix and physical Intel qualification in the linked release decision. Record
these as waived and unperformed, not passed; do not manufacture a v2 receipt or
claim its validator succeeded. Other testers running the app is an owner report,
not independently verified, architecture- and artifact-bound evidence. The v2
validator, actual automated isolated smoke, native signatures, exact-byte
verification, data preservation, updater integrity and unexpected-Keychain-prompt
stop conditions remain unchanged. This does not carry forward to a later release.

The existing website command below remains ARM-compatible. To expose a qualified
Intel artifact from the same canonical `release-manifest.json`, also supply:

~~~text
--intel-installer-path <absolute-path>/TiboTattle-X.Y.Z-macOS-x64.dmg
--intel-installer-url https://github.com/adamallcock/tibotattle/releases/download/vX.Y.Z/TiboTattle-X.Y.Z-macOS-x64.dmg
--intel-minimum-macos 14.0
~~~

The generator validates Intel source, bytes, trust, architecture and minimum
macOS independently, including the published download. Omit these flags to
retain the unavailable Intel tab. The separate Homebrew tap currently selects
ARM only; do not show a Homebrew command on the Intel tab until that tap has
an architecture-aware cask and updater workflow, with its own validation.

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

Run candidate preflight while untagged work remains under `Unreleased`. The
documentation checker requires a stable tag for a dated release entry: finalize
and commit the release text, create the local annotated tag as described in
section 1, then run the final preflight below before pushing that tag. Do not
weaken the checker or edit tracked release text after freezing the tag.

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

### 0.1.17 local-state migration gate

Before signing the 0.1.17 internal-dogfood candidate, rehearse the applicable
schema-11 transition against a consistent disposable copy of the stable unified
index and its matching device salt. Schema 8/9 must take the normal staged
rebuild from readable raw history. Schema 10 takes the additive physical
schema-11 migration on a staged copy, but that does not bypass parser
compatibility: upgrading parser v10 to v11 still reprocesses readable sources
through normal ingestion. Only an unchanged source whose parser and source
provenance are already current can be reused without rescanning. Record both
`PRAGMA user_version` and the published generation's parser provenance; the
physical version alone cannot establish whether a parser rescan is required.
Keep the installed app stopped while taking the copy, leave the live source
read-only, and compare SQLite integrity, generation metadata, row counts,
aggregate token/cost ranges, and source-cursor coverage before and after the
transition. Follow the canonical
[local unified-index recovery runbook](./unified-index-recovery.md)
for compatibility and preservation rules.

The isolated `preview_distribution` app cannot satisfy this gate: it creates a
fresh schema-11 index under `Usage Monitor Preview` and may test a full rebuild,
but it cannot read or migrate stable state. The signed same-identity
`internal-dogfood` installation is the later in-place upgrade proof. Never copy
the live stable database into Preview, relabel `PRAGMA user_version`, delete the
index, or reopen a migrated schema-10 or schema-11 index with shipped 0.1.16.

The replacement validator has a closed previous-only exception for published
stable `0.1.16` / bundle version `0.1.16`: SHA-256
`5e3e60402ffa3c61d8279f5f759548a8b48084f1ae567eeb1b30156c7f30a9fe`,
49,341,389 bytes, source `4f30508eff55c122e73025ad06d73b33cadbc508`
at `v0.1.16`. Its exact receipt, source/payload digests, updater key/framework,
and normalized Keytar tuple are pinned. Only the checksum-verified previous
artifact receives short-lived compatibility for the absent source seal,
migration helper, and both Keychain identity plist fields. A version match or
public boolean cannot authorize it. The capability expires before candidate
validation, including when previous validation fails. Native signature,
notarization, Gatekeeper, and isolated-smoke checks remain required; the old
manifest and artifact are never rewritten. This is replacement-artifact proof,
not existing-state rollback or prompt-free installed-upgrade proof.

A separate closed previous-only exception covers the
pre-policy internal-dogfood `0.1.16` / build `1022` DMG: SHA-256
`2b32964c8b3bc2912620dbbe078aaf4e2fd49f1725a4e94a62dff184cdc9f8c1`,
49,341,249 bytes, source `5adaca5fdc8f981c391144e0d29b6f4c764f0f96`
at `v0.1.16`. Its receipt predates channel-specific tags and its app lacks an
embedded source seal. Only the checksum-verified previous side of
`validate-macos-replacement.js` accepts that identity, its exact build digests,
and the existing channel, updater-key, and signed-release assurances. Native
signature, notarization, Gatekeeper, and isolated-smoke checks still run. Matching
previous-only rules cover its exact normalized Keytar binary and its two absent
Keychain identity plist fields. The old payload is fully verified, never
rewritten; current candidates still require the current normalization inventory
and both explicit Keychain identity fields. No compatibility flag is available
for a candidate, public installer, or signing path.
Do not rewrite the old receipt or tag. Preserving this artifact does not prove
state rollback: a schema-9 backup is already newer than its schema-8 reader.

### Native Keychain migration gate

Unexpected Keychain security prompts block dogfood replacement and public
release. Normal startup, refresh, background work, and automatic migration must
not enable Keychain interaction. Preserve the last usable local state when
access is unavailable; do not erase an identity, weaken access controls, disable
macOS protections, or move secrets to plaintext to make a candidate appear ready.

The silent-migration source change adds a separately signed native helper to
the closed payload inventory. Its `node` signing identifier and exact Developer
ID designated requirement must match the previously shipped Node reader, with
the same Team ID, hardened runtime, and no helper entitlements. The native app
keeps its own stable identity. Do not broaden an ACL or restore a general
interpreter credential reader to make a test pass.

Before qualifying that change, obtain explicit owner authorization for the
signed synthetic probe described in
[`test/fixtures/macos-keychain-migration/README.md`](../../test/fixtures/macos-keychain-migration/README.md).
Its default invocation is inert; `--compile-only` compiles without signing or
Keychain access. The protected `--run-signed` invocation uses the release signing
key and creates/deletes only its own validated private fixture Keychain. It must
prove exact-secret migration, no-clobber adoption, repeated-upgrade continuity,
unauthorized-peer rejection, bounded helper lifetime, and unchanged default and
search lists. This approximates historical default ACLs; it does not establish
every installed user's access controls or a notarized replacement.

The separate installed-candidate check must cover clean installation and a
same-identity old-to-new upgrade using the exact signed artifacts. Check normal
launch, refresh, companion restart, locked/unavailable Keychain, exhausted
retries, partial migration, and denial/cancellation. Confirm no automatic
Keychain prompt, up to three bounded silent attempts, and the explained native
**Secure upgrade** fallback only after deliberate approval, with Cancel as the
default. Keep the old key as a recovery copy; do not treat reset/deletion as
migration recovery. Verify the separate, deliberate reset waits for all current
and retiring credential writers, then removes that capability's legacy copy
before its modern copy, without allowing delayed migration to restore it. The
implementation and synthetic reset evidence are recorded in the
[migration decision](../decisions/2026-08-31-silent-keychain-migration.md)
and do not authorize resetting real credentials during qualification. An
unsigned smoke or a blocked signed probe is not signed-upgrade evidence.

Another closed previous-only exception accepts the retained 0.1.17 / build
1023 RC2 DMG, SHA-256
`125a15da9b0e260ec3797527d6b98e15aa1172e8b6fc8e7942d2a799cc2b29b0`,
49,574,961 bytes, source `3d9055fc8e58c84f8ba71feb5deb58b52c532138`.
It predates the helper inventory. Its exact source and normalized payload
digests remain pinned; it is never rewritten. Only the previous side of the
replacement validator permits the absent helper. Current candidate inspection,
signing, and release paths require it.

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
protected by the repository's version-tag rules. It may identify the frozen,
reviewed PR head; it need not identify the later main merge commit. Build only
with HEAD at that exact tagged commit.

The sole historical exception is the pre-policy `v0.1.10` published ref. It is
a protected lightweight tag at
`3b3a852abad643095c296550a827ed448b3720fa`, while the v0.1.10
version-bump source is `151adec996c9a0f621819f89777ac5a05f1df8b6`. The release
documentation checker accepts only that exact pair and reports it separately
from annotated tags. This closed exception does not authorize another
lightweight tag: every new stable tag must remain annotated and protected.

~~~bash
git status --porcelain=v1 --untracked-files=all   # must print nothing
git tag -a vX.Y.Z HEAD -m "TiboTattle X.Y.Z ..."  # final reviewed commit
git describe --exact-match --tags HEAD           # must print vX.Y.Z
~~~

For a tagged PR head, complete local checks and final-artifact validation from
that frozen checkout before atomically pushing its branch and tag. Set
`RELEASE_BRANCH` to the actual reviewed branch; do not push directly to main:

~~~bash
git push --atomic origin "refs/heads/$RELEASE_BRANCH" "refs/tags/vX.Y.Z"
~~~

Require passing CI for the frozen PR head after the remote tag is available.
The release-trust PR job uses the PR merge checkout and fetches full history;
the tag need not point at that synthetic merge. Merge normally, without squash
or rebase, preserving the tagged head as an ancestor and an identical tree.
Resolve `MERGE_COMMIT` to the actual resulting merge commit and verify:

~~~bash
git merge-base --is-ancestor "vX.Y.Z^{}" "$MERGE_COMMIT"
git diff --exit-code "vX.Y.Z^{tree}" "$MERGE_COMMIT^{tree}"
~~~

Only then proceed to public release publication. Keep artifact provenance at
the tagged PR-head commit, not the later merge commit. Do not rewrite tags or
shared history; if CI or merge changes require different source bytes, stop and
resolve the release identity before continuing. Final notes and changelog must
already be committed before the local tag; later publication steps verify and
upload that frozen text rather than changing it.

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
export USAGE_MONITOR_BUNDLE_VERSION="1026"
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
the refresh-policy RC9 internal-dogfood allocation `1023.7`, fit-metadata RC8
allocation `1023.6`, retired-checkpoint
RC7 `1023.5`, accounting-deadline RC6 `1023.4`, integrated RC5 `1023.3`,
startup-recovery RC4 `1023.2`, migration RC3 `1023.1`, retained RC2 `1023`,
and earlier shared-identity dogfood `1022`. The
checked-in allocation is authoritative; the
current 0.1.18 `USAGE_MONITOR_BUNDLE_VERSION=1026` example above is only an exact
assertion and cannot select or override a different build. A future stable version must add
and test a new monotonic channel allocation before the release path will run.
The separate `TiboTattle Preview.app` identity may use the deterministic
preview epoch (`2000.1.17` for 0.1.17); it does not participate in stable
Sparkle ordering.

The owner accepted the runtime from source
`394c8a03a986e0daadbe662679fd002202682e44` in dogfood `1023.7` and inspected
stable build `1024`. That acceptance is the retained runtime basis, not proof
of newly finalized bytes. The final `0.1.17`/`1024` artifact must bind the
reviewed release tag and pass fresh signed-artifact and exact previous-stable
replacement validation. Formal PR #94 local qualification completed with
`passed_with_historical_artifact_refusal`; the final candidate passes its strict
cache validator. The
[qualification receipt](../receipts/2026-09-03-pr94-account-plan-attribution-qualification.md)
records exact data conservation, coverage review, and resource measurements.
Failed or partial earlier comparison runs remain historical failures, not
qualification evidence.

For 0.1.17 only, the full clean-profile/physical Login Item matrix is explicitly
deferred, not passed, under the
[owner's release-specific decision](../plans/2026-09-03-public-0.1.17-release.md).
Automated isolated-profile and fake-manager checks do not establish those
manual results. Data conservation, signatures, updater integrity, and the
unexpected-Keychain-prompt stop condition remain unchanged. Hosted migrations,
protocol activation, live contribution tests, and website publication remain
separate; this release decision does not authorize them.

The [2026-09-05 owner decision](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md)
is the separate forward exception for 0.1.18's unavailable manual/physical
matrix. It does not alter the historical 0.1.17 decision or create a passing
manual receipt for either architecture.

Signing-key access on the release machine is a separate owner provisioning
step, not an end-user permission requirement. If signing requests approval,
pause for the owner to verify the exact signer and key. Do not automatically
approve the dialog, recommend blanket Always Allow access, or change Keychain
ACLs/partitions to unblock an unattended build. The finalizer validates Developer
ID signing, hardened runtime, notarization, stapling, Gatekeeper, and clean
installation. It emits
the final arm64 DMG at:

~~~text
.release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg
~~~

Read the minimum OS and Finder dates from the app inside the final DMG, not
the retained review candidate (the finalizer signs a separate staged app).
After final validation, mount the DMG read-only without launching the app.
Compare the outer `.app` directory's birth time and modification time against
the committer timestamp of its sealed source commit:

~~~bash
(
  set -e
  FINDER_DMG="$PWD/.release-build/macos-release/TiboTattle-X.Y.Z-macOS-arm64.dmg"
  FINDER_MOUNT="$(mktemp -d /private/tmp/tibotattle-final-finder.XXXXXX)"
  /usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$FINDER_MOUNT" "$FINDER_DMG"
  trap '/usr/bin/hdiutil detach "$FINDER_MOUNT"' EXIT
  FINDER_APP="$FINDER_MOUNT/TiboTattle.app"
  FINDER_COMMIT="$(/usr/bin/plutil -extract release.source.commit raw -o - \
    "$FINDER_APP/Contents/Resources/build-manifest.json")"
  FINDER_EPOCH="$(git show -s --format=%ct "$FINDER_COMMIT^{commit}")"
  test "$(/usr/bin/stat -f %B "$FINDER_APP")" = "$FINDER_EPOCH"
  test "$(/usr/bin/stat -f %m "$FINDER_APP")" = "$FINDER_EPOCH"
  /usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" \
    "$FINDER_APP/Contents/Info.plist"
)
~~~

Both timestamp comparisons must pass. This checks only the outer bundle's
Finder metadata; internal payload timestamps remain normalized. Never repair
dates inside a mounted or signed artifact. Use the printed minimum OS value
afterwards.

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
  --bundle-version "1026" \
  --sparkle-public-ed-key "jhgPwmvWLMr7TGURJUoi6sXias7YP1F+hejZawKVTGw="
~~~

This uses the pinned generate_appcast and embeds the feed signature required by
the installed client's SURequireSignedFeed=true. A hand-built minimal appcast
is not a valid updater subject. `1026` is the allocated 0.1.18 stable build,
not the marketing version; future releases must use their reviewed allocation.

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
  "$DMG" "$RELEASE_MANIFEST" "$SHA256SUMS" "$VERIFY_GUIDE" \
  "$RELEASE_DIR/appcast.xml"

# For the attested v1 profile/path, use this command instead:
gh release upload "$TAG" --repo "$REPO" \
  "$DMG" "$SPDX" "$PROVENANCE" "$SBOM_ATTESTATION" \
  "$RELEASE_MANIFEST" "$SHA256SUMS" "$VERIFY_GUIDE" \
  "$RELEASE_DIR/appcast.xml"
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
gh release verify-asset "$TAG" "$PUBLISHED_VERIFY_DIR/appcast.xml" --repo "$REPO"
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
(
  set -e -o pipefail
  LIVE_VERIFY_DIR="$(mktemp -d /private/tmp/tibotattle-live-update.XXXXXX)"
  SPARKLE_DOWNLOAD_URL="$(/usr/bin/xmllint --xpath \
    'string(/rss/channel/item/enclosure/@url)' "$RELEASE_DIR/appcast.xml")"
  test -n "$SPARKLE_DOWNLOAD_URL"
  curl --fail --show-error --location \
    --output "$LIVE_VERIFY_DIR/$ARTIFACT_NAME" "$SPARKLE_DOWNLOAD_URL"
  LIVE_SHA="$(shasum -a 256 "$LIVE_VERIFY_DIR/$ARTIFACT_NAME" | awk '{print $1}')"
  EXPECTED_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
  test "$LIVE_SHA" = "$EXPECTED_SHA"
)
~~~

Use the actual generated enclosure URL: its content-addressed namespace is the
bundle build (`releases/1024/...` for 0.1.17), not the marketing version. The
fresh GitHub-download validation in section 6 separately verifies those bytes.

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
