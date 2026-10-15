---
title: Linux update publisher authentication
date: 2026-10-12
type: decision-record
status: accepted
---

Linux in-app updating now fails closed until an independently provisioned
publisher key is embedded in a reviewed application release. Current source
contains an empty production key set, so Linux cannot check, download, or
install updates. Local analysis and ordinary startup remain available. This
source security change does not establish an installed or published release.

The trust root is
`config/electron-production-distribution.cjs:PRODUCTION_ELECTRON_LINUX_UPDATE_KEYS`.
Keys must arrive in reviewed application bytes. A feed, environment variable,
renderer, downloaded file, or HTTPS response cannot introduce a trusted key.
The existing macOS and Windows updater authorities remain separate.

## Authenticated update contract

The Linux feed contains `tibotattleLinuxUpdate`, an exact object with `manifest`
and `signature`. The manifest fields below occur in this exact order in the
signed UTF-8 JSON object, followed by one newline. The signature is canonical
base64 Ed25519 over those bytes.

| Field | Required value or bound |
| --- | --- |
| `schemaVersion` | `tibotattle-linux-update-v1` |
| `appId` | `com.usagemonitor.local` |
| `channel` | `stable` |
| `target` | `linux-x64` |
| `version` | Stable three-component version, each component at most nine digits |
| `sequence` | Positive safe integer, within the selected embedded key's interval |
| `size` | Exact final AppImage byte length, at most 2 GiB |
| `sha256` | Lowercase SHA-256 of those final bytes |
| `keyId` | Exact embedded key identifier |
| `expiresAt` | Unix milliseconds, later than current time and within 31 days |

Unknown feed, manifest and envelope fields fail closed. The closed feed has
`version`, `files`, `path`, `sha512`, and `tibotattleLinuxUpdate`; unsigned rollout
or minimum-system-version overrides cannot turn a signed newer version into a
claim that this installation is current. The updater also restricts the
file descriptor and installer path to the canonical
`TiboTattle-{version}-linux-x86_64.AppImage` basename under the fixed feed, its signed size,
a well-formed SHA-512 and an optional bounded block-map size. This prevents the
unsigned download descriptor from selecting another origin, unbounded size,
or an unrelated sibling AppImage as the install destination.
Its checksum remains a transport check; the independent signature and SHA-256
establish publisher authorization.

The wrapper suppresses electron-updater's automatic download and quit-time
installation. It authenticates both update-available and no-update responses,
then persists rollback state before publishing availability. A saved automatic
download preference starts a download only after this authorization. Full,
differential and cache-restored downloads all reach the same final-file check
before the UI can offer installation. A library `update-downloaded` event alone
does not establish trust.

The final file must be a regular, single-link, current-owner file without
group/other write permission. A no-follow, nonblocking descriptor prevents
symlink following and FIFO blocking. SHA-256 and size are checked after
download and synchronously again immediately before the pinned AppImage
updater's synchronous installation call, after the companion has stopped.
The wrapper recovers the companion if this final check fails. This removes
event-loop work between verification and installation; it does not claim to
defeat another process that already controls the user's files or process.

## Replay, expiration and rotation

`linux-update-high-water-v1.json` uses the existing owner-only, bounded, atomic
desktop settings backend. It records the highest authorized sequence and
version, the manifest digest, and artifact digest. Lower sequences/versions,
same-sequence conflicting metadata, and a different artifact for the same
version fail. Identical retries are allowed. A higher sequence can renew the
expiration for the same version and artifact. Corrupt/unavailable durable
state prevents authorization and download; it is never silently reset.

Expiration requires an operator to renew signed feed metadata before it
expires, including when no new version is released. This is a source contract,
not a newly installed renewal automation. The system wall clock is the local
freshness authority. Clock rollback by code controlling the user session is
outside this publisher-compromise boundary.

Each embedded key has `id`, canonical raw-32-byte base64 `publicKey`,
`minimumSequence`, and `maximumSequence`. Rotation first ships an authenticated
release containing both keys with reviewed sequence intervals, then changes
the publisher key in that interval. A subsequent authenticated release removes
the old key. The feed cannot rotate its own authority. Emergency revocation
requires a trusted replacement application when the installed key is no longer
safe; this design does not invent a second online revocation authority.

## Release and migration gates

The explicit local producer is `scripts/sign-electron-linux-update.mjs`. After
owner-authorized key provisioning and signing approval, its `--sign` mode takes
`--artifact`, `--feed`, `--sequence`, `--expires-at`, `--key-id`,
`--private-key-file`, and `--output`. It checks the final AppImage against the
builder feed, checks that the owner-only private key matches the embedded root,
signs the closed manifest, verifies its own result, and writes a new feed file
without overwriting an existing file. JSON output is valid YAML for the pinned
updater. It never creates a key or publishes. Signing material is never placed
in source, fixtures, receipts, logs, or command-line arguments.

The stable publication planner must independently verify that signed envelope
and bind its digest/size to the already-hashed final AppImage. The envelope is
inside the exact feed bytes, so existing feed digests, readback and owned
rollback bind it too. Unsigned or unprovisioned publication is refused. A
rollback restores only the approved previous discovery bytes; it cannot roll
back an installed application's version/high-water state. The writer records
`publisherVerifiedAt` in its bound operation journal. Exact owned rollback can
revalidate the approved signature at that earlier time after expiration; new
publication still requires fresh metadata and checks expiration again before
the Linux feed write.

Same-version feed renewal keeps the four-target publication contract. All
predecessors must have that version; the three non-Linux feed preimages must
exactly equal the proposed feed bytes and remain verified no-ops. The signed
Linux predecessor must match the unchanged final AppImage and have a strictly
lower sequence and earlier expiration. Its signature may be checked at a
bounded historical validity time when already expired; the renewed signature
must be current. All immutable artifacts must already exist and match before
any feed write. Only the Linux feed is replaced or eligible for owned rollback.
This does not allow rebuilding or republishing different application bytes
under an existing version.

Real AppImage update/final-lifecycle runners stop with
`UPDATE_TRUST_UNPROVISIONED` before launch while the production root set is
empty. Synthetic tests qualify signature refusal, rollback, renewal, cache
handling and wrapper integration with the pinned updater. Injected differential
task coverage is not proof of the native block-map algorithm or a physical
Linux install/restart. New publisher roots, renewed feed operations and exact
installed Linux qualification remain release gates.

Existing clients released without this verification boundary remain vulnerable
to a compromised feed. They cannot learn an independent trust root safely from
that same feed alone. Distribute the first rooted application through an
independently authenticated channel and require a verified manual replacement
where necessary. A valid checksum from the compromised channel does not
qualify that migration. This change does not silently trust or upgrade old
clients, alter public feeds, sign production artifacts, or publish a release.
