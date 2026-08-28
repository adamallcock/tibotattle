---
title: Local unified index compatibility and recovery
date: 2026-08-27
type: runbook
status: canonical
---

# Local unified index compatibility and recovery

Use this runbook when TiboTattle reports that the unified local index is
unavailable or was written by a newer build. The index is derived local state;
raw Codex history and collector inputs are separate and must not be deleted as
part of this procedure.

## Choose the least invasive repair

For a healthy index written by an older supported schema, the normal repair is
to install a trusted compatible TiboTattle upgrade. The application migrates
the index forward in one transaction and preserves its generation and rows.
The shipped 0.1.16 app wrote schema 8; newer pre-release code may have written
schema 9. The 0.1.17 migration accepts either supported predecessor as
applicable and moves it to schema 10.
Schema changes between releases are ordinary embedded-database maintenance;
silent downgrade, stamping old metadata onto a newer schema, or sharing one
database between unrelated app channels is not.

Beginning with 0.1.17, compatibility-aware code that sees a newer schema or
minimum-reader requirement opens the file read-only, returns
`local_unified_index_schema_newer`, and leaves the bytes unchanged. Install a
newer compatible build.

Do **not** reopen a migrated schema-10 index with shipped 0.1.16. That binary
opens the database writable, may change SQLite journal mode before validation,
and returns only its older generic schema rejection. It does not implement the
typed, byte-preserving newer-schema refusal described above. If rollback is
required after migration, keep the app stopped and use the preserved
pre-migration copy, a newer compatible build, or the explicit recovery process;
do not point 0.1.16 at the migrated live index merely because it is signed.

Use the explicit recovery command only when the normal transactional migration
cannot complete, validation finds a derived-index problem, or an owner has
chosen to rebuild the index from retained source history. Recovery is not a
cache-clear button and never authorizes deletion of raw history, collector
state, unrelated build residue, or rollback artifacts.

## Before preparation

1. Quit TiboTattle and confirm no TiboTattle process is writing the index.
   Keep it stopped through preparation, receipt review, and apply. The apply
   flag is an operator attestation; it cannot prove that the app is stopped.
2. Preserve the state directory and confirm there is enough free space for the
   live index, a consistent backup, a rebuilt candidate, and an exact
   pre-publish rollback copy.
3. Confirm the existing unified-index device salt is an owner-only regular
   file. Recovery deliberately refuses to create, chmod, or repair a missing
   or invalid live salt: doing so would change the index's HMAC identity
   domain.
4. Choose a new recovery directory directly inside the live index directory.
   It must not already exist. The tool creates it mode `0700`; candidate,
   backup, private salt copy, receipt, and rollback names are fixed within it
   and must not alias the live index.
5. Do not move, edit, compact, or delete the live index or device salt between
   preparation and apply.

The examples below use placeholders deliberately. Replace every placeholder
with an absolute path and keep the quoted spaces:

```bash
node scripts/rebuild-local-unified-index.mjs \
  --index "/absolute/path/to/Usage Monitor/local-unified-index-v1.sqlite" \
  --recovery-dir "/absolute/path/to/Usage Monitor/recovery-YYYYMMDD-HHMMSS" \
  --dry-run
```

Dry-run validates argument and path topology and writes nothing. Review the
printed `indexFile`, recovery paths, source-history directory, worker count,
and generated apply command before continuing.

## Prepare a candidate without replacing the live index

Run the same command without `--dry-run`:

```bash
node scripts/rebuild-local-unified-index.mjs \
  --index "/absolute/path/to/Usage Monitor/local-unified-index-v1.sqlite" \
  --recovery-dir "/absolute/path/to/Usage Monitor/recovery-YYYYMMDD-HHMMSS"
```

Preparation first read-validates rollback-journal state and then the live
device salt without modifying either. WAL, a live SQLite sidecar, or a missing
or invalid salt stops before the recovery directory is created. It then
reserves the private directory, writes an exact owner-only `device-salt.copy`,
makes a consistent SQLite backup, proves the source and salt identities did
not change around the copy, rebuilds only against that private salt copy, and
validates:

- SQLite `quick_check` and foreign-key integrity;
- physical schema and explicit minimum reader/writer compatibility;
- generation identity and completion status; and
- declared versus actual row counts.

Preparation also requires rollback-journal mode with no live `-wal`, `-shm`,
or `-journal` sidecar. It inspects the SQLite header without opening the source
through SQLite, so rejecting WAL does not create or attach sidecars. Stop and
diagnose a WAL-mode index; do not delete its sidecars or copy only its main
file, because committed pages may exist only in the WAL.

