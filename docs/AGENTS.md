# Documentation and evidence guidance

Scope: all files under `docs/`. Apply the repository root guidance first.

## Find the right authority

- Start with `docs/README.md`. It names maintained operational entrypoints and
  distinguishes them from historical records.
- Read the document header, status, scope, and supersession notes before relying
  on it. A recent date alone does not make a document authoritative.
- Decisions define accepted contracts; runbooks define current operations; plans
  define intended work; receipts, QA notes, audits, reviews, and reports preserve
  point-in-time evidence. Do not silently promote one type into another.
- When two maintained sources disagree, verify code and current operations,
  resolve or document the conflict, and update the index if authority changes.

## Writing principles

- Put durable material in the existing purpose-based folder. Use a dated,
  kebab-case filename for new plans, research, runbooks, specs, reviews, decisions,
  reports, and receipts unless that category has a stronger convention.
- Use frontmatter only where the surrounding category already supports it. Do
  not add it to root READMEs or rewrite a historical document for uniformity.
- Lead with status, scope, claim boundary, and current authority. Separate verified
  facts, implementation state, live observations, assumptions, decisions, and
  open gates.
- Prefer principles, contracts, and acceptance criteria over long examples.
  Include commands only when they are maintained interfaces; include output only
  when exact evidence is necessary.
- Use exact dates, versions, environments, artifact identities, and source links.
  Prefer primary sources for external claims and preserve citations near claims.
- Keep diagrams and tables only when they materially clarify a relationship or
  gate. Text must still state the conclusion and limitation.
- Never include session content, credentials, real private paths, raw identifiers,
  or sensitive payloads. Use content-free summaries and synthetic placeholders.

## Evidence and history

- Do not rewrite a receipt, decision, audit, or QA record to imply that a later
  result existed at the recorded time. Add a new dated record or explicit
  correction/supersession link.
- A test receipt proves only the named checkout, environment, command, and time.
  A source review does not prove a live service; a browser capture does not prove
  a native app; a release manifest with null evidence fields does not prove the
  omitted evidence.
- Keep source merge, CI, artifact build, signing, notarization, publication,
  updater availability, installed state, and public deployment as distinct steps.
- Mark owner-only, credential-gated, hardware-gated, or destructive steps rather
  than writing them as routine agent actions.
- Preserve the distinction between supported, experimentally qualified,
  source-compatible, planned, and untested platforms.

## Maintenance and validation

- Update inbound and outbound links when moving or superseding documents. Do not
  reorganize the docs tree without auditing scripts, READMEs, and hardcoded paths.
- Add a maintained entry to `docs/README.md` only when it truly becomes current
  authority; otherwise keep it in the appropriate records category.
- Run `npm run test:preflight` for documentation changes. Also run
  `npm run docs:links:check` when links or paths change, while recognizing that it
  checks the repository's normalized-link contract rather than every external URL.
- Run the owning contract or release-trust tests when documentation changes a
  machine-checked path, schema, workflow, manifest, or operational assertion.
- Re-read the rendered Markdown for hierarchy, tables, links, and claim clarity
  before reporting completion.
