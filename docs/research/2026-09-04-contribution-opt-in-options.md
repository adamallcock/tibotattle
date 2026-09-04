---
title: Easier community contribution and consent options
date: 2026-09-04
type: research
status: proposed
---

# Easier community contribution and consent options

Recommendation: keep explicit opt-in; first make the existing sign-in-once
flow dependable and understandable, then test accountless contribution with
credentials created after consent. Default-on upload is not recommended for
the current linked usage dataset. Authentication, consent and background
delivery are separate decisions: removing an account requirement does not
require removing consent.

This is research and a proposed workstream, not a change to defaults,
credentials, collection, retention or production. It complements the
[desktop convergence plan](../plans/2026-09-04-desktop-convergence.md) without
putting a new enrollment design on the desktop migration's critical path.

## Evidence boundary

Inspected application source is `origin/main=9e1c3333`, available in this
planning worktree. Pinned native release checkpoint `5ff2713a` has unchanged
contribution `app.js`, `index.html` and local server compared with that base.
The separate credential-lifetime branch is `9244830c`, with four dirty tracked
files; committed and uncommitted proposals are distinguished below.

Read-only public [health](https://tibotattle.com/api/health) on 2026-09-04
reported deployment `b4c8f103bf697fb530434e6de196f2c187645661`, open enrollment,
operational collection, and externally authorized incremental v1.0 uploads.
It reported account-scoped v0.2 disabled. It also advertises participant
deletion, whereas newer source retires self-service deletion. This is a
source/deployment discrepancy to resolve before designing removal copy; the
health flag does not prove that an authenticated deletion works. No sign-in,
enrollment, private-data inspection, upload or deletion was performed.

There is no current measured funnel in this research. Historical download or
install estimates are not a reliable denominator for contribution conversion.
The recommendations below are engineering/product judgments, not demonstrated
percentage improvements.

## The current flow is already short on the happy path

1. Open Community and choose Google or Apple sign-in in the system browser.
2. TiboTattle prepares and validates a local review sample automatically.
3. Review the displayed scope and click **Review and approve** once.
4. Enrollment, device pairing, protected credential storage and first-history
   delivery run internally. New measurements follow while the app is running.

There is no user pairing code, mandatory manual export, or approval for every
batch. Browser-session expiration is not supposed to stop a valid paired
device from uploading. The existing UX should not be redesigned around
imaginary extra steps.

Source reveals more specific opportunities:

| Finding | Consequence and proposed improvement |
|---|---|
| Review bootstrap tries a 24-hour export, then one hour if too large; even that can exceed limits or time out | Approval can remain unavailable. Spike a bounded, verified representative review from the validated index, while retaining complete scope disclosure and exact review/consent binding |
| User-visible review shows coverage, item count and bytes | Add optional human-readable field/sample details. Make clear that the representative sample does not limit the full-history permission |
| Heading says “Contribute anonymous usage data” | Correct to “Share usage statistics” and explain pseudonymous linkage; the maintained user guide already says the records are not anonymous |
| Full history and six-hour update wording omits runtime/coverage conditions | State available indexed history, future collection while running, and measured coverage; do not imply continuous delivery when the app is closed |
| Returning repair can still say “Review and approve” while approval remains recorded | Say “Reconnect sharing” when existing consent is valid; reserve new approval for actual consent changes or explicit rearming after disconnect |
| Recovery exposes device/Keychain/protocol machinery | Present one truthful state and next action, with technical details in diagnostics; locked key storage is temporary unavailability, not permission to reset identity |

Entry discovery may be another limitation, but it is unmeasured. A prior
August 2026 workstream intentionally omitted a post-first-analysis invitation.
This research proposes revisiting that choice: consider one dismissible inline
card after useful local results, or improve the persistent Community entry.
Keep the core dashboard available, preserve a durable decline, and avoid
repeated reminders. Do not automatically prepare optional exports merely
because someone installed the app; start preparation when they enter the
sharing review.

## What comparable products establish

These are current documented patterns, not conversion studies or verified
enrollment journeys. Common Voice's account rule was read through indexed
primary terms/privacy text; direct page extraction returned a JavaScript shell.

| Product | Verified pattern | Transferable lesson and limitation |
|---|---|---|
| [KDE](https://kde.org/privacypolicy-apps/) | Optional telemetry is disabled by default and preferences remain changeable | Explicit opt-in can be an ordinary in-app setting. KDE's [no-unique-identifier policy](https://community.kde.org/Policies/Telemetry_Policy) differs from TiboTattle's longitudinal records |
| [Homebrew](https://docs.brew.sh/Analytics) | Opt-out after advance notice; aggregate events have no user-ID field and are not used to build an individual's history | Useful example of background delivery and narrow data scope. It is not a direct precedent for default-on full-history contribution |
| [Firefox](https://support.mozilla.org/en-US/kb/technical-and-interaction-data) | Technical/interaction collection has an opt-out control and associated deletion handling; a separate daily-usage ping has a separate setting | Its [profile telemetry identity](https://docs.telemetry.mozilla.org/concepts/profile/profile_creation) illustrates account-independent collection. Avoid an apparently comprehensive off switch that leaves another optional stream running |
| [Common Voice](https://commonvoice.mozilla.org/terms) | Current terms permit participation without an account, with accounts required for some extra features; contributions have an explicit public-dataset license | Dataset donation does not inherently require account creation. Its public voice-data license and retention model are substantially different |

The [ICO's consent guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/consent/how-should-we-obtain-record-and-manage-consent/)
expressly permits account-free consent, active opt-in buttons and layered
information. It calls for an audit trail and withdrawal controls and does not
accept preselected/default settings as consent. This supports a simpler
permission interface without a forced account ceremony.

## Options and recommendation

| Option | User experience | Engineering / data-quality cost | Recommendation |
|---|---|---|---|
| A. Reliable sign-in once | Existing browser sign-in and one approval; subsequent renewals/recovery mostly internal | Smallest change; retains current participant continuity and backend contracts | Do first |
| B. Accountless explicit opt-in | Review, press Enable sharing; app establishes an installation credential | New secure enrollment, recovery and contributor-eligibility policy; existing upload pipeline mostly reusable | Preferred experiment for the unified app |
| C. Accountless plus optional later linking | B, with account linking for recovery or multi-device management | Identity merge/conflict rules and two management paths add complexity | Defer until demand justifies it |
| D. Default-on current contribution | Starts sending linked historical/future usage unless disabled | Changes the published promise, legal basis and expectations; still needs secure enrollment and abuse protection | Do not adopt for this dataset |
| E. Separate minimal anonymous analytics | Coarse product-health counters with no longitudinal identifiers | New payload/purpose/retention design; cannot replace the current allowance evidence | Consider only for a separately demonstrated need |

### A: improve the working architecture first

Prioritize privacy wording, bounded review readiness, reliable browser return,
clear connection states, and existing renewal/repair work. Keep one sharing
panel: off, connecting, sharing, paused or needs attention, with detailed
protocol states behind it. Preserve separate consent and connection state
internally so a retry neither revokes permission nor silently grants it.

The credential branch contains three unmerged commits worth reviewing:

- `07d5f0fb`: renewal scheduled proportionally to observed credential lifetime.
- `be3da7eb`: device credential/idle bound extended to 90 days.
- `9244830c`: separate server authorization refusal from unavailable local
  credentials, allowing a clearer returning-user reconnect path.

Current main still uses a 30-day device/idle bound and 180-day social recheck;
the browser session is 30 minutes. Renewal already exists. A proposed ten-year
social recheck is uncommitted and is a separate security decision, not a
prerequisite for easier opt-in. Prefer revocable, renewable credentials and
tested lapse recovery over an effectively permanent token.

Integrate these patches with current serialization/ambiguous-rotation repair
logic; do not copy the older worktree wholesale. Check mixed old/new client
and server lifetime handling before rollout. Test long offline intervals,
clock differences, locked stores, interrupted rotation and revoked devices.
Consent to changed fields or a new provider remains a separate decision.

### B: create the credential invisibly after a real choice

The server's Google/Apple requirement is a production enrollment policy, not
a requirement of the measurement schema. Its repository can already create
random participant identities without an identity-link key. Uploads already
authenticate through scoped device credentials independently of browser login.

Proposed flow:

1. Open a local review showing the actual data categories, history scope,
   destination, ongoing behavior, retention and available removal controls.
2. User presses **Enable sharing**. Record versioned consent and use a
   dedicated bounded enrollment bootstrap to create the installation's
   contribution authority. A consent receipt alone is not proof of a human
   or protection against a malicious client.
3. Store the secret through the existing secure OS adapter. Keep enrollment
   and first send retry-safe; if storage fails, preserve local-only operation
   and give an actionable failure. Never embed a shared API secret in the app.
4. Reuse existing upload authorization, validation, encryption, deduplication,
   revocation and renewal. Do not expose the development enrollment bypass.

The important cost is trustworthy contributor continuity. Current Google/Apple
identity binds issuer/subject to a participant; it does not prove one human or
one Codex account. Current limits and source selection nevertheless rely on
that continuity. Reinstalling or cloning an accountless app can otherwise
create multiple participants and evade per-participant limits.

Before accountless data affects public estimates, define enrollment budgets,
replay/duplicate defenses and eligible independent-contributor semantics.
Challenge suspicious enrollment if needed, rather than making every person
complete a challenge. IP limits are only one abuse signal and must tolerate
shared networks; app signatures, local keys and challenges do not establish
unique people. Do not introduce hardware fingerprinting or silently join
provider-account pseudonyms across devices.

Run a bounded accountless pilot separately from current public eligibility.
Do not count installations toward existing participant thresholds merely
because they upload valid records. Current daily source selection chooses a
winning device per participant/day. The allowance median uses qualifying reset
fits and reports distinct participant counts separately; weekly cohorts have
their own participant-support thresholds. This is not a one-person, one-vote
estimator. Test cloned profiles, reinstallation, overlapping histories and
mixed authenticated/accountless cohorts before promotion.

Accountless recovery is also a product decision: losing the installation key
loses its continuity unless a separately designed recovery capability exists.
An upload token must not silently gain whole-account export/erase powers.
Keep management authority purpose-scoped, preserve tombstones and define a
verified ownership/removal route. Optional later linking must resolve existing
history without duplicate evidence; it is deliberately outside the first pilot.

### D: why default-on is a poor fit here

TiboTattle's [published privacy overview](https://tibotattle.com/privacy)
promises review and opt-in before contribution. Its current contribution
includes timestamps and stable pseudonymous session linkage, potentially
covering available historical usage. This is materially different from a
coarse installation counter. Existing users' choices must survive upgrades.

The [ICO explains](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/pseudonymisation/)
that pseudonymisation does not make data anonymous to a party holding the
additional linking information. Removing Google sign-in alone also does not
prove anonymity: persistent keys and activity patterns still require an
identifiability assessment.

Default-on processing is not universally prohibited: GDPR has
[multiple lawful bases](https://www.edpb.europa.eu/topics/key-gdpr-concepts/legal-basis_en).
But default selection cannot be presented as consent. A different basis would
need jurisdiction-specific review of this actual purpose, dataset, user
expectations and applicable device-access rules. Narrow audience-measurement
exceptions, such as [CNIL's conditions](https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications),
do not automatically cover a linked community research dataset. This is
product/legal issue-spotting, not a conclusion about every jurisdiction.

E would require genuinely different data minimization and retention choices.
Do not start collecting extra analytics as an unannounced way to measure
whether people consent to contribution. Differential privacy or secure
aggregation could be investigated if necessary later; neither is a small
replacement for the longitudinal observations the current estimator uses.

## Proposed consent wording and controls

Illustrative accountless-pilot copy; exact fields must come from the active
schema and actual prepared review, not this example:

> Help improve community allowance estimates.
>
> Share derived Codex usage measurements, including models, token counts,
> quota changes, timestamps and pseudonymous session IDs. Prompts, responses,
> file paths and commands are excluded.
>
> Share available indexed history, then new measurements while TiboTattle is
> running. You can stop future sharing in Settings. Previously contributed
> records are retained; see retention and removal details.

Actions: **See the data** · **Keep local** · **Enable sharing**. Keep the choice
clear and accessible, with no preselection or blocked local features. For A,
retain an honestly labelled sign-in step; do not advertise accountless access.

Show real history coverage and the difference between the review sample and
the whole approved stream. If user research finds full-history scope itself
causes refusal, assess a bounded-history/future-only option against calibration
and replacement-domain requirements before implementing it. A shorter initial
scope is not automatically compatible with the current contribution protocol.

Stopping future collection, revoking a device and removing already stored data
are distinct. Explain them plainly. Current source's owner-operated erasure
and live health's different claim must be reconciled; do not promise an instant
delete button or invent a retention deadline. Provide a documented workable
request route before promoting broader participation. Adding a new self-service
erase capability requires a separate reviewed decision.

Codex approval must not silently become Claude approval. The unified app can
use one shared consent/connection implementation with explicit provider and
schema scope; preserve current grants and identity during desktop migration.

## Measure the result and keep delivery bounded

Measure completed contribution, not just agreement clicks. Use existing
authorized operational records where adequate; introduce any new instrumentation
with an explicit minimal-data purpose and disclosure. Do not collect private
paths, raw accounts, payloads or logs for funnel analysis.

- Among people starting sharing: sign-in completion, review readiness, approval
  attempt, successful pairing, first server-accepted upload, and time between
  those states. Keep denominators and repeated attempts distinct.
- Among consenting contributors: continued delivery at 7/30 days while active,
  reconnection frequency, accepted useful evidence, and withdrawal/failure rates.
- Validate discoverability with a small voluntary usability study or local
  diagnostics volunteered by testers. Downloads do not establish installations,
  active eligible users or invitation exposure.
- Compare source/version/platform cohorts and disclose opt-in selection bias.
  Increasing contributor count does not by itself make the sample representative.

First implementation slice: repair A and verify it on the installed app, using
the existing State Lab and real authorized end-to-end qualification. Success
means first use, browser cancellation/retry, restart, credential lapse and
disconnect all produce one understandable state and preserve consent/history.
Decide on the optional invitation separately from credential work.

Then spend a short design/spike cycle on B. Exit with explicit admission,
eligibility and lost-key decisions plus a consent-bound synthetic enrollment
demonstration. Keep pilot data out of public participant counts until those
gates pass. Do not build C, a new identity platform or E as prerequisites.

## Source references

At `9e1c3333`, unless another revision is named:

- `apps/web/public/index.html:1038,1145,1168,1289`: wording, intended one-step
  approval, full-history scope and disconnect.
- `apps/web/public/app.js:10739,10898,12830,13339,13791`: review sample,
  bounded-preparation failures, browser handoff, state and internal pairing.
- `apps/worker/src/identity-oidc.ts:275,402` and `repository.ts:188,246`:
  production identity requirement, HMAC linkage and reusable enrollment/grants.
- `apps/worker/src/device-auth.ts:128,677,1068,1167`: lifetimes, pairing,
  device authorization and rotation; `constants.ts:14,26`: session/device TTLs.
- `apps/worker/src/admission.ts:142,193`,
  `community-daily-aggregates.ts:256`, `community-allowance.ts:352`,
  `community-snapshots.ts:681`: rate limits, source winners and cohort semantics.
- [User guide](../user-guide.md), [privacy inventory](../reference/local-data-and-privacy.md)
  and [self-service retirement decision](../decisions/2026-08-30-self-service-deletion-retirement.md):
  accepted local/source promises; deployment must be checked separately.

Only research documentation was changed. No enrollment or conversion lift,
accountless security qualification, legal clearance, or live upload success
is claimed by this document.
