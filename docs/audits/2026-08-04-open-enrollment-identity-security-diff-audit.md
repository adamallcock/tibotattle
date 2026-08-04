---
title: Open-Enrollment Identity Security Diff Audit
date: 2026-08-04
type: audit
status: completed_pending_release
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

The sealed security-diff review was anchored at
`575450df2d816ede845cd091a90ced558ccc782c`. It covered the 37 initially
ranked source files and nine supporting add-backs, then a scope reconciliation
identified and reviewed the eight omitted runtime/configuration files introduced
by the parallel local-report relocation work. This gives receipts for every
non-test runtime/configuration path in the current diff (46 paths); tests and
documentation are explicitly excluded from that execution-surface count.

The corresponding machine-generated sealed report and scope-completion
addendum are retained with the scan bundle outside the repository. This durable
summary records their conclusion and the release implications without copying
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

## Security hardening backlog

The supplemental review found no cross-user or remote attack path in the
parallel local-report relocation code. It did identify four useful same-user
developer-workspace hardening items that should be handled in a separate change
owned by that workstream:

1. Refuse final-component and ancestor symlinks for legacy-report reads and
   report-output writes, instead of allowing Node write calls to follow a
   pre-created link.
2. Keep the legacy-report migration read bounded by the descriptor size rather
   than checking size before a whole-file read that can race with growth.
3. Preserve the existing owner-only semantics for collector state and
   accounting caches; treat them as availability/reliability resources, not a
   claimed defence against a malicious same-UID process.
4. Re-run the local-report and tool-inventory boundary suites after that
   workstream resolves its independent architecture and inventory changes.

These are defence-in-depth improvements, not a reason to delay the identity
remediation integration. They must not be fixed by rewriting or reverting the
parallel archive/local-report change in this shared checkout.

## Validation receipt

Focused remediation checks passed:

```text
npm --prefix apps/worker run typecheck
npm --prefix apps/worker run types:check
npm --prefix apps/worker test -- --run test/identity-oidc.spec.ts test/device-auth.spec.ts test/worker.spec.ts test/community-snapshots.spec.ts
node --test --test-concurrency=1 apps/local/server.test.mjs
node --test --test-concurrency=1 apps/web/test/lib.test.mjs apps/web/test/community-site.test.mjs
node --test test/local-legacy-report-storage.test.js test/local-companion-data.test.js
git diff --check
```

The focused Worker run passed 120 tests, the local server run 35, the browser
run 114, and the supplemental local-storage run 14.

The current broad `npm test` sweep is **not green**. Its failures include the
parallel local-report architecture boundary, generated R7 receipt drift,
reporting-owner expectations, tool inventory drift, localization inventory
expectations, and legacy collector/cache fixture expectations. The full Worker
suite also has a separate telemetry expectation failure, and the Worker script
inventory check has stale quota-package expectations. None is in the reviewed
open-enrollment identity surface; all require their respective owners to
reconcile before a repository-wide green release claim.

## Preconditions before enabling open enrollment

1. Apply migrations `0023` through `0026` to an isolated D1 staging database
   and prove upgrade, rollback/restore, retention cleanup, and admission-limit
   behavior.
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
