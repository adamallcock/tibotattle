---
title: Mac App Store Compatibility and Distribution Plan
date: 2026-08-14
type: plan
status: active-feasibility
owners:
  - product
  - macos
  - local-companion
  - release
---

# Mac App Store compatibility and distribution plan

## Decision and present boundary

Pursue a Mac App Store build as a second distribution target, while retaining
the current Developer ID/Sparkle build. Do not create an App Store Connect
record, spend money, upload a build, or begin review until the local sandbox
feasibility gate in this plan is green and the owner has chosen the Store
identity and commercial model.

The first hard question is not Store metadata. It is whether the complete local
product works when:

1. the app and its bundled Node companion are sandboxed;
2. Node runs without JIT exceptions;
3. the companion can retain read-only access to a user-selected Codex data
   folder through a security-scoped bookmark; and
4. Sparkle and every other self-update path are absent from the Store bundle.

If that proof succeeds, the remaining work is conventional packaging,
migration, product QA, privacy disclosure, and App Review preparation. If it
requires a broad native rewrite, stop and make a separate investment decision.

## Minimum route from today's build

This is the smallest credible path to a Store-compatible beta:

1. **Freeze a dual-channel contract.** Keep today's direct build unchanged;
   add a distinct Store build configuration with Store-only entitlements,
   JIT-less Node, container storage, and no Sparkle.
2. **Build a local Store-like feasibility artifact.** Development-sign and run
   the main app and bundled helper under App Sandbox. Prove launch, dashboard,
   quit, and helper cleanup before doing Store administration.
3. **Replace implicit `~/.codex` access.** Ask the user to select their Codex
   data folder, persist an app-scoped security-scoped bookmark, and prove that
   the sandboxed companion can activate and use it after relaunch and login.
4. **Productize the separate target.** Move Store state into its container,
   define safe migration/import behavior, compile out Sparkle, add signing and
   archive support, and run the test matrix below.
5. **Prepare and beta-test the listing.** Only after an owner gate, reserve the
   final bundle ID and app record, complete privacy and review materials, upload
   to TestFlight, fix review findings, and explicitly authorize submission.

Expected effort after the feasibility proof is approximately 9–15 focused
engineering/product days. A native file-broker or substantial companion rewrite
would add roughly 3–6 weeks and is outside this plan without a new decision.

## Historical baseline observed on 2026-08-14

At that checkpoint, the macOS product was documented as an arm64, macOS 13+
AppKit/WKWebView application
with a bundled Node 26 runtime, bundled JavaScript companion, native `keytar`
dependency, a loopback HTTP server, optional hosted contribution/account flows,
an owner-controlled `SMAppService` login item, and Sparkle in the direct
distribution bundle. This is historical evidence, not the current support
floor: the reviewed builder and published 0.1.16 contract now require macOS
14.0 or later on Apple silicon.

The important Store gaps are:

| Area | Current direct build | Store requirement or target | Status |
|---|---|---|---|
| Sandbox | Main app is not sandboxed | Main app and helper run under App Sandbox | Hard gate |
| Codex data | Opens the configured path, normally `~/.codex` | Explicit read-only folder selection plus persistent bookmark | Hard gate |
| Companion | Bundled Node is signed for the direct channel with JIT-related exceptions | Sandboxed inherited helper; initial Store contract is JIT-less | Packaged JIT-less launch proven; sandbox unproven |
| State | `~/Library/Application Support/Usage Monitor` | Store container application support | Not implemented |
| Updates | Sparkle | Mac App Store updates only | Not implemented |
| Build/archive | Custom `swiftc` bundle builder and Developer ID release flow | Repeatable Store configuration, Apple Distribution signing, profile, archive, and upload validation | Not implemented |
| Reviewability | Assumes real local Codex history for the full experience | Useful first-run state and clearly labelled demo/sample data | Not implemented |
| Privacy | Existing local-first product and policy boundary | Matching App Privacy answers, manifest/API audit, review notes, and support/privacy URLs | Not completed |

No Store-compatibility or review-readiness claim is made yet.

## Quick wins completed and locally validated on 2026-08-14

- Added a minimal, distribution-specific main-app entitlement contract:
  `apps/macos/MacAppStore.entitlements`.
- Added the minimal inherited-helper entitlement contract:
  `apps/macos/MacAppStoreNodeRuntime.entitlements`.
- Added an explicit bundle runtime mode. The direct build continues to write
  `UsageMonitorNodeRuntimeMode=standard`; a Store build can set `jitless` without
  maintaining a second launcher implementation.
