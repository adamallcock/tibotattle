---
title: Open Enrollment Social Identity Remediation Plan
date: 2026-08-04
type: plan
status: implemented_pending_release
---

# Open enrollment social identity remediation plan

## Decision

Use Google and Sign in with Apple as the mandatory, privacy-minimised account
gate for open contribution enrollment. Treat a successfully verified provider
account as one provider-account-backed contributor unit: it is a reasonable
friction and recovery key for this product, but not a proof of one natural
person, one household, one device, an independently sampled participant, or
truthful telemetry.

The product accepts the residual risk that a determined actor can create or
operate multiple provider accounts. Safety comes from making each account's
influence bounded, delaying and suppressing public release, detecting abuse,
and describing the data accurately—not from claiming that OIDC solves Sybil
resistance or data provenance.

Retain the current server-owned authorization-code flows, HMAC-only identity
linking, one-use handoffs, device upload authority, envelope validation, and
server-side repricing. Do not introduce an anonymous passkey or recovery code
as an alternate open-enrollment route: it would create an easier second
identity class and dilute the chosen provider-account barrier. A passkey may
later be added only as a secondary credential attached to an already verified
social account.

The normal contribution schedule remains friction-free. Google/Apple are used
at first connection, recovery/add-device, explicit account switch, and other
high-risk actions—not every six hours. A separately scoped device credential
continues to mint the short, one-use upload authority in the background.

No hosted deployment is implied by this plan.

## Implementation checkpoint — 2026-08-04

The source changes for the contained launch design are implemented in this
worktree. Staging and production enrollment remain explicitly **disabled**;
this is a code-and-migration checkpoint, not authorization to accept public
contributors or to deploy.

| Delivered control | Concrete implementation |
| --- | --- |
| Social identity containment | Google/Apple starts refuse disabled enrollment and a disabled enrollment collection control before rate-budget use, handoff allocation, or provider redirect. `wrangler.jsonc` keeps staging and production disabled. |
| OAuth binding and minimisation | Apple has a random nonce, stores only its SHA-256 digest in a five-minute handoff, and validates the signed returned nonce. Google keeps state and S256 PKCE. Provider access, refresh, ID, code, name, email, and raw subject values are not persisted. |
| Distributed start budget | A D1 atomic UTC-minute counter (`0026`) bounds starts across Worker locations before a handoff is written. It retains only aggregate counts for 24 hours. |
| Honest session and device lifecycle | A restored service session renders as signed in and can be explicitly logged out. Disconnect this Mac first serializes local delivery mutations, revokes the remote device and pending/consuming upload authorizations, then clears only the matching local Keychain binding. |
| Friction-free bounded upload authority | An active device silently slides its 30-day expiry only while recently used and never beyond a 180-day social-verification horizon. There is no OAuth refresh token and no six-hour prompt. |
| Account/device limits | Default limits are three active recently used devices, three pairing issues per hour, and six claims per hour. Expired, idle, or invalid device state is revoked by scheduled bounded maintenance. |
| Deletion and re-entry | A fixed 400-day restore tombstone expires/purges in bounded pages. `0027` writes a 30-day purpose-separated HMAC cooldown to primary D1 before removing the old unique link, mirrors it to the independent ledger, and atomically rejects a fresh participant `INSERT` while it is live. The transient insert guard is cleared in the same enrollment transaction. |
| Identity-key continuity | `0028` pins a non-secret `IDENTITY_LINK_SECRET_VERSION` and a one-way HMAC fingerprint of the configured link secret in primary D1. A change to either fails closed before a hosted sign-in, enrollment, callback completion, or deletion can silently create a new identity namespace. |
| Descriptive aggregate contract | `0023` adds account maturity, provider-account eligibility, cross-cell account clipping, auditable exclusions, deterministic withdrawal/rebuild, and `community-weekly-snapshot-v0.3` terminology. Policy storage and browser validation permit only a stricter policy than the published 20-account / 7-day / 2-collection-day / baseline-cap contract. Existing published/suppressed snapshots are withdrawn and rebuilt rather than relabelled. |
| Local report and migration safety | Legacy report reads/migration and all canonical writers now reject ancestor/final symlinks, use descriptor-bound bounded reads, and publish through a private same-directory staged file with no-follow, fsync, revalidation, and atomic rename. |
| Release evidence | `npm --prefix apps/worker run release:preflight` is a local-only, disposable D1 migration/schema rehearsal for both primary and deletion-ledger streams. The controlled-release runbook records the remaining account-owner checks and explicit no-enable boundary. |

