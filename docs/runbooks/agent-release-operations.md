---
title: Agent release inspection and operation recovery
date: 2026-09-08
type: runbook
status: maintained
---

# Agent release operations

This is the entrypoint for local release inspection and interrupted operation
recovery. It does not grant signing, production or publication authority. Retain
the [macOS release](macos-stable-release-runbook.md) and
[production](production-operations.md) gates. Use
[publication reconciliation](release-publication-reconciliation.md) for exact
cross-surface state and [early qualification](release-qualification-admission.md)
for synthetic admission and reviewed local proof reuse. Neither grants release
authority or substitutes for final qualification.

## Read-only discovery

From the intended checkout:

```bash
node scripts/release-agent.mjs doctor --json
node scripts/release-agent.mjs doctor --plan <private-plan.json> --json
node scripts/release-agent.mjs status --operation <private-operation-directory> --json
```

Doctor reports all cheap local checks together, never signs, builds, installs,
accesses Keychain, fetches remote state or regenerates evidence. Without a plan,
both architectures are listed with missing inputs. Its exit code is nonzero
when local blockers remain. `readyToRelease` remains false: this tool does not
claim to close external/manual gates. Status summarizes only allowlisted fields
from an existing record; recorded completion is not fresh remote verification.

The optional plan is a closed JSON object with exactly `schema: 1`, full
40-character `sourceCommit`, full reviewed `baseCommit`, `channel` (`stable` or
`internal-dogfood`), and `targets`. Select one or both architectures, each once.
Each target contains `architecture` (`arm64` or `x64`) and optional paths `app`,
`nodeRuntime` (Intel), `previousManifest`, `output`. Target paths resolve against
the checkout; the plan path resolves against the invoking directory. Keep the
plan in ignored private storage; it is input selection, never approval.

The doctor distinguishes configured references from exercised credentials,
present manifests/runtime files from validated binaries, local tracking refs
from freshly fetched remote truth, receipt compatibility from release approval,
and native source proof from physical-hardware evidence. Never turn a missing
receipt into a waiver; previous release exceptions do not carry forward.

## Native finalization and resume

The release CLI journals by default under the exact `<output>.operation` path.
`--journal` is accepted only when it names that same canonical path. Different
directories cannot bypass the output lock. Keep the operation on a local disk,
under an owner-controlled canonical path without symlink traversal. Directory
mode is 0700; records and local mutex are 0600. Do not share operation directories
or publish them with installers. They retain intermediate binaries and private
Apple submission IDs, not raw signing identities or notary profile names.

Run the already-authorized finalization command with its original source,
architecture, candidate, runtime, channel, continuity and output arguments.
Resume by adding `--resume`; do not add `--prepare-candidate` or `--replace`.
The existing `--prepare-candidate` flag still proceeds into signing, so it is
not an inspection command. The journaled CLI refuses replacement of an existing
release; published immutable artifacts must never be rewritten.

Completed stages are byte-bound and durable before their completion receipt is
promoted. Resume checks the source, candidate and signing inputs, reuses verified
stages, waits on known Apple IDs, reruns current installed/trust checks, and
installs the final DMG and manifest without clobbering conflicting files. An OS
mutex prevents concurrent execution and is released when a process exits or
dies; the evidence survives. Do not delete or edit receipts to bypass refusals.

If upload may have succeeded but no ID was saved, the operation stays uncertain.
The tool deliberately cannot guess a submission from a filename or issue another
upload. An owner must investigate Apple submission history and establish the
outcome before separately deciding recovery. This path is not automatically
resumable; there is no unsafe force-resume flag. Changed source, runtime,
candidate, profile bytes or signing configuration requires a separately reviewed
new operation/release identity, not relabeling old evidence.

Retained intermediate stages consume disk space; no automatic destructive
cleanup is performed. An interrupted final copy is preserved with an
`.incomplete-<random-id>` suffix before retrying the copy; final published files
are never replaced. After final qualification/publication, archive the exact
final artifacts and receipts, then explicitly review any local staging cleanup.
Synthetic tests establish orchestration and process-crash recovery, not Apple
availability, power-loss behavior of every filesystem, installed Login Items,
Keychain access, physical Intel or real notarized release qualification.

## Production ownership and recovery

Both production entrypoints use the exact reviewed predecessor and a fixed
coordination ref: `refs/heads/codex/production-deployment-lock` on the approved
TiboTattle origin. The owner commit has an empty tree and content-free operation
metadata; taking ownership does not upload candidate source history. Conditional
creation/deletion uses an explicit expected object ID, not tracking-ref guesses.
There is no timeout-based stealing, and no repository protection changes.

The Git credential must be permitted to create/delete this one coordination ref.
These writes are part of an explicitly authorized production operation, not
doctor mode. Every production writer must use the updated guard. This is a
cooperative lock, not a Cloudflare-enforced fencing token: raw Wrangler, old
checkouts and privileged dashboard actions bypass it and must not run concurrently.

The operation persists intent before Wrangler. A lost/nonzero provider response
cannot be reported as proof of no deployment. Exact source plus public-surface
checks establish verified completion; cleanup warnings are separate. Missing or
wrong post-source leaves ownership retained. Rerunning the normal command on an
existing journal refuses, preventing blind repeated deployment.

Use the [production reconciliation procedure](production-operations.md#guarded-deployment-wrapper)
only after proving the old executor has stopped. It never deploys, and releases
only the exact owner after verifying the intended live source/public surface.
Uncertain acquisition, inaccessible remote state or a candidate not observed live
requires investigation; do not delete the shared ref manually to make progress.
A proven pre-mutation failure with no held/uncertain lock can use a new explicit
operation directory after review, retaining the failed record for diagnosis.

The conditional Git update contract follows [Git's explicit expected-value
lease semantics](https://git-scm.com/docs/git-push). Apple submission continuation
uses [notarytool submission IDs and status](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
