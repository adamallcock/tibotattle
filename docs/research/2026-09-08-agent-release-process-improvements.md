---
title: Agent release process investigation and improvement plan
date: 2026-09-08
type: research
status: recommendations-ready
source_commit: 77b564cd
---

# Agent release process investigation

## Conclusion

The largest opportunity is a **small, durable release coordinator around the
existing tools**, not a replacement build system and not fewer integrity checks.
TiboTattle already has substantial validation, immutable artifacts, signed feed
publication, source-bound evidence and guarded deployment. What is missing is
one reliable way for an agent to discover prerequisites, understand which proof
is reusable, resume interrupted work and establish that every promised
distribution surface is actually current.

Release 0.1.18 was also unusually broad: new model/accounting compatibility,
paginated history support, first Intel support, installed-state migrations,
hosted schema changes and distribution work met in one release. Genuine defects
were discovered during qualification. Those repairs were necessary; removing
the checks would have made the release faster only by shipping known defects.
The subsequent website/calculator incident was a separate operational workstream,
not several more days of signing the desktop release. [^1][^2][^3]

Recommended order:

1. Add a read-only release doctor and one machine-readable status/plan.
2. Move installed-upgrade and hosted-compatibility discovery before expensive
   finalization; freeze clean, owned candidate snapshots.
3. Add phase-level resume to native finalization and explicit post-mutation
   outcomes to hosted deployment.
4. Reconcile GitHub, both update feeds, Homebrew and website from one manifest.
5. Reuse qualified evidence by its actual dependency contract; add disposable
   hosted rehearsal and controlled parallelism where they provide measurable value.

This is a research and implementation proposal. None of the proposed commands,
schemas, approval records or new automation below has been implemented or
authorized to publish by this report. Current operating authority remains the
[macOS release runbook](../runbooks/macos-stable-release-runbook.md) and
[production runbook](../runbooks/production-operations.md).

## Evidence and scope

The inspected source is the qualified hosted branch at `77b564cd`; deployed
application source is separately recorded as `32cd6317`. Remote `main` was
checked and matched `dffe64d60c3ea6de985c697c31678bdf22feb815`. These are not
interchangeable release bases: Git reports eight main-only and 48 branch-only
commits. That measures ancestry divergence, not 56 necessarily distinct
functional changes. A future release must reconcile exact intended changes,
not pick whichever checkout happens to be active.

The investigation used maintained runbooks, source, tests, dated 0.1.18 records,
the release discussion and local coordinator event metadata. Private transcript
contents and raw operational payloads are not reproduced. The transcript has
repeated continuations and context compactions; it is not a complete stopwatch
for signing, human availability or critical-path latency. Measured durations
below are individual recorded runs, not a sum of total elapsed release time.

Current main still uses the native macOS release path. Electron is not a
released product or implemented release path in that inspected main. The
coordinator should allow later platform adapters, but an Electron migration
must not be assumed complete or made a prerequisite for these improvements.

## What consumed time in 0.1.18