The remaining release gates are intentional and must stay open until verified
against real infrastructure:

1. Run the local disposable D1 preflight, then deploy the reviewed Worker
   revision **while enrollment remains disabled**, drain all old Worker
   identity traffic, and only then apply the complete migration set
   `0023`–`0028` in a disabled staging environment. A `0023`–`0026` rehearsal
   alone does not exercise the selected re-entry and identity-key continuity
   controls. The reverse schema-before-code ordering is unsafe: an old
   deletion worker can remove an identity link without writing the new primary
   cooldown marker. Verify rollback/withdrawal behaviour with representative
   state. The local preflight is evidence only; it does not contact Cloudflare
   or prove the deployed migration state or rollout order.
2. Provision and independently verify Google/Apple portal settings, exact HTTPS
   callback origin, secrets, callback URL redaction, and the signed native
   browser journeys. Do not infer them from source configuration.
3. Configure and exercise dashboards/alerts for start-budget exhaustion,
   handoff outcomes, device-limit outcomes, exclusions, and the enrollment kill
   switch. The code records bounded state; operations still need an owner and
   alert destination.
4. Add Turnstile only after a risk rule, site key, server-side Siteverify,
   hostname/action binding, and accessibility/retry journey are approved. It
   is **not** implemented by this change and must never gate six-hour uploads.
5. Run measured staging/load tests for distributed starts, pairing, one-use
   uploads, aggregate rebuilding, disconnect races, and reconnect at the
   social-recheck boundary. Tune the hard-coded launch candidates from those
   results before enabling enrollment.
6. Publish the documented deletion/re-entry policy and obtain explicit release
   authority to change either staging or production enrollment from `disabled`.

This plan supersedes the account-choice conclusion in the
[pseudonymous contribution identity plan](2026-08-04-pseudonymous-contribution-identity-remediation-plan.md).
It complements, rather than replaces, the callback, cookie, and native-browser
hardening in the [hosted identity remediation plan](2026-08-04-hosted-identity-remediation-plan.md).

## The assurance contract

The product must state the claim it is actually making. The following contract
is deliberately narrower than "we know who the user is":

| Property | Product guarantee | Explicit non-guarantee |
| --- | --- | --- |
| Account continuity | The same validated issuer and subject reattach to the same active participant. | The account represents one unique human or household. |
| Open-enrollment friction | A new public contributor completes Google or Apple authentication and normal provider/browser risk checks. | A determined actor cannot make, buy, borrow, or automate multiple provider accounts. |
| Background delivery | A paired Mac with a valid scoped credential can send a bounded prepared payload without another browser login. | The device credential proves an unmodified app or truthful local observation. |
| Ingestion integrity | The Worker accepts only a body-bound, one-use, bounded, schema-valid envelope and server-reprices accepted records. | The reported event was observed from the claimed source rather than fabricated by a user-controlled client. |
| Public aggregate | Each provider-account-backed participant has bounded, clipped influence; releases are delayed, thresholded, rounded, and can be withheld. | The result is a population estimate, an independent sample, or immune to coordinated multi-account manipulation. |

Use the phrase "open, voluntary, provider-account-gated, self-reported
telemetry" in public material. Do not use "verified usage," "independent
participants," "one person one vote," or population-wide language for an open
cohort. NIST distinguishes digital identity, authentication, and identity
proofing, and expressly permits pseudonymous accounts where real-life identity
is not needed. OIDC and the providers give a durable account identifier, not
proof of the person behind it.

## Why social sign-in now fits the requirement

