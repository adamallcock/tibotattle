---
title: Shared dashboard capability validation
date: 2026-09-30
type: review
status: local-verified
---

Snapshot from 2026-09-30 on macOS arm64 and Node.js 26.2.0. Source and the
unsigned development package are locally verified. This record binds the
dashboard simplification to source revision
`4022779f6e2990c0a87eeec4c4d733c9a1b7e859`; subsequent documentation changes do
not change the packaged source. Current contract:
[system architecture](../reference/system-architecture.md).

One shared dashboard source defaults to read-only presentation. Electron
explicitly advertises collection, settings and accountless sharing through its
frozen preload bridge. Retired social sign-in, pairing, consent and disconnect
UI is removed; backend legacy contracts and Electron's existing sharing policy
and persistence remain intact.

Acceptance:

- No Google/Apple sign-in controls or legacy social flow in dashboard source.
- An absent or malformed host capability does not start collection or sharing.
- Electron retains manual/automatic refresh, cancellation, settings, sharing
  notices and saved opt-outs through the existing owners.
- Read-only clients reuse the same HTML, modules and styles without overrides.
- Focused behavior tests, the web gate, relevant Electron contracts, documentation
  checks and rendered inspection establish the scoped result. Packaged/native
  and release evidence remain separate gates.

Source validation on 2026-09-30:

- `pnpm run product:ui:test`: 646 passed, including read-only refusal,
  collection cadence, cancellation and visible accountless-sharing receipts.
- Focused Electron shell, sharing, sharing-installation and cadence: 106 passed.
- Export, browser serving and Electron static assets: 5 passed. Native runtime
  closure and localization boundary: 2 passed.
- `pnpm run test:preflight` and `pnpm run architecture:check`: passed.
- The exact shared source rendered existing real companion data through a
  loopback preview that refuses all mutation methods. Community and navigation
  were inspected at desktop and 390-pixel widths, including Chinese copy.
- The broad root run had 5,047 passes, 21 failures and 46 skips. The two affected
  source assertions were updated and passed; four dependency-import test files
  passed after installing locked Worker dependencies. Remaining failures concern
  separate benchmarks, retained receipts, release metadata, native sandbox or
  synthetic ingestion contracts. The broad gate is not green.

Package validation:

- `node scripts/package-electron-development.mjs --target darwin-arm64 --format dir`
  built and verified the fresh TiboTattle Dev 0.1.22 package. Receipt:
  `.release-build/electron-candidates/4022779f6e2990c0a87eeec4c4d733c9a1b7e859/darwin-arm64/dir/development-package.json`.
- ASAR SHA-256:
  `8fac1670225c9cfea76778e7a41e99470d89909e03d9148733e678410becff4b`.
- Native UI inspection used the existing synthetic smoke fixture and explicit
  `macos-electron-local-qa-v1` lane. Hosted contribution was disabled; a
  development identity kept production credentials outside the tested flow.
- Analyze local usage exposed its running/cancel controls and completed with
  fresh synthetic accounting. The fixture completed before a cancel click;
  cancellation outcomes are covered by the focused behavior tests.
- Community showed the saved sharing-off choice and only the accountless
  controls. Settings opened, displayed the current collection configuration
  and sharing-off choice, and Manage sharing returned to that same panel.
- The isolated app quit with exit code 0, and its disposable fixture was removed.
  The read-only preview and temporary browser tab were also closed.

The broad root gate remains incomplete as described above. Physical Windows
and Linux, signing, installed migration, updater and public deployment are
separate gates. No hosted sharing or publication was exercised.