| Episode | Evidence | Interpretation | Earlier or cheaper handling |
| --- | --- | --- | --- |
| Combined-source qualification rejected paginated history | Initial real-history qualification refused all 1,469 accepted Codex sources with the new export shape | Real compatibility defect; prior Intel-only evidence could not qualify new combined source | Small export-shape admission probe and representative regression corpus before the long benchmark |
| Installed-upgrade rehearsal found two more defects | Parser upgrade was incorrectly constrained to the ordinary five-minute deadline; future-parent attribution required the v14 correction | Clean-build tests were insufficient; RC2 could not be relabeled RC3 | Run previous-stable-to-candidate migration and semantic preservation checks early, before signing |
| Requalification after genuine source changes | One complete R7 generation took 31.2 minutes, including 25 minutes of real-history work | An expensive check, but not a redundant one when its workload closure changes | Detect exact invalidation; perform cheap admission/environment checks first; retain valid unrelated proofs |
| Environment and source-churn false starts | Restrictive test-child umask caused fixture failures; concurrent edits made asset staging refuse a dirty tree | Preventable preparation/orchestration problems | Test-child environment doctor and immutable candidate snapshot before the long gate |
| Hosted migrations discovered production differences | 0041 lineage mismatch; 0043 memory failure; 0044 remote trigger syntax rejection | Local fresh-schema success did not prove remote migration readiness | Read-only lineage comparison, scale-shaped synthetic rehearsal and explicit hosted prerequisite before desktop freeze |
| Stable source needed refinalization | First stable artifacts were frozen before the hosted repair changed the intended release source | Real artifact/source binding cannot survive arbitrary source relabeling | Freeze only after release-critical hosted dependencies are resolved; independently version unrelated hosted changes |
| Distribution completion lagged binary publication | Public GitHub assets and feeds could be verified while the website still showed the older/ARM-only state | Multiple independent publications were coordinated manually | Per-surface state and a manifest-driven final reconciliation gate |
| Graph problems continued after publication | Later records separately document memory/CPU failures, cache starvation and historical reconstruction | Production correctness/capacity incident, not routine desktop release overhead | Hosted performance/preservation rehearsal and live semantic checks, independently owned from desktop release |
| Concurrent deployment undid a repair | September 7's website deployment replaced the repaired scheduler; the final deployment had to merge both changes | A verified repair can regress when another agent deploys a stale source | Shared deployment ownership and an expected-current-version check across every deployment path |

The publication-preparation record also measures a 479.3-second broad root run
and a 246.6-second native suite. These are useful baseline costs, not proof that
every repetition was unnecessary. The records explicitly justify retaining R7
receipts unchanged after edits outside the workload closure. This is an existing
optimization to formalize, not invent. [^1][^2][^4]

No defensible percentage of total delay can be assigned to Apple, tests, agent
coordination or owner approvals from this evidence. A future release runner
should record phase start/end, execution time, external wait, approval wait,
retry count and why a previous result was invalidated. That will distinguish
slow tools from slow sequencing without blaming a human for unattended time.

The concurrent overwrite is explicitly recorded, including that no cross-task
deployment lock was implemented by that repair. It is not merely a hypothetical
race. A machine-local lock or one GitHub workflow's concurrency group alone
cannot coordinate other local agents and workflows targeting the same Worker. [^19]

## Existing tooling worth preserving

| Existing component | What it already does | Missing layer |
| --- | --- | --- |
| Native builder/finalizer | Explicit architecture/channel/runtime, reproducible candidate comparison, signing, app and DMG notarization, stapling, validation and final manifest | Read-only plan/doctor and resumable intermediate phases |
| R7 generator | Structured phase progress, heartbeat, source/runtime-bound results, atomic receipt installation and recovery | Explain reuse eligibility centrally; interrupted calculation itself is not resumable |
| Test lanes | Conservative changed-path planning, including staged, unstaged and untracked changes; native source/smoke/artifact distinctions | Persisted lane evidence keyed to complete inputs and an explicit final release gate |
| Sparkle publisher | Validate-only default, bounded retries, exact-object reuse, compare-and-swap feed updates, remote-byte verification and resumed-verified outcome | Invoke it from a release-wide journal instead of reconstructing commands manually |
| Release evidence/site generators | Native final-byte evidence, exact asset identities, explicit unavailable evidence and source provenance | Generate every distribution target and final verification expectation from the selected architecture set |
| Web-only lane | Separate prepare/deploy modes, explicit source restrictions and reusable public asset provenance | Easy discovery from the release plan and cross-surface status |
| Production deploy wrapper | Clean immutable source/dependency snapshot, migration gate, local preflight, assets, health and public isolation | Exact expected-source postcondition, useful redacted errors and durable mutation outcome |
| Release trust CI | Pinned dependencies, read-only checks and workflow/document/evidence validation | It is not an end-to-end signed release pipeline |

