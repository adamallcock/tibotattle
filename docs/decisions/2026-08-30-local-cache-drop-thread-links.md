---
title: Local cache-drop thread links
date: 2026-08-30
type: decision-record
status: accepted
---

# Local cache-drop thread links

The owner requested thread names and Codex deep links in both recent cache-drop
tables. This is a narrow exception for the interactive local dashboard, not a
change to anonymous accounting, reports, diagnostics, or hosted contribution.
Implementation and focused validation are complete in the working tree.
Native click-through remains a manual acceptance check; this decision does not
establish an installed-app or release result.

## Accepted behavior

- Replace the local-time column with **Thread name** in the switch-overhead and
  large-cache-drop tables. Preserve the formatted local timestamp on hover and
  in accessible link descriptions.
- A named thread links to its own canonical `codex://threads/<UUID>` target.
  A known worker shows a parent-name link followed by a separate bracketed
  worker link. Only an explicitly recorded parent relationship may be used.
- Missing names fall back to a shortened thread identifier. Missing or ambiguous
  attribution stays unlinked and unavailable; never infer a name from a prompt.
- Missing optional metadata must not delay the dashboard, hide accounting, reset
  pagination, or produce an aggressive refresh error.

## Data and navigation boundary

The existing accounting DTOs remain anonymous. A separate, bounded, read-only
`GET /api/local/cache-drop-thread-links` route resolves only recent rows already
present in the current dashboard. It accepts no caller-supplied identifiers or
paths and requires the same-origin custom request header. Responses are
`no-store`, generation-bound, and kept only in transient local UI memory.

Attribution requires an exact event-pair match in the published unified index,
including proven local source ordering. Names come only from explicit Codex
display-name metadata; worker nicknames and parent links come from allowlisted
thread metadata. The prompt-bearing `threads.title`, first messages, transcripts,
private paths, and arbitrary provider fields are not name sources.

No schema migration or accounting-cache rebuild is required. Names, raw thread
identifiers, and links must not enter persisted dashboard snapshots, accounting
caches, exported reports, share cards, diagnostics, or contribution payloads.

Native navigation accepts only canonical Codex thread URLs activated by the user
from the pinned companion's main frame. Both same-window and new-window paths
apply the same policy. Existing public HTTPS and fixed sign-in-return handling
remain unchanged; the app does not register or alter a Codex URL handler.

## Acceptance checks

Use synthetic fixtures for exact matching, generation changes, ambiguous pairs,
missing metadata, worker-parent labels, hostile text/URLs, request authorization,
and export exclusion. Exercise both tables and pagination at desktop and narrow
widths. Validate native URL policy separately from browser rendering and report
any native or installed-artifact gate that has not been exercised.

## Initial development verification on 2026-08-30

These checks used the development tree based on `b7112217`, before the feature
was isolated from unrelated accounting-layout edits for its pull request. The
isolated integration requires its own merge checks and current R7 receipts.

- Browser UI suite: 394 passing tests. Local companion suite: 254 passing tests.
  Resolver/display-metadata tests: 39 passing, including exact adjacency,
  Max/Ultra continuity equivalence, routing boundaries, ambiguity under resource
  limits, and absence of writes to source metadata or accounting snapshots.
- Native macOS suite: 64 passing tests, including compilation and the canonical
  URL/main-frame/origin policy. The isolated-world click script also has direct
  trusted/untrusted event tests.
- Real local evidence was inspected in a separate loopback preview without
  refreshing or rebuilding the live index. Both tables showed named threads,
  separate parent/worker links, ID fallbacks, local-time hover attributes, and
  working pagination. Their narrow-screen cards were visually checked; long
  labels wrap within their own column. The browser reported no warnings/errors.
- An isolated QA app compiled the current production WebKit host and loaded
  the real-data dashboard. Desktop click control repeatedly disconnected during
  interaction, so actual native-to-Codex handoff is **not yet verified**. This is a
  manual acceptance gap, not evidence of a product navigation failure.

No index migration, history reprocessing, R7 regeneration, installed-app
replacement, or release publication was performed during those initial checks.
