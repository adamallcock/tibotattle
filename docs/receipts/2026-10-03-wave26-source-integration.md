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
