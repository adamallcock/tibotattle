import test from "node:test";
import assert from "node:assert/strict";
import { assertOutputProvenance, collectOutputDigestEvidence, OUTPUT_DIGEST_POLICY, PRICING_CLASS_SCHEMA, semanticOutputRow } from "./output-digest-policy.mjs";
const binding = { kernelId: 5, computeSha256: "a".repeat(64), manifestVersion: 1 };
const columns = Object.entries({ ...OUTPUT_DIGEST_POLICY, ...PRICING_CLASS_SCHEMA }).flatMap(([table_name, keys]) => keys.map((column_name) => ({ table_name, column_name })));
function pool({ bad = null, catalog = columns } = {}) {
  return { calls: [], async query(sql, args) {
    this.calls.push([sql, args]);
    if (sql.includes("information_schema.columns")) return { rows: catalog };
    if (sql.includes("FROM pg_class")) return { rows: Object.keys(OUTPUT_DIGEST_POLICY).map((name) => ({ name })) };
    if (sql.includes("raw_sha256")) return { rows: [{ rows: 1, raw_sha256: "a".repeat(64), semantic_sha256: "b".repeat(64) }] };
    return { rows: [{ mismatches: bad && sql.includes(bad) ? 1 : 0 }] };
  } };
}
test("accounting, owners and prices survive every declared semantic projection", () => {
  for (const table of Object.keys(OUTPUT_DIGEST_POLICY)) {
    const before = { daily: { usd: 1 }, owner_digest: "owner-a", inputs_sha256: "a", cards_sha256: "a", pricer_sha256: "a", method: 1, repriced_events: 1 };
    for (const key of Object.keys(before)) {
      assert.notDeepEqual(semanticOutputRow(table, before), semanticOutputRow(table, { ...before, [key]: "changed" }), `${table}.${key}`);
    }
  }
});
test("unknown tables and columns receive no implicit stamp removal", () => {
  assert.deepEqual(semanticOutputRow("analytics_v2_future", { kernel_id: 99, compute_sha256: "wrong" }), { kernel_id: 99, compute_sha256: "wrong" });
  assert.equal(semanticOutputRow("analytics_v2_owner_day", { unknown_accounting: 9, kernel_id: 5 }).unknown_accounting, 9);
});
test("a wrong kernel, compute class, first card kernel or manifest refuses before digest collection", async () => {
  for (const bad of ["kernel_id IS DISTINCT FROM", "compute_sha256 IS DISTINCT FROM", "first_kernel_id IS DISTINCT FROM", "manifest_version IS DISTINCT FROM"]) {
    await assert.rejects(collectOutputDigestEvidence(pool({ bad }), "synthetic", binding), { code: /MEAS_OUTPUT_PROVENANCE_INVALID/u });
  }
  await assert.rejects(assertOutputProvenance(pool(), "synthetic", { ...binding, kernelId: 3 }), { code: "MEAS_OUTPUT_PROVENANCE_BINDING_INVALID" });
});
test("new pricing tables are affirmative and schema absence or broken class linkage refuses", async () => {
  await assert.rejects(assertOutputProvenance(pool({ catalog: columns.filter((row) => row.table_name !== "analytics_v2_pricing_classes") }), "synthetic", binding), { code: "MEAS_OUTPUT_CLASS_SCHEMA_INVALID" });
  await assert.rejects(assertOutputProvenance(pool({ bad: "c.cards_sha256 IS DISTINCT FROM" }), "synthetic", binding), { code: "MEAS_OUTPUT_PROVENANCE_INVALID:pricing-class" });
  await assert.rejects(assertOutputProvenance(pool({ bad: "p.method NOT IN" }), "synthetic", binding), { code: "MEAS_OUTPUT_PROVENANCE_INVALID:proof" });
});
test("raw provenance is retained beside each semantic digest, including all three pricing tables", async () => {
  const result = await collectOutputDigestEvidence(pool(), "synthetic", binding);
  for (const table of ["analytics_v2_pricing_classes", "analytics_v2_kernel_pricing_classes", "analytics_v2_transition_proofs"]) {
    assert.equal(result.tables[table].rawSha256, "a".repeat(64));
    assert.equal(result.tables[table].semanticSha256, "b".repeat(64));
  }
});

test("Q1's explicit two completed runs keep all stamp checks; unbounded counts refuse", async () => {
  const result = await assertOutputProvenance(pool(), "synthetic", { ...binding, expectedRunCount: 2 });
  assert.equal(result.expectedRunCount, 2);
  await assert.rejects(assertOutputProvenance(pool({ bad: "state <>" }), "synthetic", { ...binding, expectedRunCount: 2 }), { code: "MEAS_OUTPUT_PROVENANCE_INVALID:run" });
  await assert.rejects(assertOutputProvenance(pool(), "synthetic", { ...binding, expectedRunCount: 3 }), { code: "MEAS_OUTPUT_PROVENANCE_BINDING_INVALID" });
});
