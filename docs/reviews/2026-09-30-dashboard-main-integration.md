---
title: Dashboard social UI retirement integrated with main
date: 2026-09-30
type: review
status: local-verified
---

Electron remains the main app. The shared dashboard removes retired social
sign-in, consent, pairing and disconnect presentation at source. Collection,
Settings and the accountless Community status/toggle retain their existing
owners. Current contract: [system architecture](../reference/system-architecture.md).

Integration source: `ac619b277ed29689bd582a4a7690cc1872bfa4cf`, incorporating
main `f0067d0f6d1d69f3ed9fa79c64c429e61c122929`. Conflict resolution preserves
main's current charts, appearance, refresh leases, startup and sharing behavior.
Subsequent changes only record this evidence. The earlier
[correction record](./2026-09-30-dashboard-social-ui-correction.md) qualifies its
older source/package only. The integrated production dashboard removes 4,486
net lines; retained backend contracts are unchanged.

Validation on macOS arm64, Node.js 26.2.0 and pnpm 11.9.0:

- Web gate: 991 passed; focused dashboard checks: 79 passed.
- Expanded Electron bridge, runtime, Settings, sharing and cadence checks:
  111 passed. Architecture, documentation preflight and Codex contract checks
  passed.
- Broad root run: 5,879 tests, 5,821 passed, 10 failed, 48 skipped. Eight
  failures concern managed-sandbox process visibility/network sandboxing;
  rechecking the relevant native audit and R7 files in a permitted host context
  passed all 45 tests. The two retained R7 receipt failures reproduce on
  unchanged main and report stale workload source hashes/file counts. Retained
  receipts were not regenerated. The broad gate is not claimed green.
- All three initial PR checks passed: documentation policy, release trust
  policy and committed-lock dependency scanning. Final PR CI remains a separate
  GitHub observation after this evidence commit.

A fresh unsigned TiboTattle Dev 0.1.26 directory package passed verification:
ASAR SHA-256 `f00b6fca3715bcca8343709c61861b75423d7a6acca36e3c147a8e98346310c1`.
Its ignored receipt is under
`.release-build/electron-candidates/ac619b277ed29689bd582a4a7690cc1872bfa4cf/darwin-arm64/dir/`.
Native inspection used a disposable synthetic profile, development identity and
the existing local-QA lane with hosted contribution disabled. Automatic startup
collected 124 synthetic tokens. Community displayed the preserved off choice,
transport status and toggle without retired social controls. Settings opened,
displayed the saved choice and five-minute cadence, and Manage sharing returned
to the same Community panel. The new inspection app quit with exit zero and its
fixture was removed; the earlier user-test window was not disturbed.

This qualifies integrated source and an unsigned local package. It does not
qualify signing, installed migration, updater publication, physical Windows/Linux
or a public deployment.
