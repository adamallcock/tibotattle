---
title: Native-First macOS Client Migration Plan Red-Team
date: 2026-08-03
type: review
status: complete
---

# Native-First macOS Client Migration Plan Red-Team

## Scope and method

This review stress-tested the proposed native-first migration rather than the
current implementation. Four independent passes covered implementation
completeness, maintainability/code quality, test-and-release discipline, and
performance/resource behavior. The reviewed plan is
[`2026-08-03-native-first-macos-client-migration-plan.md`](../plans/2026-08-03-native-first-macos-client-migration-plan.md).

The red-team verdict on the *first draft* was: **directionally correct, but not
safe to start parallel implementation until the missing interface, lifecycle,
and release contracts were made explicit.** The revised plan resolves the
blocking omissions below. It is ready for a clean-baseline implementation once
the architecture and preview-channel decisions are approved.

## Consolidated findings and disposition

| Severity | Finding | Why it matters | Revised-plan disposition |
| --- | --- | --- | --- |
| Blocker | A loopback URL plus origin checks is not a native-client capability boundary. | A browser or local process could invoke a new native mutation route if the protocol only relied on host/origin heuristics. | Per-launch 256-bit capability delivered once through inherited stdin, held in process memory, sent only in a header, rotated at restart, and tested against absent/wrong/old credentials. The plan explicitly limits the threat claim to browser/network-origin misuse, not a hostile same-user process. |
| Blocker | The snapshot endpoint had no revision, operation, or payload contract. | An old response could overwrite a newer result; a huge chart could freeze native rendering; a “fresh” label could be fabricated before work completed. | The plan now specifies instance/revision/ETag ordering, operation IDs and terminal revisions, a 300-second companion deadline, deterministic server-side downsampling, and size/cardinality limits with `resource_limited` behavior. |
| Blocker | Native controls were named but not fully contracted. | Buttons would risk becoming UI-only promises with duplicate submits, unclear retry behavior, or undocumented destructive operations. | A command table now requires request/response schemas, auth, idempotency, cancellation, terminal codes, diagnostics, and JavaScript/Swift positive/negative fixtures before a button connects. |
| Blocker | The current browser renderer could retain independent pricing/freshness logic. | Two renderers calculating the same number would recreate the current hybrid contradiction. | Browser conformance is a dedicated lane in Phase 1. It reads canonical snapshots only and deletes browser-side pricing/freshness inference before it can be considered a fallback. |
| Blocker | The plan lacked a shipped-source-set guarantee for Swift. | `swift test` could exercise a package while the direct `swiftc` bundle compiled a divergent source graph. | `TiboTattleCore` plus a named AppKit allowlist becomes the declared source set. The existing bundle script derives/validates its source inventory and `product:macos:test` aggregates source parity, `swift test`, snapshots, bundle tests, and installed smoke. |
| Blocker | A native Apple sign-in implementation was assumed without a distribution decision. | Developer ID distribution cannot simply inherit an App Store authorization entitlement/provisioning model. | The first native release preserves the existing service-hosted Google/Apple browser flow. Native Apple authorization is explicitly deferred until a separately approved App Store/ad-hoc track proves entitlement and signing requirements. |
| High | Automatic refresh and menu state had competing owners. | This caused stale display, duplicate work, and menu/main-window disagreement. | One `LocalRefreshCoordinator` owns refresh intent. A visibility/activation policy forbids hidden auto-work and browser/AppDelegate/menu loops; the menu is only a projection of `DashboardStore`. |
| High | Data & privacy could become a no-op page or lose reachable controls. | The migration could either keep a confusing empty page or drop contribution, queue, diagnostics, and recovery pathways. | A lifecycle inventory assigns every retained journey a surface, safe command, and acceptance test. The empty Settings Privacy pane is removed unless real controls are wired. |
| High | Legacy removal had no proven rollback path. | A native-default bug could strand users or force data-destructive recovery. | A presentation-only native/legacy/automatic flag persists for a preview cycle. The guarded preview installer preserves an application backup, and signed upgrade/relaunch/rollback is a gate before cleanup. |
| High | Parallel agents could conflict in `UsageMonitorApp.swift`, resources, and build configuration. | Parallelism would create integration churn and hidden build regressions. | The revised plan names a serial composition/build/localization owner; feature agents own new directories only and hand off localization deltas. |
| Medium | Visual and accessibility QA was asserted but not reproducible. | Passing unit tests would not catch blank titlebar/menu, clipping, or non-native interaction regressions. | Fixed review baselines, a concrete appearance/window/text/data/interaction matrix, and an installed-app review on minimum/current macOS are release gates. |
| Medium | Performance goals lacked fixture scales and resource limits. | The migration could deliver elegant code that stalls on real local history. | Contract budgets and a benchmark lane now bind snapshot size, chart/cardinality, decode/render/share latency, memory stability, and semantic-preserving parsing performance to recorded fixtures and a reference machine. |
| Medium | A development build could remain intentionally disconnected while users were asked to test auth/updater. | Manual tests would produce false failures or dead-end buttons. | The plan separates local-fixture, signed connected-preview, and production-candidate channels. A connected preview is required for human auth/updater/contribution testing; disabled features must say which configuration is missing. |

## Residual risks that remain intentional

- The first native release intentionally keeps hosted identity in an isolated
  browser/web-view flow. It reduces native OAuth and Apple-distribution risk,
  but does not make that flow “done”; signed connected-preview tests remain
  mandatory.
- The migration intentionally does not turn loopback into a defense against a
  malicious process executing as the same macOS user. It constrains browser and
  accidental local-origin misuse without making a false security claim.
- The plan preserves Node ownership of parsing, accounting, pricing, and
  calibration. A separate accounting change remains required if an independent
  pricing audit finds incorrect underlying numbers.
- Exact performance values must be recorded on the chosen Apple-Silicon
  reference machine before they become a historical regression baseline. The
  response/cardinality budgets are immediate safety limits; machine-speed
  baselines are not guessed from a planning document.

## Required execution discipline

1. Start only from a clean, agreed integration baseline; do not interleave this
   migration with unreviewed event-time pricing work in a shared dirty checkout.
2. Freeze and review the local schema/capability/command fixture package before
   native pages make live requests.
3. Give each implementation agent the exclusive file scope and test obligations
   listed in the plan; use the serial integration lane for composition root,
   resources, localization, bundle script, and CI changes.
4. Treat a signed connected-preview upgrade/rollback journey as the first
   evidence that auth, contribution, update, and real installed behavior work.
5. Delete the legacy personal-dashboard bridge only after the preview gate and a
   separately reviewed cleanup change pass.

## Red-team conclusion

The revised plan is not a request for an all-at-once rewrite. It is a staged
replacement of the UI boundary with a narrow local contract, a testable
native-first shell, and a reversible release path. That reduces long-term
maintenance by removing duplicate route, refresh, pricing-display, and
presentation ownership rather than adding another bridge layer.