These mechanisms should stay the authority for their individual operations.
A coordinator must call their public entrypoints, not duplicate signing rules,
SQL migration logic, checksum verification or release evidence policy. [^5][^6][^7][^8][^9][^10]

Two current examples show why an additional status layer would help:

- `release-macos-app.js` accepts `--prepare-candidate`, but after preparing it
  still calls `releaseMacOSApp`; that option is not a dry run. The runbook
  explains this, but the name invites an agent to infer the wrong side effects.
- The maintained macOS runbook still says the tap is ARM-only, while current
  status records the verified architecture-selecting cask. A dated public
  release execution plan also remains `in-progress` with unchecked publication
  steps after publication. These are knowledge-maintenance gaps, not evidence
  that the current Intel cask or release is absent. Structural documentation
  checks alone do not reconcile operational truth. [^1][^5][^11]

## Recommended release architecture

### One release identity, separate delivery lanes

The release record should identify version, build number, channel, exact source
commit/tag, selected architectures, intended destinations, source/dependency
digests, validator/policy versions and references to evidence. It should also
record the hosted source/schema requirements that the desktop actually needs.
An unchanged desktop build should not inherit unrelated hosted incident work.

The dependency structure should be explicit:

```text
scope + prerequisite discovery
        |
compatibility and upgrade rehearsal -- required hosted prerequisite
        |                                      |
clean candidate + qualification <---------------+
        |
ARM finalization       Intel finalization
        \                  /
       final-byte and installed/update qualification
                       |
             manifest + verified draft
                       |
              immutable GitHub release
                       |
          feeds / cask / website reconciliation
                       |
                published and verified
```

These are logical dependencies, not instructions to run every box serially.
Independent targets may overlap only when their build outputs, ports, disk
mounts and resources are isolated. Performance measurements should retain a
controlled environment. Signature, installed-state and physical-architecture
evidence never becomes interchangeable merely because builds ran in parallel.

The record should distinguish `not_started`, `running`, `waiting_for_owner`,
`waiting_for_external_service`, `passed`, `failed`, `invalidated`,
`waived_for_this_release` and `published_unverified`. A recorded success is not
perpetual authority: status refreshes relevant remote state and validates the
bound local evidence. Unknown state must remain unknown.

### P0: read-only doctor and status

A proposed `release doctor` should finish cheap discovery before long tests or
credentialed work. It should report all discoverable blockers together:

- Requested remote/base, divergent checkout, candidate ownership and dirt.
- Exact runtime per architecture, verified runtime cache and pinned tools.
- Version/build/channel allocation and prior stable artifact for each target.
- Available public certificate metadata and configured credential references,
  without accessing/exporting private keys or prompting unexpectedly.
- Installed-upgrade, clean-profile, physical-hardware and Login Item evidence
  requirements; unavailable hardware is resolved before signing, not near release.
- R7 source-closure freshness, required test lanes and generated asset inputs.
- With approved read-only remote inspection, migration lineage, required hosted
  guard and source compatibility, recovery availability and target reachability.
- Existing draft/release/feed/cask/site states and incomplete prior attempts.

A proposed `release status` should show exactly what remains, the next safe
operation and its expected side effects. It should not interpret a missing
receipt as failure of the app, or a successfully built artifact as publication.
Add machine-readable JSON alongside short human output. [^5][^7][^10]

Credential configuration is not credential usability: distinguish `configured`,
`verified`, `unavailable` and `not_exercised`. A separate, explicitly invoked
authentication probe may validate usability; the default doctor must not
silently turn a name lookup into a Keychain prompt or notarization submission.

Acceptance tests: wrong branch; old tag; dirty generated asset inputs; missing
Intel runtime; previous-stable mismatch; already-published tag; unavailable
manual evidence; and unknown remote migration lineage. Every doctor run must
perform zero signing, database writes, installation or publication.

### P0: discover compatibility before finalization

