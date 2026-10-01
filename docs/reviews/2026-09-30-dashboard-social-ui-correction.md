---
title: Dashboard social UI scope correction
date: 2026-09-30
type: review
status: local-verified
---

Electron is the main TiboTattle app. The owner's Community screenshot means
retaining accountless sharing status and its toggle while removing retired
social sign-in UI. The previous general read-only dashboard interpretation was
incorrect; its flags, module and control suppression are removed.

Source revision: `1c5538cec8ae9860f410af1e02433b1010753855` on
`codex/shared-dashboard-capabilities`. This record applies to that earlier
source and package; integration with newer main requires separate validation.
Current contract: [system architecture](../reference/system-architecture.md).
Collection uses companion readiness; Settings and sharing use the existing
versioned Electron bridge. Refresh/cancellation, cadence, notice receipts,
saved opt-outs and legacy backend contracts retain their existing owners.

Validation on macOS arm64 with Node.js 26.2.0:

- Web gate: 644 passed. Focused Electron and export/serving contracts: 111
  passed. Native runtime closure and localization boundary: 2 passed.
- Architecture and preflight/documentation gates passed.
- The initial web check caught missing initial disabled attributes on collection
  buttons. They were restored; controls remain visible and await readiness.
- A fresh unsigned TiboTattle Dev 0.1.22 directory package passed verification.
  ASAR SHA-256:
  `129acc794d2107e5c00487573a3753c987e18b6b7eb58cd7198084f9ca07e114`.
  Its ignored `development-package.json` receipt is under
  `.release-build/electron-candidates/1c5538cec8ae9860f410af1e02433b1010753855/darwin-arm64/dir/`.
- Native UI inspection used the existing synthetic fixture and explicit
  `macos-electron-local-qa-v1` lane with hosted contribution disabled and a
  development identity. Normal startup collection completed automatically.
  Community displayed its saved off choice and toggle. Settings opened and
  Manage sharing returned to that same Community panel.
- The QA window was subsequently navigated during inspection and was left
  open on its disposable synthetic profile. It is not an installed-app or
  real-history handoff; the launcher removes that fixture when the app quits.

The prior broad root run had failures in separate benchmark, retained receipt,
release metadata, sandbox and synthetic-ingestion checks. That broad gate was
not rerun for this correction. Signing, installed migration, updater, physical
Windows/Linux and public deployment remain separate gates.