Google documents subject as a unique, stable identifier for a Google Account,
and Apple exposes a team-scoped user identifier. The present Worker derives an
HMAC of issuer and subject and stores only that opaque link key; it requests
neither a name nor email and discards provider access/refresh tokens.

That is an appropriate privacy/security trade-off for the stated goal:

```text
Google or Apple browser authentication
    -> short, one-use hosted proof
    -> HMAC-only provider-account link
    -> one active participant and paired-device relationship
    -> bounded server-side contribution pipeline
    -> delayed, clipped, descriptive aggregate
```

No external identity SaaS is needed to obtain this property. The existing
oauth4webapi verifier plus provider protocols are the maintained,
standards-based component. A managed auth product would add another processor
and another session/token surface, but would not make a provider account a
unique human or prove locally generated data. Use native
ASWebAuthenticationSession for the browser ceremony and the existing Worker
for the exchange; do not use an embedded web view for OAuth.

## What the current implementation already gets right

| Area | Present behaviour | Keep it |
| --- | --- | --- |
| Google | Server-owned authorization-code flow, S256 PKCE, one-use state, exact redirect, fixed openid scope, server token exchange. | Yes. This is the correct confidential/server-side pattern. |
| Apple | Server-owned web code flow, five-minute state/handoff, HTTPS return endpoint, short server-minted client-secret JWT, empty scope, and a digest-only per-transaction nonce binding. | Yes. |
| Identity storage | OIDC verification pins issuer, audience, JWKS signature, RS256, time claims, and derives only HMAC of issuer/subject. | Yes. Do not store raw subject, email, name, access token, refresh token, or ID token. |
| Reinstall/recovery | A matching link key reattaches the existing active participant rather than minting another one. | Yes. This is the useful deduplication property. |
| Automatic upload | A recently active device slides a 30-day expiry up to a hard 180-day social-verification deadline, then mints short one-use, body-digest-bound upload authority. | Yes. It is separate from the browser session, so no six-hour social login is needed. |
| Ingestion | The Worker validates/decrypts envelopes, checks replay digests, validates records, and server-reprices accepted data. | Yes. It keeps local editing from bypassing protocol and accounting constraints, not from fabricating plausible source data. |
| Weekly snapshots | Accepted records are delayed, thresholded, per-cell suppressed, provider-account matured, account/cell clipped, rounded, and sealed into revisions. | Yes. Use `v0.3` descriptive provider-account terminology. |

The existing HMAC identity link is a good minimisation choice. It is still a
pseudonymous account-derived datum and must be covered by the privacy notice,
access controls, deletion policy, and key-rotation procedure. The link secret
is continuity-critical: do **not** rotate `IDENTITY_LINK_SECRET` or its
non-secret version label in place. The implementation pins both a version and
a keyed fingerprint and fails closed on a mismatch. A future rotation requires
a separately reviewed dual-key migration/relink plan, with enrollment contained
throughout; it is not an incident-response shortcut.

## Red-team assessment and required response

