# Core product source guidance

Scope: all files under `src/`. Apply the repository root guidance first.

## Ownership boundaries

- `application/` orchestrates use cases and ports; it does not own concrete
  platform mechanisms.
- `platform/` owns filesystem, process, Keychain/credential, and operating-system
  adapters.
- `providers/` owns untrusted provider parsing and normalization.
- `contribution/`, `export/`, and `reporting/` own their domain contracts and
  expose reviewed entrypoints.
- Root-level modules include composition roots and migration-era compatibility
  debt. Do not add a new direct dependency on a legacy facade merely because one
  already exists.

The exact public entrypoints, allowed package directions, legacy import ledger,
and permanently retired paths live in `scripts/check-architecture-boundaries.mjs`.
Treat that executable policy as a ratchet, not a list to relax.

## Domain principles

- Keep domain transformations deterministic. Inject clocks, filesystem access,
  credentials, processes, network access, and platform selection at explicit
  boundaries.
- Parse provider state as untrusted, version-varying input. Validate shape and
  completeness before normalization; preserve raw semantic distinctions such as
  billing surface, speed mode, service tier, quota window, and freshness.
- Never infer identity backward across account changes. Credential failure leaves
  evidence unattributed and produces a bounded diagnostic.
- Ingestion accepts only complete records, uses stable content-free occurrence
  identities, bounds lines and batches, and commits data with its checkpoint so
  restart replay is safe.
- Durable mutations are no-clobber, owner-only, atomic, and recoverable. Preserve
  commit order and directory durability where a crash could expose partial state.
- Corrections and migrations append provenance rather than rewriting source
  evidence. Reject branches, cycles, digest mismatches, incompatible schemas,
  and replacement files during recovery.
- Export starts from a fresh allowlist; it never copies and redacts raw records.
  Validation errors and summaries remain bounded and content-free.
- Preserve cancellation and resumability across expensive indexing and analysis.
  A cancelled or failed pass must leave the last good result readable and the
  next action explicit.
- Keep observation, accounting, projection, and presentation semantics separate.
  Provider quota and API-price-equivalent cost are evidence to compare, not a
  hidden conversion formula.

## Change and validation discipline

- Import an owner through its reviewed public entrypoint. If the needed behavior
  is not public, decide whether it belongs in that facade instead of deep-importing
  implementation.
- Keep workspace-package imports bare and product dependencies statically visible
  to the architecture scanner.
- Add negative, restart, retry, duplication, malformed-input, and resource-bound
  coverage when those failure modes are relevant.
- Run the narrow affected Node test files while iterating, then
  `npm run architecture:check` and the applicable root or surface gate.
- Changes to local unified-index schemas, cache formats, identity derivation,
  export compatibility, or retained R7 inputs require explicit compatibility and
  recovery review before broader validation.
