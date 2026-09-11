---
title: Test performance lanes
date: 2026-08-04
type: decision-record
status: complete
---

# Test performance lanes

## Decision

Keep the existing serial `npm test` command unchanged. It is the broad,
deterministic repository suite and is intentionally not made globally parallel.
Instead, use narrowly scoped lanes with an up-front preflight:

| Command | Purpose | Concurrency / safety boundary |
| --- | --- | --- |
| `npm run test:preflight` | Verify all explicitly selected test targets, whitespace, and documentation links. | Always first; fails before an expensive native build. |
| `npm run test:fast` | macOS source and configuration assertions. | Serial test processes; excludes only the three explicitly tagged app-building tests. |
| `npm run test:macos:smoke` | Build one development app with the test compiler profile and execute its updater contract. | Requires macOS arm64 and pinned Node v26.2.0. Test profile uses `-Onone` and a keyed system-module cache; it cannot produce preview or external-distribution output. |
| `npm run test:macos:artifact` | Prepare the pinned Sparkle framework and run the complete app-bundle, updater, and updater-release tests. | Isolated from other stateful lanes; its two reproducibility outputs are independently built together and compared. |
| `npm run test:changed -- --base <rev>` | Route recognised changed paths to the smallest safe lanes. | Includes `<rev>...HEAD` plus staged, unstaged, and untracked paths. Only reviewed native app/build and i18n paths narrow; web, local, shared, runner, and unfamiliar paths run `npm run check`. |
| `npm run product:macos:test` | Complete native release-quality gate. | Remains the required pre-release/merge verification, not replaced by a fast lane. |

The artifact reproducibility test builds its two isolated output bundles in two
independent Node child processes. It still compares every listed payload file,
normalised digest, signature inventory, and runtime smoke, so the parallelism
is itself covered by the pre-existing reproducibility contract. Staging copies
request APFS copy-on-write cloning, with the platform fallback retained by Node
when cloning is unavailable.

## Why this shape

The direct baseline on 2026-08-04, from clean commit
`b011e86ce9f82e10e4c9ac4799645f1d909894c4` on this developer Mac, was
`59.73 s` for the serial `test/macos-app-bundle.test.js` file (29 passing,
one expected Sparkle-dependent skip). Most of that time was two complete app
bundles: copying the pinned Node runtime, compiling Swift with release
optimisation, ad-hoc signing, and deep integrity traversal.

Changing global test concurrency would make that stateful native work less
predictable and would not address its cost. The lanes instead distinguish
source assertions from an actual packaged-app build, leave release compilation
as `-O -whole-module-optimization`, and reserve the faster `-Onone` compiler
profile for an explicitly non-distributable smoke build. The smoke module-cache
key includes Node version, architecture, SDK path, Swift toolchain version,
minimum macOS version, and the test profile; the cache is a verified private
directory. No source output or release artifact is reused.

## Initial timing receipt

The final post-change `npm run test:benchmark` receipt on the same machine was
`1.4 s` for the source lane and `4.7 s` for the test-profile smoke (`6.1 s`
total). A subsequent release-inclusive receipt measured `1.3 s` for source,
`6.3 s` for smoke, and `93.9 s` for the retained macOS release gate (`101.4 s`
total). These are feedback-loop timings, not substitutes for the retained
release gate. They are deliberately recorded as local receipts only: compiler
module-cache state, APFS cache state, and machine load can materially change
them.

## Operating rule

Use a fast lane during edit/feedback cycles. Before merging native changes,
publishing a preview, or claiming a release result, run the retained
`npm run product:macos:test` gate. For a timing receipt on the current machine,
run `npm run test:benchmark:release`; timings are machine and cache-state
specific and must not be treated as a release proof.