The first release-specific test should be a small representative compatibility
and upgrade rehearsal, not the full expensive corpus. Cover retained source
formats, paginated/reset history, model/effort/tier propagation and the actual
supported predecessor schema. Then run a preserved-copy semantic/accounting
comparison before spending time on RC signing.

This is not a substitute for real-history qualification. It catches known
classes cheaply and moves inevitable source corrections earlier. Synthetic
fixtures cannot supply real-corpus, real installed-app or physical Intel proof.
Real-history access remains separately scoped, and private source material must
never enter CI artifacts. [^2][^4]

Use separate mutable development and frozen qualification directories. Record
which agent owns the candidate and its evidence directory. Recheck identity at
each boundary. Do not solve dirty-tree refusals by ignoring changes or by
relabeling an existing binary with the new source commit.

### P1: resumable native finalization

The native finalizer currently rebuilds, signs, notarizes the app, staples it,
packages/signs/notarizes the DMG, validates it and only then writes the final
manifest. Its `finally` removes the temporary staging tree. A late failure has
no supported phase-resume entrypoint. This is a concrete opportunity for speed
and reliability. [^5]

Add private, exact-input-bound stage receipts and a journal for a single
architecture/channel/build. Persist a phase only after its outputs are durable
and validated. Keep completed intermediate files immutable and use explicit
retention/cleanup ownership. Resume must verify bytes, source, toolchain,
entitlements, updater identity and policy before reusing anything.

Persist an Apple submission identifier as soon as it is available. After an
interrupted wait, query that submission rather than automatically submitting
again. If the submit response is lost before its identity is known, classify the
operation as uncertain and reconcile conservatively; do not claim exactly-once
submission. Apple explicitly documents preserving submission IDs and retrieving
status/logs. [^12]

Acceptance tests: interruption after each durable phase; app accepted but DMG
not finished; failure after final artifact rename but before manifest creation;
same output name with different bytes; changed signing inputs; cross-architecture
receipt reuse; revoked/invalid present trust; and two agents claiming the same
release. A resumed operation must not re-sign/re-submit already verified bytes,
and it must still rerun checks whose truth depends on current conditions.

### P1: deterministic publication and safe retries

Treat publication as a set of independent, verified transitions. GitHub, R2,
Homebrew and the website are not one atomic transaction. The tool should expose
partial completion rather than say simply “release failed” or “release done.”

Use the canonical manifest to enumerate the required asset set. Create a draft,
upload and re-download exact assets, verify them, then publish the immutable
release. On retry, inspect the specific release/tag and byte identities; reuse
matching results and refuse conflicting ones. Never overwrite immutable assets.
GitHub recommends draft-first immutable publication and provides release/asset
verification commands; retain those tools. [^8][^13]

After release verification, invoke existing Sparkle publication for each
architecture and the existing tap/site workflows. A missing Intel row or stale
website is an incomplete release surface, not a reason to rebuild both DMGs.
Check version, channel, architecture, minimum OS, URL and downloaded digest,
not just “HTTP 200” or the cask's version string. Same-version repairs must
compare full desired content. One cask can select both architectures; a second
Intel cask would create unnecessary divergence. [^8][^11][^14]

A proposed `release reconcile` should be read-only by default and resume only
explicitly authorized pending transitions. It must verify latest remote state
before writes and return a consolidated per-surface receipt. Readiness ends
with verified distribution, not with the GitHub publish response.

Acceptance tests: GitHub published but response lost; one feed succeeds and the
other fails; concurrent feed publisher; tap already at the desired version but
missing Intel; stale cached tap content; site fails after feeds succeed;
downloaded digest mismatch; and rerunning a fully completed release with zero
additional writes. Keep existing Sparkle compare-and-swap and resumed-verified
semantics rather than introducing a second updater implementation.

### P1: make hosted deployment outcomes unambiguous

The production wrapper currently captures Wrangler output but reduces a failed
command to a generic deployment failure. Its health predicate checks health,
not equality with the intended deployed source; that comparison is currently
an independent runbook/operator check. Snapshot cleanup failure can also replace
the operation result after the deployment attempt. These distinctions matter
because retrying a read-only preflight and retrying an uncertain publication
are different actions. [^10]