- Added a separate `--jitless-smoke-test` path and artifact assertions. This
  tests the packaged companion under `node --jitless` without changing normal
  installed behavior.
- Added tests that fail if the Store helper entitlement file silently gains a
  JIT or unsigned-executable-memory exception.
- Rebuilt the ad-hoc development bundle and passed both its unchanged standard
  companion smoke and the separate packaged JIT-less companion smoke. This does
  not apply or prove the Store sandbox entitlements.

These are source contracts and feasibility aids, not a signed Store artifact.
The normal direct product still uses its existing runtime and updater behavior.

## Product invariants and non-goals

All Store work must preserve these invariants:

- Local Codex session content stays on device. The Store project must not add
  raw-log, prompt, response, filename, or source-path upload.
- Optional contribution/account behavior retains its present consent,
  minimization, revocation, and diagnostics boundaries.
- Security-scoped access is read-only and limited to the folder the user chose.
- The app executes only code shipped and signed inside its bundle. It must not
  download plugins, JavaScript, binaries, or updates for execution.
- The direct Developer ID/Sparkle channel remains independently buildable and
  testable throughout the work.
- Store state migration is non-destructive. Removing the Store app must never
  remove the user's Codex history.
- Store review lag must not make the service unsafe: hosted APIs remain
  compatible with at least the currently released Store build and its immediate
  predecessor.

Out of scope unless separately approved: Intel support, iOS/iPadOS, a broad UI
redesign, a native rewrite of the analytics engine, new data providers, paid
subscriptions or in-app purchases, and public submission.

## Apple constraints to design against

The implementation should be checked again immediately before upload, but the
current primary-source constraints are:

- Mac App Store apps must use App Sandbox and request only capabilities needed
  for their core behavior.
- A sandboxed app obtains persistent access to a user-selected location through
  a security-scoped bookmark. A raw saved path is not sufficient.
- A bundled helper executable must be signed and sandboxed; Apple's inherited
  helper pattern uses `com.apple.security.inherit`.
- Store software must be self-contained and must not download or install code
  that changes app functionality. The Store build must not carry an independent
  updater.
- Sandboxing changes the app's writable home and application-support location;
  migration from a previously unsandboxed distribution needs an explicit plan.
- The app record, signing profile, privacy answers, screenshots, review notes,
  and support/privacy URLs are separate release gates from a working local app.

Primary links are collected at the end of this document.

## Target dual-channel architecture

The codebase should produce two intentionally different artifacts from shared
sources:

| Contract | Direct distribution | Mac App Store distribution |
|---|---|---|
| Bundle identity | Existing identity | Owner-selected Store identity |
| Signing | Developer ID + notarization | Apple Distribution + Mac App Store profile |
| Sandbox | Existing behavior | Required for app and helper |
| Node mode | `standard` | `jitless` initially |
| File access | Existing configured path | Security-scoped read-only folder bookmark |
| Writable state | Existing Application Support root | App container Application Support root |
| Updates | Sparkle | App Store only; Sparkle absent from bundle and UI |
| Login at startup | Existing user-controlled `SMAppService` behavior | Same visible consent model, proven under sandbox |
| Hosted services | Existing optional behavior | Same API contract, subject to privacy/review QA |

Prefer one bundle-building implementation with an explicit distribution enum
over parallel scripts. Each target must produce a machine-readable build receipt
that records channel, bundle ID, version/build, runtime mode, entitlement files,
updater mode, minimum OS, architecture, and source commit.

## Decisions the owner must make

These decisions are deliberately deferred until local feasibility succeeds:

1. **Store bundle ID.** A distinct ID such as a Store-specific suffix gives the
   cleanest dual-install and container boundary. Reusing the direct ID gives a
   smoother brand identity but increases migration, Keychain, and concurrent
   installation complexity. Bundle IDs cannot be changed after a build has been
   uploaded; record creation is therefore an owner gate. The decision must also
   assign collision-free URL schemes/semantic-open identities and matching
   hosted OAuth redirect allowlists for side-by-side installations.
2. **Store business model.** Recommended first beta: free, with no IAP, matching
   the current local-first adoption goal. Any paid download, subscription, or
   paid hosted feature requires a separate commerce and App Review plan.
3. **First public version.** Recommended: TestFlight from the next minor line,
   then release only after direct/Store parity is demonstrated. Do not relabel
   today's direct artifact as the Store artifact.
