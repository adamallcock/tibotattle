---
title: G1 Local Export Deletion Verification Receipt
date: 2026-07-24
type: verification-receipt
status: verified-local
---

# G1 local export deletion verification receipt

## Verified scope

This receipt covers the first Gate D slice: target-specific, crash-recoverable logical deletion of one complete independently verified local export set and its bound valid workspace. It does not cover incomplete or poisoned workspace deletion, source-log deletion, identity deletion, cloud/server deletion, upload, secure physical-media erasure, or a hostile process already running as the same OS user.

No real Codex/Claude source log, existing user export, identity secret, collector state, activity history, or report was deleted during verification. Destructive drills used newly generated temporary fixtures only.

## Implemented contract

- `delete-local-export --workspace PATH --directory PATH` performs a read-only verified preflight and emits only fixed state, bounded file/byte counts, and a short plan-specific Base32 confirmation token.
- `--confirm-deletion TOKEN` must match the twice-built exact plan: once before locks and again under the existing-only workspace lease followed by the destination lease.
- `recover-local-export-deletion` resumes only a durable journal/commit pair or validates a true receipt-only completed state; a copied valid receipt over live fixed artifacts is rejected.
- The private journal is closed-schema canonical JSON. It binds manifest representation, directory device/inode identities, monotonic roles, exact file device/inode/link/size/SHA-256 evidence, counts, and the plan digest without storing paths, filenames, source/provider identifiers, pseudonyms, content, or secrets.
- Every target moves to a deterministic same-directory quarantine name, the directory is synced, the quarantined artifact is re-verified, and only then is it durably unlinked. Replaced, symlinked, hardlinked, permission-unsafe, identity-mismatched, mutated, missing-control, or directory-replaced states fail closed with fixed codes.
- Completion leaves a fixed no-clobber owner-only receipt stating logical removal, preserved source/identity state, retained directories, no network activity, `transportReady=false`, and no secure-erasure claim.

## Verification evidence

Final commands on Node 26.2.0:

```text
node --test test/export-deletion-schema.test.js test/export-deletion-preflight.test.js test/export-deletion-executor.test.js test/export-storage.test.js test/storage-pair-recovery.test.js test/export-workspace-lock.test.js test/normalization.test.js
90 passed, 0 failed

node --test --test-concurrency=1
406 passed, 0 failed

pnpm telemetry:check
telemetry contract current: 151 reviewed fields
9 passed, 0 failed
```

The generated temporary-set drill exercised:

- no-token preflight, wrong token, a genuinely stale formerly valid token, confirmed deletion, CLI recovery, and repeated receipt-only recovery;
- real subprocess `SIGKILL` after journal commit, manifest removal, quarantine-before-unlink, first and last compressed bundle, SQLite sidecar, workspace database, first and last chunk receipt, set receipt, final receipt publication, and both journal/commit cleanup boundaries;
- restart after each death, exact idempotent completion, and a no-recursion source guard;
- byte-for-byte preservation of source log, identity state, collector state, activity markers, reports, and unrelated output siblings through normal and crash-recovery paths;
- injected replacement at the quarantine move boundary, symlink/hardlink substitution, byte-identical inode replacement, journal mutation, directory rename/replacement with copied controls, nonexistent workspace recovery, and a copied valid receipt placed over a live export; and
- scans of CLI output, errors, durable journal, commit marker, and final receipt for local paths, source/session identifiers, pseudonyms, fixed artifact filenames, content canaries, and secrets.

Two independent read-only audits were run. The final destructive-boundary audit reported no remaining material finding under the documented same-OS-user trust boundary. The test/document audit's initial multi-chunk, SQLite-sidecar, quarantine-death, stale-token, byte-identity, persisted-control privacy, and no-recursion gaps were added before the final runs above.

## Residual boundary

The OS user account is the local trust boundary. POSIX does not expose a portable conditional unlink-by-inode primitive, and malicious same-UID code can already bypass this program to read, move, replace, or delete all raw logs, identity state, artifacts, locks, and controls. The lease/quarantine/revalidation protocol protects the supported cooperative workflow and detects replacements at its validation boundaries; it is not a sandbox claim.

Deletion is logical unlink plus directory durability, not guaranteed SSD/block erasure. Empty owner-only workspace/output directories and unrelated output siblings remain. Complete-set deletion no longer requires the participant secret. Strict deletion of authenticated incomplete/poisoned workspaces remains a separate future slice.
