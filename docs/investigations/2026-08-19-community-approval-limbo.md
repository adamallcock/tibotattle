---
title: Community approval limbo investigation
date: 2026-08-19
type: investigation
status: validated-fix-pending-release
---

# Community approval limbo

## Outcome

There is not enough evidence to attribute both reports to one trigger. Five
client defects can produce the same grey **Review and approve** surface or the
same apparent return-to-start loop:

1. **Confirmed scheduling/review coupling.** A locally verified payload in
   `retry_wait` or `paused` was rejected by both the page and companion as a
   review candidate. Those states control upload timing only; they do not make
   the retained payload less reviewable.
2. **Confirmed silent-unavailable branch.** If the local queue preview was
   unavailable, malformed, or not configured, the page returned silently. It
   left the default “preparing and verifying” sentence on screen, exposed no
   retry, and recorded no diagnostic. The screenshots are consistent with
   this branch, but the swallowed underlying error cannot be reconstructed
   after the fact.
3. **Confirmed unbounded wait; occurrence unproven.** Preparation and exact
   review crossed loopback, SQLite, and macOS Keychain boundaries with no page
   deadline. A dependency that never settled could leave the button grey
   forever. There is no retained evidence proving this happened on either
   reported Mac.
4. **Confirmed stale review authorization and unsafe ordering.** The local
   review authorization expired after ten minutes, but the button retained it.
   The ceremony also changed hosted enrollment/pairing state before recording
   local consent, so a late local failure could split server and client state.
5. **Confirmed crash-unsafe OAuth result recovery.** The page discarded its
   pending handoff as soon as it collected the provider result, leaving the
   only identity proof in page memory. A quit before enrollment then lost the
   recovery path. Browser storage was not a valid fix because the companion
   receives a new random loopback port, and therefore a new origin, on restart.

The Google flow itself completed in the supplied screenshots: the page held a
Google proof and rendered “Signed in with Google.” That rules out a missing
browser-opening permission as the explanation for those particular attempts.
“Reconnecting” was a separate presentation bug: proof-only state was
mislabelled as transport reconnection.

Hosted observability also amplified the investigation cost:
`IDENTITY_RESULT_PENDING` is the expected answer while the app polls, but it
was logged as a warning and retained as a diagnostic error. The existing
native diagnostics receipt omitted the contribution journey entirely.

## When each trigger can occur

| Trigger | Fresh, never-approved Mac | Returning, upgraded, or partially enrolled Mac |
| --- | --- | --- |
| `retry_wait` | Not through the normal flow; it requires an earlier upload attempt that received a retryable failure | Yes: service/network retry, interruption with a retry floor, or another retryable upload failure |
| `paused` | Not through the normal flow; it requires an earlier delivery or explicit pause | Yes: unreadable/revoked device credential, excessive `Retry-After`, disconnect, or an explicit pause |
| preview unavailable | Yes | Yes |
| preparation/review never settles | Yes | Yes |

A clean queue normally follows `empty -> prepare -> ready -> exact local
review`. The retry and pause finding is therefore a real defect and a strong
explanation for returning Macs, but it is not by itself a complete explanation
for a genuinely first-time contributor.

The contradictory-looking combination in the screenshots is possible after a
contract upgrade: the older prepared-upload queue and the newer incremental
consent settings are separate durable files. An older queued job may therefore
still be `retry_wait` or `paused` while the current consent surface truthfully
says **Not approved** and asks for the newer one-time review. The old client
then refused to show that very review because it incorrectly treated delivery
scheduling as payload validity.

## Why it survives relaunches and resets

In the affected build, the loop combined three independent lifetimes:

- The local prepared payload, review archive, and queue live under the
  owner-only Application Support state root. The queue is
  `private/contribution-sync-v0.1.sqlite3`.
- A completed provider result, once collected, was an in-page one-use proof
  until **Review and approve** enrolled the identity and minted/claimed the
  device credential.
- A local review authorization lived for ten minutes in companion memory even
  though its button could remain open longer.

Consequently, quitting while approval was blocked could discard the collected
Google proof while retaining the exact local condition that blocked approval.
The next launch asked for sign-in again, obtained another proof, and encountered
the same durable local condition.

| Action | Local queue/prepared review | Collected proof/session in the affected build | Effect on the affected loop |
| --- | --- | --- | --- |
| Close and reopen app | Retained | A collected-but-unenrolled proof is lost; a valid established web session may remain | Loop survives |
| Sign out | Retained | Proof/session cleared or revoked | Loop survives |
| App update | Retained | Persistent WebKit/session and Keychain state are separate | Loop survives |
| Move app to Trash and reinstall | Retained unless Application Support is separately erased | Keychain and web state are separate from the app bundle | Loop survives |
| **Identity & Device Reset** | Explicitly retained, including prepared contributions | The reset does not target WebKit or hosted state; it removes only the paired-device and export-identity Keychain capabilities plus their two residue files | Queue blocker survives |
| **Move all local data to Trash** | Removed with the Application Support state root | Keychain and hosted data remain | This exact persisted queue blocker does not survive |

