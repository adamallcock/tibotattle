---
title: Local Data, Network, and Privacy Inventory
date: 2026-08-27
type: reference
status: maintained
last_verified_commit: 52399658
---

# Local data, network, and privacy inventory

This is the maintained technical inventory behind TiboTattle's first-run and
public privacy disclosures. It describes what the implemented app can read, what
it derives and stores, which operations use the network, and which removal
actions are intentionally separate. The baseline review commit above predates the
[2026-08-30 self-service retirement](../decisions/2026-08-30-self-service-deletion-retirement.md)
and [local cache-drop thread links](../decisions/2026-08-30-local-cache-drop-thread-links.md)
documented here. Source changes do not prove that an installed or published
artifact already contains them, or that the hosted service has been deployed.

The central rule is structural: prompts, responses, reasoning, raw commands,
credentials, private paths/filenames, emails, account names, and other free
text have no allowed destination in contribution schemas, diagnostics, or
public aggregates. Unknown fields are omitted; an input that cannot be safely
projected is refused or shown as unavailable.

## Electron sharing transition

The [accepted accountless policy](../decisions/2026-09-04-accountless-sharing-policy.md)
applies to the unified Electron workstream. Fresh installations default to
sharing; existing installations with no prior choice receive three visible
notices before activation. A persistent Settings choice enables sharing now or
keeps it off, cancelling all remaining reminders. Known off, paused and
disconnected states remain off. Uncertain or unreadable state does not enable
sharing. No social sign-in is required by this new mode.

Electron stores the policy version, destination, basis and notice timestamps
in the protected `desktop-settings/accountless-sharing-v1.json` profile record.
It distinguishes automatic activation from affirmative choice and never invents
an explicit-consent event. Classification reads metadata for a fixed set of
managed files, not their contents or provider histories. Removing every app
state marker can make a reinstall indistinguishable from a fresh installation;
an upgrade or ordinary reinstall preserving the profile preserves the choice.

The current candidate implements local preferences and notices. Accountless
upload ownership, renewal/revocation and scheduling remain unfinished, so the
Electron host disables the older hosted transport and the UI reports uploads
unavailable. The native and standalone review/consent path described below
remains unchanged. Production privacy disclosures must change before a build
that actually sends under the new policy is distributed.

## Normal refresh sources

| Provider | Exact source | What is read | What is retained by TiboTattle | Network boundary | Removal/reset |
| --- | --- | --- | --- | --- | --- |
| Codex rollout metadata | Selected Codex home, normally `~/.codex/sessions` and `~/.codex/archived_sessions` | Bounded record headers and allowlisted metadata from `turn_context`, `token_count`, `thread_settings_applied`, quota/accounting, tool-outcome, lineage, and compaction-boundary records. | Typed usage/quota/tool facts, timestamps, model/speed/reasoning/outcome enums, local HMAC join keys, source cursors, coverage and diagnostic codes. | Local filesystem only. | App **Erase local data** removes TiboTattle's projection, not Codex source files. |
| Codex configuration | `~/.codex/config.toml` | Only the top-level `service_tier` baseline used when a rollout has not yet recorded an observed speed. | Timestamped declared speed-baseline windows. An observed rollout value always wins. | Local filesystem only. | Local erase removes the derived baseline ledger; it never edits Codex config. |
| Codex selected-rollout store | `~/.codex/state_5.sqlite` | Read-only `threads.id` and `threads.rollout_path`, after owner/file/path validation, to select the physical head of a logical thread. | Only the validated selected rollout filename mapping needed during ingest. | Local filesystem only. | Local erase removes derived selection state; it never edits Codex SQLite. |
| Codex account/quota service | Local `codex app-server` subprocess using `account/read`, `account/rateLimits/read`, `account/usage/read`, and bounded update notifications | Current plan/account scope, quota windows, resets, credits-presence flags, and provider usage projection. | Sanitized quota/account observations and Keychain-HMAC account scope. No Codex authentication token is copied. | TiboTattle talks to a local subprocess. If Codex itself cannot refresh its account evidence offline, TiboTattle records the source as unavailable/stale rather than inventing continuity. | Local erase removes observations; identity reset separately rotates the Keychain pseudonym. |
The normal installed refresh does **not** read Claude Desktop quota history,
Claude prompt transcripts, Claude project files, or Gemini artifacts. Claude
prototype and benchmark readers remain in the source tree for development
evaluation, but the installed companion exposes no setting, route, UI, or
upload surface that enables them.

