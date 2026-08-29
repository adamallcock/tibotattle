---
title: Sign in once, stay signed in credential durability
date: 2026-08-11
type: design
status: complete
---

# Sign in once, stay signed in — credential durability

The durable Keychain broker, device-credential renewal route, local renewal
controller, and persistent WebKit store are implemented. A real signed update
remains an artifact-level release gate; source implementation alone does not
prove cross-version Keychain continuity on an installed Mac.

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
