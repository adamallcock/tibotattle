---
title: Unified Index Preservation and Recovery
date: 2026-08-27
type: runbook
status: maintained
last_verified_commit: 52399658
---

# Unified index preservation and recovery

Use this runbook for `local_unified_index_schema_invalid`, integrity failures,
an app that can no longer open its index, or a suspected interrupted migration.
It is preservation-first: recovery must never destroy the only copy of facts
whose rollout source may already have rotated away.

## Hard prohibitions

Do not:

- edit `PRAGMA user_version` or `meta.schema_version` to make a reader accept a
  file;
- delete, truncate, vacuum, or rebuild over the only index;
- wipe Application Support or use **Erase local data** as diagnosis;
- open a newer index with an older app/reader in writable mode;
- copy only the database while losing its device salt and surrounding
  provenance; or
- assume a visible 30-day chart is the retention horizon.

If an exact destructive replacement is eventually needed, it requires a
separate reviewed decision after the copy and candidate are verified.

## 1. Freeze the writer

Quit TiboTattle and confirm no companion or rebuild process still owns the
state root. Do not kill a process while it is publishing unless it is truly
stuck; the normal cancellation path preserves completed checkpoints.

For an installed app, the expected state root is:

```text
~/Library/Application Support/Usage Monitor
```

Standalone developer/CLI runs may use a configured root or the platform
`app-usagemonitor` default. Resolve the exact path from the failing runtime;
never guess between them.

## 2. Preserve the exact state

Create a new owner-only sibling recovery directory inside the live index/state
directory. Copy, without moving or modifying the originals:

- `local-unified-index-v1.sqlite`;
- `local-unified-index-device-salt-v1`;
- `local-collector-state-v1.sqlite`;
- relevant fixed-code diagnostics; and
- the app version, source commit (if a source checkout), state-root path, file
  sizes, mtimes, and SHA-256 digests.

If SQLite sidecars exist while every writer is stopped, preserve them too.
Keep private paths/digests in the local recovery record, not a public issue.

## 3. Inspect the copy only

Run SQLite checks against the copied database:

```sql
PRAGMA query_only = ON;
PRAGMA quick_check;
PRAGMA application_id;
PRAGMA user_version;
SELECT value FROM meta WHERE key = 'schema_version';
SELECT value FROM meta WHERE key = 'status';
```

Record exact output. `quick_check = ok` proves page-level consistency, not
semantic compatibility or complete source coverage.

Compare the copy with the current constants in `src/local-unified-index.js`:

- schema family `local-unified-index-v2`;
- `user_version` 11;
- parser `unified-rollout-typed-v11`; and
- source identity `codex-immutable-rollout-v1`.

## 4. Classify before acting

| Observation | Classification | Next action |
| --- | --- | --- |
| Integrity passes; version is newer than this reader | Reader downgrade/mismatch | Install or build the newer compatible reader. Do not change the database. |
| Integrity passes; version 1-9 and legacy family is recognized | Supported forward migration | Rehearse the current reader against a second copy, then inspect generation/coverage before considering live recovery. |
| Integrity passes; version/family/application id is unexpected | Wrong file, unsupported format, or metadata corruption | Preserve and escalate. Do not relabel. |
| Integrity fails | Physical corruption | Preserve original and all sidecars; attempt extraction or rebuild only into separate candidates. |
| Schema opens but generation is partial/incomplete | Source/provenance problem | Inspect generation issues and retained last-good facts; do not equate it with database corruption. |
| App opens an older copy but current live file fails | Likely forward incompatibility or publication/migration issue | Keep both; compare versions and generation descriptors without overwriting either. |

## 5. Dry-run the copy-first recovery paths

The maintained recovery command is a prepare/apply workflow. Choose a new
owner-only recovery directory directly inside the live index directory; it must
not already exist. Start with the non-writing path check:

```bash
npm run index:rebuild -- \
  --index "/absolute/path/to/Usage Monitor/local-unified-index-v1.sqlite" \
  --recovery-dir "/absolute/path/to/Usage Monitor/recovery-YYYYMMDD-HHMMSS" \
  --codex-home "/absolute/path/to/the/selected/codex-home" \
  --workers 1 \
  --dry-run
```

Dry-run validates exact path topology and arguments without creating the
recovery directory. Review every printed path and the generated apply-command
shape. Unknown, duplicate, missing, and mode-incompatible options fail before
source or destination access.

## 6. Prepare and inspect a separate candidate

Run the same command without `--dry-run`. Preparation does not replace or open
the live index writable. It refuses WAL or live SQLite sidecars, validates the
existing device salt without repairing it, creates a consistent backup and
private salt copy, rebuilds a separate candidate, and verifies schema,
compatibility, generation, counts, `quick_check`, and foreign keys.

The immutable owner-only `receipt.json` binds the live source, backup, salt,
candidate, generation, counts, paths, sizes, and SHA-256 identities. A rebuild
can reconstruct only sources that still exist, so compare candidate and backup
for earliest/latest usage and quota timestamps, usage/quota/tool counts,
source coverage, skipped reasons, and any facts whose rollout has rotated away.
Do not apply a candidate with an unexplained loss or quarantine.

## 7. Apply only the reviewed receipt

Replacement is a separate explicit operation. Keep the app stopped and use the
exact `applyCommand` emitted by preparation:

```bash
npm run index:rebuild -- --apply \
  --index "/absolute/path/to/Usage Monitor/local-unified-index-v1.sqlite" \
  --candidate "/absolute/path/to/Usage Monitor/recovery-YYYYMMDD-HHMMSS/candidate.sqlite" \
  --receipt "/absolute/path/to/Usage Monitor/recovery-YYYYMMDD-HHMMSS/receipt.json" \
  --confirm-index "/absolute/path/to/Usage Monitor/local-unified-index-v1.sqlite" \
  --confirm-app-stopped
```

Apply revalidates every receipt-bound identity, creates and validates an exact
`pre-publish-live.sqlite` rollback copy, acquires the recovery and SQLite writer
locks, then atomically replaces the live index. It never auto-removes an
existing recovery lock. If it reports
`local_unified_index_recovery_publication_state_uncertain`, keep the app stopped
and preserve the live file, sidecars exactly as found, receipt, backup, and
pre-publish copy; do not retry or delete anything.

## 8. Validate and close with a private receipt

Relaunch the compatible app, run an explicit refresh, and verify generation,
usage, quota, tools, timeline, weekly, and accounting coverage against the
reviewed receipt. Missing evidence must remain unavailable rather than zero.
Retain both rollback copies, the private salt copy, and `receipt.json` through
an agreed observation period; cleanup or rollback requires separate explicit
authorization.

Record the failure code, versions, integrity result, preserved digests, actions,
candidate receipt, comparison, post-restart result, and remaining gaps. Redact
usernames, home paths, account identities, and private evidence from public
issues. If the cause was a schema or runbook mismatch, update
[`../reference/unified-index-schema.md`](../reference/unified-index-schema.md),
the relevant tests, and this runbook together.
