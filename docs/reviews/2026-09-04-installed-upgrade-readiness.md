---
title: 0.1.18 installed upgrade readiness
date: 2026-09-04
type: review
status: in-progress
---

# 0.1.18 installed upgrade readiness

The owner authorized replacing the installed app with a signed candidate while
preserving data and a rollback copy, and asked to continue to the publication
decision point. Publication remains held until actual release gates pass.
The [signed RC2 receipt](../receipts/2026-09-04-macos-combined-rc2-signed-candidates.md)
remains immutable historical evidence; upgrade timeout and paginated-setting
regressions require corrected source and fresh RC3 bytes before qualification.

## Observed starting point and preservation

Direct inspection supersedes the older installed-RC9 status entry: the installed
app is ARM **stable 0.1.17 / 1024**, source
`aa660b24a66196155ba59267ab832cc4ef6e1c7d`, tag `v0.1.17`. Its source/payload
and channel metadata match the retained published stable DMG and receipt.
The prior same-dogfood RC9-to-RC2 artifact check is not an observation of this
installed stable-to-dogfood transition.

After a graceful Quit, no app/companion process or open state-root file owner
remained. A fresh owner-only backup outside the state root preserves the entire
Application Support directory, native preference domain and exact installed
app. Cloned copies were checked against original contents and modes: 607 files,
167 directories, nine preserved symlinks and 27,227,038,463 regular-file bytes
across app/state. Keychain items remain in place; none was exported, reset or
granted broader access. The older separate Dogfood app was not touched.

The preserved index passes `quick_check`, has physical schema 11 and parser
`unified-rollout-typed-v11`. Its published generation is partial solely for
incomplete historical tool provenance, with 8,086 indexed sources and no skipped
sources. Private exact aggregates and timestamp bounds are retained locally;
no session identifiers, source names or raw history enter this review. The
saved contribution pause is true and is not changed by preparation.

Retained stable rollback DMG: 49,871,590 bytes, SHA-256
`f4a56f7a90e1fe0f6018b9aa5c99a27ff8b34dabd9416fc76a0491aa7fc75d50`;
adjacent receipt SHA-256
`5bd463f627c97aaa15fcacb1b6d0920fce557e5e868d26360381dbb4c1c2799a`.
This is suitable future ARM stable continuity input, not an Intel predecessor.

## Upgrade deadline regression

RC2's companion still restricted its extended parser-upgrade deadline to target
v11, while its ingestion parser was v13. The preserved installed v11
generation therefore received the ordinary five-minute limit before accounting
could start, despite requiring a full supported parser rescan.

The initial correction admitted only reviewed published v10/v11/v12-to-exact-v13
transitions. Existing physical/schema, minimum reader/writer, source identity,
contract and terminal-publication checks remain intact. Current, unknown,
malformed, future and uncertain parser states retain five minutes. This changes
the deadline classification, not ingestion admission, integrity checks or
publication rules. A sparse large-file regression matches the installed
v11/tool-partial/no-skipped-source shape without scanning user data in tests.

Focused deadline tests pass 3/3, with no skips; two parser-upgrade tests failed
against the pre-fix source. The changed companion/deadline documentation is
outside the R7 workload closure, so that correction alone did not require
regeneration. The subsequent v14 source correction below does invalidate the
retained ten receipts and requires fresh generation before release use.

The complete affected companion suite passes 305/305 with no skips, and the
retained native suite passes 110/110 with no skips. The initial sandboxed
companion run was stopped after loopback-listen `EPERM`; the unrestricted
rerun passed without changing source or weakening tests. Independent quality
and test/documentation reviews found no remaining actionable issues in the
deadline/allocation changes. The production classifier also assigns the
preserved actual index the exact four-hour deadline without reading its facts.

## Copy-only rehearsal and attribution finding

One isolated v11-to-v13 ingestion completed in 189 seconds, with `rebuilt: false`,
8,091 discovered/scanned sources, no skipped sources and no malformed lines.
All 8,086 prior sources, 804,238 prior usage keys and 844,934 prior tool-fact keys
remain present. No source history lost rows or receded at its first/last bound.
The resulting generation remains partial solely for historical tool provenance.

One copy-only accounting run completed in 61 seconds, publishing and reading
back a v0.15 cache bound to that exact v13 generation. Accounting coverage is
complete with no block reason. The original backup, cloned index, unrelated
cloned state and four copied speed-baseline windows remain unchanged by this
accounting stage. No quota refresh, Keychain access, upload controller, baseline
recording or network request was constructed.

Semantic comparison nevertheless found two retained events changing from Sol
to Astra without own-file model evidence. Both are independent paginated fork
resets with no physical `history_base`; their exact raw counters and bounded
prefixes are unchanged. Neither prefix supplies a turn context. Both logical
parents have Astra usage after the child's event, but none at or before it.
The old Sol labels are historical incremental results, not proof that Sol is
the correct replacement label.

The cause is fallback from an absent/unknown physical history seed to a logical
parent's latest model in unified ingestion and rebuild lanes. Resume has a
similar tier fallback. This is future-parent attribution, not an Astra price
table error; unanchored missing settings must remain unknown. Parser v14 must
close the boundary across serial/parallel rebuild and incremental/resume, retain
explicit physical-base evidence without null-coalescing to later settings, and
force reparsing of earlier private v13 candidates. Physical schema remains 11.
The deadline's reviewed predecessor set consequently becomes v10-v13 to exact
v14, with all existing compatibility and publication checks retained.

The synthetic follow-up also reproduced descendant tier/replay traversal past
paginated resets and selected-head confusion: physical dependency ordering can
scan a retired continuation after a selected reset. Shared resolved-head
selection now controls parent settings, snapshot traversal and warm snapshot
planning. Retired physical sources still contribute their accounting facts;
they cannot overwrite the selected head. Ambiguous heads fail closed, while
legacy noncanonical singleton inheritance is retained. Serial, worker, warm-new
and warm-resume regressions cover both settings and replay boundaries.

The corrected source's five-file owning suite passes 238/238; the independent
targeted selected-head/legacy matrix passes 30/30, including ambiguity refusal.
The full companion suite passes 305/305 and pricing/catalog checks pass 25/25.
All have no skips. Architecture and the 20-test documentation preflight pass.
These are synthetic/source gates, not fresh real-corpus or installed evidence.

The v13 rehearsal is useful preservation/diagnostic evidence, not completed
attribution or RC3 qualification. Fresh synthetic, copy-only v14 and full R7
evidence are required before signing or installed replacement.

## Remaining work

- Allocate and verify fresh signed ARM/Intel RC3 `1025.2` on a common new clean
  annotated source tag. Keep RC2 `1025.1` unchanged; stable remains `1026`.
- Rehearse forward parser recovery against a separate state copy, then perform
  the authorized installed ARM transition and observe launch/refresh/restart,
  preserved state and prompt behavior. Do not reopen migrated state with an
  older reader; rollback includes its matching pre-upgrade state copy.
- Record the actual manual-v2 clean-profile/Login Item and failure-path matrix;
  ordinary launch or fake-manager tests cannot fill unobserved checks.
- Obtain physical Intel evidence or an explicit narrower public architecture
  decision, then finish the separate stable artifacts, CI/merge, hosted and
  publication gates in the [preparation plan](../plans/2026-09-04-release-0-1-18-publication-preparation.md).

No installed-state migration, app replacement, new candidate signing or
publication is inferred from the isolated rehearsal and source tests above.
