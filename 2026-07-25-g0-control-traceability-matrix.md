---
title: G0 Control Traceability Matrix
date: 2026-07-25
type: reference
status: active
---

# G0 Control Traceability Matrix

## Purpose

This reviewed matrix maps the program's permanent invariants and G1 route to implementation, automated evidence, and operator-facing documentation. A mapped row is not necessarily a passed release gate: `partial` and `open` rows identify the exact missing proof. Paths are repository-relative so a clean clone can verify the mapping.

Update this matrix whenever a control moves, a schema or contract version changes, a test is renamed, or a release gate closes. Dated receipts remain immutable evidence for their historical commits; the [G1 route](./2026-07-24-g1-local-release-route.md) and [risk register](./2026-07-25-g0-risk-register.md) are live.

## Permanent invariant mapping

| Control | Requirement | Implementation | Automated evidence | Runbook or decision evidence | Current status |
|---|---|---|---|---|---|
| C-01 | Extraction, never redaction; unknown fields have no output path | `src/export-safe-records.js`, `src/export-contract.js`, `src/export-privacy.js`, strict schemas under `schemas/telemetry-v0.1/` | `test/export-safe-records.test.js`, `test/export-privacy.test.js`, `test/export-schema.test.js`, `test/telemetry-contract.test.js` | [Telemetry privacy contract](./2026-07-24-telemetry-privacy-contract.md) | Implemented for current local adapters |
| C-02 | No arbitrary telemetry strings | `src/export-registries.js`, generated field dictionary and compatibility tuple | `test/export-contract.test.js`, `test/telemetry-contract.test.js`, `test/export-schema.test.js` | [G1 exporter hardening receipt](./2026-07-24-g1-exporter-hardening-receipt.md) | Implemented for draft v0.1; successor freeze open |
| C-03 | Official client never transmits content | `transportReady: false`, local CLI commands only; no upload/enrollment module | `test/export-contract.test.js`, `test/export-privacy.test.js`, `test/activity-markers.test.js` | [G1 multi-source receipt](./2026-07-24-g1-multi-source-local-export-verification-receipt.md) | Local source claim implemented; packaged no-egress proof open |
| C-04 | Useful local inspection without enrollment | `inspect-export`, `export-local`, `export-set`, workspace inspection and verifiers in `src/cli.js` | `test/metadata-exporter.test.js`, `test/bundle-verifier.test.js`, `test/export-set-controller.test.js`, `test/export-set-verifier.test.js` | README local metadata exporter section | Implemented locally |
| C-05 | Pseudonymous, email-free identity with separated capabilities | `src/export-identity*.js`, `src/account-observation*.js`, `src/account-scope.js`, `src/claude-callback-capability.js` | `test/export-identity*.test.js`, `test/account-observation-secret.test.js`, `test/account-scope.test.js`, `test/claude-callback-capability.test.js` | [macOS Keychain decision](./2026-07-24-macos-keychain-backend-decision.md) | Participant/account/Claude capabilities implemented; fresh-user packaged smoke open |
| C-06 | Account and plan continuity boundaries | `src/account-scope.js`, `src/plan-timeline.js`, `src/passive-collector.js` | `test/account-scope.test.js`, `test/plan-timeline.test.js`, `test/passive-collector.test.js`, `test/provider-crosscheck.test.js` | [Multi-surface/account decision](./2026-07-24-multi-surface-account-provider-decision.md) | Implemented prospectively; real account-switch smoke open |
| C-07 | Subscription speed and API tier remain independent | `src/tier-semantics.js`, normalization and price ledgers | `test/tier-semantics.test.js`, `test/normalization.test.js`, `test/weekly-calibration.test.js` | README Fast/API-tier section | Implemented for current OpenAI evidence |
| C-08 | Tool calls remain explanatory unless provider billable units exist | `src/tool-mechanism-analysis.js`, safe tool-class counts, `src/claude-transcript-export-source.js` | `test/tool-mechanism-analysis.test.js`, `test/metadata-exporter.test.js`, `test/claude-transcript-export-source.test.js` | [Tool mechanism decision](./2026-07-23-milestone-6-tool-mechanism-decision.md) | Coarse client mapping implemented; Claude `server_tool_use` remains explicitly excluded pending G2 semantics |
| C-09 | Personal and public products use different disclosure rules | Draft contract classifies restricted/local fields; transport/public flags disabled | `test/telemetry-contract.test.js`, `test/export-contract.test.js` | [Complete goal](./2026-07-24-end-to-end-multi-user-usage-monitor-goal.md), Stage 8/9 | Planned; no public product exists |
| C-10 | Server cannot broaden local collection | Explicit CLI source selection; source plans bound into export-set identity | `test/export-set-controller.test.js`, `test/export-supplemental-source-plan.test.js`, `test/supplemental-source-lifecycle.test.js` | [G1 multi-source receipt](./2026-07-24-g1-multi-source-local-export-verification-receipt.md) | Implemented locally; server protocol future |
| C-11 | Deletion covers relations and derived outputs | Exact local set deletion/discard; future server deletion specified | `test/export-deletion-*.test.js`, `test/export-workspace-discard*.test.js`, `test/supplemental-source-lifecycle.test.js` | [Local deletion receipt](./2026-07-24-g1-local-export-deletion-verification-receipt.md) | Local implemented; canonical/public lifecycle planned |
| C-12 | Uncertainty remains visible | Quota precision, staleness, reset identity, unknown tier/model, residuals retained | `test/interval-inference.test.js`, `test/monitoring-quality.test.js`, `test/simple-quota-gradient.test.js`, `test/weekly-calibration.test.js` | [Usage accuracy floor](./2026-07-24-usage-accuracy-floor-decision.md) | Implemented for local reports |
| C-13 | Material change requires renewed consent | Contract and consent status are hash-bound compatibility inputs | `test/export-contract.test.js`, `test/telemetry-contract.test.js` | [Telemetry privacy contract](./2026-07-24-telemetry-privacy-contract.md) | Draft machinery implemented; real consent/version migration future |

