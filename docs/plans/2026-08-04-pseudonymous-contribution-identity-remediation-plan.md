---
title: Pseudonymous Contribution Identity Remediation Plan
date: 2026-08-04
type: plan
status: proposed
---

# Pseudonymous contribution identity remediation plan

## Decision

Do **not** use Google or Apple social login as the primary control for
deduplicating contribution telemetry or protecting aggregate statistics.

For a contributor programme where the service does not need to know the
person's real-world identity, use four deliberately separate controls:

1. an opaque, server-issued **participant** identifier for continuity;
2. a pseudonymous **passkey** for private participant recovery and sensitive
   account actions;
3. a separately scoped **device upload credential** for unattended six-hour
   uploads; and
4. a server-issued, one-use **eligibility unit** for any pilot or public
   statistic that requires independently sampled contributors.

Keep the existing server-side envelope validation, replay resistance,
server-side repricing, and delayed clipped aggregation.  Treat submitted
usage as *self-reported telemetry* unless the service verifies independent,
source-signed evidence.  An authenticated user, passkey, device key, or
notarized app does not turn user-controlled local logs into cryptographically
truthful data.

This supersedes the use of social OIDC **for contribution deduplication and
statistical integrity**.  It does not prohibit an optional social account in a
future, separate personal portal if the product genuinely needs a familiar
account-recovery or cross-platform convenience feature.  Such an account must
not be described as an anti-abuse proof or as evidence that a sample is
independent.

No hosted deployment is implied by this plan.

### Does the server need to receive the logs?

**Yes, for the controls the service can actually enforce.** The Worker must
receive a prepared contribution in order to authenticate the upload authority,
bind it to a one-use request, validate and decrypt the envelope, reject
replays, apply quotas, and calculate a privacy-safe aggregate. Local-only
deduplication can be bypassed by clearing or editing local state.

That server receipt establishes integrity of the *submission protocol*, not
truth of locally observed data. The distinction is the central security
constraint in this plan: server-side processing is necessary, but it cannot
by itself certify the provenance of a user-controlled log.

## Why this change is necessary

The desired properties are often accidentally collapsed into the word
"identity." They are different claims with different controls:

| Claim the service wants to make | What it actually means | Social login proves it? | Recommended control |
| --- | --- | --- | --- |
| Same returning contributor | A later request may reattach to the same server record. | Only for one issuer subject; not if the user makes another provider account. | Opaque participant plus passkey/recovery ceremony. |
| Same installation may upload | A particular enrolled installation has a current, narrowly scoped authority. | No. OAuth is about a browser session, not an installation. | Device credential and one-use upload authority. |
| No duplicate delivery | The same prepared payload is not counted twice. | No. | Server-side digest binding, atomic consume, and canonical event uniqueness. |
| One independent sample | One actor cannot cheaply add many observations to a public statistic. | No. A person can operate multiple Google/Apple accounts. | Independently issued eligibility units, per-unit clipping, thresholds, and delayed release. |
| The app/log was not altered | The server can establish software and data origin. | No. A modified client can use a perfectly valid OAuth session. | Source-signed receipts or a separately evaluated attestation signal; otherwise make no such claim. |
| The endpoint is not cheaply automated | The service can absorb or reject abusive enrollment traffic. | At most mild friction. | Rate limits, admission control, and optional enrollment-only bot challenge. |

OpenID Connect defines a stable `sub` only within an issuer; the stable key is
the pair of `iss` and `sub`. That is useful for account continuity, but it is
not a proof of a unique natural person, an independent statistical sample, a
particular Mac, or the origin of a telemetry record.  NIST similarly separates
identity proofing, authentication, and federation, and explicitly permits
pseudonymous accounts where real-life identity is not required.

### Red-team result: valid login, false telemetry

A user who controls the Mac can make an otherwise valid contribution request
through any of these paths:

1. alter the client before it reads local data, or patch its in-memory
   aggregation;
2. replay a newly constructed but schema-valid set of observations through the
   valid enrolled device credential;
3. create several provider accounts and enrol each to gain several social
   identity links; or
4. alter the underlying local source data while continuing to use the
   unmodified signed app.

The present Worker correctly verifies that a request has a valid encrypted
envelope, ties the one-use upload authority to the body digest, decrypts and
validates it server-side, rejects replayed digests in the participant scope,
and server-reprices the canonical contribution.  That is valuable **ingestion
integrity**.  It cannot prove that a user-controlled local process observed
the claimed real-world usage.  The current identity link merely lets a later
Google/Apple subject reattach to a participant; it does not change that trust
boundary.

