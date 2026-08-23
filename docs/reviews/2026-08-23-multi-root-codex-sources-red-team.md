---
title: Multi-root Codex sources red-team review
date: 2026-08-23
type: review
status: stage-a-source-complete; no-blocking-findings
reviewers:
  - source-and-index-map
  - availability-and-lifecycle-map
  - identity-and-replica-red-team
  - repository-evidence-review
---

# Multi-root Codex sources red-team review

## Verdict

Proceed with the lean Stage A contract. Do not implement issue #51 literally
as root-qualified logical sources, and do not describe Stage A as installed
Windows/WSL support.

The simplifying direction is sound: several explicit `.codex` roots can be
one dashboard user and one contribution device. A general event deduplication
system is unnecessary because the repository already owns logical rollout,
session, source, event, and contribution identities.

Stage A still needs one narrow collision control: several physical files that
claim the same rollout key must agree on session identity and form an exact
raw-byte prefix chain. It also needs a stable local cursor owner so an
incremental byte cursor never resumes against a different physical copy.

The implementation deliberately chooses **no automatic owner failover**. This
removes the riskiest and largest part of the first plan: there is no block
manifest, no proof-driven cursor switch, and no new root-qualified accounting
identity. Missing or lagging owners retain last-known-good facts and make
coverage partial.

## Threat model

The review asks whether Stage A can avoid:

- double-counting copied sessions;
- silently selecting one divergent continuation;
- resuming a cursor against bytes from another physical copy;
- publishing an empty corpus when WSL or another root stops;
- allowing one broken root to truncate healthy-root results;
- losing cross-root parent state;
- treating roots as additive live quota meters;
- splitting one participant across upload devices;
- exposing local paths or root identity; and
- claiming platform support not exercised by installed artifacts.

It does not promise:

- semantic merging of divergent JSONL histories;
- automatic discovery or startup of WSL distributions;
- automatic recovery from a missing cursor owner;
- safe installed Windows reparse/ACL/UNC handling;
- account separation across roots; or
- erasure/retraction of previously accepted history when a root is removed.

## Findings and dispositions

### 1. Root-qualified logical identity manufactures duplicates

If `sourceLocal` includes a root namespace, one copied rollout becomes several
sources. Usage keys may sometimes converge, but source-scoped quota, tools,
ordinals, export plans, and chunks can diverge or add.

Disposition: rollout, session, source, event, and contribution identities stay
root-independent. Root participates only in an opaque local cursor owner.

### 2. Existing size-only resume is unsafe across physical copies

A larger replica is not proof of append. Resuming at a prior cursor offset can
combine carry state from one branch with bytes from another.

Heavy-plan response: maintain physical file IDs and a persistent block proof,
then allow a verified rebind.

Stage A response: never rebind an owned cursor. The index looks for the
remembered owner candidate and ignores other replicas for incremental work. A
missing or lagging owner retains LKG and reports partial coverage. This is
simpler and safer, at the cost of requiring an explicit future recovery design
to use a replacement replica.

### 3. Session metadata alone cannot prove replica equivalence

Two copies may share a session ID and then be continued independently.

Disposition: collision groups require the same non-null session ID and exact
raw-byte prefix equivalence. The longest candidate is selected only on first
ownership when that proof succeeds. Divergence is omitted, never semantically
merged.

The byte test uses raw handle reads. This matters because distinct invalid UTF-8
bytes can both decode to the same replacement character.

### 4. A remembered owner can be present but behind

Adversarial sequence:

1. replicas A and B are initially identical;
2. deterministic first ingest binds A;
3. B later grows while A remains readable;
4. collision proof says B is a strict extension; and
5. owner selection correctly keeps A.

Without an extra signal the index would report ready while holding B's newer
tail. That violates the product's coverage honesty even though it avoids
cursor corruption.

Disposition: process any new bytes on A, do not switch to B, and mark aggregate
coverage partial until the owner catches up or a future explicit recovery is
performed.

### 5. Missing history and unavailable ownership are not the same

The index intentionally retains a cursor after an old rollout file disappears.
Treating every absent historical file as an unavailable owner creates a
permanent false warning on normal provider cleanup.

Disposition:

- absent source, remembered root completely scanned: normal retained history,
  coverage can stay ready;
- absent source, remembered root unavailable/partial: LKG plus partial;
- remembered root removed from configuration: LKG plus partial; and
- logical source visible only through a different replica: no rebind plus
  partial.