## G1 route mapping

| Route | Exit evidence | Primary implementation | Primary tests/receipts | Current gap |
|---|---|---|---|---|
| R1 baseline | Full serial Node 24/26 suite, generated contract, clean diff | Entire repository and `scripts/generate-telemetry-contract.js` | `npm test`, `npm run telemetry:check`, dated checkpoint receipts | Clean-clone golden rerun before formal G1 |
| R2 cleanup | Exact complete-set deletion and failed-workspace discard with crash recovery | `src/export-deletion*.js`, `src/export-workspace-discard*.js` | deletion/discard schema, preflight, executor, SIGKILL, supplemental lifecycle tests | Packaged uninstall cleanup open |
| R3 Codex provider quota | Explicit bounded collector source, checkpoint/resume, mutation and process-death evidence | `src/codex-collector-*.js`, `src/passive-collector.js`, supplemental controller/workspace | collector source/workspace, passive collector, supplemental lifecycle tests; [multi-source receipt](./2026-07-24-g1-multi-source-local-export-verification-receipt.md) | Same-account and deliberate-switch real smoke |
| R4 Claude parity | Authoritative status quota plus transcript usage, callback lifecycle, conformance and real callback | `src/claude-statusline*.js`, `src/claude-transcript-*.js`, `src/claude-callback-*.js` | Claude transcript/source/workspace/status/callback tests; real export, verifier, structural and offline `ccusage` reconciliation in the [local receipt](./2026-07-25-g1-claude-local-verification-receipt.md) | Usage and callback lifecycle implemented; authenticated non-null quota callback open |
| R5 native capability storage | Separate Keychain capabilities and lifecycle | `src/export-identity-keychain.js`, production identity/account modules, `src/claude-callback-capability.js` | identity, Keychain, account-secret, and Claude callback-capability tests | Code paths implemented; fresh-user packaged smoke open |
| R6 minimization | Frozen A1–A7 analysis and field decisions | `src/minimization-ablation.js`, `scripts/minimization-ablation.js` | `test/minimization-ablation.test.js`; [ablation preregistration](./2026-07-24-g1-data-minimization-ablation-preregistration.md); [inconclusive decision](./2026-07-25-g1-data-minimization-ablation-decision.md) | Machinery implemented; retention decision remains inconclusive pending three eligible resets |
| R7 release ceilings | Measured, versioned, enforced heavy-history envelope | `src/export-resource-policy.js`, release evidence/watchdog/boundary/decision modules | Dual-runtime 721-test suites, exact ten-receipt matrix, [measured verification](./2026-07-25-g1-r7-measured-release-verification-receipt.md), and [open ceiling decision](./2026-07-25-g1-r7-release-ceiling-decision.md) | Evidence package complete; policy promotion remains open on explicit gates |
| R8 frozen artifact | Successor contract, pinned runtime, SBOM, provenance, signatures, no-egress proof | Not implemented | None yet | Entire route open; signing/notarization externally dependent |
| R9 clean machine/reviews | Clean macOS arm64 and two independent local reviews | Not implemented | None yet | Entire route open; human recruitment/approval required |

## Verification commands

```bash
npm run telemetry:check
node --test --test-concurrency=1
/Users/adamallcock/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-concurrency=1
git diff --check
```

The absolute Node 24 path is a machine-local verification convenience, not a portable runbook or packaged runtime. R8 must replace it with a pinned or bundled artifact workflow.