## Optional local integrations

| Integration | Activation | Data boundary | Persistence |
| --- | --- | --- | --- |
| Managed Claude status-line callback | Explicit standalone CLI install/repair lifecycle | Bounded JSON status input through the managed local broker; projected status/usage fields only. | Managed callback state plus provider-isolated pseudonym capability. This is not an installed-app feature. |
| Custom Codex home | User chooses a directory in Settings | It replaces the default Codex home anchor; the same fixed subpaths and allowlists apply. | Owner-only launcher setting. |
| Local cache-drop thread links | Local interactive dashboard, for recent displayed drops only | Read-only bounded `session_index.jsonl` (`id`, `thread_name`, `updated_at`) and `state_5.sqlite` (`id`, explicit `name`, worker nickname, and allowlisted `source.subagent.thread_spawn` ancestry). Never uses prompt-bearing `threads.title`, first messages, or transcripts. | Names and IDs exist only in a separate `no-store`, same-origin local response and transient UI memory. No snapshot/cache/report/share-card/diagnostic/contribution persistence. Clicking hands only the canonical thread UUID to the local Codex URL handler. |
| Export workspace | Explicit CLI or review flow | Only allowlisted metadata for the selected time range and sources. | Journaled workspace, chunks, manifest, and verification/deletion receipts at explicit paths. |
| Contribution preparation | Explicit review/consent flow | Closed telemetry schema; exact payload is locally reviewable before first approval. | Prepared spool/review archive and replay-safe sync state under the app state root. |

## Installed local state

The macOS app owns `~/Library/Application Support/Usage Monitor` with
owner-only permissions. Important entries include:

| State | Purpose | Retention behavior |
| --- | --- | --- |
| `local-unified-index-v1.sqlite` plus device salt | Canonical replay-safe Codex usage/quota/tool projection and source provenance. | Accumulates locally; the 30-day UI horizon is not retention. |
| `local-collector-state-v1.sqlite` | App-server quota observations, checkpoints, dedupe, locks, and replay-safe collector state. | Accumulates until explicit local erase or a reviewed migration/retention workflow. |
| `private/` settings/handoff state | Automatic/incremental contribution settings, bounded OAuth restart handle, fast-mode preference, and speed baselines. | Settings persist; the OAuth handle expires and is bounded. |
| Prepared contribution/review directories and queue | Exact local review, delivery, retry, and audit state. | Retained for replay-safe completion, explicit cleanup, or local erase. |
| Diagnostics log | Fixed error/status codes and opaque support references. | Bounded, content-free local diagnostics only. |
| WebKit website data | Loopback dashboard session/local storage and short-lived hosted web session state. | Cleared by **Erase local data**; provider pages use the system browser. |

The standalone CLI/developer default uses the platform-specific
`app-usagemonitor` state directory. The installed app supplies the stable
`Usage Monitor` state root. Documentation and support instructions must not
conflate those locations.

## Keychain and credential state

TiboTattle keeps separate credential capabilities for:

- export/contribution pseudonym identity;
- current account observation pseudonymity;
- the paired contribution-device credential.

The optional managed Claude callback has its own standalone CLI/local-review
pseudonym capability. It is not exposed by the native app.

These installed-app capabilities are served to the companion through the signed
native Keychain broker. A content-free binding/renewal record lives under Application
Support; it is not the credential. Keys are intentionally separate so one
identity namespace cannot be joined to another by accident.

The [silent native migration change](../decisions/2026-08-31-silent-keychain-migration.md)
adds a narrow compatibility helper for existing legacy keys. It authenticates
its native parent, accepts only fixed capabilities, and passes the unchanged
value over a private descriptor for app-owned storage and exact readback. It
adds no network destination, diagnostic field, consent, or uploaded data. The
legacy recovery copy is retained during migration. Automatic attempts cannot
open a Keychain prompt; only an explained native approval can do so. An explicit
credential reset removes that capability's legacy copy before its modern copy,
and waits for retiring companion writers before deletion. A failed deletion
does not authorize a new identity or inferred success. Signed synthetic
qualification is recorded in that decision; this source description does not
qualify an installed upgrade.

**Reset identity and device** is a separate two-step action from local data
erase. It removes the selected local Keychain capabilities and associated app
state; it does not represent hosted participant deletion. A locked Keychain is
a temporary availability condition, not evidence of a corrupt credential.

