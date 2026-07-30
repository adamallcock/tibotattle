---
title: Local Sync Controls UI Plan
date: 2026-07-26
type: plan
status: completed-development
---

# Outcome

Turn the existing read-only queue card into a functional loopback app surface
for inspecting and controlling foreground privacy-safe delivery, while keeping
filesystem paths, service origins, device credentials, and record content
outside the browser.

# Privilege boundary

- The browser never supplies a directory, queue path, service origin,
  credential, contribution identifier, filename, or digest.
- A prepared-spool directory and service origin are selected once when the
  loopback server starts.
- Browser requests use fixed routes, no query string, same-origin verification,
  the `X-Usage-Monitor-Local: 1` header, exact JSON bodies, and a 1 KiB request
  ceiling.
- The loopback server performs prepared-set verification, Keychain access,
  queue updates, encryption, and network delivery.
- Responses pass through new bounded projectors and never return raw queue or
  sync objects.

# Product controls

The queue panel will support:

- loopback-only inspection of the next queued contribution, with no service
  request, key fetch, authorization, or upload;
- one explicitly initiated foreground sync pass;
- local pause;
- local resume; and
- refreshed queue/preview state after every action.

The UI will show record-class counts, covered time, client-declared cost
diagnostics, prepared bytes, conservative reserved bytes, prior attempts, and
ready/retry-wait/paused state. It will retain the explicit statement that no
background service has been installed.

# Delivery bounds

The first UI action uses server-fixed defaults: at most 10 claimed queue jobs
and a 16 MiB conservative encrypted upload-body reservation. CLI users retain
the existing configurable 1–100 and 16 KiB–256 MiB controls.

One sync action is allowed at a time. The server uses a bounded abort signal,
returns `409` for overlap, and retains the durable queue state across client
disconnects and process interruption.

# Verification

- Unconfigured prepared storage fails closed without filesystem discovery.
- GET preview performs no external service request or upload.
- Mutating actions require loopback, exact Host, same Origin, custom local
  header, JSON content type, and an empty object body.
- Unknown API routes and query strings remain rejected.
- Browser normalizers reject malformed or identifier-bearing responses.
- UI actions never render paths, origins, credentials, filenames, digests, or
  contribution IDs.
- Pause/resume and the one-pass action change real injected queue state in
  server tests.
- Rendered loopback QA covers configured, unconfigured, paused, and
  bandwidth-limited states.

# Release boundary

This is still foreground-only. It does not install persistence, pair a device,
create a participant browser session, configure production service authority,
or approve external collection.
