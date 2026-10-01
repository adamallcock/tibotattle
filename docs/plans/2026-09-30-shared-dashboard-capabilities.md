---
title: Shared dashboard capability simplification
date: 2026-09-30
type: plan
status: in-progress
---

Use one shared dashboard source with read-only presentation as its default.
Electron explicitly advertises collection, settings and accountless sharing
through its frozen preload bridge. Remove retired social sign-in, pairing,
consent and disconnect UI from the dashboard; retain backend legacy contracts
and Electron's existing sharing policy and persistence.

Acceptance:

- No Google/Apple sign-in controls or legacy social flow in dashboard source.
- An absent or malformed host capability does not start collection or sharing.
- Electron retains manual/automatic refresh, cancellation, settings, sharing
  notices and saved opt-outs through the existing owners.
- Read-only clients reuse the same HTML, modules and styles without overrides.
- Focused behavior tests, the web gate, relevant Electron contracts, documentation
  checks and rendered inspection establish the scoped result. Packaged/native
  and release evidence remain separate gates.

Steps:

1. Trace startup, mutation controls and retired social dependencies.
2. Remove retired presentation and add explicit host capability gates.
3. Update regression tests and maintained architecture documentation.
4. Validate behavior and rendered defaults; record evidence and remaining gates.

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

Remaining: build a fresh unsigned Electron package and inspect its capability
controls and Settings with an isolated synthetic local-QA profile. No signing,
installation, hosted contribution or publication is authorized by this plan.