The repaired build keeps only the bounded `{provider, state, verifier,
startedAt}` read-back capability in an owner-only `0600` companion file for at
most fifteen minutes. The service may return the same proof to that exact
state+verifier until enrollment consumes it or it expires. Collection no
longer clears the file; confirmed enrollment does. **Move all local data to
Trash** now stops the page, trashes that state root, clears TiboTattle's WebKit
cookies/cache, and restarts from a clean app-state boundary. It deliberately
does not delete Keychain capabilities or hosted contributions, as the dialog
states.

## Fix

- Treat `ready`, `retry_wait`, and `paused` as equally eligible for exact local
  review and a one-use review token. Delivery remains paused or delayed; only
  review readiness is decoupled.
- Turn every missing/unusable preview into an explicit **Check again** state and
  create a content-free local diagnostic reference instead of silently
  retaining optimistic copy.
- Bound preparation, re-check, and exact-review waits to one minute. A timeout
  exposes retry and records `local_review_timed_out`; it does not upload or
  discard the companion's durable work.
- Render a collected proof as **Signed in**, reserving **Reconnecting** for a
  real upload-authority repair.
- At approval click time, re-read and validate the exact local review, mint a
  fresh authorization, and retry once if the authorization expires in the
  final local interval.
- Record local consent before any hosted enrollment or pairing mutation. A
  crash may now leave an approved Mac needing connection, which is an explicit
  recoverable state, but cannot leave hosted authorization ahead of consent.
- Fence review/preparation responses with a monotonic generation so an older
  timed-out request cannot overwrite a newer retry.
- Persist the bounded OAuth read-back capability in owner-only companion state
  before opening the browser. Keep it through result collection and clear it
  only on cancellation, terminal expiry/verdict, sign-out, reset, or confirmed
  enrollment. Fence cancellation until its asynchronous clear finishes.
- Make provider-result delivery idempotent for the initiating state+verifier
  until proof consumption or expiry.
- Add allowlisted contribution state and the five newest `TT-…` references to
  **Data & Diagnostics**, plus **Copy diagnostics** beside **Check again**.
  The projection rejects tokens, OAuth state/verifiers, device/account IDs,
  paths, prompts, responses, and contribution content.
- Log `IDENTITY_RESULT_PENDING` as expected `request_pending` info and do not
  persist it as a diagnostic error.

## Installed-app failure matrix status

| Scenario | Evidence now in the repository | Remaining installed check |
| --- | --- | --- |
| `retry_wait` → restart → sign in → approve | SQLite reopen preserves the job and exact review binding; both `retry_wait` and `paused` mint a fresh review token; the one-step ceremony records local consent first | One real provider round trip in the production-configured bundle |
| unavailable preview → **Check again** → recovery | Browser tests prove explicit recovery controls, bounded retry, diagnostic reference, and late-response fencing | Visual confirmation in the release bundle |
| page left open beyond ten minutes | Companion rejects the stale token without mutation; the click-time client path re-reads the exact review and retries once with a fresh token | None beyond the normal release UI pass |
| quit after OAuth returns, before enrollment | Worker result delivery is idempotent; a real companion restart on a different port recovers the owner-only handoff and resumes the ceremony | One real provider round trip in the production-configured bundle |
| quit during approval | Source/integration tests enforce local-consent-first ordering, so restart can only yield “approved, connection needed,” never hosted-ahead-of-local consent | A deliberate process kill at each network boundary remains a manual release check |
| **Identity & Device Reset** with a retained queue | The reset test removes only the two exact Keychain capabilities and two residue files while byte-checking that `private/contribution-sync-v0.1.sqlite3` remains | Confirm the installed dialog and post-reset re-pair copy |
| **Move all local data to Trash** | The native contract stops the page/companion, trashes the exact owner-only state root, clears all TiboTattle WebKit data, then restarts; the rebuilt bundle contains this path | Perform the destructive click once in a disposable release-profile account |

## Validation

- Browser/UI: 189/189 tests passed. Coverage includes the one-minute deadline,
  unavailable-preview recovery, retry/paused review, review-generation fencing,
  local-consent-first ordering, stale-token refresh/retry, diagnostics
  allowlisting, cancellation fencing, and restart recovery.
- Companion/queue/diagnostics: 94/94 focused tests passed. A real companion was
  stopped and restarted on a different random loopback port against the same
  state root; it recovered the handoff from a `0700` parent and `0600` file.
  Clear/expiry replaced the bound values with a content-free tombstone. A
  review left open beyond ten minutes rejected the stale token, minted a fresh
  one, and approved exactly once. `retry_wait` and `paused` both remained
  reviewable.
- Worker: 35 files / 385 tests passed, plus `tsc --noEmit`. Google and Apple
  result delivery is repeatable for the initiating state+verifier, enrollment
  consumes it, and later result/enrollment attempts fail. Pending polling emits
  info, no warning, and no `diagnostic_error_events` row.
