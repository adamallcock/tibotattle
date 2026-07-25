---
title: G1 Compression and Local Export Deletion Plan
date: 2026-07-24
type: plan
status: active
---

# G1 compression and local export deletion plan

## Decision

Complete deterministic, resource-bounded bundle compression before implementing local export deletion. Compression changes the stored chunk representation, filenames, manifest rows, verifier dispatch, and deletion inventory. Building deletion against the current plain representation first would create a second deletion protocol immediately afterward.

Both gates remain local-only. They add no upload, enrollment, server, background process, analytics, or network destination. Compression must never remove a prior artifact. Deletion must never touch Codex or Claude source logs, the participant identity secret, collector history, account registration state, activity markers, reports, or arbitrary neighboring files.

## Gate C — canonical compressed representation

### Representation

- Use a single-member gzip stream through built-in `node:zlib`; add no package or subprocess dependency. Signed/release artifacts must pin and record their bundled Node/zlib runtime.
- Pin an explicit profile: gzip, compression level 6, default strategy, no filename, no comment, and a zero modification-time header.
- Store chunks as fixed names such as `chunk-000000.bundle.json.gz`; keep chunk receipts and set manifest/control files uncompressed.
- Treat gzip as a representation, not the logical identity. Bundle IDs, decoded `bundleSha256` and `bundleBytes`, record ordering, packing decisions, chunk-independent logical-record digest, and participant pseudonyms continue to derive from canonical decoded `stableJson` bytes. The encoded ceiling is an independent acceptance gate, not an automatic packing signal; a caller wanting smaller artifacts must lower the decoded canonical chunk ceiling.
- Add separate manifest and receipt fields for the fixed encoding/profile plus exact stored `artifactSha256` and `artifactBytes`. The stored hash authenticates the emitted representation; recompressing decoded bytes on another zlib version is not required to reproduce that hash. Version-dispatch plain v0.1 and compressed v0.2 artifacts; never permit a mixed set.

### Binary publication

- Narrowly extend the existing receipt-first, bundle-last pair transaction to accept a `Buffer` or `Uint8Array` as well as a string.
- Preserve current no-clobber, inode, size, digest, owner, permission, symlink, hardlink, sync, failpoint, and recovery rules.
- Never infer text encoding for binary artifacts, and never print an artifact path or digest in ordinary CLI output.

### Independent resource bounds

- Retain the existing 32 MiB decoded canonical-bundle ceiling per chunk.
- Add a separately named encoded-artifact ceiling; use 34 MiB as a conservative candidate until real compressed-set evidence supports a lower value.
- Add cumulative decoded-set and encoded-set counters and ceilings. Both must exactly match manifest totals.
- The verifier must lstat/open/hash and bound the encoded artifact before decompression.
- Decompress one chunk at a time with `maxOutputLength` bounded by both the declared decoded size and the decoded ceiling. Then require exact decoded bytes/hash, canonical JSON, schema, compatibility, privacy checks, record counts, ordering, uniqueness, greedy packing, and logical digest.
- Reject truncation, corrupt checksums, concatenated members whose total output exceeds the bound, nested/archive declarations, declaration mismatches, and all decompression failures with fixed content-free codes.
- Keep existing elapsed-time, RSS, chunk-count, manifest-size, and temporary-verifier workspace limits. A compression-ratio heuristic is not an acceptance rule; exact input/output ceilings are.

### Compression acceptance

1. Two clean materializations from one workspace produce identical encoded artifacts, receipts, and manifests within the same pinned release runtime. Cross-runtime verification consumes and hashes stored artifacts; it does not recompress them.
2. Decoded canonical-bundle and logical-record goldens remain unchanged across the supported verification runtime matrix. A zlib-version fixture demonstrates that compressed-byte identity is intentionally not the semantic identity.
3. Compressed single-bundle and complete-set round trips pass independent verification.
4. Encoded oversize fails before inflation; a tiny bomb and concatenated-member case fail at the decoded ceiling without unbounded allocation or residue.
5. Truncation, checksum corruption, encoded hash/size mismatch, decoded hash/size mismatch, encoding/profile mismatch, and mixed plain/compressed chunks fail closed.
6. Binary pair publication and recovery pass every existing receipt-first transaction failpoint and concurrent/stale-lock case.
7. Decoded artifacts and all output/control/error surfaces pass privacy-canary scans.
8. Plain v0.1 format dispatch remains explicit and isolated; compressed v0.2 is the only format emitted after the compatibility change. Because the telemetry contract is an unfrozen local draft with `backwardCompatibility: none_regenerate_local_review_artifacts`, a v0.1 artifact carrying an older compatibility tuple is intentionally rejected and must be regenerated.

