---
title: Node telemetry byte bounds composition
date: 2026-10-03
type: receipt
status: source-implemented-unregistered
---

# Scope and result

This isolated candidate composes native `Buffer.byteLength` into the Node GCP analytics telemetry bounds path. It changes only final UTF-8 length calculation after the unchanged descriptor walk and `JSON.stringify`. Its source baseline is Wave26 `e5710f174e38d5ac8c710bcde428aebf17500b2e`. The accepted research branch `codex/byte-bounds-20261003` at `2ab8e5acbeefd1a6876cb02c06c54e07ef3648b1` remains unchanged. This branch reuses those research files and reviewed offline producer-helper `32c47fc3` as prerequisites.

No canonical package, vendor source, manifest, browser mirror, schema, registry, resource budget or Wave26 checkout changed. No generator is needed because vendored bytes remain original. There is no registered candidate, full-refresh result, production admission or new cache-class claim. No corpus, database, cloud operation, network request or new benchmark ran.

## Binding and source identity

[The Node facade](../../apps/worker/cloud-run/node-host-primitives.mjs) adds `hostUtf8Length(serialized)`, using `Buffer.byteLength(serialized, "utf8")`. [The new binding policy](../../apps/worker/cloud-run/telemetry-byte-bounds-binding.mjs) acts only for Node ESM and exactly `vendor/analytics-d43c8f92/packages/telemetry-contract/src/primitives.js`. It pins that complete original file to SHA256 `6f883333bf39759f0f42b7c8f6fa5524d0b6cd421ed0cc7fe3d61c338c20aa2e`, verifies one exact expression and injects the reviewed facade import. Unexpected source changes fail with `TELEMETRY_BYTE_BOUNDS_SOURCE_CHANGED`; other files, non-Node platforms and IIFE retain original defaults.

The imported helper replaces only `new TextEncoder().encode(serialized).byteLength`. Complete validation, serialization, sanitized failures, return value, string-type guard and strict greater-than threshold stay unchanged; no limit causes early exit. Canonical and vendored package source remain platform-neutral and byte-identical to the baseline. The transformation is deterministic from those pinned source bytes and the hashed policy.

The existing `cloudRunBuildPlugins` composes the plugin for actual builds. The metafile assertion checks the exact transformed-source-to-facade import edge, plus presence of the target source in both refresh Job and compute Worker outputs. Missing or escaped composition refuses. Build/check and closure derivation invoke that assertion.

Compute identity hashes original reached bytes, the actual Node facade and transformation policy. Pricing identity includes the policy only if the transformed primitives contribute to the pricing output; a synthetic extra pricing export exercises that positive conditional path. No broad pricing/cache stability is inferred from a file being outside a narrower class.

The reviewed offline producer helper passes its injected source reader through composition and adds the policy when the transformed module is reached. Wave26 has no `store-prepared-day.ts`, so actual L2 producer-class derivation still refuses. A clearly labelled source/policy fixture builds the real bound primitives and proves sensitivity without supplying an L2 runtime or inventing a producer class. Actual producer-class qualification remains after the L2 fold.

## Focused proof and remaining gates

The actual Node composition replaces the research-only Buffer transform in the complete 334-case differential suite. It retains exact thresholds, error class name/message/code/detailCode, returns and hook/Proxy traces, including inherited object/array-toJSON and inherited-accessor effects. The portable counter's exhaustive UTF-16 checks remain in the same suite.

The new composition checks prove native Buffer invocation only after valid serialization, no call for pre-serialization rejection, missing-edge/required-output refusal, source-pin refusal, portable browser/IIFE/non-target behavior, compute policy/facade sensitivity, conditional reached-pricer sensitivity and fixture producer-policy sensitivity. The missing actual L2 producer fails explicitly on this source baseline. Seven owning Node tests passed; the existing Node host spec passed 11/11. Source was still under development for these iteration checks; final pinned gates and independent review follow below.

Registration and consolidated closure pins remain coordinator-owned. Production `build.mjs --check` and normal build must stay refused while no registry entry names this candidate; `--kernel-closure` can report its source identity. Full combined analytics/workload/resource qualification remains separate. No new CPU or allocation improvement is claimed here beyond [the accepted synthetic research receipt](2026-10-03-telemetry-byte-bounds-investigation.md).

Owning commands, Node 22.16.0:

```sh
node --test test/telemetry-byte-bounds.test.js
cd apps/worker
npm exec -- vitest run --config vitest.analytics-v2.config.mjs analytics-v2-test/node-host-primitives.spec.ts
node cloud-run/build.mjs --kernel-closure
```

Root preflight, architecture, Worker typecheck and pricing-class checks qualify the final pinned source. Complete registry/closure and producer-runtime gates remain deferred as specified above.
