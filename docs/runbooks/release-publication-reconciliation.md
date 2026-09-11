---
title: Exact release publication reconciliation
date: 2026-09-08
type: runbook
status: maintained
---

# Exact release publication reconciliation

Status: maintained operational interface. This tool coordinates publication of
an **already qualified stable release** through its Apple silicon and Intel
Sparkle feeds, GitHub assets, cask and website. It admits either the existing
two-Mac native release or the explicit four-platform Electron transition below.
It does not build, sign, notarize, change consent, run migrations, publish tags, or
replace the installed-artifact and hardware gates in the
[macOS release runbook](./macos-stable-release-runbook.md).

The default command performs read-only reconciliation. Credentials being present,
a prepared plan, and a saved journal are not publication authority. A separate
explicitly authorized invocation is required for remote changes.

## Prepare the exact inputs

Keep the plan and operation journal in a private release-staging directory, outside
tracked source. Freeze final installer bytes before generating the canonical
cross-platform `release-manifest.json` and `SHA256SUMS` with the existing release
evidence generator. For the existing native release, the manifest determines the
GitHub asset set: all checksum-enumerated artifacts and conditional evidence,
plus `SHA256SUMS` and `verify-release.md`. Files must retain their public basenames
and share the canonical manifest's staging directory.

For example, the published 0.1.18 contract has seven assets: one cross-platform
manifest, two installers, two architecture appcasts, checksums, and verification
instructions. The architecture-specific native finalization manifests are
separate inputs to the existing Sparkle publisher, not invented extra GitHub
assets. Keep those finalization manifests and the corresponding previous stable
manifests for both architectures.

### Four-platform Electron transition

The Electron branch requires exactly four direct GitHub-release artifact entries:
macOS arm64, macOS x64, Windows x64 and Linux x64. Every artifact retains
`updater.mechanism: electron-updater`; each Mac's `updater.metadata` identifies
`TiboTattle-<version>-darwin-<architecture>-update.yml`. Do not replace that YAML
with a native appcast or invent a second app artifact to represent an incoming
update transport.

The incoming native Sparkle XML files are additional immutable GitHub assets.
Use distinct public basenames, such as
`TiboTattle-<version>-native-arm64-appcast.xml` and
`TiboTattle-<version>-native-x64-appcast.xml`. Preserve their signed bytes when
copying or renaming them. Each must advertise the correct architecture-specific
stable destination; isolated test feeds cannot be published as stable feeds.

For the current checksum/native-signature profile, the exact public set is:

| Files | Count |
| --- | --- |
| Four canonical installers | 4 |
| Both Mac ZIPs, ZIP blockmaps and DMG blockmaps | 6 |
| Four Electron updater YAML files | 4 |
| Two incoming native Sparkle XML files | 2 |
| Canonical manifest, `SHA256SUMS`, `SHA256SUMS-ALL-RELEASE-FILES`, verification guide | 4 |

The baseline is 20 files. Any conditional evidence already required by the
canonical manifest remains required. The reconciler rejects arbitrary extras,
missing XML, aliases inserted as additional public installers, and checksum
drift. `SHA256SUMS` remains generator-owned. The auxiliary checksum file contains
one exact `SHA256  filename` line for each installer, updater artifact, YAML and
incoming XML and conditional manifest evidence, sorted lexicographically by the
full line with a final newline.
It excludes the canonical manifest, both checksum files and verification guide;
those already have their separate manifest/immutable-release bindings.

The Electron successor must retain the predecessor's exact `SUPublicEDKey` in
its signed Mac Info.plist. This is passive incoming-update compatibility metadata;
it does not embed or enable a Sparkle runtime in Electron. Keep the incoming
native and outgoing Electron updater configurations distinct. Each local
`tibotattle-electron-sparkle-transition-v1` feed manifest must bind the actual
architecture-specific native installed journey, final DMG and ASAR, key
continuity, and source. A manual-copy test or a green job status cannot substitute
for that receipt. A canonical manifest with pending execution acceptance is
preparable but final validation refuses publication.

This coordinator still reports only its two native Sparkle feed surfaces.
Publish and read back all four Electron feeds through the existing
[Electron stable-feed lane](./2026-08-18-cross-platform-release-publication.md).
A complete reconciliation here does not mean those four outgoing feeds were
activated. Track both lanes in the same release closure plan, using their existing
guarded operations; never bypass either publisher with raw storage writes.

Prepare the cask using the first-party tap's existing `scripts/update-cask.rb`.
Pin the bytes of `.github/workflows/update-tibotattle.yml` reviewed for dispatch;
the reconciler invokes that existing workflow rather than rewriting the tap or
duplicating its native installer checks. The expected cask must contain the
canonical paired architecture/digest declarations and macOS Sonoma floor. Native
releases use `macOS-#{arch}` URLs; the Electron branch uses `mac-#{arch}` URLs
for the standard canonical GitHub installers.

