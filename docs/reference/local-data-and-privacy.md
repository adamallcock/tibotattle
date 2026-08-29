---
title: Local Data, Network, and Privacy Inventory
date: 2026-08-27
type: reference
status: maintained
last_verified_commit: 52399658
---

# Local data, network, and privacy inventory

This is the maintained technical inventory behind TiboTattle's first-run and
public privacy disclosures. It describes what the shipping app can read, what
it derives and stores, which operations use the network, and which deletion
actions are intentionally separate.

The central rule is structural: prompts, responses, reasoning, raw commands,
credentials, private paths/filenames, emails, account names, and other free
text have no allowed destination in contribution schemas, diagnostics, or
public aggregates. Unknown fields are omitted; an input that cannot be safely
projected is refused or shown as unavailable.

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

The device credential is served to the companion through the signed native
Keychain broker. A content-free binding/renewal record lives under Application
Support; it is not the credential. Keys are intentionally separate so one
identity namespace cannot be joined to another by accident.

**Reset identity and device** is a separate two-step action from local data
erase. It removes the selected local Keychain capabilities and associated app
state; it does not represent hosted participant deletion. A locked Keychain is
a temporary availability condition, not evidence of a corrupt credential.

## Optional hosted contribution

Contribution is off until the person completes the review, identity, consent,
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

## Network destinations

| Destination | When used | Data sent |
| --- | --- | --- |
| `https://tibotattle.com` | Public community reads, hosted identity/session, optional contribution, participant export/delete, app compatibility/preflight. | Route-specific closed requests; contribution requires consent and one-use/device authority. |
| `https://admin.tibotattle.com` | Owner operations only. | Cloudflare Access assertion and bounded admin reads/actions. The app is not an admin client. |
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
| Deletion tombstone | 400 days, to suppress deleted data after restore replay |
| Sampled admin diagnostics | 30 days |
| Contribution quarantine age deletion | Disabled in shipped source; explicit participant/contribution deletion and reconciliation still apply |

There is no blanket short time-based retention promise for accepted
contribution/aggregate evidence in current source. Participant actions provide
export, device revoke/disconnect, and complete
hosted participant deletion. The deletion ledger persists a tombstone so a
backup restore cannot silently resurrect deleted participant data.

## Separate deletion actions

| Action | Removes | Does not remove |
| --- | --- | --- |
| **Erase local data** | Moves the installed app's Application Support state root to Trash and clears TiboTattle WebKit data. | Provider source files, Keychain capabilities, or hosted data. |
| **Reset identity and device** | Reviewed TiboTattle Keychain capabilities plus their associated local binding/app state. | General local analysis state unless the reset contract explicitly reports it; hosted contribution records. |
| **Disconnect this Mac** | Hosted authority for this device plus its local device credential/binding; pauses delivery. | Other devices, hosted participant data, or local analysis. |
| Delete hosted participant | Hosted participant/account, contribution, session, and device lifecycle with a deletion tombstone. | Local analysis or provider source files. |
| Ordinary app/Homebrew uninstall | Application binaries. | By design, local state and Keychain survive ordinary uninstall. |
| Homebrew `--zap` | Declared app Application Support/cache/WebKit/preferences. | `~/.codex`, Keychain identities, or previously hosted data. |

Use the app's explicit controls before uninstall when the intent includes
Keychain or hosted deletion. Do not manually delete the only local index as a
repair technique; follow
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
