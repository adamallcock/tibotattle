---
title: Multi-root Codex sources plan
date: 2026-08-23
type: plan
status: stage-a-verified; release-provenance-refresh-pending
owners:
  - product
  - local-companion
  - accounting
  - native-apps
  - privacy
---

# Multi-root Codex sources plan

## Decision

Implement [issue #51](https://github.com/adamallcock/tibotattle/issues/51)
as one TiboTattle user reading one to eight explicitly selected `.codex`
activity roots.

Stage A deliberately does not create a general deduplication subsystem. It
keeps the identities the repository already uses:

- one provider session identity;
- one logical rollout identity derived from the rollout key;
- one device-local source identity;
- one replay-safe event/occurrence identity;
- one unified local index;
- one dashboard user and contribution participant; and
- one upload-device credential.

Roots are physical places from which those logical rollouts can be read. They
are not new users, accounts, event namespaces, or upload devices.

The one new integrity rule is narrow:

> When several configured roots contain the same rollout key, they are
> replica candidates for one logical rollout. TiboTattle accepts them as one
> source only when their raw bytes form one exact prefix chain and their
> non-null session IDs agree. Divergence is omitted and reported as partial
> coverage.

After a logical rollout is indexed, its cursor is bound to one opaque local
physical-root owner. Stage A never automatically moves that cursor to another
root. If the remembered owner is missing, removed, or behind a longer replica,
the accepted history is retained and coverage is partial.

The paired adversarial review is
[Multi-root Codex sources red-team review](../reviews/2026-08-23-multi-root-codex-sources-red-team.md).

## Scope split

### Stage A — implemented in this change

- accept one to eight explicit activity roots;
- combine disjoint roots into the existing logical scanner and unified index;
- choose one explicit primary root for live account/app-server behavior;
- make discovery independent of caller root order;
- prove only same-key collisions by streaming raw-byte prefix hashes;
- persist one opaque root owner on each logical source cursor;
- retain last-known-good facts and refuse automatic owner failover;
- resolve lineage globally, including one trustworthy retained parent;
- isolate incomplete root traversal from healthy roots;
- refuse an apparently complete empty rebuild when all roots are unavailable;
- expose only aggregate root coverage to the dashboard and diagnostics;
- support plural roots in direct activity export, contribution preparation,
  transition, and tool scans;
- migrate macOS launcher settings from one root to a bounded list; and
- preserve the existing contribution and Worker contracts.

### Stage B — optional hardening, not required for Stage A

- prove and permit automatic cursor rebinding to an equivalent replica;
- persist a block digest manifest so a large historical prefix need not be
  reread for every proposed switch;
- persist generation-bound coverage so collision/owner state survives process
  restart before the next refresh;
- add root-scoped account/config evidence if combining roots from different
  accounts becomes a supported product contract;
- widen the legacy passive collector to watch several roots; and
- tune or adapt the fixed per-root discovery ceilings if installed-platform
  benchmarks show the current production values are too coarse.

### Separate platform gate

Installed Windows/WSL support remains part of the broader Windows desktop,
filesystem-security, signing, and installer work. Portable Node support for
several paths is not an installed Windows support claim.

## Why this avoids broad deduplication

The repository already makes ordinary replay idempotent. Adding a root to the
logical identities would create duplicates and force every downstream reader
to remove them again.

| Existing boundary | Stage A treatment |
|---|---|
| `rolloutKey` | Remains root-independent and groups physical replicas |
| `sessionLocal` | Unchanged |
| `sourceLocal` | Unchanged |
| usage/tool/quota event identity | Unchanged |
| source-scoped transactional rescan | Reused |
| missing-source retention | Reused |
| contribution occurrence/chunk identity | Unchanged |
| Worker device/day selection | Unchanged; roots are not devices |

The scanner does not compare unrelated records, fuzzy-match sessions, or merge
divergent JSONL branches. It performs byte proof only when two paths claim the
same existing logical rollout key.

## Product contract

### One combined activity view

All selected roots contribute historical usage, tools, and quota observations
to one dashboard corpus. Configuring them is an explicit owner statement that
they should be viewed as one local user. TiboTattle does not discover roots or
prove that several roots belong to the same OpenAI account.

### One primary live root

Exactly one configured root is primary. It alone supplies scalar `CODEX_HOME`
to legacy/live app-server and collector behavior. Multi-root ordering never
silently changes the primary.

The primary is not used to exclude historical activity from other roots. It
only prevents live account state from being summed or silently failed over.

The global `config.toml` speed baseline is disabled when several roots are
configured because applying the primary root's setting to other roots would be
an unsupported attribution. Tier evidence recorded inside rollouts still
applies normally.

### One contribution identity

The combined local corpus continues through the existing contribution builder,
participant identity, and device credential. Root paths, root owner digests,
coverage state, and collision evidence are never added to contribution rows.

Using one device per root was rejected: the Worker treats devices as alternate
transports and chooses a winner for a participant/day, so root-specific devices
would suppress rather than add history.

## Configuration

### Native macOS settings

The existing owner-only settings file now writes schema
`usage-monitor-launcher-settings-v2` with:

```json
{
  "schemaVersion": "usage-monitor-launcher-settings-v2",
  "activityRoots": [
    {
      "rootId": "stable UUID",
      "path": "/owner-local/absolute/.codex",
      "enabled": true
    }
  ],
  "primaryRootId": "stable UUID"
}
```

Rules:

- one to eight enabled roots;
- exact document shape and one primary root;
- stable UUIDs independent of list order;
- canonical, owner-readable, non-symlink directories when adding a root;
- duplicate canonical paths rejected;
- atomic owner-only persistence;
- v1 `{codexHome}` migration to one v2 root;
- an already persisted v2 path may be temporarily absent at reload, allowing
  the companion to surface unavailable coverage and retained history;
- an existing unsafe, wrong-owner, non-directory, symlink, or unreadable target
  still fails validation; and
- removing the primary requires selecting another primary first.

Removing or resetting a configured root stops future reads but does not delete
the Codex directory or erase history already accepted by TiboTattle. The UI
states that before the action.

### Server and CLI

The local companion accepts repeated `--codex-home PATH` and, for a plural
configuration, requires one in-list `--primary-codex-home PATH`. The macOS
launcher also sets scalar `CODEX_HOME` to that primary for legacy child
processes.

Direct activity commands accept repeated roots without needing a primary:

- `transitions`;
- `tools`;
- `inspect-export`;
- `export-local`; and
- `export-set`.

The legacy foreground/passive collector commands remain single-root and reject
plural input explicitly. They are not the installed dashboard's unified usage
authority.

Programmatic scalar `codexHome` and plural `codexHomes` are mutually exclusive.
Plural lists are bounded to eight and reject exact duplicate paths before
traversal. Native configuration additionally canonicalizes paths; portable CLI
input intentionally does not claim platform-specific alias detection.

## Discovery and replica arbitration

### Atomic root inventories

Every root scans `sessions` and `archived_sessions` in isolation. Active files
continue to shadow the same rollout key in the archive within one root.

If a traversal or metadata read becomes unsafe after the scan begins, all new
candidates from that root are discarded. Healthy roots may still advance. A
missing top-level sessions directory is allowed because Codex need not have
both active and archived trees.

The public aggregate is:

```js
{
  status: "ready" | "partial" | "unavailable",
  configuredRoots,
  availableRoots,
  emptyRoots,
  unavailableRoots,
  retainedHistory,
  unavailableOwnerSources,
  ambiguousSources
}
```

No path, root UUID, root digest, filename, session ID, or raw OS error crosses
that boundary.

### Deterministic merge

Configured roots are sorted by an opaque root-owner key before concurrent
observation, so input reordering does not change candidate precedence.

After all safe candidates are collected:

1. Group globally by existing rollout key.
2. Read bounded session metadata for each candidate.
3. For a collision, require the same non-null session ID.
4. Sort by size, active/archive precedence, and opaque owner key.
5. Stream SHA-256 over the exact raw-byte common prefix through no-follow file
   handles; UTF-8 replacement characters can never make distinct bytes equal.
6. Select the longest candidate only when every shorter candidate is its exact
   prefix.
7. Omit a divergent or unprovable logical group and increment the bounded
   ambiguity count.
8. Reject one session ID claimed by distinct rollout keys.
9. Apply time filtering, ancestor inclusion, and lineage ordering globally.

Each root's active and archived trees share a fixed ceiling of 500,000
directory entries and 125,000 rollout files. A root that exceeds either limit
is discarded atomically and reported as partial; it cannot consume another
root's allowance or stop a healthy root advancing. If no root completes
safely, an authoritative generation is returned unchanged, or a fresh build
fails before creating an index or secret.

### Live source safety

Collision proof uses no-follow handles, verifies file identity and state before
and after hashing, and hashes in bounded chunks. Existing active-source parsing
continues to verify its frozen prefix and permits only records appended after
the requested end boundary during a scan.

Stage A does not cache collision hashes or persist block proofs. A large first
collision can therefore be expensive and is bounded by the existing runtime
guard when one is supplied. That is a measured-performance item, not a reason
to invent semantic deduplication.

## Unified index continuity

The local index schema advances from user version 8 to 9. `source_cursor` gains
one nullable, 32-byte `owner_local` value:

```text
owner_local = HMAC(deviceSalt, opaqueRootOwnerKey)
```

It is local-only and cannot recover the path or native root UUID.

Migration is additive. Existing v8 cursors begin with `NULL` ownership. Their
first accepted source pass is changed from a no-op `skip` to a metadata-only
`touch`, which stamps the deterministic current owner without rebuilding
logical identities.

For an owned cursor:

- the remembered owner candidate is always chosen, independent of input order;
- a different replica is never used for size-only resume or rescan;
- if the remembered owner is absent, its facts and diagnostics are copied into
  the new generation as last-known-good;
- if another compatible replica has a longer tail, the remembered owner may
  advance but the other tail is held and coverage is partial;
- an owner removed from configuration retains accepted history and produces
  partial coverage;
- normal deletion of an old source from a successfully scanned remembered root
  retains historical facts without falsely declaring the root unavailable;
- all configured roots unavailable returns an authoritative prior generation
  unchanged; and
- all roots unavailable with no authoritative prior generation fails with
  `local_unified_index_roots_unavailable` and publishes no empty index.

The physical owner is persisted separately from `sourceLocal`, so the source,
event, quota, tool, session, and contribution identities do not change.

The exported `rebuildLocalUnifiedIndex` primitive and `npm run index:rebuild`
remain explicit empty-index reset operations. They can choose a new current
physical owner because they deliberately discard the prior cursor table. The
automatic ingest/rebuild path does not use that as owner recovery: when a
persisted owner is degraded, even a contract- or schema-triggered rebuild
fails closed and preserves the published database. Any future product-facing
owner recovery needs a separately reviewed confirmation flow or Stage B proof.

### Cross-root lineage

Current candidates resolve parent/child order globally. If a parent root later
becomes unavailable, a child can seed model, effort, tier, and replay-snapshot
state from exactly one retained cursor matching the parent's `sessionLocal`.
Zero or several possible retained parents remain fail-closed.

## Refresh, dashboard, and exports

The refresh runner sends all roots only to unified activity discovery and
accounting. It sends only the primary to the live collector/app-server lane and
never passes simultaneous scalar and plural discovery inputs.

Onboarding schema `local-onboarding-v0.3` reports aggregate filesystem
availability. A partial root set is operational only when a readable root has
rollout evidence; an empty-plus-unavailable fresh install remains
`needs_attention`.

The terminal unified-index refresh receipt adds the closed aggregate coverage
above. The web dashboard combines that with onboarding so it can show a
warning for:

- unavailable configured roots;
- collision ambiguity;
- retained missing owners;
- a remembered owner held behind a longer replica; and
- all-unavailable service of retained history.

The receipt is not persisted as a second index table in Stage A. After a
process restart, collision/owner-specific warning state is rediscovered by the
next refresh; ordinary root availability remains visible through onboarding.

Export and transition/tool scanners use the same global arbitration. Export
plans retain existing frozen-prefix behavior: a resumed workspace may resolve
the same logical source at another currently proven replica only when the
frozen byte count and SHA-256 still verify. It never continues from an
unverified prefix.

Local contribution preparation now receives the same plural root set as the
dashboard. The payload and Worker schema remain unchanged.

## Privacy and security

- Roots are explicit; TiboTattle does not enumerate users, drives, or WSL
  distributions.
- Native paths remain only in the owner-only settings file and process launch
  inputs.
- Index ownership is an opaque device-local digest.
- Collision proof, readiness, HTTP responses, logs, and diagnostics do not
  expose content or root identity.
- Raw OS errors are collapsed to fixed local error codes.
- Same-key byte proof uses safe handles and raw bytes.
- Existing reviewed contribution `sessionUuid` behavior is unchanged; Stage A
  adds no root/session identity to readiness or telemetry.

## Implementation map

| Path | Stage A responsibility |
|---|---|
| `src/providers/codex/log-sources.js` | plural discovery, root isolation, prefix arbitration, global lineage |
| `src/local-unified-index.js` | v9 owner cursor migration |
| `src/local-unified-index-build.js` | plural cold build, owner cursor writes, unavailable refusal |
| `src/local-unified-index-ingest.js` | stable owner selection, LKG, retained parent |
| `src/local-companion-refresh.js` | primary/activity split and closed coverage receipt |
| `src/local-installation-diagnostics.js` | onboarding v0.3 aggregate readiness |
| `apps/local/server.js` | repeated-root composition and contribution forwarding |
| `src/cli.js` | command-specific repeated-root plumbing |
| export/scanner application modules | plural direct activity/export path |
| `apps/macos/UsageMonitorApp.swift` | v2 settings, migration, UI, safe missing-root reload, launch |
| `apps/web/public/*` | path-free degraded coverage notice |

## Acceptance matrix

| Case | Required Stage A result |
|---|---|
| singleton legacy configuration | Same logical corpus and public behavior; one owner-stamping migration touch allowed |
| two disjoint roots | Union in one index/export/contribution |
| reordered roots | Same logical selection and totals |
| exact replicas | One logical source |
| strict-prefix replicas on first ingest | Longest source selected once |
| divergent same-key replicas | Omit group; partial coverage |
| remembered owner disappears with replica present | No rebind; LKG and partial |
| non-owner replica grows | No rebind; longer tail held and partial |
| historical file deleted from healthy owner | Retain history without false root outage |
| unsafe mid-tree traversal | Discard that root's candidates |
| one root unavailable | Healthy roots advance; LKG retained; partial |
| all roots unavailable with LKG | Return prior authoritative generation unchanged |
| all roots unavailable without LKG | Fixed failure; no empty publication |
| parent unavailable, child advances | Seed from exactly one retained parent |
| plural live refresh | Primary only for live lane; all roots for unified lane |
| plural contribution preparation | Combined path-free contribution through one device |
| v1 macOS settings | Atomic one-root v2 migration |
| missing persisted v2 root | App launches; companion reports availability |
| remove primary | Block until another root is selected |
| accepted native root change | Stop the old companion, retain it through termination, and start exactly one replacement |
| Quit while a native replacement is stopping | Await the retained child, cancel the restart, and launch no replacement |
| replacement launch fails | Re-enable root controls, show the fixed failure and Retry surface, and recover to one companion after repair |
| root availability recovers | A validated terminal `ready` receipt clears a stale partial onboarding warning |
| automated rebuild while a cursor owner is degraded | Preserve the published index; do not import a replica tail |
| explicit manual empty-index rebuild | Deliberate reset; current replicas may become new owners |

## Effort correction

The earlier document's headline said 18–30 days while its own slice table
summed to 20–34. More importantly, it bundled three different products:
Stage A, automatic replica failover with a persisted block-proof system, and
installed Windows qualification.

A more useful planning split is:

| Work | Planning estimate | What it includes |
|---|---:|---|
| Lean Stage A | 6–10 days | plural composition, collision-only proof, no-rebind cursor owner, LKG, native macOS UI, exports, tests/docs |
| Optional Stage B | 4–7 days | proven automatic failover, block manifest/cache, persisted coverage, optional root-scoped evidence |
| Installed Windows/WSL gate | 3–6 days | native UX, reparse/ACL/UNC fixtures, signing/installer qualification |

Those are planning estimates, not elapsed-time claims for this implementation.
Stage A was completed as one coordinated change because it reused much more of
the existing scanner, index, export, and LKG machinery than the original heavy
design assumed.

## Completion and release gates

Stage A source work is complete only when:

1. focused discovery/index/refresh/server/native/web/export tests pass;
2. the full repository functional/source tests pass without weakened or
   skipped source tests; retained generated release evidence is refreshed only
   at the separately authorized source-freeze gate;
3. documentation and localization checks pass;
4. independent code-quality and test/documentation audits have no unresolved
   high-severity finding;
5. rendered browser partial coverage is inspected; and
6. the reviewed work is committed to its isolated task branch; pushing,
   publishing, release tagging, and public issue changes remain separate
   authorizations.

This does not close issue #51's Windows acceptance criteria. It completes the
portable and macOS Stage A implementation on which installed Windows/WSL
qualification can build.

The R7 provenance refresh at source freeze is intentionally narrower than the
Stage A functional qualification. The current R7 harness accepts one scalar
real-history `~/.codex` input, so it can certify current-source provenance and
the existing benchmark profiles but cannot certify plural-root behavior or
performance. Plural-root behavior is qualified by the focused, integration,
packaged-process, and AppKit journey evidence above. Expanding R7 itself to
several roots is optional follow-up work, not a hidden Stage A correctness
claim.

### Validation receipt

Validated on 2026-08-23:

- local companion suite: 238/238 passed;
- browser product suite: 328/328 passed;
- packaged macOS product suite: 58/58 passed;
- final focused provider, legacy-index, and browser compatibility audit:
  235/235 passed with no code-quality finding;
- full repository run: 2,820 passed, 17 platform skips, and three failures out
  of 2,840 tests;
- the one functional failure in that run was a collector-state timing race
  outside the changed path; its named test passed immediately in isolation and
  the complete collector file then passed 52/52;
- the other two failures are the governed R7 receipt checks: Stage A changes
  runtime source bytes covered by those receipts, so their stored workload
  provenance correctly no longer validates;
- architecture/import audit, documentation links, browser localization, and
  diff hygiene passed; and
- the partial-root dashboard state was exercised through a real loopback
  companion and visually inspected for path-free, honest retained-history
  copy.

No R7 receipts were regenerated. Their ten-receipt replacement requires a
separately authorized source freeze and exact dual-runtime real-history run;
it is a release-evidence gate, not Stage A implementation work. Installed
Windows/WSL filesystem and signing qualification is likewise still separate.
