// Summary and gate checks (G1) of the dense owner e, from the generator alone.
//
//   node apps/worker/scripts/gcp-fastpath-dense-oracle/corpus-summary.mjs --work-dir <dir> [--layout compact|spread] [--scale s] [--check <dense-corpus.json>] [--out <file>]
//
// Every record is validated by d43c8f92's own v1.2 contract parser and its
// day-level usage-order check, and every bound the GCP fast path refused at
// 7ef0e144 must be crossed by the classes meant to cross it, while every
// production method bound and v1.2 admission maximum is respected. The summary
// holds counts, canonical byte totals and digests per owner-day, never records.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDenseOwner, DENSE_CORPUS_DAY_LIST, DENSE_CORPUS_PINNED_NOW, DENSE_CORPUS_SCHEMA_VERSION,
  DENSE_CORPUS_SEED } from "./dense-corpus.mjs";

const MiB = 1024 * 1024;
/** The bounds the summary checks: GCP's 7ef0e144 refusals (crossed) and the
 * production method bounds and v1.2 admission maxima (respected). */
export const DENSE_CORPUS_GATES = Object.freeze({
  gcpDayOccurrences: 20_000, gcpDayRecordBytes: 32 * MiB, gcpWindowUsageRows: 120_000,
  gcpSinglePassWindowRows: 1_024 * 200, gcpQuotaDayRows: 12_800,
  productionSharedFeatureDayRows: 6_000, productionSharedFeatureDayBytes: 4 * MiB, productionMaxWindowedUsageRows: 1_000_000,
  productionMaxSessions: 100_000, productionCacheGroupLimit: 512,
  v12ChunkRecords: 200, v12ChunkCanonicalBytes: 1_250_000, v12DayChunks: 4_096, v12DayCanonicalBytes: 64_000_000,
});