| Attack or failure | Current position | Required response before public authorization |
| --- | --- | --- |
| Same provider account reinstalls the app | It reattaches to one participant. | Preserve unique link-key semantics and test replay/reinstall after every migration. |
| Same person uses Google and Apple, or several provider accounts | Each account becomes a separate participant. | Accept as the stated residual risk; cap each account's influence, mature accounts before release, and label the cohort self-selected/provider-account-gated. Never claim human independence. |
| Delete, then re-enroll with the same account | A 30-day purpose-separated HMAC cooldown is written to primary D1 before the unique link is removed and mirrored to the deletion ledger. The primary participant `INSERT` checks it atomically. | Publish the fixed 30-day re-entry policy, test expiry/maintenance in staging, and do not retain a permanent hidden social identifier. |
| Link-secret configuration changes | Changing the HMAC secret would otherwise make every provider account and cooldown look new. | `0028` records a one-way keyed fingerprint plus immutable version label and stops identity-sensitive operations on mismatch. Keep enrollment contained and use a separately reviewed dual-key migration if rotation becomes necessary. |
| Mixed Worker/schema rollout | A pre-`0027` Worker does not create the primary marker, while a post-`0027` Worker can admit an enrollment. | Keep enrollment disabled, deploy and drain the reviewed Worker revision first, then apply D1 migrations. Do not treat a local migration rehearsal as evidence of this production ordering. |
| Scripted enrollment from many IPs | Edge limits provide ordinary burst friction; D1 now gives a globally coordinated minute budget before each handoff. | Tune budget/alerts from staging evidence; add risk-triggered Turnstile only with the separately approved server-side verification path. |
| Account/device farm | Active-device, pairing issue, and pairing claim caps exist; idle/expired state is purged. | Monitor saturation and provide a documented device-replacement support path. Devices do not add aggregate weight. |
| Account switch on one Mac | Server session logout and Disconnect-this-Mac are explicit transactions; disconnect revokes outstanding upload authority before local Keychain cleanup. | Verify the native signed build and disconnect race in staging before launch. Do not permit ambiguous silent account takeover. |
| Replay/token abuse | One-use state/proof, Google PKCE, Apple nonce binding, body binding, and upload authority reduce replay. | Verify deployed observability redaction and portal configuration; source code cannot prove those controls. |
| Modified client sends plausible records | A valid social account/device can still submit syntactically valid false values. | Preserve schema/repricing/clipping/anomaly controls and call data self-reported. Only source-signed receipts/direct provider APIs could justify stronger provenance. |
| One account dominates a metric | Weekly snapshots clip per participant and intake caps batches, but the diagnostic endpoint sums raw participant records. | Route every public surface through the delayed weekly snapshot only; add maturity, account-health exclusion, and test caps against the actual release query. |
| Small or manipulated public cohort | Snapshot has a 20-participant support threshold, but automatic open grants are bookkeeping—not independently issued eligibility. | Rename policy/fields and public copy to provider-account support; keep threshold, rounding, and release delay, but remove independence claims. |

## Target architecture

### 1. Provider account is the enrollment gate

Production enrollment must require a consumed, five-minute, one-use hosted proof
from either Google or Apple. The Worker validates the issuer, audience,
algorithm, JWKS signature, expiry, and subject before deriving the HMAC link.
The browser/app receives only an opaque handoff proof, never a provider token.

Maintain a one-to-one default mapping:

```text
issuer + subject --HMAC--> identity link --unique--> active participant
                                                 |
                                                 +--> explicitly paired Macs
```

There must be no production local-open, recovery-code-only, raw-participant-ID,
or passkey-only enrollment route. Development-only test overrides, including
test JWKS, must fail closed when configured in staging or production.

Do not automatically merge Google and Apple accounts based on email or display
name. The product does not request either attribute, Apple private relay makes
correlation unreliable, and automatic merging creates an account-takeover risk.
If cross-provider continuity is needed after launch, add an explicit,
user-visible linking ceremony from an authenticated participant and a separate
participant_identity_links table with unique HMAC keys and a provider enum.
That link reduces accidental duplicate weight; it must never silently merge two
participants or create an extra public contribution unit.

### 2. Browser and account/device lifecycle

Use two different user-facing actions because they have different effects:

| Action | Server action | Local action | User-facing result |
| --- | --- | --- | --- |
| End browser session | POST the real logout endpoint with CSRF, revoke the server session, clear the host-only cookie. | Clear page/session state only after server acknowledgement. | Private browser controls end; a paired Mac may continue only if the user explicitly left it connected. |
| Disconnect this Mac / switch account | Revoke this device authority and outstanding upload authorities; end its session. | Pause automatic contribution, preserve queue until revoke succeeds, then clear Keychain credential/binding and create a fresh device ID. | Background contribution stops and another provider account can be connected honestly. |
| Reconnect same provider account | Verify the same account in system browser and reattach existing participant. | Pair the new/replacement Mac through a scoped short ceremony. | History is retained; no duplicate participant. |
| Delete account | Revoke sessions/devices, withdraw affected aggregate revisions, delete telemetry according to retention policy. | Stop queues and clear local device material after server confirms. | Any short anti-reissue cooldown is explained separately. |