## Gate D — crash-recoverable local export deletion

### Supported first slice

The first deletion implementation supports a complete, independently verified local export set plus its valid workspace. Incomplete, poisoned, corrupt, partial, mixed-version, identity-mismatched, or unverified artifacts fail closed with fixed codes. A later separately reviewed slice may add strict partial-set deletion from authenticated workspace metadata; the first slice must not broaden into arbitrary cleanup.

CLI surface:

- `delete-local-export --workspace PATH --directory PATH` performs a read-only content-free preflight and changes nothing. It returns a short target-specific confirmation token derived from the canonical deletion-plan digest.
- `delete-local-export --workspace PATH --directory PATH --confirm-deletion TOKEN` starts or resumes deletion only when the token matches the current exact plan.
- `recover-local-export-deletion --workspace PATH --directory PATH` resumes an already committed durable deletion journal without a second destructive confirmation.

Preflight reports only artifact class, state, bounded file/byte counts, and whether deletion is ready. It omits paths, filenames, pseudonyms, hashes, source details, and record values. Every path states that network activity is absent and secure SSD erasure is not claimed.

Deletion does not read or require the participant secret. A participant must still be able to delete local exports after identity rotation, loss, conflict, or secret-store damage. The command never changes or removes identity state.

### Locking and ownership

- Export a narrow destination-lease wrapper from the existing storage lock implementation rather than creating a competing lock protocol.
- Acquire locks in the existing materialization order: workspace lease first, destination lease second. Verify and delete only while both are held.
- Resolve and reject equal, nested, root, filesystem-root, symlinked, foreign-owned, group/world-writable, or unstable targets and parents before creating a journal.
- Recover outstanding publication transactions before inventorying a set.
- Bind the workspace descriptor, manifest, export-set identity, source-plan digest, coverage, compatibility, and chunk rows to each other, then independently verify the complete set. Do not require a current participant secret.

### Exact inventory and journal

- Build a bounded exact inventory from the versioned set manifest and fixed chunk naming rules: compressed bundle artifacts first, then chunk receipts, set manifest, set manifest receipt, and finally the exact workspace database and approved closed SQLite sidecars.
- Refuse unexpected workspace entries. Preserve every unrelated destination sibling. Never use recursive removal, glob deletion, shell expansion, or unresolved environment variables.
- Bind each inventory row to a fixed role/name plus device, inode, type, link count, byte size, and SHA-256. Cap rows from the manifest chunk ceiling.
- Write one canonical owner-only `O_EXCL` deletion journal, sync it, publish a no-clobber commit marker, and sync its directory before the first unlink. The journal contains a fixed schema/version and plan digest over the workspace/output directory identities, workspace descriptor, set manifest identity, and exact inventory; it contains no absolute path, participant/export/bundle/session identifier, source path, content, secret, or raw provider identifier.
- Before the commit marker, recovery may remove abandoned staging but must delete no target. After commit, recovery may only continue exact journal-listed unlinks.
- Every resumed unlink requires the current file to match the journal evidence exactly. An absent row is already complete; a changed/replaced/linked row stops recovery without deleting the replacement.

### Monotonic deletion order

1. Durable committed journal.
2. Set manifest, making the set independently unverifiable immediately.
3. Encoded bundle artifacts; each bundle must disappear before its receipt.
4. Workspace SQLite sidecars, then the workspace database while the workspace lease remains held.
5. Chunk receipts, then the set-manifest receipt.
6. Publish a fixed, privacy-safe, no-clobber deletion receipt stating logical removal, preserved source/identity state, no network, and no secure-erasure claim.
7. Remove the deletion journal only after every listed artifact is absent, the exact deletion receipt is durable, and directory state is synced.

Leave empty owner-only workspace/output directories in the first slice. Directory removal is unnecessary for the privacy claim and would widen the destructive boundary. Deletion is logical file removal, not guaranteed physical-media erasure.

### Deletion acceptance

