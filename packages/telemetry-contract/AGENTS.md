# Telemetry contract guidance

Scope: all files under `packages/telemetry-contract/` and the contract artifacts
generated from them. Apply the repository root guidance first.

## Privacy and schema contract

- Telemetry is a fresh allowlist, not redacted raw input. Every exported field
  needs a purpose, bounded shape, privacy classification, and compatibility
  consequence.
- Keep object schemas closed and recursively reject prompt/response content,
  commands, URLs, paths, credentials, raw account/scope identifiers, arbitrary
  metadata, and unbounded text in both keys and values.
- Unknown upstream fields are omitted. Unknown model values follow the current
  fingerprint/unknown policy; they are not exported as convenient free text.
- Privacy contracts are versioned. Do not broaden, rename, pseudonymize, or remove
  a field ad hoc, even when a change appears more private: consent, clients,
  Worker validation, stored data, deletion, and migration may depend on its exact
  meaning.
- The narrowly UUID-shaped provider `sessionUuid` permitted by the current
  telemetry-v1 contract is a deliberate contract field, not permission for raw
  session identifiers generally. Any change requires coordinated end-to-end
  compatibility and consent review.

## Canonical sources and mirrors

- Change the canonical package schemas/normalizers first. Regenerate root schema,
  browser, and upload mirrors through their owning scripts; never patch mirrors or
  generated compatibility dictionaries directly.
- Keep runtime validation, JSON Schema, TypeScript declarations, canonicalization,
  fixture builders, field policy, contract status, and consent status aligned.
- Preserve deterministic canonical bytes, exact enumerable keys, size/resource
  ceilings, version tuples, and safe bounded error output.
- A draft, frozen, consented, uploadable, accepted, or retired contract state is a
  machine-checkable gate. Do not infer authorization from code presence.

## Validation

- Run focused package and privacy-canary tests while iterating.
- Run `npm run telemetry:check`, `npm run telemetry:browser:check`, and
  `npm run telemetry:upload-schemas:check` for contract changes. Use the matching
  generation commands only when canonical sources intentionally changed.
- Run `npm run product:worker:check` when package exports, schemas, or installed
  contents change; the Worker guards an independent npm-installed copy.
- Add negative cases for nested forbidden keys/values, extra properties, bounds,
  version mismatch, and unsafe validation errors.
- Treat compatibility, consent, migration, deletion, and already-prepared local
  data as part of acceptance. Schema tests alone do not complete a contract
  change.