## Optional hosted contribution

In the released native and standalone flow, contribution is off until the
person completes the review, identity, consent,
and pairing flow. A contribution can include closed-schema derived fields such
as:

- opaque participant/session/event pseudonyms and schema versions;
- provider/plan/model families and observed speed/reasoning categories;
- timestamps, token counts, standard API-price-equivalent cost, quota windows,
  resets, coverage, and fixed diagnostic/outcome codes; and
- source/provenance versions needed for replay, deduplication, and correction.

It excludes prompts, responses, reasoning text, commands, repository/file
paths, URLs, credentials, emails, account names, raw local account identifiers,
and arbitrary metadata. Canonical schemas and mirror ownership are listed in
[`schema-contracts.md`](./schema-contracts.md).

Hosted storage uses Cloudflare D1 for identity/session/device/contribution and
derived aggregate state, R2 for encrypted contribution objects and update
artifacts, and a Durable Object for shared upload admission. Public community
figures are derived, delayed, rounded/capped, and withheld when privacy or
quality thresholds are not met.

Stable pseudonyms and identity reattachment permit longitudinal linkage.
Content-free, pseudonymous contribution is not anonymous data.

### Account/plan attribution successor (staged)

The source includes a closed v1.1 successor, disabled for new writes by default
until a separately authorized hosted cutover. Its additional fields are account
basis, a purpose-separated account pseudonym or null, plan basis/type, and an
opaque plan-era pseudonym or null. The exact field inventory and derived sample
must be reviewed; an explicit hosted-session consent grant and local approval
bind the new schema, field dictionary, privacy contract and destination. Existing
consent, pairing or an app update alone does not authorize these fields.

The derivation reuses a leased existing account-observation root. It binds to
the canonical destination and authenticated enrollment namespace, never creates
a missing root during export, and makes no cross-device identity claim. Missing
root/history proof leaves attribution unknown without dropping raw local usage.
Current quota capture is bracketed by compatible account reads; logout, read
failure and disagreement clear provisional markers. Markers cannot tag history
before capture and are not upgraded to exact source proof.

Day chunks remain staged until one complete replacement domain passes source,
occurrence and base-accounting compatibility checks. Old accepted data remains
stored; a partial replacement cannot become a hybrid primary. Immutable consent
grants, enrollment bindings, staged chunks and active domains participate in the
existing owner-erasure/restore boundaries. Device disconnect retains accepted
history; format rollback changes upload admission only, not the selected data.
No account/era pseudonyms or finer account cells are added to public aggregates.

An owner-only progress file beside the local index preserves interrupted
replacement uploads. Its closed, at-most-1-MiB payload contains day/manifest
digests and control fingerprints, never credentials, root bytes, account
markers or raw provider identifiers. Loss of this file can require revalidation
and retry, but it does not erase local evidence or accepted hosted history.

Accepted v0.2 history keeps its existing analytical source. Until a compatible
replacement adapter exists, this history blocks the stronger-format upgrade
before consent or admission-floor changes; disjoint dates do not make it safe
to hide the old source. No local or hosted history is deleted by this refusal.

## Network destinations

| Destination | When used | Data sent |
| --- | --- | --- |
| `https://tibotattle.com` | Public community reads, hosted identity/session, optional contribution, participant export, device disconnect, app compatibility/preflight. | Route-specific closed requests; contribution requires consent and one-use/device authority. No self-service hosted deletion. |
| `https://admin.tibotattle.com` | Owner operations only, including explicitly targeted participant erasure. | Cloudflare Access owner assertion and bounded admin reads/actions with CSRF on mutations. The app is not an admin client. |
| `https://updates.tibotattle.com/appcast.xml` | Sparkle update checks. | Standard update request metadata; the signed appcast declares the artifact. |
| Google or Apple identity endpoints | User starts hosted sign-in in the system browser. | Provider-controlled sign-in. The provider callback goes to TiboTattle's Worker, not loopback. |
| Artifact URL from the verified appcast | User/automatic updater downloads an update. | Standard artifact request; signature, length, and digest/provenance gates remain separate. |

The loopback companion is not a general proxy. It forwards only fixed routes
and bounded headers listed in [`api-surface.md`](./api-surface.md).

## Hosted lifetimes and deletion behavior

These current source constants describe credential/control windows, not a
promise that every data class is deleted on the same schedule:

