# experiments/

Validated synthetic experiment manifests for the bounded experiment harness
(`src/experiment-harness.js`). Every manifest under `manifests/` is loaded and
validated by `test/experiment-harness.test.js` inside `npm test` — do not
delete or gitignore this directory.

A manifest with `"mode": "live"` is authorization-sensitive: it can consume a
real provider allowance or paid API capacity and must never be run merely
because it is checked in or validates successfully. Inspect the exact model,
reasoning effort, billing surface, projected cost/quota movement, headroom,
captures, and quiet-period budget, then obtain explicit approval for the run.
Prefer `dry` while changing or reviewing the harness. Validation proves only
the closed manifest contract; it does not prove current model availability,
pricing, account state, budget headroom, or permission to spend.