This distinction is important for language in product UI, privacy materials,
and aggregate reporting:

```text
device/passkey + server checks
        -> authorized, well-formed, non-replayed self-reported record

independent provider-signed receipt or API response
        -> potentially verifiable source evidence (if the provider contract supports it)
```

Do not label the first line "verified usage." A local signing key can show
that a key signed a message, not that the values in a locally controlled
message are true.

## What already exists and must be retained

This is not a proposal to make the system local-only. The hosted path already
does important server-side work:

- `apps/worker/src/index.ts` validates, decrypts, schema-checks, and
  server-reprices contribution envelopes before canonical insertion;
- the upload authorization is one-use and bound to the exact envelope digest,
  content metadata, nonce, and a short authority lifetime;
- the Worker records envelope and plaintext digests to suppress exact replay
  within a participant, and canonical occurrence/event insertion is
  idempotent in that same scope;
- the device credential is stored as a server-side verifier for a Keychain
  secret, then mints the narrower upload authority; and
- contribution admission and the newer ingress controls impose server-side
  quotas before a participant can consume unbounded resources.

Those controls answer "did this enrolled client send this bounded payload only
once?" They should remain in place regardless of the identity choice.

Two existing limits must remain explicit:

1. Digest and canonical-event uniqueness are participant-scoped.  A fresh
   participant can submit an otherwise identical payload without being caught
   by that particular duplicate check.  A global content digest would create
   linkability and can falsely merge legitimate identical observations, so it
   is not a safe substitute for eligibility design.
2. A 30-day bearer device credential in Keychain is useful for continuity but
   is not proof of possession by an unmodified app or exclusive possession by
   one human.  The current one-use body-bound authority narrows the impact;
   it does not establish telemetry provenance.

## Recommended target architecture

The service should keep these identifiers non-interchangeable:

```text
one-use invitation ──> eligibility unit ──> public aggregate contribution cap
                             │
                             └── enrols one opaque participant
                                      │
                              passkey  ├── recover / add a device / delete
                                      │
                                      └── enrolled device ──> short one-use upload authority
                                                                     │
                                                               exact encrypted envelope
                                                                     │
                                      Worker: validate, decrypt, dedupe, reprice, clip
```

| Object | Contains | Is used for | Must never be used as |
| --- | --- | --- | --- |
| `participant_id` | Random opaque server identifier | Private account continuity and contribution ownership | A claim of a real person or independent sample |
| passkey credential | Credential ID, public key, backup metadata, counter/anomaly state | Recovery, adding/revoking a device, deletion, high-risk settings | Per-upload identity or a unique-human guarantee |
| device credential | Installation key/secret and server-side verifier, scope, expiry, revocation state | Background upload authorization | Evidence that the telemetry values are true |
| `eligibility_unit_id` | Opaque, one-time invitation outcome | Sampling independence, per-unit limits and aggregate clipping | A user profile or a device ID |
| contribution/event digest | Digest and canonical event key | Replay/idempotency handling in the defined scope | Cross-user identity matching |

### 1. Pseudonymous passkey account

Use a discoverable WebAuthn/passkey credential without an email or provider
subject. The server creates a random participant record and random opaque
WebAuthn user handle; where the platform requires an account name/label, use a
non-personal RP-local label such as `contributor-<random-short-id>`, not a
name or email. The initial native registration associates the resulting
credential with that participant.

Use maintained implementations rather than creating a custom FIDO protocol:

- on macOS, evaluate Apple's
  `ASAuthorizationPlatformPublicKeyCredentialProvider` for native passkey
  registration and assertion;