4. **Migration ambition.** Recommended: rebuild disposable caches and provide an
   explicit, reviewable import for valuable local state. Do not use broad
   temporary file exceptions or silently move direct-channel data.
5. **Architecture and OS floor.** Recommended initial scope: retain arm64 and
   the currently enforced macOS 14.0+ floor; add universal/Intel only if demand
   justifies its separate native
   dependency and QA cost.

## Phase 1: prove the sandboxed local product

### Build the feasibility artifact

- Add a `mac-app-store-development` build configuration that cannot be confused
  with a release or uploadable archive.
- Apply `MacAppStore.entitlements` to the main executable.
- Sign the bundled Node executable with
  `MacAppStoreNodeRuntime.entitlements`, and sign every native executable image,
  including `keytar` and its transitive native code, inside-out.
- Set `UsageMonitorNodeRuntimeMode=jitless` in this artifact.
- Exclude Sparkle framework, keys, plist entries, menu actions, update checks,
  and update-specific network behavior at build time.
- Preserve the direct target byte-for-byte except for source changes shared by
  both channels and explicitly covered by parity tests.

### Prove file authorization, not just app launch

On first run, use `NSOpenPanel` to ask the user to select the Codex data folder.
The onboarding text should explain why access is needed, that it is read-only,
and how to reveal or navigate to the hidden `.codex` folder. Cancellation must
leave the app usable in an empty/demo state and offer a later retry.

After selection:

- validate the folder shape without requiring unrelated files;
- create an app-scoped security-scoped bookmark;
- persist bookmark data inside the Store container, never the raw folder path as
  the authority;
- resolve the bookmark at launch, detect staleness, refresh it when possible,
  call `startAccessingSecurityScopedResource()`, and balance every successful
  start with a stop;
- handle moved, deleted, stale, and permission-revoked folders with a clear
  reauthorization flow;
- redact the selected path from routine logs and diagnostics.

The companion-process boundary is the key experiment. Do not assume that a
dynamic sandbox extension held by the app becomes usable by the inherited Node
process. Prove one of these approaches end-to-end:

1. **Preferred minimal bridge:** pass bookmark data to the already-bundled,
   signed companion over a private pipe; resolve and activate it inside that
   process through a small native bridge, keeping access active only for the
   companion lifetime.
2. **Fallback broker:** keep bookmark ownership in a small native/XPC service
   and expose only the bounded read operations the analytics engine needs.

Never put bookmark data in a URL, environment-variable diagnostic, command
history, or telemetry. If neither approach works without a broad native rewrite,
record evidence and stop for an owner decision.

### Phase 1 acceptance criteria

- `codesign -d --entitlements :-` shows the exact intended entitlements for the
  app and helper, with no `get-task-allow` in the release-shaped proof.
- Sandbox denials are absent from a clean first run, authorized-folder scan,
  relaunch, login-item launch, and quit.
- The app cannot read a neighboring folder the user did not select.
- The bookmark survives reboot/relaunch, and revocation/reselection works.
- The full dashboard loads from a representative small and large local history.
- Packaged Node passes the companion smoke, auth/keychain path, and orderly
  shutdown under `--jitless`.
- Sparkle is not linked, copied, mentioned in the plist, or visible in the UI.
- Quitting the app leaves no companion, loopback listener, or bookmark access.

## Phase 2: make the Store build reproducible

- Add an Xcode project/target or an equally auditable archive-producing build
  layer. Keep the existing source allowlists and reproducibility checks rather
  than manually assembling a Store archive in Xcode.
- Parameterize bundle ID, channel, runtime mode, updater mode, entitlements,
  signing identity/profile, state namespace, and receipt output in one build
  contract. Invalid combinations must fail closed—for example, Store + Sparkle,
  Store + standard/JIT mode, or Store + unsandboxed helper.
- Reserve an explicit App ID only after the owner chooses the identifier.
- Create a Mac App Store provisioning profile and use an Apple Distribution
  certificate for uploadable archives.
- Verify nested signatures, designated requirements, architectures, deployment
  target, profile, entitlements, hardened runtime behavior where applicable,
  and absence of quarantine/development residue.
- Produce a `.xcarchive` and export an upload candidate locally. Upload through
  Xcode or Transporter remains a separate, explicit owner-authorized action.
- Add CI/source checks that require both targets to compile and that inspect
  produced bundle contents and entitlements rather than trusting build flags.

## Phase 3: container state and migration