1. Preflight is byte-for-byte non-mutating; wrong identity and unsafe/equal/nested targets fail before a journal exists.
2. A stale or wrong target-specific confirmation token fails before journal commit. Confirmed deletion removes every exact listed export/workspace artifact while unrelated sibling canaries survive.
3. Process-death recovery passes after journal durability, first and last bundle unlink, first and last receipt unlink, each manifest unlink, first SQLite-sidecar unlink, database unlink, and journal cleanup.
4. Recovery is idempotent. It never recreates an artifact and never needs source logs.
5. Symlink, hardlink, replacement, unsafe permission/owner, unexpected workspace entry, journal mutation, manifest mismatch, active lock, and stale-lock takeover cases are explicit and fail closed.
6. CLI stdout/stderr, journals, and the deletion receipt contain no paths, participant/export/bundle/session IDs, raw hashes, filenames, content canaries, or secrets.
7. Tests prove no recursive deletion path exists and that source logs, identity secret, collector state, activity markers, reports, and foreign siblings remain byte-identical.

## Implementation order

1. Version the compressed set/receipt contracts and add encoded/decoded resource fields and fixed codes.
2. Add binary-safe pair publication/recovery tests, then implementation.
3. Add deterministic compressor and compressed materializer output without deleting or overwriting plain artifacts.
4. Add bounded decompression and version-dispatched independent verification.
5. Run compressed goldens, bomb/adversarial cases, clean-runtime and real-history materialization/verification receipts.
6. Export the existing destination lease and add deletion preflight plus exact inventory.
7. Add target-specific confirmation, committed durable deletion journal, privacy-safe retained deletion receipt, and monotonic exact-file recovery for complete sets.
8. Extend the exact inventory to readable poisoned and incomplete workspaces using only validated durable chunk rows; corrupt or unbound state remains fail closed.
9. Add CLI/docs, full failpoint/SIGKILL and privacy suites, a real temporary-set deletion drill, and a dated verification receipt.

## Implementation checkpoint

Gate C is implemented and locally verified:

- current materialization emits strict `usage-export-set-manifest-v0.2` sets with fixed `.bundle.json.gz` names, decoded semantic hashes and sizes, encoded artifact hashes and sizes, producing Node/zlib provenance, and separate decoded/encoded totals;
- decoded canonical packing remains deterministic and compression-independent; the encoded limit is checked exactly once after packing and before the workspace records a plan or the destination publishes an artifact;
- the durable receipt-first pair writer publishes strings, `Buffer`s, and `Uint8Array`s byte-exactly up to the 34 MiB encoded ceiling, with binary recovery exercised at all publication failpoints and a 32 MiB + 1 byte regression;
- the verifier bounds and hashes the on-disk encoded artifact before decompression, uses `maxOutputLength`, validates exact decoded identity and privacy receipts, rejects mixed representations, and retains explicit current-tuple plain v0.1 dispatch;
- old-policy v0.1 artifacts are intentionally rejected under the checked-in no-backward-compatibility draft contract and must be regenerated;
- adversarial coverage includes corrupt/truncated gzip, checksum failure, decoded-output bombs and concatenated members, actual on-disk encoded oversize, decoded hash mismatch, unsafe permissions, privacy canaries, content-free CLI failures, crash adoption, and deterministic same-runtime output;
- a Node 20.0.0/zlib 1.2.13 fixture decodes exactly on Node 26.2.0/zlib 1.3.1 without recompression, proving the semantic/artifact identity split;
- the full serial repository suite passes 370 tests, while the 151-field telemetry contract remains current and all 9 contract checks pass; and
- a real local 3 hour 28 minute export produced 5,066 metadata-only records, 5,643,451 decoded canonical bytes, and one 334,815-byte gzip artifact, then passed independent v0.2 verification with `transportReady=false`.

The detailed evidence is recorded in [the compressed export-set verification receipt](./2026-07-24-g1-compressed-export-set-verification-receipt.md). Gate D deletion remains open. No existing artifact was overwritten or removed, and transport remains absent.

## Explicit non-completion

Passing these gates will not complete G1. Native secret stores, Claude parity, prospective account-scoped quota evidence, signed clean-machine distribution, two local-only volunteer reviews, and pilot-derived ceilings remain required. Every consent, enrollment, upload, cloud validation, private-results, aggregation, publication, ongoing-collection, participant-server-deletion, and incident-operations stage remains closed.

## Primary runtime reference

- [Node.js zlib API](https://nodejs.org/api/zlib.html): `gzipSync`/`gunzipSync`, binary typed-array support, and bounded convenience-method output through `maxOutputLength` (supported since Node 12.19/14.5, within the declared Node 20+ range).
