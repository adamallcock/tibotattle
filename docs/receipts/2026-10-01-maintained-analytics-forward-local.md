---
title: Maintained analytics local forward operator evidence
date: 2026-10-01
type: receipt
status: local-implemented
---

# Maintained analytics local forward operator evidence

This receipt records local operator packaging for H06 on 2026-10-01 in the
uncommitted `codex/maintained-analytics-framework` candidate based on
`f056940fefabed0c7f0e88353cf54845b077f0c8`. It covers the new
[local operator](../../apps/worker/scripts/maintained-analytics-forward-migration.mjs),
[focused checks](../../apps/worker/scripts/maintained-analytics-forward-migration.check.mjs)
and [local runbook](../runbooks/2026-10-01-maintained-analytics-forward-local.md).
The profile is explicitly **unreviewed-local**; final SQL and frozen-manifest
approval remain pending. No remote inspection, credentials, hosted writes,
deployment, production activation, release or online readiness is established.

## Local implementation boundary

The closed profile admits exactly source ingestion isolation 0014–0016 then
analytics 0034–0047. It reads the complete canonical predecessor directories,
pins all SQL inputs dynamically and projects both exact schema/operator-ledger
digests at every frontier. Seventeen migrations produce 18 joint frontiers;
there is no pending 0048. Trigger replacements are executed by SQLite, without
an additive-only schema approximation.

One SQL-plus-ledger transaction commits each migration. A durable qualification
journal records intent before submission. It binds the exact plan and phase,
retains a private no-clobber plan file, and refuses input, schema, ledger, code,
control, data or journal drift. Before/after/ambiguous uncertain outcomes are
classified read-only; continuation requires the exact reconciliation digest,
and not-applied retry needs an additional explicit acknowledgement.

The synthetic code/control prerequisite is all three feature flags disabled
for public, analytics, publication and cache roles. Compatible code evidence is
explicitly pinned. Activation requires both final database frontiers and follows
analytics → cache → publication → public. Forward-safe fallback follows the
reverse order and retains every schema, ledger and original predecessor-row
digest. There is no destructive downgrade, relabel or source-wipe interface.

The concrete adapter uses disposable in-memory Node SQLite. Test fixtures are
minimal, content-free and synthetic: an accountless participant, source/runtime
registration, cursor, owner state and stored graph result, alongside prefix
seed rows. Their retention proof is not native recomputation, deployed last-good
serving or provider interruption proof. The separately named
[populated D1 receipt](./2026-10-01-maintained-analytics-migration-local.md)
remains tied to its earlier tested bytes and supplies no later-source claim.

## SQL size boundary

At the initial local inspection, source0015 was **269,024 file bytes**, with
**129** statements from the installed Wrangler splitter. Its largest individual
statement was **7,253 bytes**; its exact SQL-plus-operator-ledger request was
**269,191 bytes**. These are separate dimensions. The local profile permits at
most **512KiB** per local migration/request. Existing global 240KiB file and
256KiB transport caps were preserved. Hosted statement/request acceptance and
any reviewed final source0015 size reduction remain outside this measurement.

## Validation checkpoints

Environment: Node.js 26.2.0, macOS arm64, Node SQLite and the candidate's installed
Wrangler SQL splitter. No dependencies or lockfiles were changed.

| Checkpoint | Result |
| --- | --- |
| `node --check apps/worker/scripts/maintained-analytics-forward-migration.mjs` | Passed |
| `node --check apps/worker/scripts/maintained-analytics-forward-migration.check.mjs` | Passed |
| Initial `node --test apps/worker/scripts/maintained-analytics-forward-migration.check.mjs` | 10/10 passed, no skipped tests, 134.63 seconds; before the saved-plan persistence addition |
| `node --test --test-name-pattern='full migration journal\|lost .*commit reply\|unapproved writes' apps/worker/scripts/maintained-analytics-forward-migration.check.mjs` | 4/4 selected checks passed, no skipped tests, 91.78 seconds after saved-plan persistence |
| `pnpm --config.verify-deps-before-run=false run docs:check` | Passed: 293 Markdown and 1,178 source/config files |
| `pnpm --config.verify-deps-before-run=false run architecture:check` | Passed: 709 production files, 3,140 imports, zero approved debt edges |