#### Bounded device-credential renewal

Implemented behaviour uses a sliding expiry rather than a forced credential
rotation: a successful device authentication renews the same upload-only
Keychain-held bearer to `min(now + 30 days, social verification + 180 days)`.
It must already be active, recently used, tied to active consent, and inside
the hard social-verification horizon. Therefore normal six-hour delivery needs
no browser interaction, while an idle device or a long-lived device cannot
renew itself indefinitely. No OAuth refresh token is stored.

The code also contains a hash-only atomic credential-rotation primitive for a
future recovery/reuse-detection flow: same-attempt retry is idempotent and old
credential reuse revokes the device. It is deliberately not exposed to the
current local client, so release acceptance must not claim automatic secret
rotation until a native transactional client flow is added and tested.

Use bounded values that are configuration, not folklore: initially a 30-day
idle limit and a 180-day maximum since the last successful Google/Apple
verification are reasonable launch candidates, subject to staged load and
support evidence. At idle/max-age expiry, device replacement, explicit
disconnect, or risk signal, pause uploads and use the system-browser social
flow again. Existing Google/Apple browser SSO will often make this one tap,
but the UI must not promise that no provider interaction will ever be needed.
Never retain an OAuth refresh token to avoid this recheck, and never let a
device bearer secret renew itself indefinitely.

Show a quiet “Connected — contribution active” state and an expiry/reconnect
notice before an impending required action. Retain the encrypted/local queue
within its normal retention bounds while reconnect is pending; do not discard
it or surprise the user with a prompt during a six-hour upload cadence.

Use ASWebAuthenticationSession and an app-owned opaque completion handoff, not a
hosted personal-session cookie forwarded to HTTP loopback. A browser cookie is
host-scoped rather than port-scoped, so proxying it to loopback could expose it
to another local service. The callback must carry an opaque, one-use completion
ticket only.

The current memory-only five-minute polling handoff is fragile when the
app/window is terminated before the callback returns. Replace visible manual
polling dependency with a native completion signal and a durable, short-lived
local pending-attempt record that contains no OAuth token or provider subject.
Cancellation, expiry, and restart should produce one clear retry state, not a
duplicate enrollment.

### 3. OAuth hardening that remains mandatory

Keep Google server-side state and S256 PKCE. Google recommends state checking
and PKCE for desktop applications; its subject, not email, is the account key.

For Apple, add a per-transaction cryptographically random nonce to the
authorization request, retain only expected nonce/hash with its state row, and
require it when verifying returned ID token. Apple documents nonce binding as
part of server verification. Update the Apple handoff schema, callback/verifier
contract, negative tests, and expiration cleanup together; do not add a nonce
that is never checked.

For both providers:

- Register only exact HTTPS service redirect URIs and pin expected issuer,
  audience, and signing algorithm.
- Retain provider access/refresh tokens only if a separately approved feature
  needs them. This product does not, so discard them in-request as it does now.
- Configure platform observability so Google callback authorization code and
  state never survive in request-URL logs, traces, analytics, or error
  reporting.
- Test signed, installed macOS builds for each provider. Apple web configuration
  needs a Services ID, associated primary App ID, verified domain, return URL,
  and private key; do not infer readiness from source or portal configuration.

### 4. Open-enrollment abuse controls

The provider account is the principal after sign-in; before then the endpoint
has only a request and a network signal. Use layered controls with different
purposes:

1. Retain present globally coarse and HMACed-client rate limits on enrollment
   and sign-in start. They protect ordinary bursts, but Cloudflare documents
   Worker rate limits as location-local and eventually consistent.
2. Use the implemented small, measured, environment-wide D1 atomic
   sign-in-start budget before the handoff insert. It is the coordinated
   authority for this low-volume launch path; choose values from staging load
   evidence rather than copied defaults.
   It prevents distributed handoff-table/callback cost attacks; choose values
   from staging load evidence rather than copied defaults.