/** Summarize and gate owner e. `P` is the oracle bundle (d43c8f92 exports). */
export function summarizeDenseCorpus({ P, owner, scale, layout = owner.spec.layout }) {
  const g = DENSE_CORPUS_GATES;
  const days = [];
  const failures = [];
  for (const value of owner.days()) {
    const { day, records } = value;
    P.validateTelemetryV12DayUsageOrder(day, records.usage);
    let bytes = 0, chunks = 0, maxChunkBytes = 0;
    const hash = createHash("sha256");
    for (const stream of ["quota", "session", "usage"]) {
      const list = records[stream];
      for (const record of list) P.parseTelemetryV12Record(stream, record);
      for (let offset = 0; offset < list.length; offset += g.v12ChunkRecords) {
        const text = P.canonicalTelemetryV12Json(list.slice(offset, offset + g.v12ChunkRecords));
        maxChunkBytes = Math.max(maxChunkBytes, Buffer.byteLength(text));
        chunks++;
      }
      for (const record of list) {
        const text = P.canonicalTelemetryV12Json(record);
        bytes += Buffer.byteLength(text);
        hash.update(text).update("\n");
      }
    }
    const sevenDayQuota = records.quota.filter((record) => record.windowDurationMinutes === 10_080).length;
    const sessions = new Set(records.usage.map((record) => record.sessionUuid)).size;
    const groups = new Set(records.usage.map((record) => `${record.modelId}:${record.reasoningEffort}`)).size;
    const occurrences = records.usage.length + records.quota.length + records.session.length;
    days.push({ day, class: value.class, usage: records.usage.length, quota: records.quota.length,
      sevenDayQuota, session: records.session.length, occurrences, canonicalBytes: bytes, chunks, maxChunkBytes,
      usageSessions: sessions, cacheGroups: groups, sha256: hash.digest("hex") });
    const fail = (rule) => failures.push({ day, rule });
    if (chunks > g.v12DayChunks || bytes > g.v12DayCanonicalBytes || maxChunkBytes > g.v12ChunkCanonicalBytes) fail("v12_admission_maximum");
    if (sessions >= g.productionMaxSessions || groups >= g.productionCacheGroupLimit) fail("production_day_method_bound");
    if (value.class === "X" && !(occurrences > g.gcpDayOccurrences && bytes > g.gcpDayRecordBytes)) fail("x_day_crosses_count_and_bytes");
    if (value.class === "H" && !(occurrences > g.gcpDayOccurrences && bytes <= g.gcpDayRecordBytes)) fail("h_day_crosses_count_only");
    if (value.class === "Q" && !(sevenDayQuota > g.gcpQuotaDayRows)) fail("q_day_crosses_quota_rows");
    if (value.class === "M" && (layout !== "spread" || scale === 1) && !(records.usage.length > g.productionSharedFeatureDayRows
      && occurrences <= g.gcpDayOccurrences)) fail("m_day_native_in_production_shared_in_gcp");
    if (value.class === "S" && !(occurrences <= g.productionSharedFeatureDayRows
      && bytes <= g.productionSharedFeatureDayBytes)) fail("s_day_within_production_shared_feature_bounds");
  }
  const usageByDay = new Map(days.map((day) => [day.day, day.usage]));
  const windowRows = (throughIndex) => {
    let rows = 0;
    for (let index = Math.max(0, throughIndex - 100); index <= throughIndex; index++) rows += usageByDay.get(DENSE_CORPUS_DAY_LIST[index]);
    return rows;
  };
  const modelWindows = DENSE_CORPUS_DAY_LIST.slice(-70).map((day) => ({ day, usageRows: windowRows(DENSE_CORPUS_DAY_LIST.indexOf(day)) }));
  const latest = modelWindows.at(-1).usageRows;
  if (!(latest > g.gcpSinglePassWindowRows)) failures.push({ day: modelWindows.at(-1).day, rule: "latest_window_crosses_single_pass" });
  // The spread layout loads every model window; the compact one loads the
  // current-fits window and the last model windows only.
  if (layout === "spread" && modelWindows.some((window) => !(window.usageRows > g.gcpWindowUsageRows))) {
    failures.push({ day: null, rule: "every_window_crosses_120k" });
  }
  if (modelWindows.some((window) => window.usageRows >= g.productionMaxWindowedUsageRows)) failures.push({ day: null, rule: "window_under_1m" });
  const totals = days.reduce((n, day) => ({ usage: n.usage + day.usage, quota: n.quota + day.quota,
    session: n.session + day.session, canonicalBytes: n.canonicalBytes + day.canonicalBytes }),
  { usage: 0, quota: 0, session: 0, canonicalBytes: 0 });
  const summary = {
    schemaVersion: DENSE_CORPUS_SCHEMA_VERSION, sourceCommit: "d43c8f92a059d9c577776f7eca8a331eb305b8a6",
    generator: "apps/worker/scripts/gcp-fastpath-dense-oracle/dense-corpus.mjs", seed: DENSE_CORPUS_SEED,
    synthetic: true, pinnedNow: DENSE_CORPUS_PINNED_NOW, layout, scale, owner: owner.spec, gates: g,
    totals, windows: { latest, min: Math.min(...modelWindows.map((w) => w.usageRows)),
      max: Math.max(...modelWindows.map((w) => w.usageRows)), modelWindows },
    failures, days,
  };
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const workDir = value("--work-dir");
  const scale = Number(value("--scale") ?? "1");
  const layout = value("--layout") ?? "compact";
  const { buildDenseOracle } = await import("./build.mjs");
  const build = await buildDenseOracle({ workDir: resolve(workDir ?? "") });
  const P = await import(pathToFileURL(build.bundle.path).href);
  const owner = createDenseOwner({ pricer: P.priceTelemetryUsageEvent, scale, layout });
  const summary = summarizeDenseCorpus({ P, owner, scale, layout });
  const text = `${JSON.stringify(summary, null, 1)}\n`;
  const check = value("--check"), out = value("--out");
  if (out) writeFileSync(resolve(out), text);
  const equal = check ? readFileSync(resolve(check), "utf8") === text : null;
  process.stdout.write(`${JSON.stringify({ failures: summary.failures, totals: summary.totals,
    windows: { latest: summary.windows.latest, min: summary.windows.min, max: summary.windows.max },
    sha256: createHash("sha256").update(text).digest("hex"), checkEqual: equal })}\n`);
  process.exitCode = summary.failures.length === 0 && equal !== false ? 0 : 1;
}
