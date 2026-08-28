# Repository script guidance

Scope: all files under `scripts/`. Apply the repository root guidance first.

## Tooling boundary

- Scripts are one-way entrypoints into product libraries, build systems,
  verification, generation, or protected operations. Production code must never
  import them.
- Keep command behavior explicit, deterministic, non-interactive where practical,
  and fail-closed. Separate inspection, planning, dry run, mutation, publication,
  and recovery into distinguishable modes.
- Default to no external write and no destructive local change. Require explicit
  flags, exact targets, preflight evidence, and environment identity for higher
  consequence modes; do not infer permission from credentials being available.
- Validate paths, owners, file types, symlinks/hardlinks, permissions, expected
  hashes, versions, and no-clobber conditions before mutation. Use staging,
  fsync/atomic rename, journals, and recovery where partial execution matters.
- Keep output bounded and content-free. Never print secret values, private paths,
  raw session data, identities, signing material, or payload rows.

## Generators and builds

- A generator has one canonical input, deterministic output, a check mode, and
  exact-set/provenance validation. Change generator and generated outputs
  together; never make the generated file the source of truth.
- Pin downloaded build inputs by version and digest, verify before use, and reuse
  only verified caches. A network fetch is an environment action, not evidence
  that a release dependency is generally available.
- Keep developer, test, preview, candidate, release, and publication profiles
  distinct. Build scripts must refuse incompatible runtimes, identities, channels,
  endpoints, entitlements, or output paths.
- Public-release-site builds must explicitly exclude local dashboard/runtime
  assets and expose only claims supported by the selected release manifest.
- A release script should produce exact local evidence before any external
  publication and must never hide a missing signing, provenance, SBOM, previous
  version, or live verification gate.

## Protected operations

- Deployment, remote migration, signing, notarization, app installation, appcast
  or website publication, release creation, store submission, live experiments,
  and R7 regeneration require explicit authorization and their current runbook.
- Do not combine an authorized local build or dry run with a protected follow-on
  action. Stop at the authorized gate and report exact outputs.
- Recovery operates only on a journal it can bind to the exact interrupted
  operation. Never guess ownership or delete an unverifiable draft.

## Validation

- Add unit tests for argument parsing, refusal paths, path safety, interruption,
  recovery, deterministic output, and dry-run/mutation separation.
- Run `node --check` and the narrow owning tests while iterating. Run
  `npm run test:preflight` for layout/docs tooling and
  `npm run architecture:check` when dependency scanning or boundaries change.
- Use the owning surface gate for build/release tooling. Changes to the macOS
  builder, Worker deployment, release trust, or public site require those exact
  gates; `npm test` alone is insufficient.
- Test only safe modes unless the user explicitly authorizes the exact external
  or destructive operation. State protected or unavailable validation separately.