Prepare the website through the existing [web-only lane](./2026-08-17-web-only-release.md)
in its exact clean source checkout. Retain its web-release receipt and generated
`release-site-manifest.json`. Each website installer row must identify the exact
GitHub assets in the canonical release manifest. Website publication can use a
different, explicitly receipt-bound source commit from the application release.
For the four-platform transition, also inspect the rendered desktop/mobile
download section and open all four manual download links: each must select the
matching immutable GitHub release asset. This coordinator checks all four
Electron download rows, including published-byte verification, source build,
URLs, sizes and hashes. Retain rendered-link and interaction evidence separately.

### Closed plan schema

The JSON plan accepts exactly these fields; unknown fields are rejected:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `1` |
| `source` | `{repository, commit, tag, tagObject}`; canonical public repository, full 40-character source and annotated tag object, exact `v<version>` |
| `channel` | `stable`; other channels are not admitted by this public-release coordinator |
| `version`, `build` | Three-part release version and Apple-compatible bundle version |
| `assets` | Complete public set of `{name, path, sha256, bytes}`; unique public basenames and final hashes |
| `notes` | `{path, sha256, bytes}` for exact GitHub release notes; title is `TiboTattle <version>` |
| `targets` | Exactly one ARM and one Intel target, described below |
| `tap` | `{path, sha256, bytes, workflowSha256}` for the prepared canonical cask and reviewed updater workflow |
| `website` | `{repositoryRoot, receipt, manifest}`; receipt and manifest each use `{path, sha256, bytes}` |

An existing native target has exactly:

```json
{
  "architecture": "arm64",
  "dmgName": "TiboTattle-1.2.3-macOS-arm64.dmg",
  "appcastName": "TiboTattle-1.2.3-macOS-arm64-appcast.xml",
  "feedManifest": {"path": "/absolute/staging/native-finalization-arm64.json", "sha256": "<64 lowercase hexadecimal characters>", "bytes": 1234},
  "previousManifest": {"path": "/absolute/staging/previous-stable-arm64.json", "sha256": "<64 lowercase hexadecimal characters>", "bytes": 1234},
  "sparklePublicEdKey": "<canonical base64 public Ed25519 key>"
}
```

For the Electron transition, **both** targets additionally require a
`sparkleDmg` file spec, and `dmgName` names the standard public Electron DMG:

```json
{
  "architecture": "x64",
  "dmgName": "TiboTattle-1.2.3-mac-x64.dmg",
  "appcastName": "TiboTattle-1.2.3-native-x64-appcast.xml",
  "sparkleDmg": {"path": "/absolute/staging/incoming/TiboTattle-1.2.3-macOS-x64.dmg", "sha256": "<same final installer SHA-256>", "bytes": 1234},
  "feedManifest": {"path": "/absolute/staging/incoming/intel-transition-manifest.json", "sha256": "<64 lowercase hexadecimal characters>", "bytes": 1234},
  "previousManifest": {"path": "/absolute/staging/previous-stable-x64.json", "sha256": "<64 lowercase hexadecimal characters>", "bytes": 1234},
  "sparklePublicEdKey": "<canonical base64 public Ed25519 key>"
}
```

`sparkleDmg` is a local input to the same native publisher, not a second public
artifact. The Intel `macOS-x64` alias is required by the native namespace policy;
make a separate regular-file copy of the final `mac-x64` DMG and verify identical
size and SHA-256. Never repackage or re-sign an alias. ARM can reference its
standard final `mac-arm64` file. The reconciler verifies the alias against the
canonical installer before passing it to the existing Sparkle publisher, which
checks the manifest, signed archive, key and installed evidence. Native targets
must not supply `sparkleDmg`; their existing contract remains unchanged.

Use `x64` for Intel. The `1234` sizes and placeholder hashes above are illustrative,
not valid evidence. Public keys are not signing keys; never put secret values or
credential-store contents in this plan. Local regular files and canonical parent
directories are required; symlink aliases and hardlinked release inputs fail.

## Inspect before authorizing changes

```sh
node scripts/reconcile-release-publication.mjs --plan /absolute/private/publication-plan.json
```

This writes no journal or remote state. It validates canonical evidence and
checksums, both native/Sparkle inputs, source provenance, key continuity and the
prepared website receipt. It then reports GitHub, ARM feed, Intel feed, tap and
website separately. Output contains the plan digest and public release identity,
not the private input paths, credential values or remote command diagnostics.

