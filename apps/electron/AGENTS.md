# Electron desktop guidance

Scope: all files under `apps/electron/`. Apply the repository root guidance first.

## Ownership and isolation

- Electron owns desktop lifecycle, preload/IPC capabilities, settings, tray,
  menus, notifications, and platform integration. The existing local companion
  owns analysis and the shared web dashboard owns its data presentation; reuse
  those owners rather than introducing a second accounting implementation.
- Read `apps/local/AGENTS.md` for companion changes and `apps/web/AGENTS.md` for
  dashboard changes. Read `scripts/AGENTS.md` for packaging or smoke tools and
  `native/AGENTS.md` for Windows filesystem or credential changes.
- Keep renderer sandboxing, context isolation, loopback validation, navigation
  restrictions, and the frozen, narrow preload bridge. Renderer input does not
  authorize arbitrary paths, URLs, commands, or main-process operations.
- Platform capabilities must reflect actual qualification. A simulated adapter,
  development package, or passing contract test cannot enable signed-updater,
  notification-identity, credential, or installer production policy.
- Preserve single-instance control, bounded recovery, shutdown of the owned
  companion, safe cancellation, and settings persistence. Do not kill unrelated
  processes or reuse another app's mutable state to simplify a test.

## Packaging and dependencies

- Use the reviewed Electron staging and builder configuration. Keep the exact
  source/dependency closure and target-specific native bytes verifiable.
- Electron's pinned Keytar dependency is independent of the native Mac app's
  Swift Keychain broker. Do not restore retired native dependencies or route
  Electron through a native-only broker without an explicit design change.
- Keep unsigned development packaging separate from signing, notarization,
  installer/updater qualification, and public release. Never promote a prior
  receipt to proof for different source or artifact bytes.

## Validation and local handoff

- Run focused `apps/electron/test/*.test.mjs` tests while iterating, followed by
  affected web/companion and packaging contracts when their boundary changes.
- A user-visible fix needs a fresh packaged app and rendered inspection, not
  only a fake BrowserWindow or browser test. Bind smoke evidence to its exact
  source revision and ASAR digest; test the relevant settings and lifecycle flow.
- Use synthetic disposable profiles for automated tests. For an explicitly
  requested real-data handoff, use a private copy and preserve its matching
  identity salt. Never mutate or downgrade the native app's databases.
- Keep user-test apps and launchers in durable locations, not OS temporary
  directories. Preserve the previous working app/profile until the candidate
  passes its package gate. Keep raw logs and private state untracked.
- A local-QA launch must retain its no-hosted-contribution/no-credential-mutation
  safeguards. Preserving the host HOME for macOS Keychain discovery is not
  whole-process Keychain isolation and must not be described as such.