- on the Worker, run a small compatibility spike with
  [`@simplewebauthn/server`](https://github.com/MasterKale/SimpleWebAuthn),
  which documents Cloudflare Workers support; and
- store only the WebAuthn public credential material and lifecycle metadata in
  D1, never a private key or a social-provider token.

The challenge must be server-generated, short-lived, bound to the intended
ceremony and participant, and atomically consumed. Verify the relying-party
ID, origin, challenge, user verification result, credential ownership, and
the relevant WebAuthn backup state. Record signature-counter regressions as a
risk signal, not an automatic clone proof: modern synced passkeys can have
backup/counter behaviours that make a counter unsuitable as a sole security
decision.

Use passkeys only when a human is present:

- initial enrollment;
- restoring the same participant on a replacement Mac;
- pairing an additional device;
- viewing/exporting private account data;
- revoking a device; and
- deleting the participant.

Never prompt for a passkey just because the six-hour contribution timer fires.
The normal background flow remains silent and uses the scoped device
credential. This preserves the desired friction-free experience while making
the high-consequence actions visibly intentional.

### 2. Device authority for unattended contribution

After a successful passkey ceremony, issue or rotate an installation-scoped
device authority. Retain the existing pattern of an expiring parent device
credential that can mint a short, one-use, body-digest-bound upload authority.
Scope it only to enrolling/pairing the device and submitting a prepared
envelope; it must not be accepted as a personal-web-session credential.

In a later hardening increment, assess replacing the long-lived bearer parent
secret with proof-of-possession from a Keychain/Secure Enclave-backed device
key. That can reduce the impact of a copied credential, but it is *not* the
answer to tampered telemetry: a hostile same-user process can often still ask
the legitimate app/key to sign a chosen request. Do not block this plan on a
new custom signing protocol; preserve the current narrowly scoped server
authority first, then choose a maintained platform/library path after a
threat-modelled spike.

### 3. Eligibility units for statistical independence

For a private, invitation-only pilot, an independently issued, one-use
invitation is the strongest privacy-preserving control available without
collecting identity. The invitation service creates one opaque
`eligibility_unit_id`, permits it to enrol one participant, and prevents a
second participant from adding another unit. Aggregate queries count and clip
eligibility units—not passkeys, device IDs, OAuth subjects, or raw
participants.

The validity of the resulting "independent sample" claim depends entirely on
how invitations are issued. If an operator gives one actor many invitations,
no database schema can restore independence. Record the issuance basis and
do not make a stronger sampling claim than it supports.

For a broadly open public programme, there is no privacy-preserving technical
mechanism that both collects no identity and proves one enrolment per human.
Choose the product trade-off explicitly:

- retain a closed/invited cohort for statistically meaningful public metrics;
- accept open enrollment but state that it is a voluntary self-selected
  dataset, apply aggressive clipping and anomaly monitoring, and avoid
  independence claims; or
- introduce a deliberately proportionate identity/proofing process, with its
  privacy, accessibility, cost, and legal consequences.

Google/Apple login does not escape this trade-off; it merely makes additional
enrolments somewhat less convenient.

### 4. Abuse and capacity protection

If enrollment becomes open, add an enrollment-only Cloudflare Turnstile check
validated at the Worker, alongside the existing rate limits and admission
budget. It can add bot friction and protect cost, but must not gate every
background upload or be recorded as an identity proof. Cloudflare rate limits
are also an abuse/cost guard—not a globally consistent accounting system—so
the D1/eligibility-unit atomic state remains the authority for contribution
limits.

Retain and expand server-side data checks independently of authentication:

- exact authorization/body digest binding and one-use consumption;
- bounded content type and body size before expensive work;
- envelope and plaintext replay controls;
- strict schema and allowlisted source/event fields;
- server-side repricing and time-window/sequence plausibility checks;
- per-participant and per-eligibility-unit contribution caps;
- anomaly flags and manual quarantine rather than silent inclusion; and
- delayed, thresholded, clipped, and rounded aggregate release.

### 5. The only route to stronger data-origin evidence

If a high-stakes metric truly needs the statement "this usage came from the
provider," research whether that provider offers a server-verifiable signed
receipt or a direct API response covering the precise metric. Verify the
evidence server-side and make the provider connection/data scope clear to the
contributor. This is a separate product and privacy decision; a generic social
login ID token is not such a receipt.

Apple App Attest is also not the immediate universal answer. App Attest was
unavailable on Mac before macOS 27; Apple's 2026 platform material describes
macOS 27-and-later support and requires a runtime `isSupported` check. The
product supports older macOS releases, so it cannot be a baseline control.
Even where available, treat it as a version-gated risk signal about app/key
provenance, not proof that user-controlled source data are true or that a
person is unique. Developer ID signing and notarization protect distribution
and launch integrity; they are not server-verifiable per-upload attestation.

## Options considered

| Option | Friction | Privacy | Resistance to duplicate people | Resistance to altered logs | Decision |
| --- | --- | --- | --- | --- | --- |
| Keep Google/Apple as the core | Low after browser SSO | Shares a stable provider relationship | Low to moderate friction only | None | Reject for this purpose |
| Random local installation ID only | Very low | Strong | None; reset/reinstall creates a new identity | None | Insufficient alone |
| Existing device credential plus recovery code | Low after enrollment | Strong | Low without invitations | None | Safe interim fallback, but weaker recovery UX |
| Anonymous passkey plus device authority | Low; no six-hour prompt | Strong | Low alone, good participant continuity | None | Adopt for account continuity |
| One-use invitation / eligibility unit | One initial code/action | Strong | As strong as invitation issuance | None | Require for pilot/public independence claims |
| Email/phone verification | Medium | Weaker | Still bypassable and introduces personal data | None | Do not add without a separate need |
| CAPTCHA / Turnstile | Low to medium | Good | Delays bulk bots only | None | Enrollment-only abuse layer |
| App Attest / device attestation | Low once available | Depends on implementation | Does not establish one person | Partial app/key signal only | Future optional risk signal |
| Direct provider receipt/API | Potential consent friction | Provider-specific | Depends on provider/account model | Potentially meaningful for covered fields | Research only when a metric requires it |

## Remediation sequence

### Phase 0 — freeze the wrong coupling

1. Do not expand social-login enrollment while its purpose is described as
   telemetry deduplication or statistics protection.
2. Keep the existing hosted OAuth remediation plan available only for any
   deliberate continued social-login feature. Its browser/callback/session
   fixes remain necessary if OIDC is retained for another reason.
3. Close or keep invitation-only any cohort for which published metrics imply
   independent contributors, until eligibility-unit enforcement is live.
4. Update product language immediately: contributions are authenticated,
   server-validated, and self-reported; they are not "verified usage."

### Phase 1 — prove the native anonymous-passkey path

1. Build a disposable signed-build spike using a development Relying Party
   domain, Associated Domains `webcredentials`, native passkey registration,
   and the intended Worker verifier. Do not infer compatibility from a
   simulator or a web-only demo.
2. Test each supported macOS release band, including recovery/add-device,
   cancellation, offline failure, and a replacement Mac.  Confirm the exact
   system/browser requirements before setting the minimum-supported version.
3. Pin the maintained verifier version, add challenge replay/expiry tests,
   and verify the Worker implementation under its actual runtime rather than
   relying on a library compatibility claim.
4. Define the fallback before shipping: retain local recovery state in the
   user's Keychain, show a separate high-entropy recovery code once for the
   user to save, and retain only a slow server-side verifier for that code. It
   is acceptable for a device that cannot use the passkey path. The fallback
   must not silently create a new participant.

**Exit gate:** a signed macOS build can create, recover, and add a device to
one opaque participant without an email, OAuth provider, browser cookie, or
manual polling; its failure state is recoverable and does not duplicate the
participant.

### Phase 2 — make participant, device, and eligibility state explicit

1. Add migrations for pseudonymous participant identity, WebAuthn credential
   metadata, one-use challenge state, and invitation-to-eligibility-unit
   consumption. Keep identifiers opaque and store no email, provider subject,
   or passkey private material.
2. Bind each credential to exactly one participant. Permit deliberate
   add-device/recovery ceremonies, but do not allow a raw participant ID or
   local setting to attach a device.
3. Bind each invitation to exactly one eligibility unit and each eligibility
   unit to at most one active participant, subject to a deliberate operator
   recovery process. Make the consume operation atomic and auditable without
   logging raw code material.
4. Keep the present device/upload authorization contract initially; rotate or
   revoke it after a passkey-mediated recovery, account/device switch, or
   deletion. It must not cross participant boundaries.
5. Move aggregate denominators, clipping, threshold checks, and release
   accounting to `eligibility_unit_id`. A participant with no valid unit can
   retain private local/product functionality but must not increment a public
   cohort metric.

**Exit gate:** a fresh local install cannot increase an independent public
aggregate without consuming a distinct server-issued eligibility unit, and a
participant/device reset cannot bypass per-unit limits.

### Phase 3 — migrate existing social-linked participants without surprise

1. On the next interactive account-management action, offer "Secure this
   contributor profile with a passkey" rather than forcing a new account.
   A successful ceremony attaches the new credential to the existing
   participant and keeps its existing device/contribution ownership intact.
2. Retain the old social link only as a time-bounded migration/recovery method
   with a documented cutoff. Do not use it in new aggregate eligibility logic.
3. After a participant has a passkey and all active devices have re-bound,
   delete the OIDC identity-link material on the normal deletion/retention
   schedule. Do not create a second participant merely because migration is
   cancelled or temporarily offline.
4. Make disconnect/delete revoke every device credential, WebAuthn credential,
   session/handoff, invitation recovery path, and future upload authority in
   a defined order. State backup and tombstone retention accurately.

**Exit gate:** an existing contributor can retain their contribution history
through migration, sign out/disconnect honestly revokes background upload,
and no personal OAuth artifact survives beyond the documented migration
window.

### Phase 4 — operate and, only if justified, raise assurance

1. Run a small invited pilot; record invitation issuance basis, enrollment
   failures, duplicate/recovery attempts, upload rejection reasons, and the
   rate of quarantined anomalies using redacted operational events.
2. Perform an abuse simulation: multiple passkeys, multiple devices, copied
   device credential, modified schema-valid client, replay, clock skew,
   invitation sharing, and concurrent invitation redemption. Verify the
   expected result is correct containment or honest statistical exclusion—not
   an impossible promise of detecting all tampering.
3. Publish a metric only after its eligibility-unit threshold, clipping,
   delayed-release, and audit evidence are satisfied. Include the sampling
   caveat in any public claim.
4. Only then decide whether a source-signed evidence integration or
   macOS-27+-only App Attest signal materially improves a named metric enough
   to justify its privacy and maintenance cost.

## Security and user-flow acceptance tests

The following are release gates, not documentation aspirations:

| Scenario | Required result |
| --- | --- |
| Normal six-hour schedule | No passkey, Google, Apple, browser, or user prompt. A scoped device authority mints the bound upload authorization. |
| Restart/offline upload | Queue preserves the prepared payload and retries under server backoff; it never silently re-enrols or makes a new participant. |
| Replacement Mac | User chooses recovery, completes a visible passkey/recovery ceremony, and reattaches to the same participant. |
| Lost/revoked device | Revocation blocks new upload authorities from that device without disconnecting other explicitly paired devices. |
| Modified but authenticated client | It may reach the server, but cannot bypass body binding, schema, replay, caps, or aggregate clipping. The metric is still labelled self-reported. |
| Many passkeys or provider accounts | No additional public cohort weight without distinct valid eligibility units. |
| Invitation sharing/race | Atomic first consumption wins; later requests disclose neither the existing participant nor raw invitation state. |
| Browser/callback inspection | No provider token, long-lived identity credential, or hosted personal cookie crosses a loopback bridge. |
| Deletion | Future devices/uploads are rejected and the retention/deletion state matches the published policy. |
| Aggregate query | Counts, caps, and thresholds are applied to eligibility units; raw participant/passkey/device cardinality cannot inflate the result. |

## Non-goals and hard truths

- A passkey is not anonymous in the absolute sense: it is a durable
  authenticator relationship with this service. It is nevertheless
  privacy-minimising because its identifiers are scoped to the relying party
  and the service need not collect a name or email.
- A device secret/key is not robust remote attestation against a hostile owner
  of the Mac.
- A closed invitation pilot can support a qualified independence claim only to
  the extent that invitation issuance is independent.
- No client-only design can prove user-controlled logs were not fabricated.
  If the product cannot tolerate that limitation, stop treating local logs as
  evidentiary inputs and use independently verifiable provider data instead.
- This plan deliberately does not add email verification, phone checks, KYC,
  biometric identity, advertising IDs, or cross-site fingerprinting. Those
  would add collection and exclusion harms without solving telemetry truth.

## Sources

- [NIST SP 800-63-4: Digital Identity Guidelines](https://pages.nist.gov/800-63-4/sp800-63.html)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-final.html)
- [Web Authentication: An API for accessing Public Key Credentials, Level 3](https://www.w3.org/TR/webauthn-3/)
- [Apple: Supporting passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys)
- [Apple: ASAuthorizationPlatformPublicKeyCredentialProvider](https://developer.apple.com/documentation/authenticationservices/asauthorizationplatformpublickeycredentialprovider)
- [Apple: Performing fast account creation with passkeys](https://developer.apple.com/documentation/authenticationservices/performing-fast-account-creation-with-passkeys)
- [Apple: DCAppAttestService.isSupported](https://developer.apple.com/documentation/devicecheck/dcappattestservice/issupported)
- [Apple: Validating apps that connect to your server](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
- [Apple WWDC26: Secure your apps with App Attest](https://developer.apple.com/videos/play/wwdc2026/201/)
- [Cloudflare Turnstile documentation](https://developers.cloudflare.com/turnstile/)
- [Cloudflare Workers Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
