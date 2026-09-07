# Native macOS guidance

Scope: all files under `apps/macos/` and macOS bundle behavior they define.
Apply the repository root guidance first.

## Authorities and boundaries

- Read `apps/macos/README.md` for the implemented lifecycle and
  `docs/runbooks/macos-stable-release-runbook.md` for the current stable release
  order. For Preview or internal-dogfood work, read the Preview and dogfood
  sections of `apps/macos/README.md` plus the state-transition section of the
  stable runbook, so an isolated product smoke is not mistaken for a
  same-identity upgrade proof. Read only the relevant sections.
- Treat Swift shell source, a development bundle, preview distribution, a signed
  and notarized candidate, an installed app, a Sparkle update, and a published
  release as separate artifacts and gates.
- Do not change bundle identity, state roots, entitlements, login-item behavior,
  callback schemes, endpoints, update channels, signing policy, or compatibility
  promises as a convenience. These are release and user-state contracts.
- The native shell composes the loopback companion. It must not create a second
  accounting truth, scan raw logs autonomously, or make offline mode depend on a
  hosted service.

## State, privacy, and lifecycle

- Native diagnostics and UI state remain content-free. Do not expose paths,
  credentials, raw provider payloads, or session content through Swift errors,
  logs, accessibility labels, clipboard actions, or crash reporting.
  The approved local cache-drop thread-name UI and Codex UUID handoff are
  ephemeral navigation only, never native diagnostics or persisted UI state.
- Read actual macOS service state after login-item, notification, Keychain, or
  permission requests. Do not equate a requested state with an applied state.
- Unknown, stale, connecting, indexing, cancelled, unavailable, and failed states
  remain visibly distinct. Preserve the last verified result without presenting
  it as fresh.
- Never destroy shared application state to make an older build open it. Any state
  migration or updater replacement requires backup, forward compatibility work,
  and rehearsal against a copy.
- Keep app termination, child-process cleanup, retry, cancellation, and repeated
  launch idempotent. Do not leave orphaned companions or update processes.

## Prompt-free Keychain operation

- Disable Keychain interaction for startup, refresh, background work, and
  automatic upgrade/migration. Use bounded silent retries; refreshes and
  companion restarts must not create retry or password-prompt loops.
- Preserve each credential reader's narrow signing identity and designated
  requirement across releases. Matching Team IDs alone, successful notarization,
  or an ad-hoc build do not prove access to an existing Keychain item.
- After silent recovery is exhausted, offer a quiet native Settings action.
  Explain the requested access before deliberate approval can enable an OS
  dialog. Cancel must be the default; denial/cancellation preserve credentials
  and history. Never request a Keychain password in app UI or trigger approval
  from a background task, web message, or automatic retry.
- Never broaden ACLs, entitlements, or access groups; disable macOS protection;
  use plaintext secret storage; or reset/delete/rotate an identity to suppress
  a prompt. Do not recommend blanket Always Allow access as a workaround.
- Qualify clean install and same-identity upgrades with exact signed artifacts,
  including normal launch/refresh/restart, locked or unavailable Keychain,
  exhausted retries, denial/cancellation, and partial migration. Unexpected
  prompts block dogfood replacement and public release; record unavailable
  evidence honestly rather than treating source tests as signed-upgrade proof.

## Build and release discipline

- Bundle construction requires macOS arm64 and exactly Node.js 26.2.0. The build
  must fail closed on another runtime.
- Development and test profiles cannot establish preview or external-distribution
  evidence. Never weaken profile checks or substitute ad-hoc signing for a
  retained release gate.
- Preparing pinned public dependencies and validating local output is distinct
  from accessing private signing material or publishing an update.
- The release command's `--prepare-candidate` flag continues into signing and
  notarization; it is not a compile-only or dry-run boundary.
- Never run preview installation/reinstallation, signing, notarization, appcast
  publication, system replacement, or stable release commands without explicit
  authorization for that operation and exact target.
- Do not print or persist signing identities, notary profiles, OAuth secrets, or
  update-signing material.

## Validation

- Use `npm run test:macos:source` for source/configuration checks.
- Use `npm run test:macos:smoke` only on the pinned builder; it creates and smokes
  a development-only test-profile app.
- Use `npm run test:macos:artifact` for bundle/updater artifact changes and
  `npm run product:macos:test` as the retained macOS gate.
- Inspect the actual native menu, window, lifecycle, and failure states for
  user-facing changes. A browser dashboard, source test, or screenshot from a
  different bundle does not qualify the native result.
- Record any unavailable signing, hardware, updater, clean-profile, or prior-version
  rehearsal gate explicitly rather than collapsing it into a passing source check.