Persist whether an external mutation was attempted, its known deployment/version
identity, exact expected source, verified postconditions and cleanup outcome.
Preserve a `deployed_unverified` result if deployment may have succeeded but
postchecks failed. Compare `/api/health` source to the intended commit and
verify intended asset bytes as part of the supported entrypoint. Return bounded,
redacted stage errors and timings; do not dump credentialed process output.

Acceptance tests: healthy old source; successful deploy followed by timeout;
cleanup failure after successful deployment; mixed-source/old assets; changed
migration ledger after approval; and uncertain response followed by read-only
reconciliation. Existing health, migration and public-isolation gates stay intact.

Add deployment coordination across every production writer, with a shared
lease/owner and fencing or equivalent provider-supported preconditions. Bind
the operation to the expected currently deployed version and reject a stale
candidate unless its differences have been reconciled. A check followed by an
unprotected write is not atomic compare-and-swap. Include the website-only lane
and define how emergency operations participate; an advisory local lock is
insufficient. Failure tests must reproduce the recorded scheduler-overwrite
sequence and demonstrate that the later stale deployment cannot erase it. [^19]

### P2: evidence reuse and test scheduling

Evidence reuse must follow its dependency closure, not a blanket “same version”
or “tests passed yesterday” rule. Cache keys should include the selected source
closure, dependency lockfiles, runtime/OS/architecture, relevant environment,
input/fixture identity, validator and policy version, arguments and completeness.
Only successfully completed, trusted results are eligible. Unknown inputs or
changed validation semantics force rerunning the affected gate.

| Evidence | Safe reuse direction | Must not be inferred |
| --- | --- | --- |
| R7 complete receipt set | Existing exact workload/runtime/decision checks still pass | A new source workload is qualified because unrelated tests pass |
| Synthetic suite result | Same test/dependency/environment closure under an approved reuse policy | Empirical installed/history/physical proof |
| Signed/notarized artifact | Exact same bytes and bound release identity, with present trust checks | RC-to-stable promotion or another architecture's trust |
| Public generated assets | Exact source/manifest/dependency provenance matches | Old installer metadata is current because HTML renders |
| Installed/manual receipt | Same bound artifact, supported transition and environment contract | A release-specific waiver carries into the next version |
| Live service result | Fresh readback of intended deployment and relevant semantics | Health proves completed backfill or production capacity |

The R7 generator already has a journal, but its recovery discards an unfinished
generation or restores the previous receipt set after partial installation.
It does not resume its expensive calculation. Prioritize reliable reuse of
already-complete valid evidence first. Phase-resumable R7 generation is a later
design task: preserve the common frozen source plan, measurement comparability
and atomic complete-set installation. Never splice unrelated partial benchmark
runs into a fabricated successful receipt. [^6][^7]

There is also a concrete over-invalidation opportunity: the current R7 workload
scan includes all of `src/` plus selected packages, not only reachable benchmark
code. An independent import-closure test already checks that reachable modules
and separately launched workers are covered. A reviewed narrower fingerprint
could avoid reruns for irrelevant changes, but must include dynamic/runtime
inputs, subprocess entrypoints, schemas, lockfiles and measurement policy.
Changing that contract requires an explicit evidence-schema transition; do not
silently reinterpret old receipts under a smaller key. [^20]

Retain the final release-specific broad gate. During development use the
existing conservative test planner, then record which gates the final candidate
actually satisfies. A hosted-only change should not trigger desktop signing or
real-history receipt regeneration when their inspected contracts are unchanged.
Run resource-sensitive benchmarks serially; parallelize only isolated work with
known resource and output ownership.

The owning-test planner is similarly conservative: unknown/shared paths fall
back to the broad suite. Add explicit Worker and public-website lanes only after
mapping complete dependencies and testing the routing. Keep the unknown-path
fallback, and retain one integrated final-candidate gate. This targets iteration
cost without declaring an incompletely tested release ready. [^7]

