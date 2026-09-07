---
title: R7 release-evidence receipt maintenance
date: 2026-08-19
type: runbook
status: maintained
---

# R7 release-evidence receipt maintenance

## Purpose and authority

The ten files matching `generated/r7-release-*.json` are retained
dual-runtime evidence for the R7 workload. Their source file count and digest
are generated from `workloadSourcePaths()` in
[`src/r7-release-evidence-schema.js`](../../src/r7-release-evidence-schema.js).
Do not copy a file count or digest into prose: the source closure changes as the
runtime graph, schemas, contracts, packages, and lockfiles change.

The receipts are current only when the generated-evidence test passes on the
exact checkout. A dated receipt never proves a later source tree merely because
its JSON still exists.

## Freshness check

Run:

```bash
node --test test/r7-generated-release-evidence.test.js
```

A source digest or file-count failure means every retained receipt is stale.
Do not hand-edit generated JSON, weaken the test, or relabel the source version.
Regeneration is required before those receipts can be used as release evidence.

Changes outside the source closure do not require regeneration. When attribution
is uncertain, inspect `R7_RELEASE_EVIDENCE_WORKLOAD_SOURCE_PATHS` or the
generated test result rather than inferring reachability from a filename.

## Protected inputs

The real-history profile reads the owner's private local Codex and Claude
corpora. Running it is an owner-authorized, local-only operation. Never upload
these corpora, copy them into fixtures, print private paths, or send them to an
external model. A normal documentation or source change does not authorize
regeneration.

The generator requires exact, hash-pinned binaries:

- Node 24.14.0 as the pinned candidate runtime; and
- Node 26.2.0 as the compatibility crosscheck.

Pass resolved absolute binary paths, not mutable symlinks. The script validates
each binary's version and SHA-256 before executing the workload.

## Regeneration

The retained interval is frozen at exactly 31 days:

```text
2026-06-24T09:00:00.000Z
2026-07-25T09:00:00.000Z
```

A fresh checkout can materialize tracked receipts as `0644`; the replacement
guard requires owner-only destinations. Correct the exact generated receipts
before starting:

```bash
chmod 600 generated/r7-release-*.json
```

Then run the generator without a short foreground timeout:

```bash
node scripts/regenerate-r7-release-evidence.js \
  --node24 "/absolute/path/to/node-v24.14.0-darwin-arm64/bin/node" \
  --node26 "/absolute/path/to/node-v26.2.0-darwin-arm64/bin/node" \
  --start-at 2026-06-24T09:00:00.000Z \
  --end-at 2026-07-25T09:00:00.000Z \
  --replace
```

Progress is written to stderr. Stdout remains the final summary containing the
validated receipt count and the generated source count/digest. Treat a missing
summary or nonzero process result as failure.

## Validation

After a successful generation:

```bash
node --test test/r7-generated-release-evidence.test.js
```

Inspect the diff for all ten receipts. Verify that runtime identities, source
provenance, deterministic projection comparisons, profile names, and decision
states changed only as the run explains. A passing generation does not itself
resolve an `unresolved` R7 release decision or authorize a release.

Wall time and child CPU are environment-sensitive. Peak RSS also varies with
GC timing, page-cache state, and memory pressure. Deterministic projection
digests are the strongest content comparison. Do not attribute a metric change
to a commit until the measured worker actually reaches the changed code.

The filesystem sampler measures a changing task-owned tree, not an atomic disk
snapshot. Its v0.2 transient-file rule permits one zero-link observation followed
by a distinct owned, singly-linked regular inode on the same device, only while
the exact parent and root stay bound. Both observed inode sizes are counted
conservatively; enumerated pathname count and observed file count can differ.
Persistent zero links, unsafe replacements, identity changes, and arithmetic
overflow still fail closed. This handles SQLite DELETE-journal pathname reuse
without changing product verification, resource limits, or retrying until a
sample passes. A sampler change invalidates prior workload-source provenance
and requires the complete protected regeneration, not partial receipt reuse.

Symlink refusals distinguish an unapproved basename, a different owner, fewer
than one link, and more than two links using fixed outcome labels. These labels
never include paths, targets or owner identifiers. They do not broaden the
single explicitly allowed export-lock name or permit a zero-link symlink;
failure classification alone is not evidence that an entry was safe.

## Interrupted generation

The generator journals replacement state at the repository root and uses a
staging directory. A later run refuses to start while an interrupted generation
needs recovery. Use the supported recovery path:

```bash
node scripts/regenerate-r7-release-evidence.js \
  --destination generated \
  --recover
```

Recovery validates the journal and discards only the incomplete generation. Do
not manually delete journal or staging files, and never replace committed
receipts with a partial staging set.

## Merge discipline

A branch-side generation certifies that branch tree only. If integration changes
any source-closure file, regenerate on the integrated result. Before staging or
committing, inspect the exact receipt diff and run the freshness test once more.
