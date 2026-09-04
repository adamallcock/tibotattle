---
title: Astra live-log validation and Intel integration for 0.1.18
date: 2026-09-04
type: plan
status: in-progress
---

# Astra live-log validation and Intel integration for 0.1.18

Integrate the existing Astra/Codex compatibility work with the separately
implemented macOS Intel changes on `codex/release-0.1.18`, preserving its
requested `9e1c3333` base. Inspect only the owner-authorized current conversation
for live compatibility evidence. Raw content and identifiers stay outside
repository artifacts; regression fixtures must be synthetic.

- [ ] Inspect current Astra usage, model/effort/tier metadata, cache components
  and event shapes; compare observed evidence with the implemented parser and
  canonical price cards.
- [ ] Refresh official Astra pricing/capabilities and fix any verified mismatch.
- [ ] Preserve the tested compatibility work in a local commit, then integrate
  `codex/macos-intel-foundation` at `2b6b6be9`; resolve overlaps and regenerate
  derived contracts from their owners.
- [ ] Validate combined accounting, native architecture routing, build/runtime
  closure, website and Worker contracts. Run the broad root suite after fixes.
- [ ] Create reviewable release notes and a receipt with exact source/test
  status, live evidence limits, inherited artifact provenance and remaining
  release gates.

The Intel branch's signed tester candidate and R7 receipts certify its earlier
source. They do not qualify the combined Astra/Intel tree. Existing public
releases remain immutable; this task prepares source and local evidence.
Signing, installation, publication and any expanded private-corpus run require
their specific authorization and runbook.