### 6. Partial traversal must not publish a truncated root

Directory APIs can fail after returning some entries. Keeping those candidates
would make traversal timing affect totals.

Disposition: each root inventory is atomic. Any unsafe mid-tree failure
discards all candidates from that root for the pass. Other roots continue; the
index retains prior facts.

Each root's active and archived trees share their own production ceiling of
500,000 directory entries and 125,000 rollout files. Hitting a ceiling marks
only that root partial and discards its entire inventory; it cannot consume
another root's allowance. If no root completes safely, a prior authoritative
generation is returned unchanged or a fresh build fails without publishing an
empty index.

### 7. All unavailable roots can look like a valid empty install

Disposition: a cold rebuild fails before creating an index or secret when all
roots are unavailable. Incremental ingest may return an unchanged prior
generation only when it is already authoritative and coverage explicitly says
retained history. It never publishes a new empty complete generation.

### 8. Cross-root lineage can disappear on a later pass

When a parent in root A is no longer discovered but a child in root B advances,
current-only lookup loses inherited model/effort/tier and replay evidence.

Disposition: derive the parent's `sessionLocal` and seed from exactly one
retained cursor. Multiple or absent candidates remain fail-closed.

### 9. Per-root devices are alternatives, not additive shards

The Worker selects one winning device for a participant/day. Three root upload
devices would lose two roots rather than combine them.

Disposition: one local index, participant, device credential, contribution
builder, and existing Worker schema.

### 10. Root removal cannot imply remote retraction

The current contribution protocol cannot safely erase a server chunk merely
because its local source disappeared.

Disposition: removing a root stops future reading and retains local/imported
history. Native settings state this before remove/reset. True forgetting needs
a separate destructive local rebuild and server tombstone/reset protocol.

### 11. Primary live state must be separate from activity union

Root order is not account evidence. Summing live quota or silently failing over
could fabricate an allowance view.

Disposition: an explicit primary is mandatory in plural companion mode and is
passed as scalar `CODEX_HOME` to live/legacy children. Unified history receives
all roots. The global `config.toml` speed baseline is disabled in plural mode.

Stage A follows the user's combined-user model for historical rollout evidence.
It does not support account-separated roots. If that becomes a requirement,
root-scoped account evidence is Stage B, not an implicit patch.

### 12. Frozen exports need proof, not path loyalty

An export workspace must not mix arbitrary replacements. Requiring the exact
original path is stronger than necessary because active/archive movement and
replicas can preserve the frozen bytes.

Disposition: the existing source plan freezes logical key, byte count, and
SHA-256. Resume may resolve a different currently proven candidate only if the
entire frozen prefix verifies through a safe handle. Failure poisons/restarts
the export rather than inventing rows.

### 13. Readiness and index integrity are different dimensions

A generation can be internally replay-safe for admitted and retained facts
while one physical root is unavailable. Conversely, all roots can be readable
while one same-key collision is ambiguous.

Disposition: keep generation integrity unchanged and add an aggregate
`rootCoverage` receipt. Onboarding reports filesystem availability; terminal
refresh coverage adds ambiguity and owner continuity. The web notice consumes
both.

Residual: Stage A does not persist collision/owner coverage inside the index.
After process restart it is rediscovered on the next refresh. If this creates a
visible stale-warning gap, generation-bound persistence is Stage B.

### 14. Native strict reload could prevent degraded startup

Validating every stored root as currently present would make one stopped WSL
or detached location abort the app before the companion can retain LKG.

Disposition: root addition and v1 migration remain strict. An already persisted
v2 absolute canonical path may be missing on reload. Existing unsafe targets
still fail. Tests cover missing secondary and missing primary configurations.

### 15. Contribution preparation can accidentally remain primary-only

The dashboard index and direct exports can be plural while the local review and
contribution path silently defaults to scalar `CODEX_HOME`.

Disposition: server composition supplies the same plural activity set to local
contribution preparation. A loopback integration test builds a real reviewed
bundle from two roots through one existing identity.

### 16. Scalar plus plural inputs can drop or duplicate roots

JavaScript defaults make it easy to forward `codexHome` and `codexHomes`
together, especially through layered export/preparation calls.

Disposition: core build/ingest/discovery reject simultaneous inputs; all
composition points pass exactly one form. Focused tests reject mixed, duplicate,
empty, and over-eight configurations before traversal.