GitHub draft assets are downloaded and hashed before publication. Published
assets are freshly downloaded and checked against immutable release attestations
using `gh release verify` and `gh release verify-asset`. GitHub immutability must
already be enabled; the reconciler never changes that repository setting. The
[GitHub repository API](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
provides the read-only enabled-state check.

The tap is read through GitHub's contents API, not a potentially stale raw-content
URL. Website readback fetches the exact manifest and every generated public file
with a cache-busting query, then requires healthy production at the receipt's
exact source commit. A successful HTTP response alone does not pass these gates.
HTML files are checked at their Workers Assets canonical routes (`index.html`
at `/`, other `.html` files without that suffix). Unexpected redirects still
fail; response bytes are hashed without normalization or injected-code removal.

## Explicit publication invocation

Only after approval of this exact plan and its pending transitions:

```sh
node scripts/reconcile-release-publication.mjs \
  --plan /absolute/private/publication-plan.json \
  --apply \
  --confirm RECONCILE_EXACT_RELEASE_PUBLICATION \
  --plan-digest <digest-returned-by-inspection> \
  --operation /absolute/private/publication-operation
```

The command creates a private durable operation record and acquires the shared
production ownership ref described in [agent release operations](./agent-release-operations.md).
It creates a draft only if absent, uploads only missing exact assets, revalidates
all draft bytes, and publishes only after immutability and the annotated source
tag are rechecked. Existing same-name/different-byte immutable assets or extra
assets stop publication; nothing is overwritten or deleted.

The existing Sparkle publisher handles each feed's immutable object checks,
signatures, previous-version/key continuity, compare-and-swap update and public
readback. The guard credential enters through the existing
`SPARKLE_APPCAST_GUARD_TOKEN` environment path, used only for the explicitly
authorized feed mutations. The coordinator consumes it once into a private
guard shared by both architecture publications and removes it from the
environment before spawning storage tools. It never records the raw credential.

The existing tap workflow is asynchronous and may take several minutes to verify
both native installers. An acknowledged dispatch is recorded as `submitted`;
the operation returns `RELEASE_PUBLICATION_REMOTE_PENDING` if the exact cask is
not yet visible. It does not dispatch repeatedly. Once the cask is verified,
ownership is released before the existing website deployment wrapper acquires
the same lock for its own guarded operation. Website health, schema, source,
asset and post-deployment gates remain in force; pending migrations are not
implicitly approved.

Final reconciliation reads every surface again. A complete fresh rerun performs
no uploads, dispatches, deployments, lock changes or journal writes. During a
single invocation, already checked GitHub asset IDs are reused only within the
same draft/published phase to avoid quadratic installer downloads. Final public
readback explicitly bypasses this short-lived optimization.

## Resume or investigate partial completion

Verify the previous process has stopped before using the exact plan and journal:

```sh
node scripts/reconcile-release-publication.mjs \
  --plan /absolute/private/publication-plan.json \
  --apply --resume --executor-stopped \
  --confirm RECONCILE_EXACT_RELEASE_PUBLICATION \
  --plan-digest <same-reviewed-digest> \
  --operation /absolute/private/publication-operation
```

Every mutation records durable `intent` first; an acknowledged response becomes
`submitted`, and only readback becomes `verified`. Lost responses are reconciled
against actual remote bytes before deciding the outcome. On resume, a matching
remote result closes its prior intent without repeating the write. If an intent
remains unresolved, `RELEASE_PUBLICATION_UNCERTAIN_RECONCILE_REQUIRED` stops the
operation. Do not delete the journal, release an unverifiable owner, or create a
new plan merely to replay the request.

For an asynchronous tap operation, wait for the already dispatched workflow and
inspect again. For a failed or uncertain website deployment, reconcile its
separate production operation using the agent release runbook before resuming
publication. For an unresolved feed/GitHub operation, inspect that provider's
existing publisher/operation evidence and obtain an explicit recovery decision;
this tool deliberately provides no blind retry override.

Ownership is cooperative, not provider-level fencing: raw provider commands,
legacy scripts and the tap's independent schedule do not acquire this ref.
Cross-surface publication cannot be atomic. A prepared plan is not reusable after
artifact/source changes, and final readback cannot promise that another writer
will never change a mutable feed, cask or website afterward. Completion reports
the exact observed state, not installed-app or physical-hardware qualification.

## Validation boundary

Run `node --test test/release-publication.test.js` for local/synthetic admission,
adapter-contract, lost-response, ownership, stale-cache, partial publication and
zero-write rerun coverage, plus four-platform inventory, alias substitution and
incoming XML versus outgoing YAML separation. Run
`node --test test/release-evidence.test.js` when changing the canonical evidence
contract. Keep the coordinator and website verifier on the same reviewed
contract: final signed-byte evidence and explicit owner acceptance must not be
replaced with invented unsigned-payload or passed-test claims to satisfy an older
validator. Pending acceptance remains a final-publication refusal. Tests never contact Apple, upload assets, dispatch a
workflow, or deploy a Worker. Live GitHub permissions, a real signed candidate,
Cloudflare guard credentials, native hardware and actual publication remain
separate owner-authorized gates.
