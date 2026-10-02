---
title: Shared window maintained proof handoff
date: 2026-10-02
type: review
status: off-tree-static-validated-awaiting-baseline
---

## Exact scope

The handoff JSON in this directory gives every immutable proposed file, patch, controller and manifest SHA256. Candidate files were not edited. No D1 run was performed. Root confirmed the separate two inventory fixture repairs now pass; the old inventory SQL physical gates remain unqualified on restored a153.

Three independently adoptable patches:

- `2026-10-02-shared-window-maintained-proof-controls.patch`: one new15-case file. Its baseline-first selected case uses only existing public APIs on current source. Its facade-specific test looks up the proposed export only inside that excluded test body, so it cannot cause baseline module-load or typecheck failure.
- `2026-10-02-shared-window-maintained-proof-source.patch`: only the existing window-plan portion and one minimal maintained dependency facade. No SQL inventory rewrite, schema, trigger, index, token format, composition root or default-path option change.
- `2026-10-02-shared-window-maintained-proof-dense.patch`: separate real canonical101 control. It is held until source adoption; the original default101 file remains7d6c7ac7 and unchanged.

## Freshness and resources

The window admits reuse only for a real matching maintained binding plus canonical producer. The existing context captures the whole interval and each selected singleton with complete native owner/scope/clock coverage. The initial native inventory and exact native/maintained digest acquisition remain real work. A fresh context check closes that acquisition before enabling reuse. The same immutable digest vector and usage-day inventory already owned by the plan are reused; no second persistent inventory/vector cache is added.

Every `current()` requires actual summary capability, full source capability/generation/clock checks, fresh target authority, then another full source check after target work. Existing full seals and page endpoints retain method, source owner/input, selected head, payload identity, target authority and erasure checks. The final endpoint gets an additional context check. Any detected loss closes the handle and plan permanently, including restoration. Early return paths explicitly dispose the handle. No capability or seeded coverage at acquisition preserves native fallback.

The new logical metadata charge is derived from a canonical representation of the actual owner and attachment identities, exact requested scopes, unique exact canonical scope keys,64-character token stamps, and maximum-safe-integer widths for generation/deadline/expiry. This upper bound is added to the existing compact byte total. It is not a heap observation and does not enlarge8MiB compact,4MiB full-day,200-row page,950-statement or admission/headroom limits. No request can retain or renew a proof beyond120 seconds or the caller's remaining deadline.

## Controls and remaining gates

The15 additive controls cover positive canonical/native bundle parity and repeated operations without new inventory/link reconstruction; no attachment/no canonical producer/missing source or target capability fallback; actual source trigger/index/table and target trigger loss with restoration and sticky closure; all102 actual scope tokens with unseeded/foreign/too-long admission refusal; accepted formerly empty-day arrival; correction; clock expiry; physical v1.1 proof deletion with unchanged owner revision and restored retention guards; and accepted source mutation between initial fence and target work. Native proof deletion is explicitly labeled deliberate local corruption, not normal admission.

The baseline case records acquisition, repeated-operation and total physical rows/statements/writes/wall before its expected no-rescan assertion fails. Component fixture migration/source admission and independent native reference reads are excluded from that component comparison and labeled. Actual ordered delivery and canonical coverage/preparation are individually metered and reported. This is not an end-to-end performance claim.

The dense case retains the original genuine101-day/20,401-usage/1,313-quota source, native ordered authority, original parity/resource assertions, original900s test ceiling and950 statement cap. Its candidate actually uses the existing canonical producer, maintained attachment and canonical graph flag. It explicitly requires a real102-scope proof for each window admission. Canonical preparation has a separately declared120-attempt ceiling, and every episode is charged; the original native16-attempt test is unchanged. The unchanged original default101 test, original native lifetime suite and original2x SQL gates remain separate required evidence. Neither initial acquisition nor reuse within one invocation certifies warm C06 behavior.

## Controller sequence

1. Root adopts controls only. Run `maintained-window-baseline-1/maintained-window-baseline-1-runner.mjs --execute-once` once after an explicit lane grant. Current source hashes are pinned. Expected result is an exact-output successful journey followed by the genuine unchanged-native-rescan assertion failure; it must not be a setup, module or metadata failure. Ceiling180s child/300s controller.
2. After reviewed source adoption, a separate grant runs `maintained-window-controls-1/maintained-window-controls-1-runner.mjs --execute-once` for all15 controls. Each test ceiling stays180s; the aggregate child is bounded900s/controller1020s.
3. After dense test adoption and another grant, run `maintained-window-dense-1/maintained-window-dense-1-runner.mjs --execute-once`. Ceiling900s child/1020s controller. Full canonical graph qualification is unknown until executed.

All three use the reviewed actual `captureWholeWorkloadRunInputs`/`verifyWholeWorkloadRunInputs` with actual test/config import graph, recursive SQL filename-set, installed runtime closure and Node; exact source hashes; exclusive once markers; no retry or source-drift waiver;8MiB combined output/result limits; detached owned-group termination/reaping; and exact before/after equality. They have not captured or executed yet.

## Static evidence

- `typecheck-baseline.json`:0 diagnostics over current product source plus only new public-API controls.
- `typecheck.json`:0 diagnostics over the two proposed source files and both added tests.
- `static-checks.json`: all6 controller syntax checks and3 `git apply --check` operations passed.

These results establish reviewability and source compatibility only. No canonical performance success, overall qualification, warm C06, deployment or production claim is made.

## Disposal review correction

The facade now holds a mutable context reference. Explicit close, a false check and any thrown check clear that reference. Errors, including budget errors, are rethrown after release. An in-flight call uses a local snapshot and verifies both the closed flag and reference identity after its final full fence, preventing a concurrent close or failed sibling check from returning current. Once an in-flight call settles, the retained closed handle has no context reference. This is reference-lifetime behavior, not observed garbage collection.

`disposal-control.json` records four passing pure control-flow unit checks against the exact transpiled facade with stubbed dependencies: explicit close, false current, thrown current and close during the final fence. These are not native D1 proof or performance tests. The15-case controls-only patch and dense test patch are unchanged. Post-source manifests use the corrected facade hash; source guards, byte/query/time caps and endpoint fence order are unchanged.
