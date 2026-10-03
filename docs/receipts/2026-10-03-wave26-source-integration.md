---
title: Wave26 initial source integration
date: 2026-10-03
type: receipt
status: source-only-checkpoint
---

This candidate composes admitted source changes only. It does not qualify serving, performance, production, or a registered kernel. The task supplied cc447d55064cf1bb84f36dfc62697f801aa579ab as the Wave25 execution pin. No Wave25 edits were made by this integration owner; the final read-only observation found that checkout clean at 9beed5282da6b3bc0690d4fe4e79f1ca0045047a and this change was reported to the coordinator. The Wave26 base remains the exact supplied pin.

Base: cc447d55064cf1bb84f36dfc62697f801aa579ab. Candidate branch: codex/gcp-wave26-20261003. Initial source checkpoint: 9c8a62fadcbf512023d0b434ab79425ef5a5508f.

| Admitted source | Candidate commit | Scope |
| --- | --- | --- |
| 6cefd11573535c5a99a3da6dcc8a2f228c80f509 | e918b9ff28183b62bd0465b7c82499aea4eb07fb | Prospective fence observation only; its prerequisite parent was not replayed |
| 58a271c1370a1cbd659efb3a7b10667684d93035 | 11073adb91987eb66c48312d7931ec6096e954de | READ-PLAN selection and independent oracle |
| e2addd88318c7f21574922a2093a22245da61f80 | 89ef7ac8752e5c2d8a3521f9fc60c8f8a5960bf6 | Merged ordered pre-owner reads and scripted contracts |
| c5718049816739187d27a82e8f20a4b9c5ec7d36 | 9c8a62fadcbf512023d0b434ab79425ef5a5508f | READ-PLAN owner receipt |

All four used `git cherry-pick -x`, without conflicts. Package scripts auto-merged. No copied prerequisite commits were replayed. Existing measure-local, fast-pricer binding and primary migration 0074 remained unchanged.

Bounded local evidence at the initial source checkpoint, Node.js 26.2.0, from `apps/worker/`:

- `node --test --test-concurrency=1 cloud-run/analytics-refresh-read.check.mjs`: 11 passed, zero skips.
- `node --test --test-concurrency=1 scripts/cloudflare-writer-fence.check.mjs scripts/cutover-source-fence.check.mjs`: 40 passed, zero skips; synthetic local provider fixtures only.
- `node --test --test-concurrency=1 cloud-run/analytics-refresh-pool.check.mjs`: 13 passed, zero skips; qualified serial rerun after fence completion.
- `./node_modules/.bin/tsc --noEmit`: passed.
- Root `npm run test:preflight`: passed, including all 21 documentation tests; receipt-only edits followed this gate.
- `node --check` for fence, refresh-read, refresh, read-plan-ab and read-plan-bench entrypoints: passed.
- `node cloud-run/build.mjs --kernel-closure`: passed identity derivation only. Compute closure 082c5df84a25705e71bde3e33db921f384ef571e973085b604e4a25c5cb00f41, vendor 85e919a6f439ff351c37d5df373d2d7299dafa1d4cac2359de9b580f151d7241, 166 closure inputs. This changed prospective closure is unregistered; no registered bundle admission is claimed.

`git diff --quiet` against the base proved kernel-registry.json, pin.ts and the registry-check pins byte-for-byte unchanged. SHA256 respectively: b769c6be30884d69267f4d1dacd38ebec4fc1ab63a3e5c2e669b95e9b3bab00c, 22ced973452c490f681859665a14d51aa204615411ca0834ebe8b624cba786cd, 3e2e5a4cc0eb1947403b696dc6ce515501c7ae431e1e4cb7311b6d7c64e475ab. Kernels 1–5 remain preserved.

Logs: `/private/tmp/tibotattle-wave26-logs/`. Dependencies were cloned locally from frozen Wave25 with `cp -Rc`; no dirty-main links or edits. Candidate apparent footprint: 703 MiB, below the 1 GiB admission boundary.

Next dependency: exact READ-EXPANSION admission and order from coordinator, then MODEL-BLOCKS before canonical MODEL-RESIDUE generation. No PG/corpus imports, full suite, provider calls, cloud writes or pushes ran. Independent READ-PLAN PostgreSQL parity and later combined registration remain separate pending gates. TELEMETRY and offline L2 were not folded.

## READ-EXPANSION source fold

