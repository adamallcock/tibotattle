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
- Every retained dated document needs `title`, `date`, `type`, and `status`
  frontmatter, with the date matching its filename. Root and component READMEs
  remain exempt unless their own format requires metadata.
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

- Git-remove obsolete plans, handoffs, reports, and guidance once they no longer
  help current work. Do not keep a file merely because it is dated or was once
  useful; Git history is the default archive.
- Retain historical evidence only when its audit, recovery, or release value is
  enduring. Its frontmatter and opening boundary must identify the snapshot
  date plus the relevant version, revision, environment, or artifact when known.
- Do not rewrite retained receipts, decisions, audits, or QA records to imply
  that a later result existed at the recorded time. Add a new dated record only
  when the new evidence itself has enduring value.
- A test receipt proves only the named checkout, environment, command, and time.
  A source review does not prove a live service; a browser capture does not prove
  a native app; a release manifest with null evidence fields does not prove the
  omitted evidence.
- Keep source merge, CI, artifact build, signing, notarization, publication,
  updater availability, installed state, and public deployment as distinct steps.
- Mark owner-only, credential-gated, hardware-gated, or destructive steps rather
  than writing them as routine agent actions.
- Retiring self-service controls does not retire owner erasure, privacy-request
  handling, retention disclosures, or deletion-safe restore. Keep those boundaries
  truthful without inventing a contact channel, deadline, or legal conclusion.
- Preserve the distinction between supported, experimentally qualified,
  source-compatible, planned, and untested platforms.

## Maintenance and validation

- When behavior, interfaces, commands, privacy boundaries, release state, or
  support claims change, search the root README, component READMEs, public docs,
  current docs, and agent guidance for the affected names and update or delete
  every stale statement in the same change.
- When deleting or moving documents, search all tracked files for both the old
  path and basename. Repair inbound links and remove stale references from
  scripts, comments, fixtures, ignore files, and security allowlists.
- `docs/README.md` is the validated current-authority index. Add an entry only
  when the target is maintained current authority; remove it in the same change
  when that ceases to be true. `current`, `canonical`, `maintained`, and
  `operational` status markers are invalid unless the document is indexed there.
- Run `npm run docs:check` and `npm run test:preflight` for documentation changes.
  The local link gate validates repository targets and Markdown anchors but does
  not make external-URL availability claims.
- Run the owning contract or release-trust tests when documentation changes a
  machine-checked path, schema, workflow, manifest, or operational assertion.
- Re-read the rendered Markdown for hierarchy, tables, links, and claim clarity
  before reporting completion.
