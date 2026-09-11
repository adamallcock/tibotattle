# Identity-core package guidance

Scope: all files under `packages/identity-core/`. Apply the repository root
guidance first.

## Contract

- This package derives deterministic pseudonyms from an explicit secret, domain,
  version, and source identity. It does not discover accounts, store secrets,
  access Keychain/Credential Manager, or decide consent.
- Keep domains purpose-separated. Export, account, participant, device, session,
  and event identifiers must not become interchangeable or joinable merely
  because they share a primitive.
- Never accept or emit a raw name, email, provider account ID, credential, path,
  or arbitrary metadata as a public pseudonym artifact.
- A derivation version, domain label, canonical input, output encoding, or length
  change breaks durable continuity. Require explicit migration/rotation semantics
  and coordinated local, prepared-data, Worker, and deletion review.
- Rotation changes future linkability and does not rewrite existing artifacts.
  Keep that lifecycle decision outside this pure package.

## Package and validation discipline

- Keep the implementation deterministic, side-effect free, runtime neutral, and
  dependent only on explicit inputs and reviewed cryptographic primitives.
- Validate exact input types and bounds. Do not normalize ambiguous identifiers or
  introduce an insecure fallback when a secret or crypto capability is absent.
- Export only through the package root with matching declarations. Do not expose
  key material, intermediate MAC state, or internal domain construction.
- Add fixed-vector, domain-separation, version-separation, malformed-input, and
  collision-resistance boundary tests for affected behavior.
- Run focused package/identity tests, then `npm test` and
  `npm run architecture:check` for public or dependency changes. Add local and
  Worker gates when continuity crosses those surfaces.