Admitted own commits f6e5422f1fdcc1527025fa8564a4c6882977d11a, 4d63d148e2893da30d0c3aca219c0dc761bc7ec5 and d38d1e9c519aaa1a83625d5a4f9aca3453c8972f became candidate 9e46b999, 9ea84176 and 4c76cbc5. Source checkout was clean at the exact admitted head. Copied READ-PLAN and stale measurement prerequisites were not replayed.

Package script-list conflicts were reconciled to retain both READ-PLAN and READ-EXPANSION syntax/test entrypoints and the real-boundaries suite. Static target validation caught and repaired a wrong real-boundaries path during reconciliation. Occurrence source auto-merged, but TypeScript exposed two byte-identical implementations of the shared selection-pair SQL helper. The owned semantic repair removes only the duplicate implementation, preserving the shared selection and grouped expansion paths. Both independent oracle suites remain; frozen oracle contents and hash are untouched.

Independent semantics review advised replacing the superseded READ-PLAN isolation assertion that expansion SQL must remain byte-identical. The combined contract now preserves the historical oracle SQL SHA256 and compares exact serialized occurrence and fingerprint Map bytes for active/staged correction runtimes, every fixture owner, all streams and boundary spans in one snapshot. Both readers must refuse maxCandidates=1 before any source expansion query. The independent expansion bounds, missing-dictionary, staged-index fallback, cancellation and error-precedence tests are retained. This strengthened combined test has passed syntax only; its real PostgreSQL gate awaits central resource admission.

Bounded Node.js 26.2.0 evidence: expansion A/B helper plus read/pool contracts, `node --test --test-concurrency=1 scripts/gcp-read-expansion-ab.check.mjs cloud-run/analytics-refresh-read.check.mjs cloud-run/analytics-refresh-pool.check.mjs`, 25/25 pass, zero skips. Worker `tsc --noEmit` passes after duplicate repair. `build.mjs --kernel-closure` derives prospective closure 1a8d3f7254c3353e88761c51f6b1cd1b3ca97f6f676c5848fd36a71d5a21447f, vendor unchanged, 166 inputs; no registration. Initial duplicate-function failures and corrected logs are retained in the local log directory.

Registry, pins and kernels 1–5 remain byte-for-byte unchanged; footprint remains 703 MiB. Stage1 GUC restoration and lane skip facts remain in the admitted lane receipt. The lane's full scripts wrapper is not claimed green: separately reproduced sampler race repair is pending separate admission. Wave25 completion receipts are expected evidence-only changes, as clarified by the coordinator; its exact executed source base remains cc447d55. Next source admissions are MODEL-BLOCKS, then canonical MODEL-RESIDUE, after this combined test contract is accepted. Full PostgreSQL parity/performance/serving admission remains pending.

## Composed reader qualification at 4b02094c

Independent semantics review accepted the exact combined contract at 4b02094c6672ead243a190f67a80b8e06a563d85. The candidate was frozen and clean throughout these gates. Root admitted one synthetic PG17.10 cluster on unused loopback port 55547 with C/C database collation, 128 MiB shared buffers, socket directory permissions 0700 and 2 GiB disk ceiling. Settings were verified directly; observed cluster peak remained below 650 MiB and host free disk stayed about 66 GiB, above the 20 GiB floor.

From `apps/worker/`, with `PG_TEST_HOST=127.0.0.1 PG_TEST_SOCKET=/private/tmp/tibotattle-pg-wave26-20261003/socket PG_TEST_PORT=55547`:

- `node --test --test-concurrency=1 --test-name-pattern='combined selection/expansion parity and candidate refusal' postgres-test/analytics-v2-read-plan.spec.mjs`: 1/1 passed, zero skips, 23.96 s.
- `node --test --test-concurrency=1 postgres-test/analytics-v2-read-plan.spec.mjs postgres-test/analytics-v2-occurrence-source.spec.mjs postgres-test/read-expansion-real-boundaries.spec.mjs`: 30 passed, zero failed, one expected optional A/B harness skip because READ_PLAN_AB_BASE_ROOT is unset, 355.21 s. Real legacy and v12 SQL 40000/40001 boundaries passed; both independent reader oracles, staged-index fallback, missing dictionary and error/cancellation contracts remained covered.

Logs `pg-combined-contract.log` and `pg-readers-composed.log` preserve exact results. No full corpus import ran. The owned cluster was stopped after qualification; no model folds occurred during the frozen reader gate. Future source changes must carry their own evidence scopes.
