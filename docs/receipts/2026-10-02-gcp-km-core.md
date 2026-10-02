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
is not merged.

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
  bytes) and retraction; new retractions belong to the new version.
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
  naming the held digest (trigger), payload digest and fields equal the row
  (CHECK over the decoded payload), wire grammar on card tokens, and no
  UPDATE, DELETE or TRUNCATE on any catalog table.
- **Loader** verifies signature, schema, canonical bytes and registry SHA,
  then the compiled assertions, then (under a table lock) continuity against
  the held head, which it re-verifies. Version 1 must equal
  `CATALOG_BASELINE_DIGEST`. Identical reloads are no-ops; a different
  manifest for a loaded version is `CATALOG_VERSION_CONFLICT`.
- **Read APIs.** `readCatalogPricingRegistry` (intake) returns the pinned,
  active, re-verified version's active cards, or the compiled baseline
  stamped version 1 when there is no table, no load or nothing active.
  `readCatalogForAnalytics` defaults to `compiled_registry`: it stamps
  manifest version 1 and binds nothing whatever the table holds (kernels stay
  compiled at cutover), reports the table version, and refuses a `frozen` pin
  on any other version. The `manifest` binding (KM-4, post-cutover) stamps and
  returns the pinned manifest. A tampered stored row is
  `CATALOG_STORE_TAMPERED`, never a silent fallback.
- **Pin** is an append-only event log: `latest_verified` (highest active),
  `pinned` and `frozen`, with closed reason codes.

### Invariant amendment

The root `AGENTS.md` raw-account-identifier invariant now states that model,
provider, speed, tier and plan names are vocabulary, plain text inside the
wire grammar, else `unrecognized`; `packages/telemetry-contract/AGENTS.md`
says the same and keeps the current client policy until the client change
ships. `docs/decisions/2026-10-02-catalog-vocabulary-plain-text.md` records
the decision (indexed in `docs/README.md`); `test/agent-guidance.test.js`
pins the wording. The privacy page and in-app notice are not changed here
(round 5 places them in the next client release).

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

## Gates run (all on this branch, local)

| Command | Result |
|---|---|
| `node --test ./scripts/catalog-manifest.check.mjs` (apps/worker) | 5 of 5 pass |
| `node ./scripts/catalog-manifest.mjs check` | ok, digest `da55288b…c941` |
| `npx vitest run test/catalog-manifest.spec.ts` | 14 of 14 pass |
| `PG_TEST_SOCKET=… PG_TEST_PORT=55433 node --test postgres-test/catalog-manifest-store.spec.mjs` | 8 of 8 pass; no `km_core_` schema left |
| `npx tsc --noEmit` (apps/worker) | pass |
| `npm run postgres:migrations:check`, `npm run vendor:kernels:check` | pass |
| `node scripts/ci-postgres-suite.mjs --plan`; `node --test scripts/ci-postgres-suite.check.mjs scripts/migration-numbering.check.mjs` | spec routed, 50 of 50 |
| `node scripts/cloud-run-build-context.mjs --check` | pass |
| root `npm run architecture:check` | pass (946 files) |
| root `npm run test:preflight` | pass |
| root `node --test test/agent-guidance.test.js`; `npm run docs:check` | 7 of 7; valid |
| full Worker `npx vitest run` | 2,376 of 2,378 pass, 177 of 179 files. The two failures are outside this change: `storage-community-graph-publication.spec.ts` (a statement-meter measurement) passed when rerun alone; `storage-graph-history-integration.spec.ts` "folds mixed v1 and v1.1 evidence…" fails identically on the unmodified base `1bea3b5f` in a temporary detached worktree, since removed |

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
  signed unreadable and blocks appending to them. Rotation must keep the old
  key in the `next` slot until a successor exists; recovering from a
  compromised key needs a reviewed procedure (KA-3).
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
