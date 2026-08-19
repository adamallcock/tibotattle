---
title: TiboTattle Sparkle delta update machinery
date: 2026-08-07
type: runbook
status: machinery-proven-locally-stable-policy-gated
---

# TiboTattle Sparkle delta update machinery

## Honest framing: what ships when

v0.1.0 is the FIRST release, and a Sparkle delta needs a predecessor to diff
against, so **no delta ships with v0.1.0 itself**. Nothing in this runbook
makes the first release download smaller. What exists is the machinery —
retained archives, delta generation, EdDSA signing, publisher validation and
upload — proven end to end on a real pair of locally built preview versions,
so that v0.1.1's publish produces deltas automatically instead of becoming a
scramble after the first release is live.

Two reviewed gates remain before a **stable** delta reaches a client, and
both are deliberately outside this machinery:

1. `config/sparkle-appcast-policy.js` keeps `allowDeltaFrom: false`. The
   generator and the publisher both read this policy, so today they emit and
   accept only full-DMG stable appcasts. Flipping the policy is a reviewed
   config change; no publisher or generator change is needed afterwards (a
   regression spec pins exactly that: the same delta appcast is rejected
   under the current policy and fully validated under the flipped one).
2. The owner-only appcast Worker guard enforces the same single-item,
   full-DMG-only shape server-side (see the
   [R2 Sparkle update publisher runbook](2026-08-02-r2-sparkle-update-publisher.md)).
   It must learn the delta-carrying shape in the same review that flips the
   policy, plus a fresh update rehearsal, or stable delta publications will
   fail at the guard after immutable objects are uploaded.

The `internal-dogfood` channel is the rehearsal path: the local pipeline
accepts delta appcasts for it today (its independently deployed guard is the
remaining dogfood gate).

## Retained-archive convention

```text
.release-archive/<channel>/<bundleVersion>/<AppName>.app
.release-archive/<channel>/<bundleVersion>/retained-archive.json
```

- Publishing version N expects the previous version's exact released `.app`
  tree retained locally. The generator retains the candidate automatically on
  every run, so the convention maintains itself once seeded.
- **Deltas are generated from up to the 2 most recent retained versions
  older than the candidate** (Sparkle convention is 1-3). Two, because update
  checks are automatic, so most clients sit at N-1 when N ships, and the
  second delta covers the common skipped-release case (a quick follow-up
  release some clients never installed). Anything older falls back to the
  full DMG automatically, so deeper chains only add signing surface and
  storage. The archive prunes itself to the newest 3 versions.
