---
title: Release tooling main-branch integration
date: 2026-09-08
type: review
status: qualified-with-existing-release-gate-limitations
---

# Scope

[PR 114](https://github.com/adamallcock/tibotattle/pull/114) integrates the five
release-process recommendations and their preceding hosted graph-recovery and
1,000-contributor scaling commits. These prerequisites were already part of
the authorized implementation sequence but had not reached `main`.

The integration preserves `main` at `dffe64d6`, including desktop customization,
model attribution, refresh retention, Intel installation guidance and the
purchased-credit research tool. Six documentation conflicts were reconciled
in `30601c8f`; no existing main-branch feature was removed.

## Findings and fixes

- Hosted dependency scanning found vulnerable development dependencies in the
  Worker lockfile. `e9c396dc` updates Vitest to 4.1.11 and scopes a sharp 0.35.4
  override to Miniflare. Its README records the upstream advisories and the
  override-removal condition. npm resolution also updates compatible transitive
  test dependencies; the full Worker suite was rerun on the resulting lockfile.
- The export test retained the scanner digest from before main's reviewed
  Actions update. Its assertion now requires the new exact immutable digest;
  all existing permission assertions remain in force.
- The combined inventory contains 102 reviewed records and 104 executable paths,
  including main's purchased-credit analyzer. The exact-count assertions are
  updated accordingly, without relaxing ownership validation.
- Initial dry asset staging rejected the older local website build because
  main changed localization source. The public-site build was regenerated from
  current source with the same verified 0.1.18 installers and social image.
  The provenance check was retained, not bypassed.

## Test run report

Environment: macOS arm64, Node.js 26.2.0. Core integration and dependency tests
ran on `e9c396dc9a95e11436e2b7b9b2430b513d40cb18`.

| Gate | Result | Boundary |
| --- | --- | --- |
| Root/web `npm test` | 4,082 passed, three failed, 17 platform skips; 4,102 total; 619.22 seconds | Two existing R7 receipt failures plus the exact inventory-count assertion repaired above |
| Worker Vitest | 958 passed across 71 files, zero skipped; 350.29 seconds | Full rerun with patched test dependencies |
| Worker owning checks | Workspace guards, endpoints, generated types, TypeScript and operational/migration tests passed | Local synthetic checks, not remote qualification |
| Worker dry builds | Development, production and staging passed | Rerun after regenerating stale local website assets; no upload |
| Export and workflow tests | 14 passed, zero skipped | Exact new scanner pin and unchanged permission boundaries |
| Final inventory suite | Six passed, zero skipped | Complete owning suite after the exact-count correction |
| Documentation/preflight | 20 passed, zero skipped | Current-document authority, links and layout |
| Architecture | Passed: 407 production files, 1,662 imports, zero debt edges | Integrated source boundaries |
| Hosted PR CI on `e9c396dc` | All three checks passed | Documentation, release trust policy and OSV dependency scan |

The initial sandbox-restricted root run was stopped after local socket/process
access failures and replaced by the complete run above. It is not passing
evidence. The post-run inventory correction is a test-only exact-count update;
its owning suite and final documentation checks passed separately before
merge and are not represented as another full root run.

## Remaining gate

The two retained R7 tests still reject
`contractProvenance.workloadCodeSha256`. This existing protected receipt mismatch
is not fixed, regenerated, relabeled, skipped or waived by source integration.
The read-only release doctor correctly reports that this checkout is not a
qualified release candidate. Early qualification's reviewed input profile also
remains fail-closed when main's changed analytical inputs require a new review;
source integration does not silently bless a reusable proof.

No production deployment, remote migration, Developer ID signing, notarization,
installed-app replacement or installer publication was performed. Local native
tests used development/ad-hoc artifacts. Source merge, hosted CI, release
qualification and deployment remain separate gates.
