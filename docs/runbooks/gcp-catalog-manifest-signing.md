---
title: GCP catalog manifest signing, key custody and rotation
date: 2026-10-02
type: runbook
status: draft
---

# GCP catalog manifest signing, key custody and rotation

> **Draft, owner-run.** Signing a catalog manifest is a protected operation
> (design `catalog-manifest-design-2026-10-02.md` §2.5, owner decision
> round 11). This runbook says how the owner signs, where the keys live, and
> how to rotate or recover them. It authorizes nothing: publishing a signed
> manifest, loading one into a store, and binding one into analytics are
> separate gated steps (KM-4 and the distribution step). Nothing here has
> signed a production manifest yet.

## What is pinned

The public halves are pinned in code, never in configuration or the
database, in `apps/worker/src/catalog-manifest-keys.ts`. Each pin carries the
key id, the standard base64 of the raw 32-byte Ed25519 public key, and the
SHA-256 fingerprint of those 32 bytes. `scripts/catalog-manifest.check.mjs`
proves every fingerprint and that no key or key id is shared between
channels.

| Channel | Slot | Key id | SHA-256 fingerprint (prefix) |
|---|---|---|---|
| production | current | `catalog-prod-2026a` | `a50e9d93…` |
| production | next | `catalog-prod-2026b` | `c6c5a025…` |
| staging | current | `catalog-staging-2026a` | `c2481329…` |
| staging | next | `catalog-staging-2026b` | `14d24304…` |

Pinning loads nothing. Until a signed manifest is deliberately loaded into
the store, every read serves the compiled baseline, stamped manifest version
1, which is what is served at cutover (round 7). Cutover serves the baseline
because no runtime code loads or reads the store: the one runtime importer
of `postgres-catalog-store` takes only `compiledBaselineCatalogManifest`.
An offline import ratchet in `scripts/catalog-manifest.check.mjs` keeps it
that way. It fails if any runtime source under `apps/worker` imports
anything else from the store (the loader, the pin writer or the read APIs),
or reaches it through an alias, a namespace, default, side-effect, dynamic
or `require` import, or a re-export. A module specifier computed at run
time is beyond a text check; review covers that. KM-4 widens the ratchet's
allowlist on purpose. The PostgreSQL spec proves an empty store under the
real pins serves the compiled baseline.

## Custody

- The four private keys exist only in the owner's macOS login Keychain, as
  services `codex-secret-tibotattle-<keyId>`, generated on 2026-10-02.
- They are reached only through the `secret` helper, which sets one
  environment variable for one process:
  `secret run tibotattle-<keyId> --env TIBOTATTLE_CATALOG_SIGNING_KEY -- <command>`.
- They are never in CI, never in GCP Secret Manager, never in the repository,
  an image, a log, a receipt or a command-line argument.
- There is no other backup. The `next` slot is the loss and rotation path.
- `catalog-manifest.mjs sign` refuses to run when a CI, hosted-runner or
  Google Cloud build or run environment is detected
  (`CATALOG_TOOL_SIGNING_REFUSED_IN_CI`), before it reads any key.

## Sign and verify

Run from the repository root, with output files in a private scratch
directory outside the repository. `<channel>` is `production` or `staging`.

1. Build the canonical payload from the reviewed data file:
   `node apps/worker/scripts/catalog-manifest.mjs build --data <data file> --out <dir>/payload.json`
   (add `--previous <dir>/previous-payload.json` for any version after 1).
2. Sign with the slot's key (default `current`):
   `secret run tibotattle-<keyId> --env TIBOTATTLE_CATALOG_SIGNING_KEY -- node apps/worker/scripts/catalog-manifest.mjs sign --payload <dir>/payload.json --channel <channel> [--slot next] --out <dir>/envelope.json`
   The tool accepts the key as base64 PKCS#8 DER, a PKCS#8 PEM block or the
   base64 raw 32-byte seed. It refuses a key whose public half is not the
   pinned key for that channel and slot
   (`CATALOG_TOOL_SIGNING_KEY_NOT_PINNED`), verifies the envelope exactly as
   the server does, and only then writes it. Its receipt names the channel,
   slot, key id, `secret` helper name, public key and payload digest; it
   never carries key material.
3. Verify against the code pins, without the key:
   `node apps/worker/scripts/catalog-manifest.mjs verify --envelope <dir>/envelope.json --channel <channel>`

A staging envelope never verifies on the production channel, because no key
or key id is shared.

## Rotate

Rotation uses the slot that is already pinned, so it needs no flag day.

1. Sign the next manifest version with `--slot next`. Every consumer already
   trusts that key.
2. In one reviewed change, move the `next` pin to `current`, have the owner
   generate a new pair straight into the Keychain through the `secret`
   helper (service `codex-secret-tibotattle-<new keyId>`), and pin its
   public half, with its fingerprint, as the new `next`. Update the expected
   key ids in `scripts/catalog-manifest.check.mjs`.
3. Keep the retiring key pinned while the store's served manifest, its head,
   or any `pinned` or `frozen` version was signed by it. The store
   re-verifies stored rows on read and before every append, so unpinning a key
   makes the manifests it signed unservable (`CATALOG_STORE_KEY_UNTRUSTED`).
   The cutover `compiled_registry` analytics binding reports that fault
   instead of stopping.

## Compromise or loss

- **Compromised key.** Ship a server (and, once clients read manifests, an
  app) update that unpins the key, and sign corrective manifests with the
  other pinned key of that channel. A successor must be exactly the held
  version plus one and must name the held digest, so a stolen key cannot jump
  the version. Limit: if a store's head was signed by the unpinned key, the
  loader refuses to append after it (`CATALOG_STORE_KEY_UNTRUSTED`), so that
  store needs a reviewed recovery procedure, which is not built (KM-CORE
  receipt, "Key revocation"). Until a manifest has been loaded, unpinning
  costs nothing: every store serves the compiled baseline.
- **Lost key** (Keychain item gone). Sign with the other slot of the channel,
  then rotate as above to restore two usable keys.
- A hardware- or KMS-backed key with an approval gate is the later option
  (KA-3); it is not built, and Ed25519 support in Cloud KMS for this project
  is not verified.