### P2: hosted migration rehearsal and early dependency delivery

The 0.1.18 database incident shows the need for two separate checks: production
lineage compatibility and production-shaped resource behavior. A fresh local
SQLite database proves neither. Use the existing local backend laboratory and
add a separately approved disposable remote rehearsal with synthetic data
matching relevant cardinality, skew and query patterns. Check preservation,
query plans, remote syntax, bounded work and behavior during interrupted
publication. Do not copy private production telemetry into fixtures. [^3][^10]

Deliver minimal required hosted compatibility before freezing the desktop
candidate—for example, a newly required architecture's update-feed guard.
Do not couple unrelated admin redesign or historical recomputation to app
signing. Database changes and deployments remain separately reviewable, with
exact migration sets and recovery position. A planned graph rebuild should
preserve authorized publications and expose progress before it reaches users.

## Existing products and infrastructure

**Use existing GitHub Actions features for execution boundaries.** Environments,
review gates and concurrency groups can provide visible job state and prevent
competing promotions. This is not a reason to introduce another approval for
every command: approve a concrete scope once and retain it until inputs or scope
change. Availability of protection features depends on repository/plan settings
and must be checked when implementing. GitHub concurrency is not a durable
release journal or an exactly-once remote-operation mechanism. [^15]

**Do not add a persistent self-hosted release runner as a shortcut.** The current
repository policy explicitly forbids it. Hosted ephemeral runners or the
existing owner-controlled local signing path are the immediate compatible
choices. Any new hardware runner/credential policy needs its own design and
approval; never run untrusted pull-request code with signing material. [^9]

**Release Please is optional, lower priority.** It can automate version bumps,
changelog preparation and release PRs, but its own documentation says it does
not handle package-manager publication or complex branch management. It does
not solve installed migration qualification, R7, notarization recovery or
multi-surface reconciliation. If adopted, its automatic release creation must
be configured around verified draft-first native artifacts, not allowed to
publish before they exist. [^16]

**Electron Builder is a future adapter, not the answer to this native release.**
It already supports packaging/notarization/publication for Electron products.
If an Electron app becomes the approved product, reuse those capabilities while
retaining TiboTattle's state-preservation, final-byte and publication contracts.
Do not adopt a desktop-shell migration merely to solve release coordination. [^17]

**One notarization instead of two is worth a bounded experiment, not an immediate
change.** Apple recommends notarizing the outermost ordinary nested container.
The current code separately notarizes and staples the app before creating and
notarizing the DMG, and policy requires both inner-app and DMG evidence. A
single-submission workflow must demonstrate the same offline extracted-app,
Finder-install, updater and final immutable-byte properties. If it cannot, retain
the two-stage path. No fixed saving is claimed because provider queue time was
not measured here. [^5][^12][^18]

## Agent operation and approval design

The default agent entrypoint should be the release status/doctor, not a search
through every historical plan. Keep runbooks as explanation and recovery
reference; generate a compact current-state view from verified evidence.
On handoff, another agent should receive the release ID, plan digest, last
verified phase and exact remaining action without needing the original chat.

Record approved operations against a reviewable plan: environment, selected
targets, candidate source/artifact identities, migration set, publication
destinations and explicit exclusions. An agent-authored file is not itself
authorization. It records an authenticated owner approval; runtime/tool approval
boundaries still apply. New migrations, new destinations or materially changed
artifacts require revised authority. Expired/absent manual evidence remains
missing unless a specific owner decision is both allowed and recorded.

Use one writer per candidate and publication target. Other agents can inspect
and validate independently, but must not mutate the release checkout while
it is qualifying. Report status on phase changes and meaningful waits, including
an actionable blocker; do not end a turn as “ready” while an already-authorized
downstream surface remains unfinished. Conversely, do not continue unrelated
product development to make an already-released version feel more complete.

## Implementation sequence and success criteria

