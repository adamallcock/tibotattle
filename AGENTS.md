# TiboTattle agent guidance

This is the canonical repository instruction file. It is written for capable,
long-horizon coding agents: prefer principles, constraints, and verifiable
outcomes over tutorials or canned examples.

## Use progressive disclosure

- Apply this file to every task in the repository.
- Before changing a scoped area, read the nearest scoped `AGENTS.md`, even when
  the client did not load descendant instructions automatically.
- Read only the references relevant to the task. Do not preload the documentation
  tree, large runbooks, or generated artifacts.
- For unlisted paths, this root file plus nearby code, manifests, tests, and
  READMEs are the applicable guidance.
- If instructions conflict, follow the narrower scope and surface the conflict.

| Work | Read next |
|---|---|
| Product purpose, setup, or repository layout | `README.md` and `CONTRIBUTING.md` |
| Security or privacy-sensitive work | `SECURITY.md` |
| Core product/domain code | `src/AGENTS.md` |
| Codex ingestion or provider normalization | `src/providers/codex/AGENTS.md` |
| Contribution projection or prepared sets | `src/contribution/AGENTS.md` |
| Local companion, dashboard API, or unified index | `apps/local/AGENTS.md` |
| Browser dashboard or public web UI | `apps/web/AGENTS.md` |
| Native macOS, app bundles, updater, or signing | `apps/macos/AGENTS.md` |
| Hosted Worker, D1/R2, auth, or deployment | `apps/worker/AGENTS.md` |
| Contained Cloud Run experiment or Google Cloud IAM | `apps/cloud-run/AGENTS.md` |
| Standalone local-review CLI, artifact, install, or deletion | `local-review/AGENTS.md` |
| Exact accounting or price semantics | `packages/accounting/AGENTS.md` |
| Pseudonym derivation or identity continuity | `packages/identity-core/AGENTS.md` |
| Quota calibration, rolling windows, or forecasts | `packages/quota-analysis/AGENTS.md` |
| Locale negotiation, catalogs, or browser i18n mirror | `packages/i18n/AGENTS.md` |
| Telemetry fields, privacy, schemas, or compatibility | `packages/telemetry-contract/AGENTS.md` |
| Native Windows filesystem or credential security | `native/AGENTS.md` |
| GitHub workflows, actions, attestations, or release trust | `.github/AGENTS.md` |
| Build, generator, verification, or release tooling | `scripts/AGENTS.md` |
| Documentation, evidence, plans, or release claims | `docs/AGENTS.md`, then `docs/README.md` |

`CLAUDE.md` imports this file so Claude and AGENTS-aware clients share one
policy. Keep model- or client-specific guidance out of this file unless it
changes a repository contract.

## Product invariants

Changing an invariant requires an explicit product decision, matching tests,
and updated authoritative documentation.

- TiboTattle is local-first and privacy-first. Local analysis must work offline,
  and local HTTP services must bind only to loopback.
- Prompts, responses, raw session commands, credentials, private session paths
  and filenames, raw account identifiers, and other session content must not
  enter derived artifacts, fixtures, logs, diagnostics, issues, commits, or
  pull requests.
- Hosted contribution is optional, off by default, content-free, pseudonymous,
  consent-gated, reviewable before first upload, and deletable afterward.
- Derived data is allowlisted and schema-validated. Unknown upstream fields are
  omitted; unknown, stale, unavailable, or unattributed evidence stays explicit.
  Never convert missing evidence to zero or inferred continuity.
- Accounting and ingestion are replay-safe, identity-scoped, bounded, and
  deterministic. Corrections are additive; durable state transitions are
  recoverable; repeated work must not double count.
- Display windows are not retention policy. Preserve accumulated local evidence
  unless an explicit, receipt-backed deletion workflow authorizes exact targets.
- Schema evolution is fail-closed and forward-moving. Never relabel a database
  version, destructively downgrade state, wipe application data, or let an older
  reader mutate newer state. Diagnose and rehearse recovery against a copy.
- Local, hosted, browser, native, installed-artifact, CI, signed-release, updater,
  and public-deployment evidence are separate gates. Passing one never proves
  another.

## Truth and evidence

- Verify the exact checkout, active diff, relevant runtime, and artifact before
  making a current-state claim.
- Use code and tests to establish implemented behavior, maintained decisions and
  runbooks to establish intended operations, and direct runtime or artifact
  inspection to establish live state. Reconcile disagreements; do not silently
  choose the convenient source.
- Treat dated plans, audits, QA notes, reports, and receipts as point-in-time
  evidence unless `docs/README.md` names them as current authority.
- State the strongest proven result and the remaining gate. Use exact versions,
  commits, paths, commands, and dates when they matter.
- Do not claim provider-authoritative billing, quota formulas, platform support,
  release provenance, or production readiness beyond the evidence actually held.

## Working contract

- Start by inspecting `git status`, applicable instructions, relevant entrypoints,
  and nearby tests. Preserve all unrelated and user-owned changes.
- Define the acceptance boundary and risks before broad work. Keep simple tasks
  direct; keep non-trivial work on a concise, durable plan.
- Reuse reviewed abstractions and public entrypoints. Add a dependency or new
  root-level concept only when existing boundaries cannot express the need.
