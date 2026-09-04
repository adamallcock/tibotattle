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
remains immutable historical evidence; a newly identified upgrade timeout
regression requires corrected source and fresh RC3 bytes before qualification.

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
v11, while the current ingestion parser is v13. The preserved installed v11
generation therefore received the ordinary five-minute limit before accounting
could start, despite requiring a full supported parser rescan.

The correction admits only reviewed published v10/v11/v12-to-exact-v13
transitions. Existing physical/schema, minimum reader/writer, source identity,
contract and terminal-publication checks remain intact. Current, unknown,
malformed, future and uncertain parser states retain five minutes. This changes
the deadline classification, not ingestion admission, integrity checks or
publication rules. A sparse large-file regression matches the installed
v11/tool-partial/no-skipped-source shape without scanning user data in tests.

Focused deadline tests pass 3/3, with no skips; two parser-upgrade tests failed
against the pre-fix source. The changed companion/deadline documentation is
outside the R7 workload closure, so the retained ten receipts do not require
regeneration. Current recovery guidance now names v13 rather than silently
retaining the historical v11 parser claim.

The complete affected companion suite passes 305/305 with no skips, and the
retained native suite passes 110/110 with no skips. The initial sandboxed
companion run was stopped after loopback-listen `EPERM`; the unrestricted
rerun passed without changing source or weakening tests. Independent quality
and test/documentation reviews found no remaining actionable issues in the
deadline/allocation changes. The production classifier also assigns the
preserved actual index the exact four-hour deadline without reading its facts.

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

No installation, state migration, new candidate signing or publication is
inferred from the preservation and source tests above.
