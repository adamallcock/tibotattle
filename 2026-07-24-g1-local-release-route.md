---
title: G1 Local-Only Release Route
date: 2026-07-24
type: plan
status: active
---

# G1 Local-Only Release Route

## Decision

The first volunteer release is restricted to **macOS arm64**. Claude Code and Codex remain required providers. The artifact remains local-only: it has no enrollment, upload, remote configuration, notification, cloud storage, or transport capability.

This decision narrows platform claims; it does not weaken privacy, determinism, deletion, content-exclusion, or clean-machine requirements. Windows, Linux, and macOS x64 move to a later platform-expansion gate and must not be implied by the first release.

## Current verified checkpoint

| Area | Current state | Evidence | G1 status |
|---|---|---|---|
| Serial repository baseline | Active hardening tree passes 470 of 470 under Node 26.2.0 and the pinned-candidate Node 24.14.0 runtime | Fresh serial test receipts | Closed for this checkpoint |
| Telemetry contract generation | 151 fields current; 9 of 9 contract/schema tests pass | Fresh `pnpm telemetry:check` | Closed for current draft |
| Codex export | Frozen-prefix, source-checkpointed, deterministic, disk-backed export sets; a bounded prospective collector source now emits provider-neutral quota candidates but is not yet wired into the workspace contract | Source-checkpoint/export-set receipts and focused collector-source tests | Open integration requirement |
| Compression | Deterministic bounded gzip with independent encoded/decoded limits and bomb rejection | Compression receipt and tests | Closed |
| Complete-set deletion | Two-step, exact-inventory, crash-recoverable logical deletion | Deletion receipt and SIGKILL matrix | Closed |
| Failed-workspace discard | Separate workspace-only implementation and schemas pass focused crash/recovery tests; the final independent destructive-boundary re-audit found no blocking defect within the declared same-user threat boundary | Exact-inventory tests, 20 of 20 focused tests, and final audit trail | Closed for this checkpoint |
| Claude quota | Bounded status-line normalization and owner-only local ledger retain independently optional five-hour/seven-day windows; canonical export and a real non-null callback remain open | 22 focused privacy/storage/race tests | Foundation closed; parity open |
| Claude usage | Local transcripts contain usage components; no production bounded adapter/checkpoints | Content-free local shape scan | Open |
| Native secrets | Stable owner-file backend plus rotation exists; exact-pinned, hash-verified macOS Keychain backend foundation passes adversarial tests but is not integrated into identity migration/rotation | Identity and Keychain-backend tests | Foundation closed; integration open |
| Minimization | Field policy and preregistered utility ablation exist; execution and decision receipt do not | Frozen preregistration | Preregistration closed; execution open |
| Resource limits | Heavy local history succeeds; limits remain candidate single-machine ceilings | Resource/source receipts | Open measured-release decision |
| Packaging | No pinned distributable runtime, SBOM, signatures, attestations, or installer | Repository inspection | Open |
| Clean-machine/volunteer gate | Not run | Requires signed artifact | Externally gated |

## G0 prerequisite matrix

G0 is a hard predecessor, not paperwork that can be backfilled after volunteers receive a build. A formal G1 receipt is invalid unless it embeds the approved dated G0 receipt hash and every row below is closed.

| G0 requirement | Current evidence | Status |
|---|---|---|
| Immutable historical baseline and reproducible golden local artifact | Dated exporter/source/compression/deletion receipts exist; a clean-clone golden rerun remains required | Partial |
| Generated allowed-field/prohibited-category control map | 151-field telemetry dictionary and privacy tests are current for draft v0.1 | Closed for draft; frozen successor open |
| Maintained risk register with control, test, owner, review date, and residual decision | Risk summary exists in the comprehensive goal; row-level register does not | Open |
| ADR set for identity, encryption, cloud, storage, cohort disclosure, and deletion | Keychain and local deletion decisions exist; later-system ADRs remain open | Partial |
| Invariant/gate-to-code-test-runbook traceability | Receipts provide partial links; one generated or reviewed matrix does not | Open |
| Repository/release controls, dependency policy, secret scan, SBOM/provenance/signing plan | Private remote verified; remaining controls and release evidence are open | Partial |
| Named operator, contact, incident owner/backup, controller responsibility, and external-review point | Adam Allcock is accountable project owner; contact/backup/review engagement remain unset | Open |
| Signed privacy-contract approval | Draft contract exists; owner approval of the frozen volunteer bytes/wording is not recorded | Open |

Exit: a dated G0 receipt closes every row, identifies any accepted residual, and is explicitly approved by Adam Allcock before the G1 receipt can be produced.

## Critical path

### R1 — Reproducible baseline and live gate ledger

- Keep the default serial suite and generated telemetry contract green.
- Treat dated receipts as immutable historical evidence.
- Use this document as the live status ledger rather than rewriting a past receipt's then-current open list.
- Add focused verification receipts for every newly closed slice.

Exit: a fresh serial run, contract check, and clean diff support the current source tree.

### R2 — Local cleanup completeness

