# Design: sign in once, stay signed in — credential durability

Date: 2026-08-11. Status: owner-approved (all three parts), pending the
in-flight structural sign-in ceremony fix landing first.

## Problem

The hosted-contribution design intends **log in once**: a Google sign-in
mints a **30-day device credential** in the macOS Keychain
(`DEVICE_CREDENTIAL_TTL_MILLISECONDS = 30 * 24 * 60 * 60 * 1000`,
apps/worker/src/constants.ts:26), and that credential — not the 30-minute
web session (`SESSION_TTL_MILLISECONDS`, constants.ts:14) — authorizes every
upload (`Device um_device_<id>.<secret>`,
src/contribution-incremental-sync.js:443). The web session and the one-use
Google proof are transient, needed only to mint the durable credential.

But the owner has re-authenticated ~7 times in three days. Two causes:

1. **The ceremony that mints the credential keeps failing** (cookie-commit
   race, one-use-proof re-consumption) — being fixed structurally elsewhere
   (single-flight ceremony, consume-proof-once). Until it succeeds, the
   durable credential never exists.
2. **A minted credential goes unreadable within days.** Historically the
   Keychain item's access is invalidated when the app is re-signed/updated
   (ad-hoc resign breaks the ACL — see
   [[signin-upload-chain-resolution]]). The 0.1.3 fix bound the *keytar
   binding's* integrity to the Developer-ID designated requirement, but the
   *credential Keychain item's own access control* is a separate thing and
   still lapses. When the app can't read its own credential the sync pauses
   `device_unavailable` and forces a re-pair = re-login.
3. The WKWebView uses `.nonPersistent()` (UsageMonitorApp.swift:1706), so an
   interrupted sign-in cannot resume — it restarts from zero.

## Approved plan (all three)

### 1. Durable Keychain access (the core fix)
Mint the contribution-device credential Keychain item with an access control
bound to the app's **designated requirement** (Team ID + bundle identifier),
NOT the running binary's build-specific signature, so a Sparkle update or
re-sign never invalidates read access. Audit the actual `add-generic-password`
/ keytar attributes used at mint (src/platform/export-identity-keychain.js and
the keytar backend) and the `-T`/partition-list/access semantics. Verify with
`codesign --verify -R=<designated requirement>` on the installed app that the
same-team next build retains access; the definitive proof is a real signed
update cycle (document what only that can show). This is the item's own ACL,
distinct from the 0.1.3 keytar-binding integrity loader.

### 2. Silent auto-renewal
Renew the 30-day credential in the background BEFORE it lapses, authenticated
by the existing credential itself (no user sign-in). Add a worker route (or
extend device-auth) that issues a fresh credential for a valid, unexpired
device credential; the companion renews at, say, 25 days, transparently.
Then the credential never expires and re-authentication is only ever needed
after an explicit revoke. Keep the per-participant device cap self-heal
(already deployed) compatible — renewal replaces the same device, not a new
slot.

### 3. Persistent session (owner opted in, accepts the trade-off)
Switch the dashboard WKWebView to a **persistent** `WKWebsiteDataStore` (or
persist just the session cookie) so an interrupted sign-in resumes instead of
restarting, and a still-valid 30-minute session survives an app relaunch. The
`.nonPersistent()` privacy rationale is superseded by the owner's explicit
choice for convenience; the durable authority is still the Keychain
credential, and the session is short-lived regardless. Update the
UsageMonitorApp.swift comment and the pending-handoff survival logic
(the handoff no longer dies on relaunch).

## Sequencing

Land the structural ceremony fix (single-flight + consume-proof-once) first —
it edits app.js / data-client.js / the sync engine that this workstream also
touches. Then run this as a dedicated pass with its own forensics (the
Keychain-ACL history means #1 needs real verification, not a quick patch).

## Acceptance

- A signed app UPDATE (Sparkle 0.1.x → 0.1.y) retains Keychain read access to
  an existing credential — no `device_unavailable` after update.
- The credential auto-renews before 30 days with zero user interaction; a
  48-hour and a near-expiry re-check both find it readable and unpaused.
- An interrupted sign-in (quit mid-flow) resumes on relaunch rather than
  restarting.
- End state: one Google sign-in, then indefinite uploads with no re-login.

## Amendment, 2026-08-20 (0.1.14): the inactive tail

The three parts above all address a Mac that is *in use*. They leave the
opposite case untouched: a Mac that is closed for longer than the renewal
window never renews, lapses, and comes back needing a full re-pair. That is
churn aimed at exactly the returning user you most want back.

Two bounds changed, and the numbers above are superseded:

- `DEVICE_CREDENTIAL_TTL_MILLISECONDS` is **90 days**, not 30, with
  `DEFAULT_DEVICE_LIFECYCLE_POLICY.idleMilliseconds` tied to it rather than set
  beside it. Both clocks run from the same last authenticated use, so they must
  be equal or one retires a device the other still authorizes. The security
  reasoning for the wider bound is recorded at the constant.
- The companion renews at **half the credential's own observed lifetime**, not
  at a fixed five-day lead. The tolerated open-to-open gap is therefore half
  the TTL rather than five days, and the rule needs no mirrored copy of the
  service TTL to stay correct.

What did **not** change, and remains the binding constraint on
"one sign-in, then indefinite uploads":

- `socialRecheckMaxAgeMilliseconds` is 180 days and `social_verified_at` is
  stamped once at pairing and never refreshed. Every device is retired half a
  year after it was paired however heavily it is used, and no renewal or
  rotation may cross that line. The acceptance line "indefinite uploads with no
  re-login" is therefore false as written: the honest ceiling is two
  re-authentications a year.
- `SESSION_TTL_MILLISECONDS` is 30 minutes and absolute — `expires_at` is
  written once and never extended. A re-pair needs a live personal session, so
  any lapse discovered more than 30 minutes after the last sign-in requires a
  fresh hosted identity proof. No amount of credential lifetime removes that;
  it only makes it rarer.