### 17. Coverage copy can overclaim retained data

A fresh partial configuration may have no prior index. Saying it “is retaining
previous history” as a current fact can be false.

Disposition: UI copy says that any last-known history is retained, reports
aggregate available/configured counts, warns totals may be incomplete, and
states that physical copies are not switched automatically. It exposes no
paths or aliases.

### 18. A manual cold rebuild can look like automatic failover

The low-level rebuild primitive intentionally starts with an empty cursor
table. Invoking it directly can therefore select a currently available
replica as the new physical owner.

Disposition: treat `rebuildLocalUnifiedIndex` and `npm run index:rebuild` as
explicit local reset operations, not routine owner recovery. The automated
ingest preflight separately loads existing v9 owner bindings and refuses a
contract- or schema-triggered cold rebuild while an owner is missing, removed,
ambiguous, or behind a longer non-owner. A regression proves the old database,
contract, owner, and accepted facts remain unchanged.

### 19. A correct restart gate can still lose its real stop callback

The pure gate proved serialized state transitions, but the first disposable
AppKit run stopped the old companion and then remained indefinitely with all
root controls disabled. `AppDelegate` cleared its only strong reference before
`CompanionProcess` could deliver the termination completion it owned.

Disposition: retain the deliberately stopping `CompanionProcess` separately
until its exact completion arrives, clear that retained instance by identity,
and only then start the replacement. The rebuilt native journey observed a
single direct child, a brief `1 -> 0 -> 1` restart, no count above one, and
control recovery. A deliberate missing-runtime launch then proved the failure
path also re-enables controls and Retry returns to exactly one child.

### 20. Ready coverage can be hidden behind stale onboarding state

The loaded page retains its onboarding snapshot across foreground refreshes.
The initial renderer accepted terminal partial/unavailable coverage but ignored
a valid terminal `ready` receipt, so it fell back to stale `1 of 2` onboarding
after the root had returned and the companion had certified `2 of 2`.

Disposition: a validated terminal receipt is newer than the cached onboarding
snapshot. Terminal `ready` explicitly clears the warning; terminal partial or
unavailable still takes precedence. The regression keeps onboarding partial,
normalizes a complete ready receipt through the production validator, and the
final rebuilt package visibly cleared the notice after `1/2 -> 2/2` recovery.

### 21. Quit can abandon the retained stopping companion

The first lifecycle repair retained the process long enough to launch its
replacement, but application termination still inspected only the active
slot. Quit during the brief stopping phase could therefore terminate the app
without awaiting the child or its two-second kill fallback. The child watchdog
would eventually notice the missing parent, but that is not the promised
graceful lifecycle.

Disposition: both application termination hooks select the stopping slot
before the active slot. Quit cancels the restart gate, awaits the real child,
and a late Settings stop completion cannot launch while `quitting` is true. A
compiled path-free smoke launches a real bundled companion, moves the only
active reference into the stopping slot, attaches both stop completions, and
requires intentional exit with no pending restart. The follow-up independent
audit found no remaining issue at any severity.

## Adversarial scenario matrix

| Scenario | Stage A behavior | Residual |
|---|---|---|
| exact Windows/WSL copy | one logical source after byte proof | first collision can reread a large prefix |
| shorter exact replica at first ingest | choose proven longer candidate | owner then remains fixed |
| copies continued independently | omit group; partial | no semantic merge |
| owner disappears, shorter replica remains | retain LKG; partial | no automatic recovery |
| owner disappears, longer compatible replica remains | retain LKG; partial | explicit rebind deferred |
| owner present, non-owner grows | keep owner, hold tail, partial | may remain partial indefinitely |
| historical file deleted from healthy owner | retain history; ready | assumes complete root traversal |
| root fails mid-walk | discard its new inventory | raw cause stays private |
| all roots unavailable, prior index exists | serve authoritative LKG unchanged | stale until refresh succeeds |
| all roots unavailable, no index | fixed failure; no empty index | setup needs attention |
| parent root down, child grows | one retained-parent seed | ambiguous retained parents fail closed |
| roots reordered | same opaque ordering and cursor owner | path canonicalization is strongest in native UI |
| one upload key per root | rejected | Worker unchanged |
| root removed | stop reading, retain history | no selective erase |
| roots belong to different accounts | unsupported combined view | root-scoped accounts deferred |
| native stored root absent | app starts, coverage degrades | installed Windows gate remains |