- `.release-archive/` is operator-owned local state (like `.release-build/`)
  and must never be committed; add it to the root `.gitignore` (owner step —
  the root `.gitignore` is outside this machinery's file scope).
- Losing the archive NEVER blocks a release: the generator **fails open** to
  a full-only appcast with a loud warning, and every client simply downloads
  the full DMG for that one update. To re-seed, place the previous release's
  exact `.app` under the convention path with its `retained-archive.json`
  (schema `tibotattle-sparkle-retained-archive-v1`), or just let the next
  release start the chain again.
- The retained tree must be the exact shipped app: Sparkle applies the delta
  against the installed bundle, and BinaryDelta patches carry whole-tree
  hashes, so a drifted archive produces a delta clients cannot apply (they
  then fall back to the full DMG — safe, but wasteful).

## Generation (part of the signing gate)

`scripts/generate-sparkle-appcast.js` automates the appcast-creation half of
the [manual signing gate](2026-08-02-r2-sparkle-update-publisher.md): it runs
where the operator already runs Sparkle's offline `sign_update`, and signs
with exactly that key path — the operator Keychain by default, or
`--ed-key-file` precisely as `sign_update` accepts it. It never generates a
key, never stores one, and never touches the network. The Sparkle private key
still never reaches the publisher.

```bash
node scripts/generate-sparkle-appcast.js \
  --channel internal-dogfood \
  --app "/absolute/path/to/released/TiboTattle.app" \
  --dmg "/absolute/path/to/TiboTattle-0.1.1-macOS-arm64.dmg" \
  --bundle-version 2 \
  --short-version 0.1.1
```

Per run it:

1. Verifies the pinned Sparkle 2.9.3 tools (`sign_update`, `BinaryDelta`)
   against their reviewed SHA-256s, and that the app's `CFBundleVersion`
   matches `--bundle-version`.
2. Signs the DMG with `sign_update` and emits the canonical single-item
   appcast with the content-addressed enclosure URL
   (`<origin>/<prefix>/<version>/<sha256>/<file>`).
3. For each retained prior version (up to `--max-deltas`, default 2), runs
   `BinaryDelta create`, **applies the patch back onto the retained tree and
   requires the result to reproduce the candidate app bit for bit**, signs
   the `.delta` with the same `sign_update` invocation, and adds it inside
   the item's `<sparkle:deltas>` container. Delta files are written beside
   the DMG, where the publisher expects them.
4. Self-checks the emitted XML with the publisher's own appcast validation,
   so generation can never produce a shape the publisher rejects, and (when
   `--sparkle-public-ed-key` is passed) verifies every emitted signature
   locally against the release public key.
5. Retains the candidate `.app` into the archive and prunes old versions.

The delta placement matters: Sparkle clients treat only enclosures inside
`<sparkle:deltas>` as delta candidates and keep the item's own enclosure as
the full download they fall back to when no delta matches the installed
version or a patch fails to apply. This shape was verified against Sparkle
2.9.3's own `generate_appcast` output on a two-version fixture (not assumed),
and the publisher rejects delta enclosures outside the container.

## Publishing (no extra steps)

`npm run product:macos:publish-update` is unchanged operationally. The
publisher now:

- accepts delta enclosures in the candidate appcast where channel policy
  allows them, requires each candidate-version delta artifact beside the DMG,
  and fails closed (`SPARKLE_UPDATE_DELTA_ARTIFACT_MISSING` /
  `SPARKLE_UPDATE_DELTA_ARTIFACT_INVALID` /
  `SPARKLE_UPDATE_SIGNATURE_INVALID`) on a missing, mismatched, or
  wrongly signed delta before any remote call;
- uploads validated deltas as immutable content-addressed objects
  (`application/octet-stream`, one-year immutable caching) alongside the DMG
  and release manifest, before the appcast-last atomic mutation;
- read-backs every published delta enclosure (immutable cache headers and
  exact Content-Length) in the same public verification pass as the appcast
  and DMG.

A full-only appcast publishes exactly as before, byte for byte — a missing
archive degrades the update experience for one release, never the release
itself.

## Local proof (2026-08-07)

Proven end to end with two locally built preview versions (distinct bundle
versions, no network, no notarization, ephemeral test signing key):

- `scripts/build-macos-app.js --preview-distribution` at bundle versions 1
  and 2, `package-macos-dmg.js --preview` for both, then the generator with
  version 1 retained: it produced
  `TiboTattle-0.1.0-macOS-arm64-preview-from-1.delta`, the BinaryDelta
  apply-check reproduced the version-2 app tree exactly, and both the delta
  and full enclosures carried locally verifying Ed25519 signatures.
- Measured, not estimated: full version-2 preview DMG **49,589,069 bytes**
  versus delta **3,802 bytes** — the delta is 0.008% of the full download.
  The two builds differ only by their bundle version (the build is
  reproducible), so this pair is the floor case: a real code-change release
  produces a larger delta, and the real ratio should be read from the
  generator's summary line at each publish.
- The generated appcast plus real delta then passed the actual publisher
  validation path (`publishSparkleUpdate`, dogfood channel, validation-only,
  network seams trapped) with the delta receipted for immutable upload as
  `internal-dogfood/releases/2/<sha256>/…-from-1.delta`
  (`application/octet-stream`, one-year immutable caching).

Regression specs pin the machinery: `test/macos-updater.test.js` watches the
generator fail open, produce, sign, and apply-validate a delta with the real
pinned tools, and `test/publish-sparkle-update.test.js` covers delta
publication, read-back, every fail-closed path, the fallback-container
placement rule, and the stable policy flip. Since 2026-08-19 the publisher's
signed-feed preflight covers both named channels, so the hand-built delta
shape proven above no longer publishes as-is: the delta specs exercise it
behind an explicit spec-injected fixture policy (unreachable from the CLI,
refused for stable), and reviving delta publication for real goes through
the reviewed delta policy flip — extending
`sparkle-signed-feed-validation.js` and the Worker guard's official parser
for delta-carrying signed feeds — not through the hand-built shape.