Use the sandbox container's Application Support location from `FileManager` for
Store-owned settings, receipts, caches, contribution state, and diagnostics.
Do not construct `~/Library/Containers/...` manually.

Classify existing direct-channel state before migrating it:

| State class | Store behavior |
|---|---|
| Codex sessions | Never copy or move; read in place only through the selected-folder bookmark |
| Derived indexes/caches | Rebuild in the Store container |
| UI preferences | Start clean or import only through a versioned, validated preference payload |
| Historical quota/usage state | Define whether it is rebuildable; if not, offer explicit export/import with schema and integrity checks |
| Hosted account/device credentials | Re-pair through the normal consented flow unless a narrowly scoped Keychain-sharing design is explicitly approved |
| Diagnostics | Start in the Store container and retain the same privacy stripping |

Test direct-to-Store, Store-to-direct rollback, side-by-side installation, stale
state, schema downgrade, and interrupted import. No migration may delete or
mutate direct-channel state. Avoid a shared application group initially: its
operational coupling is not justified unless the explicit import path proves
inadequate.

## Phase 4: Store-specific product behavior

- Replace “Check for Updates” and Sparkle status with concise copy that updates
  are delivered by the Mac App Store, or remove the command entirely.
- Keep version/build display and diagnostics channel-aware.
- Give each side-by-side channel an unambiguous URL/semantic-open identity. Test
  callback routing with both apps installed and reject callbacks intended for
  the other channel.
- Make folder authorization visible in Settings: current status, choose again,
  and revoke/forget. Revoking must stop access immediately and remove the saved
  bookmark.
- Show an honest empty state when no folder is authorized.
- Add a clearly labelled, bundled sample/demo dataset so an App Reviewer and a
  new user can inspect the product without possessing Codex history. Demo mode
  must never be mixed into real aggregates or presented as the user's data.
- Re-test login-at-startup consent, status, disablement, app relocation, app
  replacement, and uninstall behavior under the Store bundle identity.
- Make hosted outages non-blocking for the local dashboard and ensure the app is
  useful without signing in.

## Phase 5: privacy, security, and policy package

### Privacy and manifests

Account-flow update, 2026-08-30: the
[self-service retirement decision](../decisions/2026-08-30-self-service-deletion-retirement.md)
replaces the source app's hosted-deletion control with confirmed device
disconnect; hosted erasure is private and owner-operated. That decision does
not establish Mac App Store eligibility. Recheck the then-current Apple
account-management requirements against the exact proposed Store build before
submission; the policy checks below remain open, not satisfied by retirement.

- Inventory every data flow in the native app, Node companion, `keytar`,
  Sparkle-free Store dependency graph, and hosted endpoints.
- Audit use of Apple's listed required-reason APIs and third-party SDK manifest
  requirements. Add and validate `PrivacyInfo.xcprivacy` based on observed code,
  not a template guess.
- Complete App Privacy answers consistently with the shipped Store behavior.
  On-device session analysis is not “collected” merely because it is processed
  locally, but optional account/contribution data must be declared according to
  what the service actually receives and how it is linked or used.
- Keep an accessible privacy policy and support URL, and link privacy/help from
  inside the app.
- Document account revocation/deletion and contribution opt-out. If an account
  can be created, verify the current in-app account-deletion requirement.
- Complete export-compliance questions from the actual cryptography/dependency
  inventory rather than assuming an exemption.

### Security review

- Confirm the helper executes only static, bundled, signed JavaScript and native
  modules; no remote code, package installation, plugin loading, or writable
  script search path.
- Treat bookmark data and hosted credentials as secrets. Never log either.
- Bind the companion to loopback, preserve per-run authentication, reject
  inherited proxy/origin configuration, and retain owner-only file modes.
- Re-run dependency, code-signing, and native-module audits on the exact archive.
- Threat-model hostile local inputs, malformed/cyclic session data, symlinks,
  TOCTOU around the selected folder, and a same-user process probing the
  loopback service. Record explicit residual risks.

### Authentication review risk

Review the optional Google/account flow against the current App Review login
rules. Either add Sign in with Apple where required or document and validate a
specific exception. Do not assume that making login optional automatically
settles the rule; do not add a new identity provider before this review.

## Phase 6: App Store Connect and reviewer package

Only after the owner approves the Store identity and the local gates pass:

- Create the App Store Connect app record with the final name, bundle ID, SKU,
  primary language, category, age rating, price, availability, and ownership
  details.
