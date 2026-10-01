---
title: Correct dashboard social UI scope
date: 2026-09-30
type: plan
status: in-progress
---

Electron is the main TiboTattle app. The owner's screenshot shows the retained
accountless Community status and toggle. The earlier interpretation of
read-only as a general dashboard mode was incorrect.

Remove the added presentation capability flags and default control suppression.
Keep the retired Google/Apple sign-in, consent, pairing and disconnect UI
removed at source. Preserve collection readiness, refresh/cancel/cadence,
Settings, sharing notices, saved opt-outs and backend legacy contracts.

Validate focused behavior, web/export/runtime closure, architecture and
documentation. Build a fresh unsigned Electron package and inspect collection,
Settings and the remaining Community panel in an isolated local-QA profile.
Retire this plan and the earlier superseded validation record after recording
the corrected source/package evidence. Release and publication remain separate.