| Order | Work package | Relative size | Completion test |
| --- | --- | --- | --- |
| 1 | Release doctor/status, target matrix, early prerequisite and source divergence checks; repair stale authority routing | Small–medium | Fresh agent identifies all missing inputs and the next safe action without signing or publication |
| 2 | Durable operation/result schema, cross-writer deployment coordination and hosted exact-source verification | Medium | Stale concurrent deploys cannot erase repairs; timeouts cannot erase mutation outcomes |
| 3 | Native phase journal/resume using existing validators | Medium–large | Crash at every phase; resume without duplicate verified work or stale artifact reuse |
| 4 | Manifest-driven GitHub/feed/cask/site reconciliation | Medium–large | Partial publication resumes to exact desired state; complete rerun performs zero writes |
| 5 | Trusted evidence reuse, early upgrade fixtures, remote synthetic migration rehearsal and measured scheduling | Medium–large | Required gates still fail on real input changes; unrelated changes avoid unneeded expensive work |
| Later | R7 calculation resume; single-notarization experiment; optional release-note automation | Separate experiments | Demonstrated preservation of evidence/trust contracts and measured benefit |

Sizes are engineering judgments, not delivery-time commitments. Begin with
doctor/status and mutation-outcome reporting because they improve every later
step and expose remaining failures without risky changes to artifact trust.
Implement as small reviewed changes; do not build a large generic workflow
framework or duplicate the existing finalizers.

Qualification should include a synthetic complete-release simulation with fake
Apple/GitHub/R2/Cloudflare/tap adapters. Inject interruption before and after
every external mutation, malformed/stale receipts, concurrent agents and lost
responses. Verify no forbidden operation occurs from plan/doctor mode and that
no artifact becomes public without the exact required evidence. Then perform
separately authorized real candidate and publication rehearsals.

Measure the next release against explicit objectives: no late discovery of a
known prerequisite after signing; no re-signing due solely to an interrupted
notarization wait; no unnecessary rerun of a still-valid expensive proof; one
visible per-surface completion state; and no declaration of completion while
the website or selected architecture remains stale. Do not promise a fixed
release time: corpus-changing R7 qualification alone has taken about half an
hour, and first-platform or first-transition qualification is additional work.

## Validation and limitations

Read-only source and historical-evidence investigation completed. Existing
release-note and workflow-policy suites passed **22 tests, zero failures or
skips** on the inspected source. These focused tests validate existing contracts;
they do not qualify the proposed coordinator. No full desktop rebuild, signing,
notarization, production mutation, live load or new release was performed for
this investigation. External tool capabilities were checked against primary
documentation; configuration and end-to-end behavior would still need validation
when selected for implementation.

The new report passed documentation governance, repository-link validation,
workspace preflight and its 20 documentation/agent-guidance tests, with no
failures. The desktop file-preview request was queued, but the UI inspection
timed out; source Markdown was reviewed, not a confirmed rendered preview.

## Sources

Repository links below refer to the inspected checkout; source line ranges are
discovery anchors and can move during later implementation. Dated records are
point-in-time evidence, not current operating authority. External sources were
accessed on 2026-09-08.

