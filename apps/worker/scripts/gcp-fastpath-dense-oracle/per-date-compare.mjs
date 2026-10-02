#!/usr/bin/env node
// Compare a GCP fast-path rehearsal's stored preview and served
// allowanceBreakdowns with an oracle's per-date expectation (owner decision 2):
//
//   node apps/worker/scripts/gcp-fastpath-dense-oracle/per-date-compare.mjs \
//     --expected apps/worker/analytics-v2-test/golden-q1-node/per-date-expected.json \
//     --response <rehearsal --out>.response.json --preview <rehearsal --out>.preview.json
//
// The rehearsal's own comparator holds model days to the production golden,
// where production withholds a date until every owner has a result; this holds
// them to the per-date publication the fast path implements instead. Objects
// are compared with their keys sorted; arrays keep their order. Prints one JSON
// report and exits 0 only when both families are equal. Reads local files only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sorted = (value) => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
    : value;

/** Up to `limit` JSON paths where the two values differ. */
export function perDateDiffs(expected, actual, path = "$", out = [], limit = 20) {
  if (out.length >= limit) return out;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
      perDateDiffs(expected[index], actual[index], `${path}[${index}]`, out, limit);
    }
  } else if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      perDateDiffs(expected[key], actual[key], `${path}.${key}`, out, limit);
    }
  } else if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out.push({ path, expected: JSON.stringify(expected ?? null).slice(0, 200), actual: JSON.stringify(actual ?? null).slice(0, 200) });
  }
  return out;
}

export function comparePerDate({ expected, response, preview }) {
  const families = {
    preview: { expected: expected.preview, actual: preview },
    allowanceBreakdowns: { expected: expected.allowanceBreakdowns, actual: response?.allowanceBreakdowns ?? null },
  };
  const report = { schemaVersion: "gcp-fastpath-per-date-compare-v1", decision: expected.decision, families: {} };
  for (const [name, { expected: want, actual: got }] of Object.entries(families)) {
    const equal = JSON.stringify(sorted(want)) === JSON.stringify(sorted(got));
    report.families[name] = { equal, diffs: equal ? [] : perDateDiffs(sorted(want), sorted(got)) };
  }
  report.equal = Object.values(report.families).every((family) => family.equal);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const read = (name) => { const path = value(name); if (!path) throw new Error(`PER_DATE_COMPARE_ARGUMENT_MISSING:${name}`);
    return JSON.parse(readFileSync(resolve(path), "utf8")); };
  const report = comparePerDate({ expected: read("--expected"), response: read("--response"), preview: read("--preview") });
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  process.exitCode = report.equal ? 0 : 1;
}
