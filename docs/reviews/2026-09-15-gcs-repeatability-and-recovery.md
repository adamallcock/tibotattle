---
title: GCS repeatability and recovery qualification
date: 2026-09-15
type: review
status: live-repeatability-qualified
---

# GCS repeatability and recovery qualification

Snapshot: `codex/hosted-object-storage-adapter`, after the original fixed-namespace
[test asset receipt](2026-09-15-gcs-test-assets.md). Tests used only synthetic
objects in the same approved private bucket, with local Worker/D1 execution.
The [runbook](../runbooks/2026-09-15-gcs-adapter-tests.md) is the maintained procedure.

## Live results

Two consecutive runs passed against bucket
`tibotattle-gcs-test-release-20260915-a7c92f`. Their generated namespaces and
object keys are disjoint. Each proved:

- signed appcast publication and replay refusal;
- exact current-generation byte read-back;
- conditional replacement and stale write/read conflict;
- concurrent create with exactly one winner and matching winner bytes.

Both successful receipts produced default-dry-run cleanup plans containing
exactly four keys with generation preconditions. No cleanup DELETE was executed.
Eight new live objects remain, plus the replaced generations subject to the
bucket recovery policy. The original seven live objects were not targeted.
The short-lived input token was removed after both tests; the harness stopped
its local Worker processes and removed its temporary local configuration.

## Current generations recorded by the runs

| Key | Generation |
|---|---|
| `gcs-test/runs/35b9f6aebd95142fa5d49b539105a0a5/releases/1.0.0/3d17523a653fab9b3270c278c51fbcff54ffc74c0125859e307af554dd4a0e2b/TiboTattle.dmg` | `1789521830091062` |
| `gcs-test/runs/35b9f6aebd95142fa5d49b539105a0a5/appcast.xml` | `1789521830490886` |
| `gcs-test/runs/35b9f6aebd95142fa5d49b539105a0a5/scratch/replace.bin` | `1789521830932871` |
| `gcs-test/runs/35b9f6aebd95142fa5d49b539105a0a5/scratch/race.bin` | `1789521831286662` |
| `gcs-test/runs/d3d8d94f96fa5d2c7b6c8a143a4d984d/releases/1.0.0/3d17523a653fab9b3270c278c51fbcff54ffc74c0125859e307af554dd4a0e2b/TiboTattle.dmg` | `1789521858366165` |
| `gcs-test/runs/d3d8d94f96fa5d2c7b6c8a143a4d984d/appcast.xml` | `1789521858843704` |
| `gcs-test/runs/d3d8d94f96fa5d2c7b6c8a143a4d984d/scratch/replace.bin` | `1789521859258698` |
| `gcs-test/runs/d3d8d94f96fa5d2c7b6c8a143a4d984d/scratch/race.bin` | `1789521859666050` |

## Local recovery evidence

The portable lane passed 21 tests, including a write committed before a lost
response and a write that never committed. Both return a sanitized 503 and
consume the nonce. Replay performs no storage operation. Explicit read-back
finds the committed bytes or absence; a freshly signed stale expectation is
refused with 409, while a fresh request after confirmed absence can succeed.
GCS 401/403 responses remain storage failures without automatic retry.
Existing timeout tests bound credential acquisition, request and body reading.
These fault cases use synthetic transports, not deliberately broken live IAM.

The offline smoke/cleanup lane passed 14 tests, including exact target selection,
uncertain-receipt refusal, expiry between deletes and preservation of an existing
receipt. Infrastructure plan tests passed four checks. The uninterrupted Worker suite
passed 1,055 tests across 85 files in 351 seconds. Workspace-package, endpoint,
generated-type, TypeScript and existing script checks also passed. The source
was still uncommitted when these checks ran; publication remains a separate gate.

## Boundaries

This qualifies repeatable release-object tests across a local Worker and GCS.
It does not qualify a deployed GCP application, PostgreSQL, contribution storage,
physical erasure, production migration, or release publication. Cleanup execution
is locally mocked; its cloud mutation path was not exercised by these runs.