3. Add Cloudflare Turnstile only at enrollment/sign-in start when a risk rule
   requires it. Validate each token server-side, bind it to intended
   action/hostname, consume it once, and give a clear retry path. Never put it
   on six-hour uploads and never call a successful challenge a user identity.
4. After identity is known, enforce account-principal limits: one active
   participant per identity link, pairing issue/claim velocity, active-device
   maximum, upload-authorization velocity, contribution batches, bytes, and
   records. Scope all storage/rate-limit keys through HMACs; do not log raw
   IPs, provider subjects, proofs, or bearer credentials.
5. Create privacy-preserving counters/alerts for sign-in starts, completed
   handoffs, reattachments, re-enrollment after deletion, pairing issuance and
   claims, active-device count, rate-limit outcomes, rejected uploads, cap
   saturation, and manual exclusions. Redacted request-error logs alone cannot
   show whether open enrollment is being farmed.

Start with a conservative active-device cap, such as two or three, and a
documented support path for legitimate replacement. A device never represents a
new contributor unit.

### 5. Statistical safety for the accepted risk level

The existing weekly snapshot is a far better public mechanism than the legacy
communityStats diagnostic: it delays release by 48 hours, requires support of
20, clips each participant/cell (currently 1,000 events, 5,000,000 token
components, and 1,000 tool units), suppresses under-supported metric cells,
rounds values down, and seals revisions. Keep these mechanisms.

However, the existing open grant is created and redeemed automatically for every
signup. It is audit bookkeeping, not an independently issued eligibility
credential. Consequently:

- Rename minimumIndependentParticipants, grant_backed, and related public
  copy/tests to terminology such as minimumProviderAccountParticipants and
  provider_account_gated_open_cohort when enrollment mode is open.
- Ensure public release path uses only provider-linked active participants with
  accepted contributions—never raw development diagnostics.
- Add a service-tenure maturity rule before an account's records enter a public
  snapshot. Start with a configurable seven-day interval and at least two
  distinct accepted collection days; calibrate it against real retention and
  abuse data. Uploading and local results remain immediate.
- Preserve weekly per-account/cell clipping and add an account-level maximum
  across cells where a malicious split could otherwise raise total influence.
- Add dedicated aggregate-exclusion state with operator reason codes,
  review/audit trail, expiry, and deterministic snapshot rebuild. Do not reuse
  R2 quarantine, which is currently retention/reconciliation rather than
  abuse-review control.
- Expose only delayed, rounded, thresholded cells. Never publish account,
  device, provider-subject, raw-event, or exact-upload-time counts.

The metric can then honestly say: "a descriptive aggregate of eligible,
provider-account-gated contributors." It cannot say that it estimates all
users, every account is a distinct person, or every record reflects
provider-verified usage.

If a future publication requires an independent-sample claim, change cohort
policy rather than stretching social login: use separately issued one-use
eligibility units/invitations and count/clip that unit. Keep that as a
different product mode, not a hidden requirement for open enrollment.

### 6. Data-origin boundary

Server submission is necessary and already useful:

```text
social account -> participant -> device authority -> one-use body-bound upload
                                        -> Worker validate/decrypt/dedupe/reprice
                                        -> bounded self-reported aggregate
```

It stops local-only state edits from bypassing server quota, replay, schema, or
price calculations. It cannot establish that a modified client did not invent
plausible values. Treat direct provider APIs or provider-signed receipts as a
separate future evidence lane only if a named metric requires source
provenance. Neither social OIDC, device capability, code signing, nor App
Attest alone supplies that assertion for currently supported macOS versions.

## Delivery plan

### Phase 1 — make social identity safe to retain

1. Implement Apple nonce generation, storage, callback validation, expiry, and
   negative replay tests. Keep Google's state/PKCE flow unchanged except for
   regression coverage.
2. Guard test-only JWKS configuration to development environments.
3. Eliminate loopback session-cookie forwarding; use native browser/auth
   session plus opaque app completion ticket.
4. Stop platform URL logging of callback code/state and add a redaction smoke.
5. Preserve provider-continuity metadata and write a tested transfer runbook.
   In particular, use Apple's documented user-transfer process before an Apple
   developer-team/app transfer; never silently accept a changed issuer,
   audience, or team scope as the same account.