- Add a separate `discard-export-workspace` flow for poisoned or incomplete workspaces.
- Accept only a workspace path; complete export outputs must be structurally unreachable.
- Refuse scan-complete, manifest-bound, chunk-bearing, corrupt, foreign, linked, symlinked, or unexpectedly shaped workspaces.
- Delete only authenticated SQLite sidecars and the workspace database through a committed journal, exact quarantine/revalidation, durable unlink, receipt, and recovery.
- Preserve source logs, participant identity, account-scoping key, collector/activity state, reports, and any independent export directory byte-for-byte.

Exit: non-mutating preflight, stale-token/refusal cases, crash/recovery matrix, privacy scans, and preservation tests pass.

### R3 — Prospective Codex provider quota input

- Treat the passive collector ledger as a bounded frozen-prefix local source.
- Export only already-sanitized `codex_quota_snapshot` windows from `app_server_read` or notification evidence.
- Revalidate all fields against the export allowlist; never trust the collector ledger merely because it is locally generated.
- Convert a locally available account scope into an export-secret-derived account pseudonym; leave it `unattributed` when absent.
- Give account-level observations explicit sessionless semantics rather than inventing a session pseudonym.
- Bind collector source identity, prefix digest, checkpoint, resource accounting, and resume behavior into the workspace contract.
- Preserve app-server read versus notification provenance, observed/received time, integer display precision, reset time, plan type, limit, slot, and shared-pool surface.
- Do not export official lifetime/daily summaries in this slice unless separately justified by the minimization study.

Exit: create/resume/reorder/repeat equivalence, mutation/truncation/link/oversize/process-death tests, and a prospective same-account local smoke pass.

### R4 — Claude provider parity