## Privacy review

The new public shapes contain only fixed states and bounded counts. Tests use
private path/session canaries and assert they do not cross onboarding, refresh,
web, contribution, or native smoke output.

Persisted root ownership is a keyed device-local digest. Raw root paths remain
in the owner-only native settings and process launch configuration, where they
are necessary to read the selected files. No root field is added to the
contribution or Worker schema.

The existing reviewed contribution `sessionUuid` field is not changed. The
privacy claim is specifically that Stage A adds no root or session identity to
new readiness/coverage surfaces.

## Performance review

Ordinary non-collision discovery does not hash every file solely for dedup.
Collision proof streams the shorter common prefix in 256 KiB chunks and checks
the runtime guard. Memory remains bounded by a small number of candidate and
hash buffers.

Potential Stage B trigger: repeated very large replica collisions make normal
foreground refresh materially slower. The remedy would be a persisted,
versioned block-proof cache tied to safe physical identity—not record-level
deduplication.

The incremental publisher still stages a complete SQLite copy before an
atomic replacement. Clone-capable filesystems make that cheap; a fallback
copy is proportional to the combined index and needs equivalent temporary
free space. That is pre-existing publication behavior, but multi-root can
amplify it. Windows/NTFS performance and disk-headroom qualification remains a
separate installed-platform gate; replacing the publication protocol is not a
Stage A identity requirement.

## Platform review

macOS Stage A has native settings, migration, missing-root tolerance, launch
plumbing, localization, and source tests.

The portable server/scanner accepts Windows-style activity paths only to the
extent already supported by the runtime. This review makes no claim about
installed Windows picker UX, WSL UNC availability, reparse points, DACLs,
long-path behavior, signed artifacts, or installer/updater behavior. Those are
release gates under the Windows work, not polish hidden inside Stage A.

## Required validation gates

1. Multi-root discovery tests prove union, reorder, raw-byte collision proof,
   ambiguity, and unsafe-root discard.
2. Index tests prove v8-to-v9 owner stamping, SQL-level no-rebind, lagging
   replica coverage, normal historical deletion, all-unavailable LKG, and
   retained parent lineage.
3. Refresh/server tests prove primary-only live behavior, plural unified and
   contribution behavior, aggregate path-free projection, and no zero publish.
4. Native tests prove schema constraints, migration, settings UI, missing-root
   reload, primary launch environment, and removal copy.
5. Web tests prove closed coverage validation and rendered warning wiring.
6. Focused suites, full repository tests, docs links, localization checks, and
   independent audits pass without weakening existing tests.
7. Installed Windows/WSL qualification remains explicitly outstanding.

R7 regeneration is a current-source provenance and existing scalar real-history
benchmark gate. Because the governed R7 harness does not accept plural Codex
roots, its refreshed receipts must not be cited as plural-root performance
qualification; the Stage A functional and native evidence carries that claim.

## Bottom line

Stage A succeeds by refusing two attractive complications:

- it does not make roots part of logical accounting identity; and
- it does not automatically move an incremental cursor between physical
  copies.

That lets TiboTattle reuse its existing replay-safe accounting, missing-source
retention, export proofs, and one-device contribution path. The only new
dedup-like operation is collision-only byte proof at the physical source
boundary. The remaining complexity is visible and bounded: unavailable or
lagging owners produce partial coverage until the owner returns or Stage B
defines an explicit safe recovery.

## Final review disposition

Independent code-quality, test/documentation, and performance passes found no
Stage A blocker. Those passes directly caused fixes for v1 missing-path
migration, primary-only side-chat binding, export-resume physical proof,
closed aggregate coverage validation, per-root production discovery ceilings,
legacy archive-limit compatibility, and static fallback translation parity.

The residual performance risk is bounded and explicit: configured discovery
ceilings can still retain a large metadata inventory across eight roots, and
the pre-existing full SQLite staging copy can require space proportional to the
combined index on filesystems without cheap cloning. Neither changes logical
correctness; both belong in installed-platform measurement and Stage B tuning.

The final repository run had no reproducible functional failure in the changed
path. One unrelated collector-state timing failure passed by name and as part
of its complete 52-test file on immediate rerun. The two remaining deterministic
failures are the expected R7 generated-receipt provenance checks, which must
remain invalid after runtime source changes until the separately governed
source-freeze regeneration. No receipt, release artifact, commit, or public
issue was changed as part of Stage A.