6. Test Google and Apple in signed installed builds. Keep Apple behind its own
   configuration/domain gate; Google may launch first if Apple is not ready,
   without adding a weaker enrollment route.

**Exit gate:** No provider token/code/cookie crosses into loopback or browser
storage; Apple nonce mismatch/replay fails; same account reattaches; configured
development test hooks fail closed in hosted environments.

### Phase 2 — make account and device ownership honest

1. Replace page-only sign-out with two explicit actions in this plan.
2. Make switch-account a server-confirmed Disconnect-this-Mac transaction;
   old background uploads cannot continue after success.
3. Add pairing limits, active-device ceiling, stale pairing/credential purge,
   and a non-destructive replacement-device path.
4. Retain the implemented bounded sliding expiry, idle timeout, maximum
   social-recheck age, disconnect transaction, and credential-reuse tests. Add
   an imminent-expiry/reconnect native UI state before public enrollment; do
   not claim automatic secret rotation until the native client safely supports
   it. No refresh-token storage or indefinite self-renewal.
5. **Implemented:** re-entry has a documented 30-day purpose-separated HMAC
   cooldown. Its primary-D1 copy is enforced at participant `INSERT` and its
   independent-ledger copy preserves restore safety; both have bounded purge
   paths and return a neutral cooldown response.
6. **Implemented:** deletion tombstones have a real bounded purge path; the
   400-day retention is not an unbounded production record.
7. **Implemented:** the identity-link HMAC secret has an immutable,
   database-pinned configuration fingerprint. A configuration mismatch fails
   closed rather than splitting the same provider account into a new identity
   namespace. Rotation remains intentionally unsupported until a dual-key
   migration is designed and tested.

The selected local policy is the bounded cooldown path, not clean re-entry as a
new account generation. No permanent hidden social identifier is retained.

**Exit gate:** A user can clearly stop uploads, recover same account on a
replacement Mac, intentionally switch accounts, and delete data without UI
claiming a state the server/device does not share.

### Phase 3 — bound open enrollment and public influence

1. Add coordinated sign-in-start admission, optional risk-triggered Turnstile,
   and privacy-preserving abuse telemetry/alerts.
2. Add account-principal pairing/device limits and a kill switch that stops
   enrollment while preserving local-only use and existing queue data.
3. Introduce maturity, cross-cell/account clipping, exclusion/review state, and
   clear provider-account cohort metadata to snapshot build/read path.
4. Update public/site/app copy, schema names, fixtures, and tests so open mode
   never uses "independent" or "verified usage." Preserve those terms only in a
   separately enforced invite/eligibility-unit mode.
5. Load-test distributed sign-in starts, onboarding bursts, device pairing,
   one-use upload claims, and weekly snapshot construction. Set budgets/caps
   from results and document alert/rollback threshold.

**Exit gate:** One provider account's maximum aggregate influence is known,
tested, and bounded; public payload accurately identifies an open,
self-selected, provider-account-gated cohort; a coordinated attack triggers
rate controls/exclusion/kill-switch procedures rather than silently changing
published totals.

### Phase 4 — staged authorization

1. Run staging with enrollment disabled until secrets, exact redirect
   configuration, rate-limit bindings, lifecycle migrations, and signed-build
   journeys pass.
2. Enable a small production cohort only after live resource validation,
   observability, incident owner, privacy copy, deletion/cooldown policy, and
   rollback procedure are approved. Open enrollment configuration alone is not
   evidence that public collection is authorized.
3. Review first-week metrics for unusual account/device distribution,
   re-enrollment, limits, incomplete handoffs, callback errors, client
   disconnects, and aggregate exclusions before expanding availability.
4. Keep public aggregate publication disabled until descriptive cohort contract,
   snapshot test suite, privacy review, and threshold/maturity gates are all
   confirmed in deployed environment.

## Release acceptance tests

