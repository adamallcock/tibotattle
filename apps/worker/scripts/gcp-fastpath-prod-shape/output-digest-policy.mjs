import { createHash } from "node:crypto";

const stamp = ["run_id", "kernel_id", "manifest_version"];
/** Closed semantic projections. Unknown tables and columns are retained verbatim. */
export const OUTPUT_DIGEST_POLICY = Object.freeze(Object.fromEntries(Object.entries({
  analytics_v2_owner_day: stamp,
  analytics_v2_cache_bands: stamp,
  analytics_v2_owner_fits: stamp,
  analytics_v2_owner_model_dates: stamp,
  analytics_v2_published_daily: [...stamp, "released_at"],
  analytics_v2_preview: [...stamp, "computed_at"],
  analytics_v2_journal_cursor: ["run_id"],
  analytics_v2_kernel_prices: ["kernel_id", "registered_at", "compute_sha256"],
  analytics_v2_price_cards: ["first_kernel_id"],
  analytics_v2_kernel_cards: ["kernel_id"],
  analytics_v2_price_bases: [],
  analytics_v2_owner_day_price: stamp,
  analytics_v2_kernel_transitions: ["proof_run", "recorded_at"],
  analytics_v2_transition_stale: [],
  analytics_v2_daily_owner_sets: stamp,
  analytics_v2_daily_contributions: [...stamp, "price_kernel_id"],
  analytics_v2_daily_owner_set_bootstrap: stamp,
  // These new tables remain affirmative outputs. Their class/proof contents are never removed.
  analytics_v2_pricing_classes: ["registered_at", "first_kernel_id"],
  analytics_v2_kernel_pricing_classes: ["registered_at", "kernel_id"],
  analytics_v2_transition_proofs: [],
}).map(([table, keys]) => [table, Object.freeze(keys)])));
export const PRICING_CLASS_SCHEMA = Object.freeze({
  analytics_v2_pricing_classes: ["pricing_class_id", "class_sha256", "pricer_sha256", "pricing_method_version", "projection_version", "cards_sha256", "first_kernel_id", "registered_at"],
  analytics_v2_kernel_pricing_classes: ["kernel_id", "pricing_class_id", "registered_at"],
  analytics_v2_transition_proofs: ["transition_id", "method", "pricing_class_id", "sample_divisor", "repriced_owner_days", "repriced_events"],
});
const RUN_TABLES = new Set(["analytics_v2_runs", "analytics_v2_kernels"]);
export const OUTPUT_DIGEST_POLICY_SHA256 = createHash("sha256")
  .update(JSON.stringify(OUTPUT_DIGEST_POLICY)).digest("hex");
