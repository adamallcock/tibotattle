---
title: ARM RC3 installed runtime and preservation qualification
date: 2026-09-05
type: receipt
status: passed-with-explicit-boundaries
---

# ARM RC3 installed runtime and preservation qualification

This receipt applies to the final signed ARM `0.1.18` / `1025.2` internal-dogfood
app from source `7701debf44e046ac9f25bb74f7214532e32c5c5d`, with payload
`f790d439735e86a36ddfd61c690aee80c19aec17e1f3123dc69f1797062f1e02`.
The [signed receipt](./2026-09-04-macos-combined-rc3-signed-candidates.md)
binds its final DMG bytes and production installed-artifact validation. This
later observation follows owner unlock; it does not rewrite the earlier
locked-Mac result or qualify stable build `1026`.

## Observed runtime

Normal native launch starts the installed app and its direct bundled companion,
with one loopback-only listener and a ready snapshot. An earlier detailed
refresh's terminal result was not captured and is not claimed as passing.
The subsequently observed native-menu detailed refresh ran from
`2026-09-05T03:56:51.278Z` to `2026-09-05T03:58:43.541Z` and succeeded:

- Unified parser v14 generation 71; 8,110 sources and 811,273 usage events.
- Replay-safe rebuilt accounting, complete usage coverage, exact generation
  fingerprint match, zero fallback and no deferred accounting rebuild.
- Existing `tool_provenance_incomplete` remains explicit; this is not a claim
  of complete historical tool provenance.

The app was quit through its explicit native menu before read-only verification.
An earlier keyboard quit did not stop it; the verifier refused while it was
running. A separate sandbox process-inspection refusal was also retained.
Neither refusal was bypassed or relabeled. Native relaunch afterward was observed;
the initial dashboard explicitly displayed its retained last-verified projection
while background projection was pending, not a false zero.

## Stopped-state preservation

The verifier first required canonical owner-private files, no running installed
app or bundled companion, no state-file handles and no SQLite sidecars. It used
immutable read-only SQLite connections and made no database or raw-history writes.

| Boundary | Result |
|---|---|
| Baseline v11 generation 69 | All 804,238 usage, 844,934 tool and 1,043,857 quota occurrences retained; all 8,086 sources retained |
| Approved v14 rehearsal generation 70 | All 807,434 usage, 848,386 tool and 1,047,053 quota occurrences retained; all 8,096 sources retained |
| Reviewed counters | All nine counter fields match the approved rehearsal for shared occurrences; the 1,053 baseline nullable-component corrections are exactly the already reviewed changes |
| Coverage and identity | Zero missing keys, identity changes, receding coverage bounds or quarantined sources; exact internal source/order attestation passes |
| Integrity and publication | Schema 11 and expected parser metadata; all three SQLite quick checks pass; published generation counts match stored facts |
| Private settings | Device salt bytes and paused contribution-setting bytes are unchanged |
| Read-only stability | Held descriptors, file identities and bounded header/tail hashes remain stable; no full-database byte-hash claim |

The installed generation additionally contains 3,839 usage events beyond the
reviewed copy. No accounting rebuild, history deletion, credential reset or
permission change was used by this verification. Original stable app/state
recovery copies and all earlier candidate artifacts remain preserved.

## Claim boundary

No unexpected automatic Keychain prompt was observed during the named launch,
refresh, quit and relaunch operations. This is not the unavailable disposable
profile/manual Login Item matrix or physical Intel qualification. Those are
separately [waived for 0.1.18 only](../decisions/2026-09-05-release-0-1-18-manual-qualification-waiver.md),
not passed. Stable source/tag, signing, installed stable, CI, immutable GitHub
release, updater feeds and production deployment remain separate gates.