- Prefer the smallest coherent change. Avoid opportunistic rewrites, speculative
  compatibility layers, duplicated policy, and unrequested cleanup.
- Preserve cancellation, retry, idempotency, atomicity, permissions, and bounded
  resource behavior across success and failure paths.
- Parallelize independent investigation or validation when useful, with explicit
  file ownership and integration boundaries. Verify delegated conclusions before
  relying on release- or privacy-sensitive claims.
- Update tests, generated outputs, schemas, public types, and maintained docs in
  the same change when their contract changes.

## Architecture and code

- `src/` owns local/domain behavior; `apps/` composes delivery surfaces;
  `packages/` exposes runtime-neutral public APIs; `scripts/` and `tools/` are
  one-way build, verification, and operations entrypoints.
- Enter owned source areas and workspace packages through reviewed public
  facades. Do not import private package paths, reach from one app into another,
  or make product code depend on tests, scripts, or tools.
- Production JavaScript is ESM with statically reviewable dependencies. Inject
  platform adapters from composition roots rather than hiding runtime selection.
- `npm run architecture:check` is the mechanical dependency authority. Do not
  baseline, bypass, or recreate retired compatibility paths to satisfy it.
- Keep reusable packages platform-neutral. A package must not depend on an app,
  root product source, or repository tooling.
- Do not hand-edit `generated/` or generator-owned contract artifacts. Change the
  canonical source and use its generator. R7 receipt regeneration is a protected,
  environment-specific workflow, not routine validation.
- Keep schemas closed where they protect privacy or compatibility. A schema
  change includes validators, mirrors, fixtures, compatibility declarations,
  and migration behavior.
- The tracked root layout is an allowlist. Any new root entry requires a deliberate
  update to `ROOT_WORKSPACE_POLICY` and its tests.

## Validation

- Use pnpm for the root workspace. The Worker and Cloud Run apps have independent
  npm lockfiles. Do not mix lockfile ownership.
- Root tooling requires Node.js 22.13 or newer. Native macOS bundle work requires
  macOS arm64 and exactly Node.js 26.2.0; unsupported environments must fail
  honestly rather than produce partial proof.
- Run the smallest meaningful validation first, then broaden according to impact.
  Direct test-file execution is preferred while iterating.
- Use `npm run test:preflight` for documentation, root-layout, and whitespace
  checks; `npm run architecture:check` for dependency-boundary changes; and
  `npm run test:changed -- --base <review-base>` when a trustworthy base exists.
- Use `npm test` for broad root/shared behavior and `npm run check` only when the
  complete cross-surface gate is justified and its platform prerequisites exist.
- Use the owning package or surface gate for scoped changes. The macOS and Worker
  files define their retained gates.
- Tests are serial where configured. Do not weaken assertions, exclusions,
  timeouts, privacy checks, or platform gates to obtain green output.
- For user-facing changes, inspect the rendered target with real-system data.
  Browser rendering does not qualify native rendering, and simulated platform
  checks do not qualify physical operating-system behavior.
- If validation cannot run because dependencies, credentials, hardware, or
  services are absent, report that as an environment gap, not a product failure
  or a passing gate.

## Authorization and sensitive operations

- Do not push, publish, deploy, apply remote migrations, create releases, install
  into system application locations, submit to stores, send messages, or change
  external resources without explicit authorization for that outcome.
- Treat production and staging writes, live load tests, real-account experiments,
  R7 regeneration, signing, notarization, updater publication, and website
  publication as protected operations. A dry run is not authorization for a
  write.
- Never print, commit, or document secrets. Keep credentials in their designed
  local secret store and preserve redaction in failures and diagnostics.
- Never use real private session data in tests. Use synthetic, minimal, content-free
  fixtures that exercise the same structural boundary.
- Before any destructive local action, resolve exact targets, inspect ownership
  and links, preserve unrelated state, and prefer reversible or journaled flows.
- Before staging or committing, inspect the diff and status. Do not rewrite shared
  history, force-push, or discard unrelated work without explicit authorization.

## Code review rules

Flag changes that:

- weaken local-only, loopback, consent, redaction, pseudonymity, or deletion
  guarantees;
- turn sparse or stale evidence into confident values, attribution, or support
  claims;
- allow replay, retries, partial writes, account switching, or source duplication
  to overcount or corrupt durable state;
- broaden schemas, routes, platform access, filesystem access, or network access
  without a closed contract and negative tests;
- blur source, runtime, installed-artifact, release, and deployment gates;
- hand-edit generated evidence, bypass public facades, or weaken a ratchet/test;
- make remote writes, secret use, or destructive behavior implicit;
- update behavior without the corresponding tests and maintained documentation.

## Maintain this guidance

- Keep the root file under 200 lines and the deepest root-to-scope instruction
  chain comfortably below Codex's default 32 KiB project-doc limit.
- Add nested guidance only for a stable, materially different local contract.
  Put procedures and volatile detail in maintained READMEs or runbooks.
- State each rule once, prefer durable principles to examples, and remove stale
  guidance when the code or authority changes.
- Keep `test/agent-guidance.test.js` aligned with the scope map and instruction
  budget whenever guidance files are added, moved, or removed.