const identifier = /^[a-z_][a-z0-9_]{0,62}$/u;
function fail(code) { throw Object.assign(new Error(code), { code }); }
export function semanticOutputRow(table, row) {
  const omitted = new Set(OUTPUT_DIGEST_POLICY[table] ?? []);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !omitted.has(key)));
}
/** Validate projected-out stamps before hashing; a wrong stamp cannot disappear. Fresh-run schemas only. */
export async function assertOutputProvenance(pool, schema, { kernelId, computeSha256, manifestVersion = 1, expectedRunCount = 1 } = {}) {
  if (!identifier.test(schema) || ![4, 5].includes(kernelId) || !/^[0-9a-f]{64}$/u.test(computeSha256)
      || !Number.isSafeInteger(manifestVersion) || manifestVersion < 1
      || !Number.isSafeInteger(expectedRunCount) || expectedRunCount < 1 || expectedRunCount > 2) fail("MEAS_OUTPUT_PROVENANCE_BINDING_INVALID");
  const q = `"${schema}"`;
  const checks = [
    ["required", `SELECT CASE WHEN (SELECT count(*) FROM ${q}.analytics_v2_kernels) = 1
      AND (SELECT count(*) FROM ${q}.analytics_v2_kernel_prices) = 1
      AND (SELECT count(*) FROM ${q}.analytics_v2_runs) = $1 THEN 0 ELSE 1 END AS mismatches`, [expectedRunCount]],
    ["kernel", `SELECT count(*)::int AS mismatches FROM ${q}.analytics_v2_kernels
      WHERE kernel_id IS DISTINCT FROM $1`, [kernelId]],
    ["compute", `SELECT count(*)::int AS mismatches FROM ${q}.analytics_v2_kernel_prices
      WHERE kernel_id IS DISTINCT FROM $1 OR compute_sha256 IS DISTINCT FROM $2`, [kernelId, computeSha256]],
    ["cards", `SELECT count(*)::int AS mismatches FROM ${q}.analytics_v2_price_cards
      WHERE first_kernel_id IS DISTINCT FROM $1`, [kernelId]],
    ["run", `SELECT count(*)::int AS mismatches FROM ${q}.analytics_v2_runs
      WHERE kernel_id IS DISTINCT FROM $1 OR manifest_version IS DISTINCT FROM $2 OR state <> 'complete'`,
      [kernelId, manifestVersion]],
  ];
  const columns = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name LIKE 'analytics_v2%'`, [schema]);
  const present = new Map();
  for (const row of columns.rows) {
    if (!identifier.test(row.table_name) || !identifier.test(row.column_name)) fail("MEAS_OUTPUT_TABLE_INVALID");
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name).add(row.column_name);
  }
  for (const [table, omitted] of Object.entries(OUTPUT_DIGEST_POLICY)) {
    const known = present.get(table);
    if (!known) continue;
    for (const key of omitted) {
      if (["run_id", "proof_run"].includes(key) && known.has(key)) {
        checks.push([`${table}.${key}`, `SELECT count(*)::int AS mismatches FROM ${q}."${table}" t
          WHERE NOT EXISTS (SELECT 1 FROM ${q}.analytics_v2_runs r
            WHERE r.run_id = t."${key}" AND r.kernel_id = $1
              AND r.manifest_version = $2 AND r.state = 'complete')`, [kernelId, manifestVersion]]);
        continue;
      }
      if (!["kernel_id", "first_kernel_id", "price_kernel_id", "manifest_version"].includes(key) || !known.has(key)) continue;
      checks.push([`${table}.${key}`, `SELECT count(*)::int AS mismatches FROM ${q}."${table}"
        WHERE "${key}" IS DISTINCT FROM $1`, [key === "manifest_version" ? manifestVersion : kernelId]]);
    }
  }
  const classes = ["analytics_v2_pricing_classes", "analytics_v2_kernel_pricing_classes", "analytics_v2_transition_proofs"];
  const classCount = classes.filter((table) => present.has(table)).length;
  if (kernelId === 5 && classCount !== 3 || kernelId === 4 && classCount !== 0) fail("MEAS_OUTPUT_CLASS_SCHEMA_INVALID");
  if (classCount === 3) {
    for (const [table, required] of Object.entries(PRICING_CLASS_SCHEMA)) {
      const actual = [...present.get(table)].sort();
      if (JSON.stringify(actual) !== JSON.stringify([...required].sort())) fail("MEAS_OUTPUT_CLASS_SCHEMA_INVALID");
    }
    checks.push(["class-required", `SELECT CASE WHEN (SELECT count(*) FROM ${q}.analytics_v2_pricing_classes) = 1
      AND (SELECT count(*) FROM ${q}.analytics_v2_kernel_pricing_classes) = 1 THEN 0 ELSE 1 END AS mismatches`, []]);
    checks.push(["pricing-class", `SELECT count(*)::int AS mismatches FROM ${q}.analytics_v2_kernel_pricing_classes k
      LEFT JOIN ${q}.analytics_v2_pricing_classes c USING (pricing_class_id)
      LEFT JOIN ${q}.analytics_v2_kernel_prices p USING (kernel_id)
      WHERE c.pricing_class_id IS NULL OR p.kernel_id IS NULL OR c.cards_sha256 IS DISTINCT FROM p.cards_sha256
        OR c.projection_version IS DISTINCT FROM p.projection_version`, []]);
    checks.push(["proof", `SELECT count(*)::int AS mismatches FROM ${q}.analytics_v2_transition_proofs p
      LEFT JOIN ${q}.analytics_v2_kernel_transitions t USING (transition_id)
      LEFT JOIN ${q}.analytics_v2_kernel_pricing_classes f ON f.kernel_id = t.from_kernel
      LEFT JOIN ${q}.analytics_v2_kernel_pricing_classes c ON c.kernel_id = t.to_kernel
      WHERE t.transition_id IS NULL OR p.method NOT IN (1,2) OR p.repriced_owner_days < 0 OR p.repriced_events < 0
        OR (p.method = 2 AND (p.pricing_class_id IS DISTINCT FROM f.pricing_class_id
          OR p.pricing_class_id IS DISTINCT FROM c.pricing_class_id OR p.sample_divisor IS NULL))`, []]);
  }
  for (const [label, sql, args] of checks) {
    const result = await pool.query(sql, args);
    if (result.rows.length !== 1 || Number(result.rows[0].mismatches) !== 0) fail(`MEAS_OUTPUT_PROVENANCE_INVALID:${label}`);
  }
  return { kernelId, computeSha256, manifestVersion, expectedRunCount, pricingClassTables: classCount, checks: checks.length };
}
/** Content-free evidence: raw full-row digests plus separately scoped semantic projections. */
export async function collectOutputDigestEvidence(pool, schema, binding) {
  const provenance = await assertOutputProvenance(pool, schema, binding);
  const tables = await pool.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE 'analytics_v2%' ORDER BY c.relname`, [schema]);
  const out = {};
  for (const { name } of tables.rows) {
    if (!identifier.test(name)) fail("MEAS_OUTPUT_TABLE_INVALID");
    const omitted = OUTPUT_DIGEST_POLICY[name] ?? [];
    const result = await pool.query(`SELECT count(*)::bigint AS rows,
      encode(sha256(convert_to(COALESCE(string_agg(raw, '' ORDER BY raw), ''), 'UTF8')), 'hex') AS raw_sha256,
      encode(sha256(convert_to(COALESCE(string_agg(semantic, '' ORDER BY semantic), ''), 'UTF8')), 'hex') AS semantic_sha256
      FROM (SELECT md5(to_jsonb(t)::text) AS raw, md5((to_jsonb(t) - $1::text[])::text) AS semantic
        FROM "${schema}"."${name}" t) s`, [omitted]);
    const row = result.rows[0];
    out[name] = { rows: Number(row.rows), rawSha256: row.raw_sha256,
      semanticSha256: RUN_TABLES.has(name) ? null : row.semantic_sha256,
      omittedColumns: [...omitted], scope: RUN_TABLES.has(name) ? "execution-provenance" : "semantic-output" };
  }
  return { schemaVersion: "analytics-v2-output-comparison-v1", policySha256: OUTPUT_DIGEST_POLICY_SHA256,
    provenance, tables: out };
}