It then writes an immutable mode-`0400`, content-free receipt binding the live
source and device salt, their private copies, rollback backup, candidate,
generation, counts, paths, sizes, and SHA-256 identities. Preparation never
replaces or opens the live index writable and never writes the live salt. If it
fails, keep the live index and any created recovery directory for diagnosis;
do not improvise a partial apply.

## Review and explicitly apply

Inspect the complete preparation result and `receipt.json`. Confirm that the
paths name the intended index and the newly created recovery directory, every
validation status passed, source/backup and salt/copy identities agree, and
candidate counts are plausible for the retained source history.

Use the exact `applyCommand` printed by preparation. Its shape is:

```bash
node scripts/rebuild-local-unified-index.mjs --apply \
  --index "/absolute/path/to/Usage Monitor/local-unified-index-v1.sqlite" \
  --candidate "/absolute/path/to/Usage Monitor/recovery-YYYYMMDD-HHMMSS/candidate.sqlite" \
  --receipt "/absolute/path/to/Usage Monitor/recovery-YYYYMMDD-HHMMSS/receipt.json" \
  --confirm-index "/absolute/path/to/Usage Monitor/local-unified-index-v1.sqlite" \
  --confirm-app-stopped
```

Apply acquires the exclusive recovery lock, revalidates the receipt and all
source/backup/candidate identities, writes and validates an exact
`pre-publish-live.sqlite` rollback copy, hashes everything again immediately
before publication, and atomically replaces the live index. In addition to the
cooperating-process sidecar lock, apply holds SQLite `BEGIN IMMEDIATE`
transactions on both the live and candidate inodes from the rollback copy
through post-publication validation. Those transactions exclude direct SQLite
writer commits during the hash-to-rename window. They cannot revoke a process
that already retained the replaced old inode and waits until apply releases
its lock, which is why the stopped-app attestation remains mandatory. Any
mismatch or unavailable writer lock found before rename stops the operation.

Apply repeats the raw rollback-journal/no-sidecar preflight before acquiring
the recovery lock, after the lock boundary, and immediately around the SQLite
writer transactions. It refuses WAL on either the live source or candidate;
the final synchronous header/sidecar checks and rename are a trusted primitive
that cannot be replaced by a callback and has no JavaScript yield between the
last check and rename.

A separate same-UID process can still be scheduled between filesystem syscalls
and create a sibling path outside SQLite's writer lock. Apply therefore checks
the published basename immediately after rename and again around validation.
If that unavoidable race, validation, durability check, or recovery-lock
cleanup fails after rename, apply
returns `local_unified_index_recovery_publication_state_uncertain` with
`published: true` and `candidateConsumed: true`. The candidate pathname is then
gone because its main file is at the live pathname. Keep the app stopped and
preserve the live main file, any sidecar exactly as found, the complete recovery
directory, and especially `pre-publish-live.sqlite`; do not delete a sidecar,
retry apply, or claim that the old live database remains installed.

Apply never automatically deletes a pre-existing lock, even when its recorded
PID appears absent. Node does not expose an atomic compare-and-unlink primitive;
automatic stale cleanup could delete a replacement lock belonging to another
contender. A valid lock reports `local_unified_index_recovery_locked`; a
malformed one reports `local_unified_index_recovery_lock_invalid`. Both remain
byte-for-byte in place for explicit operator inspection. Do not delete a lock
merely because it appears old.

## Validate before cleanup

1. Relaunch the trusted compatible app and refresh each local data surface.
2. Confirm the index is available, the generation is complete, and usage,
   quota, tool, timeline, weekly, and replay-safe accounting coverage are
   truthful. Missing evidence must remain unavailable rather than becoming
   zero.
3. Compare the post-recovery counts and generation with the reviewed receipt.
4. Retain `source-backup.sqlite`, `pre-publish-live.sqlite`,
   `device-salt.copy`, and `receipt.json` until the repaired app has operated
   normally through an agreed observation period and an owner separately
   authorizes lifecycle cleanup.

If post-apply validation fails, quit the app and preserve the entire recovery
directory. Escalate with the receipt and content-free error code. Do not delete
the state directory or overwrite the rollback copies. Restoring a rollback is
a separate explicit operation, not an automatic response to a failed refresh.

## Expected data-loss boundary

A normal supported migration is lossless for the index rows it accepts and
rolls back as one transaction on failure. Copy-first recovery preserves the
original index twice before replacement: the consistent source backup and the
exact pre-publish live copy. Rebuilding a derived index can omit only source
events that are already absent, quarantined, malformed, or outside the
collector's supported contract; validation reports partial generation reasons
instead of presenting fabricated completeness. Raw source history is never
deleted by this command.
