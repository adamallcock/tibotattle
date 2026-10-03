---
title: Temporary HTTP cache advisory exception
date: 2026-10-03
type: decision-record
status: accepted
---

## Accepted boundary

The owner approved the reviewed client max-stale mitigation and temporary
exception on 2026-10-03. This decision authorizes only the root pnpm lock's
GHSA-ch52-4w7c-c8xp (including its CVE alias), on the exact reviewed patched
http-cache-semantics 4.2.0 builder chain. It does not authorize any unrelated
advisory suppression, merge, release or publication.

The [release decision packet](../receipts/2026-10-03-website-dependency-release-decision.md)
records the official status, patch/source/builder hashes, 19-test proof and
residual risk. A separate explicit shared-cache stale-if-error validation defect
remains for no-cache/proxy-revalidate; installed downloader HTTP caching defaults
disabled. No default application or cross-user exploit was demonstrated.

## Fail-closed enforcement and removal

`osv-scanner.toml` contains only the accepted advisory ID and expiry. Directory
scope keeps it away from child locks. No global scanner config is used. The OSV
job first runs `scripts/check-http-cache-exception.mjs` and focused tests. It
checks exact root lock/workspace, patch/test bytes, installed dependency entrypoints
and downloader/core source bytes, and disabled got cache default. Any drift,
additional root lock or config expansion refuses the exception. Fresh official
npm/advisory reads are mandatory; unavailable status fails closed. A new published
version, first patched version, withdrawal or changed advisory scope requires a
new removal/replacement review before CI can proceed.

The same named job performs proof, scanning and fail-on-vulnerability reporting.
Expiry/proof failure therefore fails the check rather than producing a skipped
scanner success. Scanner/reporter use the exact immutable action commits called
by the former reusable workflow; unrelated findings still fail. SARIF uploads
and credential persistence are disabled, permissions are contents-read only.

At 2026-10-10T00:00:00Z the proof gate refuses, even if scanner date semantics
would otherwise include part of October 10. There is no automatic renewal.
Remove earlier when a compatible published fix is adopted, the advisory is
withdrawn/corrected or any evidence condition changes. Enabling HTTP shared
caching invalidates the risk basis and requires independent review. This narrow
exception is not a general exception policy.

Removal requires deleting the root exception config and its root-layout allowance,
retiring the temporary gate/test, removing the temporary proof workflow steps,
and validating the replacement dependency plus normal OSV behavior. Keep the
mitigation regression tests as appropriate for the replacement package. Do not
merely update the expiry, identities or accepted hashes to make CI pass.

## Local evidence and pending gate

Local verification passed 23 focused tests (19 mitigation/signing-contract tests
and four exception regressions), 84 release-trust tests, 20 preflight tests and
release workflow policy across 20 files. An official OSV-Scanner 2.5.1 binary
in a private temporary directory exercised synthetic lock fixtures: current
exception filtered the exact advisory/alias while unrelated lodash advisories
remained and scan exit was 1; an expired config restored the accepted advisory
and exit 1; a child lock retained the accepted advisory and exit 1. Fixture
results are under `/private/tmp/http-cache-osv-proof-20261003`. No private data or
credentials were used. These checks do not prove hosted CI, signing or release.

The actual root lock scan examined 288 packages and returned exit 0 with the
exact advisory/alias filtered. It is local lock evidence, not a hosted recursive
scan claim. Scanner action failure is not continued: operational errors and
unrelated findings fail the job even before reporter execution.

Independent review and the actual integrated hosted OSV check remain pending.
