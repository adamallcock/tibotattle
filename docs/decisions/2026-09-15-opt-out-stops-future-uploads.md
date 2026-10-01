---
title: Opt-out stops future uploads
date: 2026-09-15
type: decision-record
status: accepted
---

# Opt-out stops future uploads

The owner explicitly clarified on 2026-09-15 that ordinary opt-out stops future
uploads and does not remove or withdraw previously shared data. This corrects
the earlier coupling between upload credential revocation and public-history
eligibility. It is an accepted product contract, not a deployment receipt.

## Contract

- Persist the local off choice before success; stop scheduling and cancel
  in-flight contribution work. Restart, credential expiry and upgrade cannot
  re-enable sharing without an affirmative choice.
- Revoke future upload permission through the authenticated device boundary.
  Historical eligibility must not grant a revoked credential new upload access.
- Retain accepted records, completed calculations and published graph history.
  Ordinary opt-out or device disconnect must not increment a hard history
  invalidation epoch or restart a calculation of retained historical evidence.
- Keep source attribution, corrections, replay protection, deduplication and
  statistical suppression unchanged. Retaining a source does not guarantee
  that its data qualifies for any particular public statistic.
- Retired self-service deletion routes remain retired. This change adds no
  deletion feature. Security containment and explicit private owner erasure
  are separate operations and must not be triggered by an ordinary opt-out.
- Do not automatically reinterpret historical security revocations or erasures
  as eligible sources. Any compatibility migration must distinguish a recorded
  user opt-out from security containment and preserve the accepted records.

## Delivery evidence

The desktop already persists an off choice and prevents future scheduling.
Local Worker source `f5865ba2f16341cc81522478225d0097c38b3288`
implements the forward correction. Baseline migration `0061` adds a prospective
source-identity marker without copying telemetry; final isolation migration
`0005` keeps that exact accepted head eligible after ordinary opt-out while
retaining hard withdrawal for containment, reset, partial authority changes,
head removal and owner erasure. Their SHA-256 digests are respectively
`0d6d9d23390770aab5c2cb9b1bbb27586ed72b9921a420468efb05ee225435d6` and
`17e4d02f0fa738b1d6fb9389af1ee4a49a69e22837728568884bdb3212777747`.

On 2026-09-15, six focused Worker test files passed 104 tests and Worker
type-checking passed. The populated tests prove pre-migration atomic refusal,
post-migration credential refusal, retained accepted records and source lookup,
unchanged calculation authority, preserved completed daily publication, and
terminal security containment both before and after an ordinary opt-out. These
are local source and migration gates. No production migration, deployment or
live behavior is claimed corrected here.
