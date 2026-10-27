---
title: Server daily-value validation parity
date: 2026-10-27
type: review
status: source-qualified-hosted-pending
---

The server kernel 23 candidate preserves the bounded synthetic refresh outputs
of kernel 22. This records local source qualification of the two daily-value
validation optimizations, not hosted CI, image, deployment or production
performance qualification. The candidate was an uncommitted source snapshot
when measured; its complete source-file manifest SHA-256 is
`b7ce0dcf0139dd9b275c66943f26de4c28948f97d8fc0bf2fb9c536c920587d9`.

The [vendor generator](../../apps/worker/scripts/vendor-analytics-kernels.mjs)
remains the authoring authority. Both source patches were applied through its
explicit source commit `76179fd4f21816693e958e436d3c84fd8555da60`; generated
files were not edited by hand. Exact key-set matches avoid sorting, while the
original comparison remains the mismatch fallback, preserving historical NUL
collisions and a single `Object.keys` snapshot. Only the primitive string `0`
short-circuits decimal parsing; other values retain their original validation.
The generator checks independently pin and reverse both patches.

## Source identities

The immutable baseline is server commit
`552a90b02533de4579a199f4f356b2588d66c809`, kernel 22. Both kernels retain
229 closure inputs, the same vendor source commit, method
`analytics-v2-method-v2`, price registry `app-official-api-prices-v0.10` and
price-registry SHA-256
`206544769b43e4b9645284258edd38f7c07a226022db10f5ec0181335df236ab`.

| Identity | Kernel 22 | Kernel 23 |
|---|---|---|
| Compute closure SHA-256 | `ae37ef5e394a1840651da0d6e0d70f15b8643ccba23619c11bb158807f61c366` | `18a4a04211b7ae328edb92dab64c6e4b6f77c6f8c0095f9fd461a2dea67ef608` |
| Vendor manifest SHA-256 | `8aff8f41794a096c6688303aa79e62478380046634fa9a678425a4605db9e37c` | `96fcec084a7ce7b62db1bfbb67fbfa1ddeb9c2f1bf8321926ff1e51814604022` |

The independently derived kernel-23 registry pin is
`340b9dab35a63d6c7baaf25b3f5ecde8d5ef683bedf3db2c30c423146a3b6273`.
All 22 preceding registry entries and pins are unchanged. The pure-pricer
identity is unchanged:
`e0aacef2f6f296ed996d78c8a886bda56a8ff63cf890f805a592418270f24c42`.
All 79 primary migrations, golden fixtures and operator contracts are unchanged.

## Paired refresh evidence

Each source snapshot was built through the canonical Cloud Run builder. The
existing [direct-seed fixture](../../apps/worker/postgres-test/fixtures/analytics-v2/direct-seed.mjs)
then ran through the actual refresh readers, compute, performance-stage
composition, store and community-daily route handler. Execution used Node
22.16.0 and an isolated PostgreSQL 17.11 cluster with TCP disabled. Both
variants applied the same 79 migrations and completed two refreshes: four
owners, four owner-days, ten refusals and two blocked days per run. The first
refresh published one day; the repeated refresh published none.

Every analytics data table was discovered from the database catalog: 29 tables
per run, including 16 populated tables, with 616 then 617 rows. All 58 paired
snapshots preserve every column, type, count and complete database-canonical
row text. Thirty snapshots match raw bytes; the other 28 match after closed,
validated substitutions for the current kernel and code identities. Run
compatibility digests are independently recomputed from the unchanged recorded
resource settings. Pricing identities are checked against the actual build and
class formula. No value columns, numeric spellings or row ordering are removed,
and no production digest policy is changed.

All four actual route-handler responses have status 200, identical headers and
identical 1,247-byte bodies, SHA-256
`526a62f683d4fd22ae482ed8eda6e3c477b080fb160e41577c08d6fd6dad9f4d`.
These are source `Request`/`Response` invocations, not live HTTP observations.
Five negative controls reject a missing table, missing column, changed usage
value, unexpected kernel identity and invalid compatibility digest.

Existing operational-only injection points fix job/compute clocks, run UUIDs
and the compute memory probe. All persisted timing/resource columns remain in
the comparison; separate raw receipts retain actual wall time, CPU and process
memory. The first baseline harness attempt correctly returned
`PUBLICATION_DISABLED` because its synthetic control was disabled. It remains
preserved; the completed successor uses a new database and the owning route
fixture's explicit publication-control setup. No product guard was changed.

After both runs, all 3,571 baseline and 3,573 candidate source files, both sets
of 13 canonical bundles and both fixture bundles matched their sealed hashes.
The stopped local cluster and 170 hash-indexed proof artifacts are retained
privately. Paired capture SHA-256:
`f2367b34cc216dab0c1b1915e24cdca2f22d98b4b0c0c6a5669fa060468b0c9c`;
complete table-comparison receipt SHA-256:
`b576d3dc563ade099ecb8d30223657d7cc94b04e6f4c9cacd0eba546eadd5593`.

## Validation and remaining gates

- `npm run vendor:kernels:check`: 59 passed, including blob identity, patch
  reversal and deterministic generator round-trip checks.
- Registry and pricing-class checks: 19 passed.
- Five focused analytics files: 57 passed, covering the nine immutable-source
  shape/decimal cases, source-patch cases, all 15 model-era cases, seven existing
  native-parity kernel cases and ten copied daily-value cases. The original
  900-record fold and every prefix comparison remain unchanged.
- `node build.mjs --check` and Worker `npm run typecheck`: passed.

No product or test limit, population, fixture expectation or skip was weakened.
The bounded paired fixture is not exhaustive population or performance proof.
The final source still requires the complete hosted parallel Worker/PostgreSQL
qualification, then fresh source-bound production preflight and immutable image
evidence before any rollout. Existing kernel-22 operational receipts remain
predecessor evidence.