| Data/control | Current lifetime |
| --- | --- |
| Web session | 30 minutes |
| One-use upload authorization | 5 minutes |
| Device pairing claim | 10 minutes |
| Device credential | 30 days, silently renewable by the same valid device |
| Hosted identity authorization handoff | 10 minutes |
| Completed identity-result delivery window | 5 minutes |
| Sign-in admission rows | 24 hours |
| Identity re-enrollment cooldown | 30 days |
| Deletion tombstone | 400 days in source, to suppress erased participant data after restore replay; not a verified production backup/retention guarantee |
| Sampled admin diagnostics | 30 days |
| Contribution quarantine age deletion | Disabled in current source; private owner erasure and orphan reconciliation remain separate operations |

There is no blanket short time-based retention promise for accepted
contribution/aggregate evidence in current source. Participant capabilities
retain hosted export and device revoke/disconnect, but neither whole-account
nor individual-contribution self-service deletion is available. Disconnecting
does not shorten retention or remove previously accepted data.

Private owner erasure fences uploads, withdraws affected aggregates, records an
independently verified deletion tombstone and identity cooldown, removes owned
R2 objects, and completes participant database removal. Immutable aggregate
revisions may remain withdrawn; replacement publication must exclude the erased
participant. A tombstone, cooldown, or content-free operational audit is not
removed merely because the participant's data has been erased. Local history,
provider-side sign-in records, and provider source files are separate.

The deletion ledger must still suppress erased data after backup restore.
For tombstoned participants, restore replay claims only active rows or
interrupted restores with a null deletion fence; it must not take over
non-null owner/legacy erasures. A busy restore is finished/retried by
maintenance, not a concurrent owner erasure; final removal must still match
the restore or owner fence.
The actual production backup/restore horizon and infrastructure log/object
policies require independent verification; the constants above do not
establish them.
This retirement adds no migration, retention change, or tombstone removal.
See [production operations](../runbooks/production-operations.md#private-owner-participant-erasure)
for the protected procedure and [SUPPORT.md](../../SUPPORT.md#hosted-history-and-privacy-requests)
for the privacy-request intake boundary. Retiring a control is not a conclusion
about applicable privacy rights or how a particular request should be resolved.

## Separate deletion actions

| Action | Removes | Does not remove |
| --- | --- | --- |
| **Erase local data** | Moves the installed app's Application Support state root to Trash and clears TiboTattle WebKit data. | Provider source files, Keychain capabilities, or hosted data. |
| **Reset identity and device** | Reviewed TiboTattle Keychain capabilities plus their associated local binding/app state. | General local analysis state unless the reset contract explicitly reports it; hosted contribution records. |
| **Disconnect this Mac** (confirmed) | Hosted authority for this device plus its local device credential/binding; pauses delivery. | Other devices, hosted participant data, or local analysis. |
| Private owner participant erasure | Hosted participant/account, contribution, session, and device state through the protected pipeline; affected aggregates are withdrawn/rebuilt. | Local analysis, provider source files, retained safeguards/audit, or immutable withdrawn aggregate revisions. |
| Ordinary app/Homebrew uninstall | Application binaries. | By design, local state and Keychain survive ordinary uninstall. |
| Homebrew `--zap` | Declared app Application Support/cache/WebKit/preferences. | `~/.codex`, Keychain identities, or previously hosted data. |

Use the app's explicit controls before uninstall when the intent includes
local cleanup or device disconnect. They cannot perform private owner erasure.
Do not manually delete the only local index as a repair technique; follow
[`../runbooks/unified-index-recovery.md`](../runbooks/unified-index-recovery.md).

## Coverage and uncertainty

- Missing, inaccessible, stale, partial, or unattributed evidence is shown as
  such; it is not converted to zero.
- A provider quota snapshot is provider-reported status, not proof of billing
  semantics or a guaranteed future allowance.
- Standard API prices are a comparison normalization, not subscription billing.
- A 30-day chart is a display window, not proof that older local data was
  deleted.
- Public aggregates do not prove a specific person's contribution, account,
  device, plan, or activity.

## Updating this inventory

Any shipping source reader, subprocess RPC, local store, Keychain item, network
destination, contribution field, retention constant, or erase/uninstall
behavior must update this file, the public privacy page, localized first-run
and refresh disclosure, and source-backed privacy tests in the same change.
Obsolete privacy documents should be deleted once this maintained inventory
supersedes them; retaining contradictory consent boundaries is a product bug.