- Native source lane: 44 passed, 3 distribution-only tests skipped as designed;
  localization checks passed; the development compiler smoke passed.
- Native package lane: 55/55 macOS build, updater, reproducibility,
  forced-termination watchdog, preview, and loopback-relay tests passed.
- Client export: 2/2 allowlist and private-path tests passed after adding the
  new recovery module to the exact exported runtime inventory.
- Contained Cloud Run: 15/15 tests and its disabled-collection configuration
  check passed after installing the worktree's declared development
  dependencies.
- A fresh development `TiboTattle.app` was built and passed clean-install
  validation. Its packaged resource graph contains
  `src/hosted-signin-handoff.js`; diagnostics and semantic app-return link
  smoke tests passed. The payload SHA-256 is
  `cd1af9888e28ab961c2a2ef2eb3d63232a3e2393a81fb61855ba7949b6a14510`
  and the source SHA-256 is
  `d4a2a55e2ee565468d7cf33a80f5a2f060ba202765cda83b26050803f5b2b193`.
  The diagnostic receipt explicitly reports every excluded secret/content
  class as `false`.
- `git diff --check` and documentation-link normalization passed.

The first repository-wide root run executed 2,605 tests: 2,581 passed, 21
were intentionally skipped, and three failed. One failure was a real client
export allowlist omission found by this run; it is fixed and its 2/2 focused
tests now pass. The other two are the retained R7 release-evidence checks:
every `src/` change intentionally invalidates that historical dual-runtime
matrix. Refreshing it is a separate release-evidence operation over the frozen
24 GB private-history interval under exact Node 24.14.0 and 26.2.0 runtimes;
the receipts were not hand-edited or silently weakened here.

The Worker passed typechecking and all 385 tests. Its aggregate deployment
check then correctly refused the dry deploy because this isolated worktree is
dirty and uncommitted. The unrelated extracted local-review artifact gate also
retains a baseline packaging mismatch: its source declares
`@app-usagemonitor/quota-analysis` and
`@app-usagemonitor/telemetry-contract` in the allowed closure but does not copy
those packages into the extracted artifact. Neither release-only blocker was
papered over as part of this contribution fix.

This development bundle is ad-hoc signed and intentionally has no central
service configured. It validates the installed runtime and local failure seams,
but it cannot complete a real Google/Apple ceremony against a production-like
Worker. One installed, production-configured OAuth pass remains a release gate;
so do normal Developer ID signing/notarization checks. No hosted service,
installed app, or public release has been changed by this work.

## Recovery after a fixed build is released

1. Install the fixed build and open the contribution page.
2. If the previous provider handoff is still inside its bounded recovery
   window, reopening the app checks it automatically. If it expired or received
   a terminal provider verdict, sign in once more.
3. The retained local review appears even if its old delivery state
   is waiting or paused; choose **Review and approve**.
4. If local consent was already recorded before a quit, the app resumes at
   connection repair and does not ask for that consent again.
5. If the page instead shows **Check again**, choose it once, then choose
   **Copy diagnostics** beside it. Send support the copied content-free receipt
   or the same receipt from **Settings → Data & Diagnostics**.

Do not delete the SQLite files, prepared sets, or Keychain items as a routine
workaround. The fixed client is designed to recover the retained review.

## Post-investigation updates (2026-08-19, later the same day)

Live dogfood validation of the ceremony began after this document was
recorded; the following landed on the same branch and supersede the
corresponding notes above:

- Internal-dogfood builds were published from the branch for live first-run
  ceremony debugging on a fresh macOS account (0.1.13 tag builds 1013–1015;
  signed-feed appcast path). These are `internal-dogfood` distribution only:
  no stable release was published, and the deployed production Worker remains
  the prior lineage — merging this branch does not deploy it.
- Two further defects were found live and fixed: a never-created prepared
  spool was classified as invalid instead of empty (956efb1), and the
  exact-review summary identity was derived from stale state rather than the
  real record arrays (55f562f). The consent column layout was reworked for
  narrow widths (ee0b49b).
- The sign-in recovery handle read-back was blocked by an Origin-header
  assumption (same-origin GETs carry no Origin header); fixed in 719978f.
- The two R7 release-evidence failures listed under Validation are resolved:
  the retained receipts were regenerated under the exact pinned dual
  runtimes (procedure now documented in
  `../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md`), and
  the repository root run is green at the branch tip.
- The publisher-side dogfood signed-feed gap noted alongside this work was
  closed: the SURequireSignedFeed preflight now covers both named channels
  (59dea15; see `../runbooks/2026-08-02-r2-sparkle-update-publisher.md`).

The remaining release gates stated above (one installed production-configured
OAuth pass, Developer ID signing/notarization checks, and the extracted
local-review artifact packaging mismatch) are unchanged by these updates
except as the live dogfood runs progressively discharge them.
