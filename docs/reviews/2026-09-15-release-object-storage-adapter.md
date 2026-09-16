---
title: Release object storage adapter first slice
date: 2026-09-15
type: review
status: implemented-local
---

# Release object storage adapter

This records the first slice before the subsequent
[GCP integration work](./2026-09-15-gcp-adapter-integration.md), which adds
provider-independent nonce storage, application composition and broader adapters.

## Scope and acceptance

Implemented the first bounded slice from the
[portability investigation](../research/2026-09-15-hosted-storage-portability.md)
on `codex/hosted-object-storage-adapter`, based on
`9385bad260698814cc2a4a6c685575a3fd63811a`.

- Define a release-object contract without Cloudflare types: metadata, opaque
  conditional tokens, conditional read, create-if-absent and replace-if-current.
- Implement it with R2, preserving SHA-256 enforcement, HTTP metadata, conditional
  failures, and deferred body-read failures. Provider errors remain content-free.
- Move stable and dogfood release-guard object operations onto the contract.
  Preserve the existing external payload/ETag vocabulary, conflict reasons,
  configuration refusal, nonce consumption, signature checks, and error phases.
- Retain the current D1 nonce implementation and quarantine lifecycle. Those are
  separate follow-up adapters; no schemas, bucket policies, deployment settings,
  public routes, or production resources change here.
- Prove the adapter against local R2 emulation, including conditional races and
  injected failures; retain the complete existing release-guard regression suite.

## Implementation and evidence

Snapshot: 2026-09-15, local macOS worktree on the base revision above, plus
this adapter change. The primary checkout and production resources were not
modified by this implementation. The accompanying research is a point-in-time
investigation of the base source, not a claim that every recommendation is now
implemented.

- `apps/worker/src/release-object-store.ts` defines the portable contract.
- `apps/worker/src/r2-release-object-store.ts` owns provider binding checks,
  conditional operations, metadata translation, checksum enforcement and
  content-free errors.
- `handleConfiguredSparkleAppcastGuard` accepts resolved dependencies. The
  existing Worker entrypoint composes R2 and retains existing route/config checks.
- Two consumer tests substitute generation-style conditional tokens while
  keeping raw/quoted wire ETags unchanged; they also check nonce consumption
  before object access.
- Eight adapter tests use local R2 emulation and fault injection, including
  concurrent stale writers, checksum no-commit, and deferred read failures.

Passed:

- Worker adapter and guard tests: **42 tests** (8 adapter, 34 guard).
- Worker generated-type check, TypeScript check and workspace-package guard.
- Standalone strict TypeScript compilation of the portable contract with
  `types: []` and `lib: ["ES2024"]`; no Cloudflare ambient types required.
- `npm run architecture:check`: 530 production files, 2,107 imports, zero debt
  edges.
- `node --test test/sparkle-signed-feed-validation.test.js test/dogfood-update-guard-config.test.js`:
  **18 tests**.
- `npm run docs:check` and `npm run test:preflight`: **20 preflight tests**.
- Independent Luna Max source review: no correctness or privacy blockers.

The complete `npm run product:worker:check` passed workspace-package checks,
deployment endpoint checks, generated types, TypeScript, script checks, and
**1,011 Worker tests across 80 files**. It then stopped in `deploy:dry` before
Wrangler deployment bundling because `production:stage-assets` requires a clean,
committed release tree. This review tree remains uncommitted. Therefore the
aggregate Worker gate is **not fully passed**: dry deployment and the subsequent
staging configuration/dry-deployment lane remain unqualified. No release-tree
check was bypassed and no remote operation was performed.

Documentation governance and the 20-test preflight passed after creating this
review. Tests emit the existing missing local envelope-secret and oauth4webapi
sourcemap warnings; fixtures supply synthetic test configuration.

## Risks and follow-up

R2 ETags are preserved as the conditional token for this implementation; they
are not a content SHA-256 or a cross-provider checkpoint. Legacy quoted/unquoted
ETag matching remains an HTTP compatibility field separate from that token.
There is no automatic retry after conditional conflict or uncertain write.
Nonce consumption still occurs before object access, so retries retain the
existing signed-request/replay rules.

A future GCS implementation needs generation-based conditions and its own remote
qualification. This slice does not prove GCP support or authorize publication.
