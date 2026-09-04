---
title: Paginated export compatibility and RC2 qualification
date: 2026-09-04
type: review
status: locally-qualified
source_commit: ef2d26ac78e75d9c9a1245d539d3ffd8c8c3476b
---

# Paginated export compatibility and RC2 qualification

## Outcome and boundary

The owner-authorized paginated reset export fix is implemented and locally
qualified on `codex/release-0.1.18`. Implementation commit
`b5fc39bf8e6976e7fbe96883bfe1ea33f7cea0bb` freezes the tested code;
`ef2d26ac78e75d9c9a1245d539d3ffd8c8c3476b` adds the ten fresh aggregate R7
receipts, yielding the complete reviewed source-and-evidence snapshot. The
validation below used those exact receipt bytes with unchanged implementation.
Synthetic compatibility and resource preflights pass. Complete R7 regeneration
and both pinned-runtime freshness checks pass. Optimized ARM/Intel builds and
all twelve isolated smokes pass. The final root suite passes with 3,815 passes,
zero failures and 17 Windows-only skips. The retained macOS suite passes all
108 tests without skips. This closes local compatibility/build qualification,
not signing, installed qualification or deployment. The earlier
[RC2 build proof](./2026-09-04-release-0-1-18-rc2-build-proof.md)
remains historical evidence for its different source.

## Supported contract

- Paginated export sources require absent/null physical history base and an
  explicit safe start ordinal zero. Logical forks do not imply inline replay.
  Actual physical-base continuations remain explicitly unsupported; malformed
  bases cannot silently become resets.
- Paginated usage and quota occurrence identities distinguish physical
  generations while preserving logical session and provider-state identity.
  Legacy v1 subjects are unchanged. Physical pseudonyms remain ephemeral and
  never become exported fields or parser-state payloads.
- Direct and checkpoint readers suppress exactly copied legacy tool records,
  not unrelated records sharing a call ID. Excluded parents and bounded
  physical-history seeds retain the same replay semantics in the direct reader.
- New source plans choose the explicitly resolved parent generation, not the
  last file in dependency order. Frozen parent edges are digest-bound and
  checked against the verified source metadata. Resume preserves that selection
  if the live head changes. Mutable head hints do not authenticate history or
  override a committed edge; the owner-only bundle is an integrity capability,
  not a signed historical selection receipt.
- Scanner v9, metadata adapter v6 and checkpoint scan v0.5 reject incompatible
  old workspaces before invocation recovery or any database mutation. Source
  plan v2, parser state v0.2 and workspace schema remain unchanged.

## Test run report

| Check | Verified result |
| --- | --- |
| Focused provider/export integration | 147 passed, no failures or skips |
| Reset, ancestry and constrained-heap regressions | 37 passed, no failures or skips |
| Local synthetic resource/evidence preflight | 62 passed, no failures or skips |
| Telemetry contract and mirrors | 13 tests passed; browser and 20 schema mirrors current |
| Architecture and documentation | Passed |
| Complete protected R7 regeneration | All ten validated receipts installed; exit 0 |
| R7 freshness and exact decision rebuild | 2/2 passed on each pinned runtime, no skips |
| Optimized development artifacts | ARM and Intel inspected; 12/12 isolated smokes passed |
| Final broad root suite | 3,832 total: 3,815 passed, 0 failed, 17 Windows-only skips; 489.7 seconds |
| Retained macOS suite | 108 passed, no failures or skips; 250.1 seconds |

The constrained-heap tests retain exact line-count assertions. Each source now
costs one additional metadata read during frozen-plan creation; the three
expected counts were updated without changing token, tool or memory limits.

An initial sandboxed root preflight recorded 3,825 tests: 3,755 passed, 53 failed
and 17 Windows-only skips. That is not a passing suite. Failures included socket,
process-sampling, nested-sandbox and disk-image restrictions, the three corrected
line counts and two genuinely stale R7 receipts. The affected synthetic resource
tests and the complete root suite subsequently passed outside the sandbox.
Intermediate stale-manifest failures occurred while versions
were being changed; the owner generator refreshed the manifests before the
passing focused results. No test was weakened or skipped to obtain a pass.

