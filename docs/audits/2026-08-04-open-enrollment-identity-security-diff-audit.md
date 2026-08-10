---
title: Open-Enrollment Identity Security Diff Audit
date: 2026-08-04
type: audit
status: implementation-complete-external-release-gated
---

# Open-Enrollment Identity Security Diff Audit

## Verdict

The open-enrollment identity remediation is ready to integrate, but **not to
enable in production yet**. The reviewed code now treats Google or Apple as a
per-provider-account admission barrier, rather than claiming to establish a
unique human identity. No provider access, refresh, or ID token is retained
after the server-side exchange. The full security review closed with no
reportable finding under the documented threat model.

The implementation remains deliberately configured as `disabled` in staging
and production. Enabling it needs the release gates below, including a real
hosted OAuth journey and D1 migration rehearsal.

## Scope and evidence

The final sealed security-diff review covers
`4393bcf823435c6082326526f4e28dc56cd01824` through
`5114acecf6c3719f8dd4c28bfdce4d3dfce0eba5` (snapshot
`codex-security-snapshot/v1:sha256:63ef50feb951eb3c5fc425d511e0b00ef6664e7c6ee9b383087af1ed477ddc8a`).
It completed full-file review of 24 selected source/configuration paths across
the identity, release-preflight, macOS release, and local-report surfaces.
Coverage is complete and the final report has zero reportable findings; tests
and documentation are deliberately outside that execution-surface count.

The earlier sealed review anchored at
`575450df2d816ede845cd091a90ced558ccc782c` remains the discovery baseline for
the initial 46-path reconciliation. The final machine-generated scan report is
retained with the local scan bundle outside the repository. This durable summary
records its target, conclusion, and release implications without copying
temporary scanner output into product documentation.

## Controls verified

- Enrollment is checked before a provider redirect or handoff creation, and is
  fail-closed when disabled or collection is paused.
- The service retains a keyed issuer-and-subject link, never a reusable social
  provider token. Apple uses a random nonce whose SHA-256 digest is retained
  only for the short-lived sign-in handoff.
- The browser receives an opaque, single-use handoff proof. Device sessions are
  bounded by idle and social-recheck deadlines, rather than prompting for OAuth
  every few hours.
- Device revocation is remote-first and requires the device bearer; a local
  disconnect latch prevents an upload/disconnect time-of-check/time-of-use
  race.
- Aggregate publication enforces the v0.3 policy, policy epoch, cohort
  exclusion, minimum thresholds, and stricter backend validation. Provider
  accounts are not presented as independent people.
- Sign-in starts have a durable, atomic global admission budget with a short
  retention window. Production and staging are still configured with enrollment
  disabled.

## Post-seal implementation completion

The hardening items recorded by the sealed review are now implemented without
rewriting the parallel archive/local-report work:

1. Legacy report reads and writers reject final and ancestor symlinks. Canonical
   writers use owner-private, no-follow/no-clobber staging, descriptor sync,
   identity revalidation, atomic same-directory rename, and exact staging
   cleanup. The migration read is bounded through one descriptor and rejects
   growth/replacement.
2. The Worker has a local-only D1 release preflight that applies and verifies
   primary migrations `0023`–`0028` and the complete deletion-ledger stream in
   disposable owner-only state. It cannot deploy, use remote D1, or read a
   secret.
3. Deletion tombstones are fixed-duration and boundedly purged. Deletion also
   writes a purpose-separated 30-day identity re-enrolment cooldown to primary
   D1 before removing the unique identity link, then mirrors it to the ledger.
   `0027` rejects a live digest at the participant `INSERT` boundary, so an
   active-to-deletion timing race cannot mint a replacement account.
4. `0028` pins the non-secret identity-link version label and a keyed,
   one-way fingerprint of `IDENTITY_LINK_SECRET` in primary D1. An in-place
   secret/version change fails closed before a hosted identity operation can
   split account continuity or bypass a cooldown. A future rotation needs a
   separate dual-key migration, not a configuration edit.
5. The controlled-release runbook makes the live OAuth, secret, migration
   ordering, observability, pilot, approval, and containment evidence explicit.

Portable Node does not expose `openat`/directory-descriptor rename primitives,
so it cannot completely eliminate a hostile **same-UID** ancestor-rename race.
The code rejects static symlinks and revalidates immediately before and after
publication; the residual is owner-local availability/integrity risk, not a
remote or cross-participant path. Do not describe owner-only local files as a
malware boundary.

## Validation receipt

Focused remediation checks passed:

```text
npm --prefix apps/worker run typecheck
npm --prefix apps/worker run types:check
npm --prefix apps/worker run types
npm --prefix apps/worker test -- --run test/worker.spec.ts test/quarantine-reconciliation.spec.ts test/identity-google.spec.ts test/identity-apple.spec.ts test/identity-oidc.spec.ts
npm --prefix apps/worker run release:preflight
node --test --test-concurrency=1 apps/local/server.test.mjs
node --test --test-concurrency=1 apps/web/test/lib.test.mjs apps/web/test/community-site.test.mjs
node --test --test-concurrency=1 test/local-legacy-report-storage.test.js test/fix-portable-report-width.test.js test/local-companion-data.test.js
git diff --check
npm run docs:links:check
```

The focused Worker identity/lifecycle regression run passes five files and 159
tests. The release preflight completes four local checks and reports a
disposable migration rehearsal as ready without contacting remote
infrastructure. Focused local report storage/width tests and the local
companion data suite pass; the completed controlled-release steps are in
[`2026-08-04-open-enrollment-controlled-release.md`](../runbooks/2026-08-04-open-enrollment-controlled-release.md).

The current broad `npm test` sweep is **not green**. Its failures include the
parallel local-report architecture boundary, generated R7 receipt drift,
reporting-owner expectations, tool inventory drift, localization inventory
expectations, and legacy collector/cache fixture expectations. The full Worker
suite also has a separate telemetry expectation failure, and the Worker script
inventory check has stale quota-package expectations. None is in the reviewed
open-enrollment identity surface; all require their respective owners to
reconcile before a repository-wide green release claim.

## Preconditions before enabling open enrollment

1. Keep enrollment disabled; deploy and drain the reviewed Worker revision
   before applying migrations `0023` through `0028` to an isolated D1 staging
   database. Prove upgrade, rollback/restore, retention cleanup, admission-
   limit behavior, and the no-mixed-version rollout order.
2. Configure only the approved production Google/Apple client IDs, callback
   URLs, Apple key material, HMAC secrets, and encrypted operational bindings;
   verify no secret appears in logs, errors, analytics, or browser bundles.
3. Perform a signed, connected-preview journey for Google and Apple: first
   sign-in, restored session, provider recheck, device pairing, disconnect,
   revocation, and a denied/expired provider result.
4. Observe the disabled-mode metrics and abuse/rate-limit alerts in staging;
   obtain explicit release approval before changing `ENROLLMENT_MODE` from
   `disabled`.
5. Enable progressively with a kill switch and monitor account-linked upload
   rejection, sign-in failure, admission limit, and aggregate-policy metrics.

The detailed implementation and operational sequence remains in
[`2026-08-04-open-enrollment-social-identity-remediation-plan.md`](../plans/2026-08-04-open-enrollment-social-identity-remediation-plan.md).