- Prepare localized name/subtitle/description/keywords/support/privacy/marketing
  metadata for the locales actually shipped by the app (currently English,
  Simplified Chinese, and Spanish should be evaluated together).
- Capture 1–10 accurate macOS screenshots at accepted dimensions from the exact
  candidate UI. Do not show fabricated live data as real user activity.
- Supply review notes explaining the local-first architecture, why the user
  selects a Codex folder, the read-only boundary, demo mode, login-at-startup
  consent, optional hosted features, and that session content is not uploaded.
- If review needs a hosted account, provide a stable review account and keep the
  backend live for the review window. Never put private production credentials
  in repository files or general documentation.
- Verify all URLs, legal text, name/icon rights, content rating, and contact
  details immediately before submission.

App record creation, certificate/profile changes, uploads, TestFlight external
distribution, and submission are owner-only external actions.

## Phase 7: TestFlight and release sequence

1. Archive from a clean tagged commit and generate a channel-specific receipt.
2. Run static bundle, signature, entitlement, privacy-manifest, dependency, and
   prohibited-content checks on the exported artifact.
3. Upload only after explicit owner approval; verify App Store Connect processing
   rather than treating successful transport as acceptance.
4. Run internal TestFlight on a clean macOS user account and at least the minimum
   and current supported macOS releases.
5. Test a no-Codex-history reviewer path, a real small history, and a large
   history; then test folder revocation and offline behavior.
6. Resolve App Review/test feedback in source and rebuild. Never edit an archive
   after its receipt was produced.
7. Obtain a final release decision with the completed gate table. Submission and
   release remain explicit owner actions; use phased release if appropriate.
8. Monitor crashes, auth/contribution errors, support issues, and Store reviews
   without widening diagnostics collection.

## Required test matrix

| Surface | Required cases |
|---|---|
| Build provenance | Clean and dirty tree behavior; source commit; version/build monotonicity; reproducible bundle inventory; direct/Store configuration separation |
| Signatures | App, Node, native modules, login item/service, frameworks; exact entitlements; valid profile; no development entitlement in release |
| Sandbox | First launch, relaunch, login launch, offline launch, folder access, denied neighboring paths, revoked/stale/moved bookmark, sandbox log inspection |
| Companion | JIT-less startup; keychain reset; crash/restart; orderly quit; no orphan/listener; malformed input; large history; repeated scans |
| Product | Empty/demo/real data; localization; settings; menu; accessibility/keyboard; dark/light appearance; minimum/current macOS |
| Local-first/privacy | Packet observation for local-only use; optional hosted flow; consent/revoke/delete; redacted diagnostics; no raw log/path/bookmark upload |
| Migration | Fresh Store install; direct plus Store side-by-side; explicit import; interrupted/invalid/older/newer schema; Store removal; direct rollback |
| Updates | No Sparkle symbols/resources/config/UI/network in Store; direct Sparkle checks continue to pass |
| Review | Reviewer can reach useful UI without Codex or personal credentials; review notes match exact build; links and screenshots render correctly |
| Performance | Representative small/large histories; startup latency; scan latency; RSS/CPU; no material regression beyond existing resource/deadline ceilings without owner sign-off |

## Release acceptance gates

Every item is required for a Store release claim:

- [ ] Final bundle ID and commercial model explicitly approved.
- [ ] Main app and every helper are sandboxed and show only reviewed
      entitlements in the exact candidate archive.
- [ ] A persistent, revocable, read-only folder bookmark works across relaunch
      and login-at-startup without granting neighboring access.
- [ ] The full companion and keychain paths pass under JIT-less Node at target
      history sizes and resource ceilings.
- [ ] Store container state and explicit migration/rollback paths are verified.
- [ ] Sparkle and all independent update behavior are absent from the Store
      archive; the direct updater remains verified separately.
- [ ] The Store app is useful without hosted service availability or reviewer
      possession of Codex history.
- [ ] Privacy manifest/API audit, App Privacy answers, privacy/support URLs,
      deletion/revocation behavior, and export-compliance answers match the exact
      binary and backend.
- [ ] Authentication rules are satisfied or a documented exception is confirmed.
- [ ] Direct-channel regression and release tests remain green.
- [ ] Internal TestFlight evidence covers fresh user, minimum/current OS,
      permission denial/revocation, login launch, quit cleanup, and offline use.
- [ ] Metadata, screenshots, localization, review notes, and contact details are
      checked against the processed build.
- [ ] Submission and release each receive explicit owner approval.

## Rollback and containment