- Treat Anthropic's [status-line field reference](https://code.claude.com/docs/en/statusline) as the quota-source contract: it documents consumed percentages and reset epochs for independently optional five-hour and seven-day windows, present for eligible Claude.ai subscribers only after the first response. Anthropic's [usage-limit error reference](https://code.claude.com/docs/en/errors#youve-hit-your-session-limit) confirms that session and weekly allowances are shared across models while a model-specific Opus limit is separate.
- Replace the ad hoc status-line tap with bounded, centralized, owner-controlled capture in application state.
- Convert independently present five-hour and seven-day status-line windows into canonical quota observations.
- Derive a session pseudonym in memory from `session_id`, then discard the raw identifier.
- Validate percentages, reset epochs, source, fixed window durations, and optional-window behavior before persistence.
- Build a streaming Claude transcript parser that reads only structural timestamp/model/usage/tool-class/lineage evidence and never forwards message content, tool arguments/results, paths, branches, titles, attribution labels, request IDs, inference geography, or raw session IDs.
- Install the Claude callback so it retrieves the telemetry pseudonym capability from Keychain at runtime; never embed a secret in Claude settings, shell configuration, command arguments, or environment variables. Preserve and restore any pre-existing user status-line configuration, and test install, coexistence, rotation, uninstall, locked-Keychain, and fixed secret-free failure behavior.
- Preserve uncached input, cache read, cache creation/write, and provider-reported combined output. Do not relabel a combined output total as visible text or separately observed thinking.
- Add Claude frozen-prefix source plans, incremental checkpoints, resource accounting, restart/process-death equivalence, deterministic cross-provider ordering, reviewed registries, and provider conformance fixtures.
- Use `ccusage claude` only as an aggregate local cross-check, never as the event-level source or quota authority.

Exit: compatibility declares Claude implemented only after usage and authoritative quota paths both pass schemas, privacy canaries, malicious fixtures, resume tests, and one real non-null subscriber callback.

### R5 — Native macOS capability storage

- Follow the [macOS Keychain backend decision](./2026-07-24-macos-keychain-backend-decision.md), which selects an injectable exact-pinned native adapter subject to binary/source audit and a throwaway-service smoke.
- Add a native Keychain backend for the export participant identity and a distinct Keychain item for account-observation HMAC scope.
- Keep telemetry identity, account observation, future upload authentication, recovery, device pairing, and optional notification capabilities cryptographically separate.
- Preserve migration conflict refusal, stable reinstall behavior, rotation serialization, content-free diagnostics, and explicit no-secure-erasure wording.
- Make uninstall preserve identity by default; permanent identity removal requires a separate target-specific confirmation.
- Keep owner-file storage only as an explicitly labeled development/fallback backend, not the default release claim.

Exit: Keychain create/read/reuse/migration/conflict/rotation/delete/error-path tests and a fresh-user macOS smoke pass.

### R6 — Preregistered data-minimization decision

The selection metrics and stop rules are frozen in the [G1 data-minimization ablation preregistration](./2026-07-24-g1-data-minimization-ablation-preregistration.md) before results are inspected.

Before comparing results, freeze hypotheses, metrics, tolerances, fixtures, and selection rules for:

- exact seconds versus minute and five-minute timestamps;
- session pseudonyms versus no session field;
- unknown-model keyed fingerprints versus a plain `unknown` class;
- detailed tool classes versus coarser tool/no-tool groupings;
- exact receipt/reset timing versus coarsened timing;
- diagnostic codes versus only quality-state summaries; and
- app-server daily/lifetime summaries versus omission.

Evaluate calibration error, reset matching, deduplication, contamination detection, provider/account separation, identifiability refusal, and disclosure risk. Remove or coarsen a restricted field unless its improvement exceeds the preregistered tolerance on untouched holdouts.

Exit: deterministic analysis, untouched holdout results, and a dated decision receipt explain every retained restricted field.

### R7 — Measured release ceilings

- Produce a content-free machine-readable benchmark receipt for scan, resume, materialize, verify, discard/delete, and uninstall cleanup.
- Exercise near-ceiling source files, line lengths, task/fork state, file count, record count, chunk count, workspace bytes, compressed and expanded bytes, RSS, CPU, and wall time.
- Enforce corresponding producer and verifier limits.
- Predeclare how ceilings are selected from heavy histories and machine samples.
- If evidence is not sufficient for a population p95, call it a conservative tested heavy-history envelope.

Exit: selected release ceilings are versioned, enforced, reproducible, and accurately labeled.

### R8 — Frozen local-review contract and signed artifact

- Create a new frozen telemetry/receipt/compatibility version; never make draft v0.1 upload- or volunteer-capable by changing a flag.
- Pin or bundle the exact Node runtime required for `node:sqlite` and compression semantics.
- Produce a reproducible macOS arm64 artifact, checksum manifest, CycloneDX or SPDX SBOM, license inventory, provenance/attestation, and private-path/fixture/credential/source-map scan.
- Run every signed-artifact install, doctor, inspect, export, verify, rotate, delete/discard, and uninstall path under deny-all egress while recording DNS/socket attempts. Bind a zero-attempt network-isolation receipt to the exact artifact checksums; absence of an upload command is not evidence.
- Document install, doctor, inspect, export, verify, rotate, delete/discard, identity preservation/removal, and uninstall.
- Update the exact privacy contract and local-review consent text for the built bytes.
- Developer ID signing and notarization remain externally dependent on owner credentials and Apple services.

Exit: unsigned reproducibility passes first; then the exact signed/notarized bytes and checksums pass verification.

### R9 — Clean machine and two independent local reviews

- On a genuinely clean macOS arm64 machine, run install, doctor, inspect, export set, verify, rotation, complete-set deletion or failed-workspace discard, and uninstall.
- Repeat the clean-machine workflow with outbound network denied and independently confirm zero attempted connections from the artifact or bundled runtime/dependencies.
- Two independent volunteers run the signed artifact locally and inspect their own bundles.
- No bundle, source log, or row-level metadata is sent to the project.
- Volunteers may return only the approved content-free verification receipt and qualitative feedback.
- The owner reviews and authorizes the exact local-review consent/privacy wording.

Exit: clean-machine receipt, two volunteer confirmations, resolved release-blocking feedback, and a formal G1 receipt.

## Human and external dependency ledger

No calendar dates have been committed by the owner yet. An unset date is itself an open gate condition, not permission to proceed.

| Dependency | Accountable owner | Current status | Required evidence | Deadline/stop rule |
|---|---|---|---|---|
| Developer ID signing and notarization | Adam Allcock | Credentials/service readiness unverified | Exact signed/notarized artifact and Apple verification receipt | Set a calendar date before R8; without it, no volunteer artifact |
| Clean macOS arm64 machine | Adam Allcock | Not scheduled | Machine provenance plus complete R9 receipt | Set before R8 freeze; without it, G1 stops |
| Two independent local-only volunteers | Adam Allcock | Not recruited | Approved consent plus two content-free confirmation receipts | Recruit only after signed artifact; fewer than two blocks G1 |
| Frozen privacy/consent wording | Adam Allcock | Draft only | Approval bound to artifact/schema hashes | Approve before any volunteer receives bytes |
| External pre-upload privacy/security reviewer | Adam Allcock | Not engaged | Scope, reviewer independence, report, closed critical/high findings | Required before G4 real upload, regardless of G1 timing |
| Incident owner and backup | Adam Allcock | Owner named; backup unset | Named backup and drill receipt | Required in G0/G4; unset backup blocks upload |
| G3/G4/G9/G10/G11 human approvals | Adam Allcock | Future | Dated signed gate receipts | Each gate stops without its own approval |

## Deferred until G1 passes

The following remain prohibited during this route: external enrollment, email/notification collection, upload URLs, cloud buckets, encryption-envelope transport, remote configuration, quarantine, canonical multi-user storage, private participant web results, aggregate publication, continuous network upload, and country collection.

Those capabilities resume only at their original G2–G11 gates in the comprehensive end-to-end goal.

## Ownership boundary

Agents may implement and audit controls and produce evidence. Only the human project owner may:

- accept residual privacy risk;
- authorize a frozen volunteer contract;
- use signing/notarization credentials;
- recruit volunteers or receive their approved receipts;
- authorize any external collection or transport; or
- approve later public aggregate publication.