[^1]: [Source 1](../plans/2026-09-04-release-0-1-18-publication-preparation.md). See the annotated source list below.
[^2]: [Source 2](../reviews/2026-09-04-installed-upgrade-readiness.md). See the annotated source list below.
[^3]: [Source 3](../plans/2026-09-05-public-0-1-18-release.md). See the annotated source list below.
[^4]: [Source 4](../reviews/2026-09-04-paginated-export-qualification.md). See the annotated source list below.
[^5]: [Source 5](../../scripts/macos-release-core.js). See the annotated source list below.
[^6]: [Source 6](../../scripts/regenerate-r7-release-evidence.js). See the annotated source list below.
[^7]: [Source 7](../../scripts/test-lanes.mjs). See the annotated source list below.
[^8]: [Source 8](../../scripts/publish-sparkle-update.js). See the annotated source list below.
[^9]: [Source 9](../../.github/workflows/release-trust-policy.yml). See the annotated source list below.
[^10]: [Source 10](../../apps/worker/scripts/production-deploy.mjs). See the annotated source list below.
[^11]: [Source 11](../current-status.md). See the annotated source list below.
[^12]: [Source 12](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow). See the annotated source list below.
[^13]: [Source 13](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases). See the annotated source list below.
[^14]: [Source 14](https://docs.brew.sh/Cask-Cookbook). See the annotated source list below.
[^15]: [Source 15](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments). See the annotated source list below.
[^16]: [Source 16](https://github.com/googleapis/release-please/blob/main/README.md). See the annotated source list below.
[^17]: [Source 17](https://www.electron.build/v26/docs/features/build-lifecycle/). See the annotated source list below.
[^18]: [Source 18](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution). See the annotated source list below.

1. TiboTattle, *Release 0.1.18 publication preparation*, September 4 record:
   R7 duration/retry, fixture umask, full-root rerun, source churn and later RC3.
2. TiboTattle, *Installed-upgrade readiness*, September 4 record, deadline and
   copy-only semantic-preservation sections.
3. TiboTattle, *Public 0.1.18 release execution*, September 5 record, hosted
   boundary and migration-repair continuation.
4. TiboTattle, *Paginated-export qualification*, September 4 record; see also
   [initial RC2 proof](../reviews/2026-09-04-release-0-1-18-rc2-build-proof.md).
5. Native finalizer, `scripts/macos-release-core.js:3666–3835`; CLI,
   `scripts/release-macos-app.js:114–130`; installed ticket requirement,
   `macos-release-core.js:3221–3227`; `config/release-evidence.js:126–128`.
6. R7 generation, `scripts/regenerate-r7-release-evidence.js:90–133`,
   `1349–1359`, `1407–1445`, `1635–1687`; maintained
   [R7 receipt runbook](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md).
7. Test planner, `scripts/test-lanes.mjs:471–515`; web-only public input
   restrictions in `scripts/web-release-lane.js`.
8. Sparkle publisher, `scripts/publish-sparkle-update.js:1526–1553`,
   `2401–2444`, `2538–2610`; cross-surface order in the
   [macOS runbook](../runbooks/macos-stable-release-runbook.md), lines 816–852.
9. Release trust workflow and `scripts/check-release-workflow-policy.mjs:301–310`.
10. Production wrapper, `apps/worker/scripts/production-deploy.mjs:652–700`,
    `880–1090`, `1204–1207`; exact-source operational check in
    [production operations](../runbooks/production-operations.md).
11. Current status, source `77b564cd`, and the
    [verified scale publication receipt](../receipts/2026-09-08-thousand-contributor-publication.md).
    Compare macOS runbook lines 110–114 for stale Intel Homebrew wording.
12. Apple, *Customizing the notarization workflow*: submission IDs, status/logs,
    nested-container tickets, stapling and custom-installer exception.
13. GitHub, *Immutable releases*; additionally
    [GitHub CLI, gh release verify-asset](https://cli.github.com/manual/gh_release_verify-asset).
14. Homebrew, *Cask Cookbook*, architecture-specific substitutions.
15. GitHub, *Deploying with GitHub Actions*; see also
    [environment protection availability](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
    and [concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
16. Google APIs, *Release Please README*, supported automation and exclusions.
17. Electron Builder, *v26 Build Lifecycle*, existing packaging/publishing phases.
18. Apple, *Packaging Mac software for distribution*, outermost-container
    notarization and testing the actual distributed product.

[^19]: [Cache publisher repair receipt](../receipts/2026-09-07-cache-publisher-repair.md), combined source and deployment coordination section.

[^20]: [R7 provenance implementation](../../src/r7-release-evidence-schema.js) and [independent reachable-module coverage test](../../test/r7-release-evidence-schema.test.js), workload scan and import-closure sections.
