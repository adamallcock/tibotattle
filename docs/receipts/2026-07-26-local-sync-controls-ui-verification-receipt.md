---
title: Local Sync Controls UI Verification Receipt
date: 2026-07-26
type: verification
status: passed-development
---

# Scope

This receipt covers the loopback dashboard integration for safe contribution
inspection and explicit foreground delivery controls. It is development
evidence, not a production or background-collection approval.

# Implemented product pathway

The local dashboard now:

- inspects the next verified queued contribution without an upload;
- shows its covered period, safe record-class counts, API-price diagnostic,
  prepared bytes, and conservative upload reservation;
- runs one explicit foreground contribution pass;
- pauses and resumes the durable local queue;
- refreshes queue and preview state after every action; and
- keeps the foreground-only/no-installed-service boundary visible.

The send action is fixed at a maximum of 10 claimed jobs and a 16 MiB
conservative encrypted upload-body reservation. CLI users retain the broader
validated configuration range.

# Browser privilege boundary

The browser never supplies or receives:

- a prepared directory or queue path;
- a service origin;
- a filename or digest;
- a queue, contribution, participant, account, or session identifier;
- a device credential; or
- any record array or user content.

Those values remain in the loopback process. Mutating requests use fixed
query-free routes, exact empty JSON objects, same-origin validation, the
`X-Usage-Monitor-Local: 1` header, and the existing 1 KiB request ceiling.
Only one foreground pass can run at a time.

# Focused automated evidence

The combined browser and local-server suite passed 34 checks. New coverage
proves:

- preview normalization fails closed on missing privacy flags or malformed
  bounded fields;
- injected paths and contribution-like identifiers do not survive server or
  browser projection;
- preview invokes no sync runner;
- unauthenticated mutation invokes no runner;
- an overlapping pass returns `409`;
- a successful pass returns only bounded counts and reservation totals;
- pause and resume update injected durable state;
- non-GET preview and unknown routes remain closed; and
- every browser mutation uses the fixed local header and empty body.

# Rendered interaction evidence

An isolated owner-only prepared set and queue were used for browser QA. The
rendered panel showed:

- one safe usage record covering 2026-07-26 12:00–13:00 UTC;
- a `$0.012000` API-price-equivalent diagnostic with 100% pricing coverage;
- 2.1 KiB prepared and a 12.4 KiB conservative reservation;
- `Ready` preview state;
- a working loopback-only Inspect action with no service request or upload;
- a working Pause action with `Queue paused` and Resume enabled;
- a working Resume action restoring `Delivery active`; and
- a disabled Send action because no delivery service was configured.

The isolated prepared set and queue were moved to Trash after QA. The preview
server was stopped.

# Full product gate

`npm run product:check` passed:

- 28 browser/UI contract tests;
- 41 local companion, transport, queue, CLI, and privacy tests;
- generated Worker binding verification;
- TypeScript checking;
- 13 backend script and load-profile checks;
- 65 Cloudflare-runtime tests; and
- a successful Wrangler dry deployment.

No production deployment or external upload occurred.

# Remaining gates

This slice does not provide:

- device pairing inside the local dashboard;
- saved launch configuration or a signed desktop settings surface;
- scheduler/login-item/daemon installation;
- signed packaging or auto-update;
- a 30-day ongoing-collection soak;
- production service authority, secrets, key rotation, or incident approval; or
- named-human G10 privacy and security approval.
