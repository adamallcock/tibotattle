---
title: Monitoring Quality Report Source Notes
date: 2026-07-24
type: research
status: complete
---

# Monitoring Quality Report Source Notes

## Reporting job

The report answers which improvements the retained logs support and which changes most improve the reliability of local quota monitoring. It uses a technical audience and a single portable HTML delivery surface.

## Required technical-report structure

| Required role | Visible report section |
|---|---|
| Title | Where the Usage Monitor Can Get Tighter |
| Technical summary | Technical summary |
| Key findings with visual evidence | Coverage, quantization, reset-family, and priority sections |
| Scope, data, and definitions | Scope, data, and metric definitions |
| Methodology | Methodology |
| Limitations and robustness | Limitations, uncertainty, and robustness |
| Recommended next steps | Recommended next steps |
| Further questions | Further questions |

## Source inventory

| Source | Role |
|---|---|
| `.usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json` | Adjacent quota snapshots, local usage, reset families, parser diagnostics, and retained coverage from July 21–24 |
| `.usage-monitor/collector-events.jsonl` | Prospective collector freshness, source, account-scope, speed, and receipt-lag diagnostics |
| `.usage-monitor/monitoring-quality-v0.1.json` | Reproducible derived quality profile used by the report |
| `docs/governance/2026-07-24-coverage-gaps-register.md` | Cross-surface blind spots that cannot be inferred from local Codex logs alone |

## Chart map

| Section | Analytical question | Family / type | Fields | Supported claim | Palette and non-color policy |
|---|---|---|---|---|---|
| Metadata coverage | Which required dimensions are actually observed? | Comparison / categorical bar | dimension, coverage fraction | Speed coverage is strong; account, plan, age, and control are binding gaps | Single-root blue; category labels and exact tooltips carry meaning |
| Quota signal mix | Why is minute-level attribution unstable? | Comparison / categorical bar | display signal, interval count, share | Whole-percentage flat observations dominate adjacent snapshots | Single-root blue; sorted labels and exact tooltips carry meaning |

The reset-family evidence remains a table because there are only two rows and exact group, cluster, singleton, and transition counts are the decision-relevant evidence. A chart would either hide the main-limit detail under the 583-group moving family or require a transformed scale that would make the comparison less direct.

## Reproduction

```bash
npm run quality -- --input .usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json
node ./src/build-monitoring-quality-report.js
node $HOME/.codex/plugins/cache/openai-curated-remote/data-analytics/0.2.8-13ceeea1f599/skills/build-report/scripts/build_portable_artifact.mjs \
  --input .usage-monitor/legacy-reports/2026-07-24-monitoring-quality-artifact.json \
  --output .usage-monitor/legacy-reports/2026-07-24-monitoring-quality-report.html
node ./src/fix-portable-report-width.js .usage-monitor/legacy-reports/2026-07-24-monitoring-quality-report.html
node $HOME/.codex/plugins/cache/openai-curated-remote/data-analytics/0.2.8-13ceeea1f599/skills/build-report/scripts/verify_portable_artifact.mjs \
  --html .usage-monitor/legacy-reports/2026-07-24-monitoring-quality-report.html \
  --artifact .usage-monitor/legacy-reports/2026-07-24-monitoring-quality-artifact.json
```

## Interpretation boundary

The report diagnoses monitorability. It does not identify the provider's absolute subscription allowance, infer historical account identity, or assign shared ChatGPT/Work/cloud usage to a local Codex event.