Initial assertions cover every migration's late-failure rollback and exact
retry, original-data retention, ledger uniqueness, before/after response loss,
exact read-only reconciliation, ambiguous cross-database drift refusal, enabled
controls/incompatible code/partial ledger/premature activation refusal,
activation response loss, consumer-first fallback, replay completion,
changed/extra/symlink SQL refusal, closed CLI modes, private journal permissions
and operation binding. No test was skipped or weakened.

## Point-in-time operator checkpoint

At 2026-10-01 08:50:42 UTC, after the selected saved-plan checks, the owned
operator SHA-256 was
`155ec4fc8500817b95582ef875cf5d168d6febe40020a3a256112394b9425443`
and its check file SHA-256 was
`69c70137d19e9f2fbecc24f8e3cdb24fed6a409422fdb515cc66ab67083a17f7`.
These identify the local files at that checkpoint; they are not frozen-manifest
approval or a rerun of all ten tests after saved-plan persistence. Owned-file
whitespace checks passed. Final root preflight and gate integration belong to
the integration owner.

## Split-statement frontier alignment

The local projector and adapter now execute the pinned Wrangler-split statements
and a bound ledger insert within the same transaction. This matches D1 batch
schema text, including splitter removal of inline comments inside two 0040
triggers. Original migration bytes and hashes are unchanged. The closed-plan
and every-migration late-failure/rollback checks passed 2/2 after this change
(3.38 seconds). Earlier hashes and validation rows above remain historical.

## Transport candidate proof

The new transport module, script checks and actual-D1 test are integrated into
the Worker owning gates. Fifteen unique Node cases passed across focused runs;
the successful selected run times total173.83seconds, including repeated cases.
The exact local D1 batch proof passed1/1 in1.65seconds. Syntax and owned-file
whitespace checks passed. These are local source/test checkpoints, not frozen
manifest or hosted approval.

The exact source0015 body is273,935bytes with130 entries, including its final
bound ledger insert; SHA-256
`d3e365e19ae62a3d351dda95626cd395bab8b8ebb0055e8cc1a958efdf99a820`.
The scoped exception leaves existing global caps and prior profiles unchanged.
Cases cover full17-step progress, exact target/input/approval refusal, six
uncertain-response modes, no implicit replay, late rollback, lost committed
response reconciliation, malformed/conflicting results, nonserializable pins
and an independent timeout even when injected mock I/O ignores its abort signal.
The actual D1 test proves both late-failure and duplicate-ledger rollback before
successful commit of the exact130 entries.

Hosted REST request acceptance, hosted rollback/result shape and populated
index duration remain unqualified. The transport has no credentials or real
network execution mode.

## Remaining gates

The precise hosted file/profile/transport allowance and 0041/0043 regression
qualification must settle before an exact frozen manifest can be reviewed.
Source0015 remains unchanged for the integration owner's active immutable local
diagnostic; that freeze is not online approval. This receipt will retain checkpoints
as point-in-time evidence; it will not promote dynamic preparation hashes to
live pins or reinterpret an earlier test result as a later execution.

The new package has no live CLI/provider. Hosted packaging still needs exact
observed predecessor inventories/ledgers/schema variants, immutable role code
and bindings, maintained backup/deletion-ledger posture and production lock,
provider/transport bounds, protected authorization, uncertain terminal-status
reconciliation, drain/containment and live activation/rollback qualification.
Deterministic throw/response-loss tests are not abrupt OS-process death or
provider terminal-status tests. Combined Worker qualification, H06/H07 and
production cutover remain separate open gates.