| Scenario | Required result |
| --- | --- |
| First connection | User reviews consent, chooses Google or Apple in system browser, returns once, and connects Mac. No email/name is requested or stored. |
| Normal six-hour upload | No OAuth browser, CAPTCHA, passkey, or user prompt. Device authority acquires one body-bound upload authorization. |
| Active-device renewal | A recently active Keychain-held device bearer slides only to the hard social-verification deadline, without browser interaction. If/when secret rotation is exposed, it must preserve that deadline and old-secret reuse must revoke the device. |
| Idle or maximum-age recheck | After configured device idleness or maximum social-verification age, the queue pauses and the user gets one clear system-browser reconnect flow; no silent indefinite renewal occurs. |
| Same account after reinstall | Fresh Mac/app login reattaches existing participant; it does not create a duplicate account unit. |
| Identity-secret configuration | The configured version and keyed fingerprint match the primary D1 pin; an attempted in-place change fails closed before a new sign-in, enrollment, or deletion. |
| Different provider/account | App requires explicit Disconnect-this-Mac or authenticated linking; it cannot silently retain old device/session while presenting a new account. |
| Apple replay/nonce | Missing, mismatched, expired, or consumed nonce/state/proof fails without participant/session/device write. |
| Callback/browser privacy | OAuth codes, tokens, session cookies, and raw subject never appear in local browser storage, loopback requests, application logs, or URL telemetry. |
| Distributed enrollment pressure | Edge rate limits, global budget, and risk challenge shed load before unbounded handoff rows/provider exchange; alerts and kill switch work. |
| Device farm | Pairing/device caps prevent unlimited active credentials; extra device attempts give recoverable replacement flow. |
| Modified authenticated client | It cannot bypass envelope/body binding, schema, replay, server repricing, intake caps, clipping, maturity, or snapshot suppression. Output remains self-reported. |
| Multiple provider accounts | They may create separate account units under accepted risk, but each is clipped/matured and public material makes no unique-human/independent claim. |
| Deletion/re-entry | Behaviour matches published policy: data withdrawal, session/device revocation, any short HMAC cooldown, and expiry/purge are verified. |
| Public snapshot | Uses delayed snapshot path, correct open-cohort terminology, account maturity, thresholds, clipping, rounding, and deterministic exclusion/rebuild behaviour. |

## Off-the-shelf components and non-decisions

| Need | Use | Do not use it for |
| --- | --- | --- |
| Google/OIDC verification | Existing oauth4webapi, server code exchange, Google JWKS | A unique-human or data-truth assertion |
| Apple sign-in | Apple Services ID / REST web flow, server-side JWT client secret | Native Developer-ID entitlement workaround or email correlation |
| Native browser security | ASWebAuthenticationSession | Embedded WKWebView OAuth login or loopback-cookie bridge |
| Enrollment bot friction | Cloudflare Turnstile, server-side Siteverify, only when risk requires | Every background upload or identity proof |
| Cheap burst protection | Cloudflare Worker Rate Limiting bindings | Globally accurate accounting or sole distributed-attack control |
| Global admission | The implemented D1 atomic UTC-minute budget | A claim that account is a person |
| Future stronger telemetry provenance | Direct provider receipt/API if one covers required metric | Generic provider sign-in ID token |

Do not adopt Clerk, Auth0, Better Auth, or passkey-first accounts just to obtain
this control. They can be reasonable for a future general-purpose account
portal, but none makes a social account more Sybil-resistant or local telemetry
truthful. The existing server-side OIDC implementation is the right thin
wrapper once lifecycle and open-enrollment controls are fixed.

## Sources

- [NIST SP 800-63-4: Digital Identity Guidelines](https://pages.nist.gov/800-63-4/sp800-63.html)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-final.html)
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google OAuth 2.0 best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
- [Apple: Authenticating users with Sign in with Apple](https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple)
- [Apple: Verifying a user](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)
- [Apple: Configuring Sign in with Apple for the web](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web)
- [Apple: Transferring apps and users to another team](https://developer.apple.com/documentation/signinwithapple/transferring-your-apps-and-users-to-another-team)
- [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