- Keep Store changes behind a build-time channel contract until release; a
  failed experiment cannot change the installed direct app's entitlements,
  updater, state root, or runtime mode.
- A rejected or faulty build can be held in TestFlight or withheld from release
  without affecting direct distribution.
- Store migration never removes direct data. A user can return to the direct app
  and reselect/re-pair without restoring a backup.
- Revoking/forgetting a bookmark removes Store authorization and stops active
  access; it does not touch the selected directory.
- Disable optional hosted features server-side only through a backwards-
  compatible, fail-safe response. Local analysis must continue.
- Preserve candidate archives and receipts for diagnosis, but keep credentials,
  bookmarks, raw sessions, and private diagnostics out of them.

## Stop conditions and escalation

Stop before further investment if any of these is true:

- the inherited helper cannot use a persistent folder authorization safely and
  the only viable answer is a broad privileged or temporary-exception design;
- JIT-less Node cannot meet correctness or existing performance/resource gates,
  and a narrowly justified Store-safe entitlement cannot be validated;
- required functionality depends on downloaded/executed code or on writing to
  the user's Codex data;
- App Review policy makes the core bundled companion architecture ineligible;
- migration would require destructive or silent access to direct-channel data;
  or
- maintaining two release channels costs more than observed Store demand
  justifies.

At a stop condition, write a decision record with the failed proof, affected
requirements, measured cost, and a choice among stop, native broker, broader
rewrite, or direct-only distribution.

## Estimated work and checkpoints

| Checkpoint | Estimate | Exit |
|---|---:|---|
| Source contracts and JIT-less smoke | 0.5 day | Completed; standard and JIT-less ad-hoc artifact smokes green |
| Sandboxed helper + bookmark feasibility | 2–3 days | Phase 1 acceptance criteria green or documented stop |
| Production Store target, container, migration, updater split | 5–8 days | Repeatable signed local archive and full local matrix green |
| Privacy, demo/reviewer path, metadata, screenshots | 2–3 days | Owner-reviewed App Store Connect package |
| TestFlight fixes and release hardening | 2–4 days plus Apple processing/review | Release gate table complete |

The next bounded slice is Phase 1 only. Its deliverable is a local,
development-signed sandbox proof and a short receipt containing the artifact
hash, exact signatures/entitlements, bookmark lifecycle results, JIT-less
companion results, bundle inventory showing no Sparkle, sandbox-log outcome, and
measured startup/scan/resource behavior. It creates no external resource.

## Likely implementation map

| Area | Expected ownership/change |
|---|---|
| `apps/macos/UsageMonitorApp.swift` | Channel-aware updater UI, folder picker, bookmark lifecycle, container paths, empty/demo state, diagnostics |
| `apps/macos/MacAppStore.entitlements` | Reviewed main-app sandbox contract |
| `apps/macos/MacAppStoreNodeRuntime.entitlements` | Reviewed inherited-helper sandbox contract |
| New native bridge or XPC source under `apps/macos/` | Companion-side bookmark activation or bounded file brokering, only if the direct proof requires it |
| `scripts/build-macos-app.js` and release helpers | Explicit channel configuration, Store bundle assembly, archive/receipt support, prohibited-combination checks |
| Store resources under `apps/macos/Resources/` | Privacy manifest, truthful sample data, and any Store-specific help copy |
| `apps/local/` companion boundary | Accept only an already-authorized source; no authority from an untrusted raw path |
| Hosted auth configuration | Distinct redirect/semantic-open identities where the Store ID differs; backwards-compatible client support |
| `test/macos-*.test.*` and local companion tests | Artifact inventory, signatures, entitlements, bookmark lifecycle, JIT-less correctness/performance, migration, direct/Store parity |
| `docs/runbooks/` and `docs/receipts/` | Store build/upload runbook and point-in-time feasibility/TestFlight evidence |

Keep bridge code narrowly owned by the Store file-access boundary. Do not let a
feasibility experiment silently refactor shared accounting or contribution
logic.

## Primary sources checked for this plan

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Accessing files from the macOS App Sandbox](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
- [Embedding a helper tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- [Migrating an app's files to its App Sandbox container](https://developer.apple.com/documentation/security/migrating-your-app-s-files-to-its-app-sandbox-container)
- [App privacy details](https://developer.apple.com/app-store/app-privacy-details/)
- [Add a new app in App Store Connect](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
- [Create a Mac App Store provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile)
- [Upload app previews and screenshots](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots)