## Fresh R7 evidence

The complete owner-authorized local workflow ran from 21:09:13 to 21:41:05 UTC
on 2026-09-04, using the unchanged preregistered interval and hash-pinned Node
24.14.0 and 26.2.0 binaries. All six preliminary profiles completed. The shared
real-history plan froze successfully at 21:15:49; its lifecycle phase completed
in 25.6 minutes. Both decision rebuilds passed and the generator installed all
ten validated receipts, then cleaned its transaction controls.

The retained source closure is 362 files, SHA-256
`76ee96306c297f7e77279e7dc382411c801f6a020a0c26e61864f698d3e782af`.
Each pinned runtime independently revalidates the complete set and exactly
reconstructs its decision receipt from all eight inputs. The decisions remain
`release_open`, with unresolved export resource ceilings; that preserved outcome
is not a generic macOS release blocker. Fresh provenance is now established,
not inferred from the earlier Intel receipts or from a partial profile run.

The shared plan covers 3,125 selected sources and 12,068,007,861 source bytes.
Both runtimes produce 456,918 records, 541,586,222 decoded artifact bytes and
30,253,881 encoded bytes. Scan, materialization and verification projections
agree across runtimes; each runtime's complete repeated-run projections match
internally. Cleanup/lifecycle projections can differ across runtimes as before;
this is not a claim that every cross-runtime receipt hash is identical.
Privacy and preservation flags are unchanged. Five metric locations retain a
single external-RSS sampling failure each while satisfying the validator; the
run is not represented as having error-free sampling. Changed source byte
totals and environment-sensitive resource metrics do not establish a controlled
before/after performance improvement.

The real-history profile covers four completed lifecycle operations; six remain
`not_run`, as in the retained protocol. Both decisions retain nineteen unresolved
dimensions and seven open promotion gates. Network activity remains unmeasured.
Completion means the entire prescribed evidence workflow produced valid fresh
receipts, not that every possible real-corpus operation or release gate passed.

## Exact development artifacts

Both builds use the optimized `release` compiler profile, version `0.1.18`,
development bundle version `2000.1.18`, minimum macOS `14.0`, ad-hoc signatures,
disabled updater and unconfigured central service. Neither is signed RC2 build
`1025.1`. Their common build-source digest is
`02d3b3371ad6a7098a534156bd901ff7377d5199a20b6f49f285e5ba3f3d5085`.

| Target | Normalized payload SHA-256 | Payload bytes |
| --- | --- | ---: |
| ARM64 | `25d1d8e6e9ccf332d23e3653cc84fae1d6caa3e0253865c361fd011013ed54c5` | 155,138,731 |
| Intel x64 | `2385f7f106f96b5c804257e2b0e6bee94126ee90c6645bc8496be239347d13d1` | 156,927,851 |

Independent bundle inspection and `lipo` checks verify exactly three intended
thin Mach-O executables in each app. The preserved Intel Node runtime passes
its pinned binary and license checks. All six smoke modes per architecture pass:
disabled updater, fake Login Item, in-memory Keychain broker, migration UI,
normal companion startup and JIT-less startup. Each uses a separate empty
temporary profile; checks confirm owner-only state and no LaunchAgent/Daemon.
Intel execution is under Rosetta, not physical Intel proof.

An initial ARM build invocation incorrectly supplied the Intel-only runtime
override and was refused before construction. The documented pinned-builder
ARM default then passed; no source or guard was changed for that correction.

## Release boundaries

RC2 allocation remains `1025.1`; stable remains `1026`. Signed Intel RC1 build
`1025`, source `18c7065b`, and its immutable evidence are preserved. There is no
new signed/notarized RC2, annotated source tag, installed upgrade, physical Intel
test or confirmed physical Intel upload evidence from this work. No publication,
push, hosted write, updater activation, real Keychain change or system install
is authorized by this qualification task.

Task-local logs and development artifacts live under ignored `.release-build/`
with the `paginated-` prefix. Raw histories remain local and are never copied
into fixtures, retained diagnostic output or this review. Only the generator's
validated closed aggregate receipt set may replace retained R7 evidence.
