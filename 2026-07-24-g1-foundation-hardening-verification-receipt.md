---
title: G1 Foundation Hardening Verification Receipt
date: 2026-07-24
type: verification-receipt
status: verified-local
---

# G1 foundation hardening verification receipt

## Verified scope

This receipt covers four local-only foundations on branch `agent/bounded-export-identity-lifecycle` before their release integrations:

- bounded prospective Codex collector-ledger quota extraction;
- bounded Claude status-line normalization and owner-only local capture;
- failed/incomplete export-workspace discard; and
- an exact-pinned, hash-verified macOS arm64 Keychain adapter.

It also covers the governing end-to-end goal corrections for purpose-separated credentials, independently issued eligibility units, and the mandatory pre-upload external review. It does **not** claim that Codex collector candidates or Claude records are wired into canonical export, that the Keychain adapter is the active identity backend, that Claude transcript usage is implemented, that telemetry v1 is frozen, or that G1 is complete. Network transport remains absent and unauthorized.

## Implemented evidence

### Codex collector source

- Freezes a complete-line source prefix and resumes from exact byte, line, and window cursors.
- Revalidates the current collector record rather than trusting locally generated data.
- Emits provider-neutral quota candidates without official daily/lifetime balances, raw account values, paths, content, or raw identifiers.
- Refuses mutation, truncation, replacement, unsafe permissions, links, oversized structured records, an oversized unterminated tail, and resource-limit exhaustion with content-free errors.

### Claude status-line capture

- Bounds stdin to 64 KiB and preserves independently optional five-hour and seven-day windows.
- Strictly validates percentages, reset epochs, model/version classes, and hostile objects without retaining prompts, responses, paths, repository details, or raw session identifiers.
- Persists complete owner-only records under an owner-only, descriptor-verified application-state tree.
- Uses bounded reads, no-follow/single-link checks, directory identity revalidation, atomic publication/recovery, resource ceilings, and a lease that never reaps a live process solely because the lock is old.
- A concurrency stress regression exercises 48 writers; ten consecutive focused stress runs passed after the transient released-lock race was fixed.

### Failed-workspace discard

- Uses a separate `discard-export-workspace --workspace PATH [--confirm-discard TOKEN]` command and cannot address a complete export output directory.
- Refuses complete, manifest-bound, chunk-bearing, unexpected, linked, permission-unsafe, foreign-transaction, and replaced workspaces.
- Authorizes only a fixed SQLite database/sidecar inventory through an opaque target-specific token, committed journal, marker, and receipt that contain no paths, hashes, inodes, identifiers, or source content.
- Quarantines by atomic no-clobber hard link, verifies inode and content evidence, durably unlinks the source, and recovers monotonically across declared crash states without recursive deletion.
- The final independent destructive-boundary re-audit returned **ACCEPTED**, with no blocking scope, race, link, recovery, foreign-transaction, error-leak, or authorization-token defect inside the documented cooperative same-OS-user boundary.

### macOS Keychain adapter

- Pins `@github/keytar` at exactly `7.10.6` and directly loads only its audited Darwin arm64 prebuild after verifying SHA-256 `855c21e1e702967230bd87f600d04c311b77f29150f3372d547e72882c58de6a`.
- Separates export-identity and account-observation capabilities with fixed service/account pairs and distinct stored values.
- Accepts only canonical 32-byte base64url secrets, uses timing-safe comparisons, never enumerates credentials, and reduces native failures to fixed content-free codes.
- Supports read, create-if-missing, exact replacement, and exact deletion under a caller-held application lease. It does not claim native compare-and-swap or secure erasure.
- A random throwaway Keychain smoke completed create, read, replacement, deletion, and confirmed-missing cleanup under Node 24.14.0. This proves local feasibility, not packaged-artifact acceptance.

## Final verification evidence

Commands run against the active hardening tree:

```text
NODE_NO_WARNINGS=1 <bundled-node-24>/bin/node --test --test-concurrency=1
470 passed, 0 failed (Node 24.14.0)

node --test --test-concurrency=1
470 passed, 0 failed (Node 26.2.0)

npm run telemetry:check
telemetry contract current: 151 reviewed fields
9 passed, 0 failed

node --test test/export-workspace-discard-schema.test.js test/export-workspace-discard.test.js
20 passed, 0 failed

git diff --check
clean

gh repo view adamallcock/app-usagemonitor --json visibility,isPrivate,url
visibility PRIVATE; isPrivate true
```

Representative ignored local/private artifacts were checked with `git check-ignore -v`: `.usage-monitor/`, `exports/`, and verification-failure screenshots remain excluded from the commit surface.

## Remaining release blockers

- Integrate the native Keychain backend into participant-identity inspection, migration, lease, rotation, and permanent-removal flows.
- Bind the Codex collector source into the canonical workspace source plan, checkpoint/resource accounting, account pseudonymization, and deterministic materialization order.
- Convert Claude quota records into canonical observations and add a bounded transcript-usage adapter; install a real callback that retrieves its capability from Keychain at runtime.
- Execute the preregistered minimization ablation and measured-release ceiling study.
- Freeze telemetry v1, produce the reproducible signed/notarized no-network artifact, pass the clean-machine workflow, and complete two local-only volunteer reviews.

The owner-file identity backend remains a development/fallback path. The Keychain decision stays `proposed` until integration, policy-denial/concurrency testing, packaging/SBOM evidence, and clean-machine validation pass.
