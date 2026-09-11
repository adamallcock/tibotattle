# Standalone local-review app guidance

This file governs `local-review/`. The root guidance also applies. This directory
is a distributable application and security boundary, not scratch tooling.

## Contract

- Keep the application local-only and offline-capable. It has no enrollment,
  pairing, upload, queue, backend, server, remote configuration, notification,
  or automatic-update surface.
- Treat every source file, workspace, artifact, receipt, and identity input as
  private and untrusted. Bound reads, reject unsafe filesystem objects, and keep
  paths, content, raw identifiers, and secrets out of output and diagnostics.
- Build new exports from explicit allowlists and closed schemas. Never copy or
  redact raw records into a derived artifact.
- Enter product behavior only through the reviewed application and platform
  facades. Do not import private owner modules, other apps, legacy flat source,
  build scripts, or tools from production code.
- Keep the CLI surface closed. A new command or option requires an explicit
  product decision, matching parser and negative tests, updated usage text, and
  review of the frozen release contract.

## Lifecycle safety

- Separate inspection and planning from mutation. Destructive operations require
  an exact, target-bound confirmation and a durable receipt or recovery path.
- Bind install, uninstall, export deletion, and workspace discard to verified
  inventories. Refuse modified or unexpected entries and preserve unrelated
  files, source evidence, and participant identity.
- Preserve crash recovery, no-clobber creation, owner-only permissions, bounded
  resource use, deterministic serialization, and replay safety on every path.
- Identity selection and rotation must fail closed on ambiguity. Keep export and
  Claude-callback capabilities domain-separated and in their approved secret
  backends; development overrides must remain explicit.
- Ordinary uninstall or logical deletion does not establish secure erasure. Do
  not broaden receipts or user-facing claims beyond the performed operation.

## Artifact and release evidence

- `release-contract.json` is the closed runtime contract. Keep the CLI, launcher,
  artifact manifest, lifecycle smoke, and contract verification aligned.
- Reproducibility, dependency closure, privacy scan, SBOM, provenance, runtime
  smoke, no-egress evidence, signing readiness, signatures, notarization, and
  clean-host qualification are separate gates.
- Change canonical source or release tooling rather than generated candidates.
  Signing, notarization, publication, and protected receipt generation require
  explicit authorization.

## Validation

- Run direct tests for the changed CLI, install, identity, export, deletion, or
  artifact contract while iterating.
- Run `npm run architecture:check` for dependency changes and
  `npm run product:local-review:runtime` when the packaged lifecycle or release
  contract changes.
- Use synthetic private-data canaries and retain the network-audit positive
  control. A source test, unsigned artifact smoke, or simulated no-egress result
  is not signed-release or clean-machine proof.
