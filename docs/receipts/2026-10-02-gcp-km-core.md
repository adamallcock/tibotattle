---
title: GCP KM-CORE catalog manifest contract, signing step and server store
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP KM-CORE catalog manifest contract, signing step and server store

This is a 2026-10-02 receipt for branch `claude/gcp-fp-km-core`, built on
`1bea3b5f` (`claude/gcp-fastpath-final`). It records **local, synthetic**
evidence only: one macOS arm64 workstation, Node 26.2.0, vitest 4.1.11 and the
local PostgreSQL 17 fan-out cluster on a private Unix socket. No Cloudflare or
Google Cloud resource was read or written, no Wrangler or gcloud command ran,
nothing was pushed, and no production data was used. Every signing key is a
synthetic Ed25519 key generated at test time; every fixture is synthetic. It
is not merged. It was updated the same day for review round 1 (see "Review
round 1"); the gates below are the post-review run.

## Scope

KM-1, KM-2 and KM-3 of the catalog manifest design
(`design/catalog-manifest-design-2026-10-02.md`), with the wave-5 cross-check
overrides and the owner's round 7 answers applied:

| Item | Delivered |
|---|---|
| KM-1 contract | Closed manifest schema `tibotattle-catalog-manifest-v1`, validators, canonical bytes, append-only successor rules, token guard |
| KM-1 baseline | Version 1 projected from the d43c8f92 compiled registry, catalog, plan roster and Fast assumption; byte-identical pricing proven |
| KM-1 invariant | Root `AGENTS.md` and `packages/telemetry-contract/AGENTS.md` amended, decision record, guidance test |
| KM-2 | Envelope `catalog-envelope-v1`, Ed25519 over a domain-separated message, pinned key slots, build-and-sign step with the key referenced by name |
| KM-3 | Staged primary migration, verifying loader, append-only pin log, read APIs for intake pricing and analytics, PostgreSQL 17 spec |

## What landed

### Contract (`apps/worker/src/catalog-manifest.ts`)

- **Schema.** Exact top-level keys: integer `version`, `previousVersion`,
  `previousDigest` (the hash chain), `publishedAt`, `activateAt`,
  `projectedFromCommit`, `compat` (registry version, observation instant,
  registry SHA, catalog version), `normalization`, `assertions`, `providers`,
  `models`, `priceCards`, `retractions`, `speeds`, `tiers`, `plans`. Price
  cards are validated closed (keys, decimal strings, https evidence URLs,
  provenance consistency, a per-card context boundary instead of the
  model-name branch, short/long pairing, no overlap in one pricing context,
  no alias claiming a second model). Models resolve their price references to
  a card that names them.
- **Token guard** `catalog-token-guard-v1` is exactly the wire grammar
  `[A-Za-z0-9._:-]`, 1 to 64 characters, case preserved, nothing else refused
  (round 7). `guardCatalogToken` returns a plain-text token, `unrecognized` or
  `missing`. Inside a manifest an out-of-grammar token is refused
  (`CATALOG_TOKEN_OUT_OF_GRAMMAR`).
- **Canonical bytes** are `JSON.stringify` with the given key order; a
  payload must round-trip exactly (no whitespace, duplicates or non-canonical
  escapes). Key order is preserved, not sorted, because the compiled registry
  SHA is `sha256(JSON.stringify(cards))` in insertion order.
- **Append-only.** A successor is exactly version + 1, names the held digest,
  carries every provider, speed, tier, model core, plan id, card (identical
  bytes) and retraction; new retractions belong to the new version; neither
  `publishedAt` nor `activateAt` moves backwards.
- **Adapters, not crypto.** Validators take an injected digest and signature
  verifier (the cross-check's package rule); WebCrypto defaults are separate
  exports. The module has no imports.
- **Plans** carry `{id, label}` only. The design's `nominalMultiplier` was
  dropped: the cross-check found the kernels do consume a plan table, so a
  manifest value could only be a second source. The compiled roster bounds
  `plans` (`assertCatalogCompiledAssertions`); `assertions` carries
  `fastModeAssumedMultiplier` as a compiled-equality check.

### Baseline (version 1) and the byte-identity proof

- `apps/worker/catalog/manifest-0001.json` is the one reviewed data file:
  generator-owned, two-space JSON, 642,781 bytes; canonical payload 436,922
  bytes, digest `da55288b83bbc6d012a3c087dc82db05000dfaa9c4570e73c0a74d279deec941`
  (pinned as `CATALOG_BASELINE_DIGEST`). Its instants are the compiled
  `APP_PRICE_REGISTRY_OBSERVED_AT`.
- Proof that pricing from it is byte-identical to the compiled registry:
  1. its `priceCards` serialize to exactly `JSON.stringify` of the compiled
     178 cards, and `sha256` of them reproduces the compiled
     `APP_PRICE_REGISTRY_SHA256` `48119389…63b9` (check and spec);
  2. the vendored d43c8f92 modules and the Worker's installed packages both
     project to the committed file (spec and `catalog-manifest.mjs check`);
  3. after a signed round trip, `priceUsageEvent` over every card, every
     model and alias, each effective boundary plus fixed days, both band
     edges and a synthetic unseen model gives identical JSON for manifest and
     compiled cards (more than 1,500 events, more than 1,000 priced; vitest);
  4. on PostgreSQL 17, the cards the read API returns after loading the
     signed baseline price a second sweep identically (PG spec);
  5. the manifest's speed rules equal what `priceTelemetryUsageEvent` does
     for every listed speed (vitest).

### Signing step (`apps/worker/scripts/catalog-manifest.mjs`, KM-2)

- `check`, `write`, `build` (canonical payload from the data file, with
  continuity against `--previous` for later versions), `sign`, `verify`.
- The private key is referenced by name only
  (`src/catalog-manifest-keys.ts` `CATALOG_SIGNING_KEY_REFERENCES`: a Secret
  Manager secret name and an environment variable name). The step that runs
  `sign` resolves the secret into that variable for one process; the key is
  never written, printed or passed as an argument (checked against output).
- Pinned public keys (`CATALOG_PINNED_KEYS`) have `current` and `next` slots
  per channel and are **empty**: the owner has not generated keys. Every load
  therefore refuses with `CATALOG_KEY_UNTRUSTED` and the read APIs serve the
  compiled baseline, which is the round 7 cutover state.
- npm scripts in `apps/worker/package.json`: `catalog:manifest:check` (added
  to the Worker `check` chain) and `catalog:manifest:sign`.

### Store (`*_catalog_manifest_store.sql`, `src/postgres-catalog-store.ts`, KM-3)

- Staged primary migration `0066_catalog_manifest_store.sql` (placeholder
  number, contiguous after C-IPR's staged `0065`): `catalog_manifests`,
  `catalog_cards` (integer `card_no`), `catalog_card_retractions`,
  `catalog_pin_events`. Content-free, no owner or participant column, so no
  FC-11 erasure inventory applies. Purely additive (no contract operation).
- The database enforces what it can: version 1 first then exactly held + 1
  naming the held digest and never activating before it (trigger), payload
  digest and fields equal the row (CHECK over the decoded payload), wire
  grammar on card tokens, card and retraction rows written only under the
  head version (trigger), and no UPDATE, DELETE or TRUNCATE on any catalog
  table.
- **Loader** verifies signature, schema, canonical bytes and registry SHA,
  then the compiled assertions, then, under one lock over the manifest, card
  and retraction tables, continuity against the held head, which it
  re-verifies, and that the derived vocabulary is exactly the projection of
  that head (see "Review round 1"). Version 1 must equal
  `CATALOG_BASELINE_DIGEST`. Identical reloads are no-ops; a different
  manifest for a loaded version is `CATALOG_VERSION_CONFLICT`.
- **Read APIs** are bootstrap reads: each call fetches and re-verifies the
  full envelope. `readCatalogPricingRegistry` (intake) returns the pinned,
  active, re-verified version's active cards, or the compiled baseline
  stamped version 1 when there is no table, no load or nothing active, and
  fails closed on a table fault. `readCatalogForAnalytics` defaults to
  `compiled_registry`: it stamps manifest version 1 and binds nothing
  whatever the table holds (kernels stay compiled at cutover), refuses a
  `frozen` pin on any other version, and treats the table as report-only
  (`tableFault`). The `manifest` binding (KM-4, post-cutover) stamps and
  returns the pinned manifest and fails closed. A tampered stored row is
  `CATALOG_STORE_TAMPERED` and a row whose key is not pinned is
  `CATALOG_STORE_KEY_UNTRUSTED`, never a silent fallback.
- **Pin** is an append-only event log: `latest_verified` (highest active),
  `pinned` and `frozen`, with closed reason codes.

### Invariant amendment

The root `AGENTS.md` raw-account-identifier invariant now states, in two
normally wrapped lines, that model, provider, speed, tier and plan names in
the wire grammar are vocabulary, not account IDs, and points at
`docs/decisions/2026-10-02-catalog-vocabulary-plain-text.md`, which carries
the exact grammar and the `unrecognized` rule. To keep the root file under
200 lines (199), two dangling one-word continuation lines elsewhere were
tightened without changing their meaning ("separate gates; one never proves
another", "a dry run never authorizes a write").
`packages/telemetry-contract/AGENTS.md` states the grammar and keeps the
current client policy until the client change ships. The decision record is
indexed in `docs/README.md`; `test/agent-guidance.test.js` pins the root
wording, the pointer, and the grammar and `unrecognized` rule in the record.
The privacy page and in-app notice are not changed here (round 5 places them
in the next client release).

## Deviations from the design, and why

1. **The contract lives in `apps/worker/src`, not in the packages.** The GCP
   line holds `packages/*` at the d43c8f92 bytes: the IN-3 oracle
   (`postgres-test/postgres-legacy-contribution-admission.spec.mjs` with
   `fixtures/legacy-contribution-oracle-blobs.json`) pins the Worker's
   installed `@app-usagemonitor/{accounting,telemetry-contract}/index.js` to
   their d43c8f92 blobs, and both packages export only through `index.js`.
   Exporting new modules would change those blobs. The modules are import-free
   and adapter-injected so they can move into the packages unchanged when
   the client track (KC-1/KC-2) is allowed to move package bytes.
2. **Version steps are contiguous** (+1), stricter than the design's +1000
   client bound.
3. **No `catalog_entries`, `catalog_tokens` or `catalog_unseen_values`.** The
   brief scoped the store to manifest versions and cards; KM-6 is dropped by
   round 7 (unseen-name counts belong to analytics), and K-STAMP/K-PERCARD own
   the integer key tables.
4. **CI signs only if the owner wires it.** The design said CI never signs;
   the brief asks for a CI build-and-sign step with the key in Secret Manager
   or owner custody. The step exists and takes the key by name; no GitHub
   workflow job, Secret Manager secret or OIDC binding was created (protected
   operations).

## Review round 1 (2026-10-02)

Five findings were verified against the committed `58b711e0`; all five held
and none was rejected. Each new negative test was run against the `58b711e0`
store, contract and migration first and failed there (the forged-row loads
returned `NO_ERROR`, the early-activating successor was accepted, and the
cutover analytics read threw), then passed on the fix.

| # | Finding | Verified | Fix |
|---|---|---|---|
| 1 (medium) | The loader skipped already-known card ids without comparing them, so `catalog_cards` (and retractions) could disagree with the signed chain | Yes: `if (knownIds.has(card.id)) continue;`, and the runtime grant gives INSERT on every table | Under one lock over the three tables, the loader requires the vocabulary to be exactly the projection of the re-verified head: the same card ids with the same digest, provider, model and tier, `first_version` between 1 and the head version and non-decreasing in `card_no` (load) order, and the same retractions (`retracted_in`, `reason`); otherwise `CATALOG_STORE_TAMPERED`. A new trigger lets card and retraction rows be written only under the head version, so a row can never claim an older version than it was written under; together with the check at every load this keeps `first_version` exact by induction. A retraction insert that touches no row is also refused. PG17 negatives: the reported forged row, a forged row with the true bytes written ahead of its manifest, a forged older `first_version`, an edited card row, a forged retraction (which previously would have broken the legitimate load on the `card_no` key), a forged older `retracted_in`, and an edited retraction reason |
| 2 (medium) | The cutover `compiled_registry` binding resolved the table first, so a table fault stopped a run that binds nothing from it | Yes: `resolveCatalog` ran before the binding branch; the spec asserted the throw | In `compiled_registry` mode the frozen-pin check still runs first and still refuses; the table is then report-only: `CATALOG_STORE_TAMPERED`, `CATALOG_STORE_KEY_UNTRUSTED` or `CATALOG_PIN_NOT_ACTIVE` is returned as `tableFault` with null table fields and stamp 1. Database errors and invalid arguments still throw. The `manifest` binding and the intake read still fail closed. A stored row whose key is not pinned is now `CATALOG_STORE_KEY_UNTRUSTED` rather than `CATALOG_STORE_TAMPERED`, and a malformed pinned-key list is `CATALOG_STORE_ARGUMENT_INVALID`. This follows the cross-check's "stamped but not bound" rule and the design's "keep the current manifest" rule |
| 3 (low) | A successor could declare an earlier `activateAt` and carry a pending predecessor live early | Yes: only `publishedAt` was ordered | `assertCatalogManifestSuccessor` requires `next.activateAt >= held.activateAt` (`CATALOG_NOT_APPEND_ONLY`, path `activateAt`), and the continuity trigger raises `catalog_manifests_activation_regression`. Vitest and PG17 negatives, plus a positive "activate together" case |
| 4 (low) | The read APIs re-verify the full envelope on every call | Yes: measured locally on this branch, 10.8 ms mean over 50 calls for a 582,740-byte baseline envelope | Documented as bootstrap reads in the module header and on `readCatalogPricingRegistry`: once per analytics run, or once per pin re-read interval with the result held in memory (design §5.3), never per request. No caller exists yet; no cache was added |
| 5 (low) | Root `AGENTS.md` was exactly 200 lines against its own "under 200 lines" rule, via one 205-character line | Yes | The carve-out is now a two-line pointer to the decision record; two dangling continuation lines elsewhere were tightened; the file is 199 lines. The guidance test still enforces `<= 200` while the prose says "under 200"; that pre-existing mismatch is left for the guidance owners |

## Gates run (all on this branch, local)

| Command | Result |
|---|---|
| `node --test ./scripts/catalog-manifest.check.mjs` (apps/worker) | 5 of 5 pass |
| `node ./scripts/catalog-manifest.mjs check` | ok, digest `da55288b…c941` |
| `npx vitest run test/catalog-manifest.spec.ts` | 15 of 15 pass |
| `PG_TEST_SOCKET=… PG_TEST_PORT=55433 node --test postgres-test/catalog-manifest-store.spec.mjs` | 10 of 10 pass; no `km_core_` schema left (counted afterwards) |
| the same spec and the vitest spec against the `58b711e0` store, contract and migration (new tests only, restored afterwards) | the five changed or new PG tests (including the migration function list) and the new vitest test fail, as intended |
| `npx tsc --noEmit` (apps/worker) | pass |
| `npm run postgres:migrations:check`, `npm run vendor:kernels:check` | 10 of 10; pass |
| `node scripts/ci-postgres-suite.mjs --plan`; `node --test scripts/ci-postgres-suite.check.mjs scripts/migration-numbering.check.mjs` | spec routed, no failures; 50 of 50 |
| `node scripts/cloud-run-build-context.mjs --check` | pass |
| root `npm run architecture:check` | pass (946 files) |
| root `npm run test:preflight` | pass (exit 0) |
| root `node --test test/agent-guidance.test.js`; `npm run docs:check` | 7 of 7; valid (322 Markdown files); root `AGENTS.md` 199 lines |
| full Worker `npx vitest run` | 2,378 of 2,379 pass, 178 of 179 files. The one failure, `storage-graph-history-integration.spec.ts` "folds mixed v1 and v1.1 evidence…", also fails on the unmodified base `1bea3b5f` (checked in round 0 in a temporary detached worktree, since removed) |

Environment gap, not a product result: `npm run workspace-packages:guard`
reports `ACCOUNTING_PACKAGE_STALE` in this worktree and identically in the
read-only `fp/FINAL` worktree (APFS-cloned `node_modules`); no package file
changed here except `packages/telemetry-contract/AGENTS.md`, which is not in
the package's published `files`.

## Open gates and owner actions

- **Keys.** The owner generates the production and staging Ed25519 keys in
  custody or Secret Manager, and a reviewed change pins the public halves.
  Until then nothing loads, by design.
- **Key revocation.** A held manifest is re-verified on every read and before
  every append, so removing a key from the pins makes every manifest it
  signed unservable (`CATALOG_STORE_KEY_UNTRUSTED` for intake pricing and the
  `manifest` binding) and blocks appending to them. The cutover
  `compiled_registry` analytics binding keeps running and reports the fault.
  Rotation must keep the old key in the `next` slot until a successor exists;
  recovering from a compromised key needs a reviewed procedure (KA-3).
- **Staged activation and hotfixes.** Activation now never moves backwards
  along the chain. While a manifest is pending, a corrective successor cannot
  go live before it, because it carries the pending content. A hotfix for a
  pending manifest's mistake activates with or after it and, being the higher
  version, is what `latest_verified` serves from that moment; to keep the
  pending content from ever going live, the operator pins an earlier version.
- **The first `card_no` reader.** No read API serves `catalog_cards` yet.
  The loader proves the vocabulary at every load; rows written outside the
  loader after the last load are caught at the next load. K-PERCARD, the
  first reader, should reuse the same check (`assertVocabularyIsHeadProjection`
  in `src/postgres-catalog-store.ts`, exported then) rather than trust the
  table between loads.
- **Bootstrap reads.** The read APIs cost about 11 ms of CPU and the full
  envelope per call. Callers hold the result per run or per pin interval;
  a request-path caller needs a cache keyed by version, digest and key id.
- **Integration.** Promote and number the staged migration after K-STAMP's,
  regenerate `src/postgres-runtime-schema.ts`, move the build-context count
  and tail pins. Wire the loader into the refresh or an ops job (KM-4 owns
  `analytics-refresh.mjs` and `build.mjs`). Intake is not switched: KM-6 is
  dropped and v1.x intake prices nothing.
- **Not done here:** KM-4 kernel binding, KM-5 stamps, KM-7 website metadata,
  the client track, the GitHub workflow job, and the privacy wording.
- **Re-vendoring at P** must re-project the baseline as a successor version;
  the spec fails if the compiled registry stops projecting to
  `CATALOG_BASELINE_DIGEST`.
