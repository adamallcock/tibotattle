# Accounting package guidance

Scope: all files under `packages/accounting/`. Apply the repository root guidance
first.

## Contract

- This package computes exact API-price-equivalent accounting. It does not model
  subscription billing, provider quota internals, credits, allowance capacity,
  or an invoice.
- Preserve token components, billing surface, service tier, speed mode, model,
  context band, event time, price source, and warning provenance when they affect
  price semantics. Do not collapse distinct provider concepts into one flag.
- Event-time cost, current-price comparison, quota movement, and provider-reported
  daily totals are separate series. A caller must choose explicitly.
- Unknown model, tier, price, currency, or long-context evidence remains unknown
  or fails according to the public contract. Never silently substitute a nearby
  model, default tier, zero price, or current price.
- Preserve numeric exactness and the established rounding boundary. Do not round
  intermediate components or let presentation formatting feed the ledger.

## Package boundary

- Keep the kernel deterministic, side-effect free, runtime neutral, and usable by
  both local Node and the Worker. It must not read files, environment variables,
  clocks, credentials, network state, app code, or repository tooling.
- Export behavior through the package root with matching types. Avoid public
  subpaths and do not make callers depend on internal representation.
- Make registry and policy changes auditable and source-backed. Pin versioned
  inputs where reproducibility depends on them and surface staleness explicitly.
- Treat a pricing-semantic change as a compatibility change for cached ledgers,
  retained evidence, Worker parity, and reports.

## Validation

- Add focused unit and property coverage for component conservation, replay,
  unknowns, boundaries, and rounding whenever affected.
- Run the package's affected tests through the root suite, then `npm test` and
  `npm run architecture:check` for public or dependency changes.
- Run `npm run product:worker:check` when exports or installed package contents
  change, because the Worker uses a guarded file-installed copy.
- Compare local and Worker results for shared semantics. A matching typecheck
  without numeric parity is not sufficient.
- Do not regenerate retained R7 receipts as routine follow-up. Identify them as
  stale/protected evidence when hashed accounting inputs change and follow the
  owner-authorized runbook separately.
