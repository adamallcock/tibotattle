// Integrity checks for the committed dense production-code golden
// (apps/worker/analytics-v2-test/golden-dense). Node 22.13 or later; reads
// JSON and hashes files only, so it runs without the oracle's Node 24.10+
// SQLite adapter. Regenerating the golden is oracle.mjs's job; this check
// proves the committed files are the ones the committed oracle produces
// (blob identities), that the run converged and stood still under the
// lease-expiry probe, that the dense owner took production's native paths,
// that every forced native reference equals the scheduled result it was
// compared with, that the corpus crossed every bound it is meant to cross,
// and that no golden string carries a path separator or an email address.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const GOLDEN = resolve(HERE, "../../analytics-v2-test/golden-dense");
const read = (name) => JSON.parse(readFileSync(join(GOLDEN, name), "utf8"));
const blobOf = (path) => {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
const D43 = "d43c8f92a059d9c577776f7eca8a331eb305b8a6";

test("the golden was produced by the committed oracle files and adapter", () => {
  const source = read("SOURCE.json");
  assert.equal(source.schemaVersion, "gcp-fastpath-dense-golden-source-v1");
  assert.equal(source.sourceCommit, D43);
  assert.ok(Object.keys(source.oracleFiles).length >= 9);
  for (const [path, blob] of Object.entries(source.oracleFiles)) {
    assert.equal(blobOf(join(REPO_ROOT, path)), blob, `${path} changed since the golden was generated; rerun oracle.mjs`);
  }
  assert.equal(blobOf(join(REPO_ROOT, source.adapter.path)), source.adapter.blob);
  assert.match(source.dump.usageMonitorJson.sha256, /^[0-9a-f]{64}$/u);
});

test("the scheduled run converged, stood still under the probe and read the pinned instant", () => {
  const manifest = read("manifest.json");
  assert.equal(manifest.schemaVersion, "gcp-fastpath-dense-oracle-manifest-v1");
  assert.equal(manifest.sourceCommit, D43);
  assert.equal(manifest.now, "2026-10-01T12:00:00.000Z");
  assert.equal(manifest.nowMs, Date.parse(manifest.now));
  assert.equal(manifest.convergence.converged, true);
  assert.equal(manifest.convergence.scheduleErrors, 0);
  assert.deepEqual(manifest.leaseExpiryProbe.changedOutputs, []);
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.response.schemaVersion, "community-daily-read-v1.0");
  assert.equal(manifest.sourceDump.sealedSqlite.sealReady, true);
});

test("every owner routes effective and the dense owner takes production's native paths", () => {
  const manifest = read("manifest.json");
  const corpus = read("dense-corpus.json");
  assert.deepEqual(manifest.owners.map((owner) => [owner.key, owner.expectedSourceRouting]),
    [["a", "effective"], ["b", "effective"], ["c", "effective"], ["d", "effective"], ["e", "effective"]]);
  // Shared day features refuse every day above 6,000 rows or 4 MiB, so each
  // X, H, M and Q day of owner e is computed by the native paths.
  const nativeDays = corpus.days.filter((day) => ["X", "H", "M", "Q"].includes(day.class)).map((day) => day.day);
  const refused = new Set(manifest.routingEvidence.sharedFeatureRefusedDays.e ?? []);
  for (const day of nativeDays) assert.ok(refused.has(day), `owner e ${day} was not refused by shared features`);
  // And the compact layout's S days stay on production's shared path.
  for (const day of corpus.days.filter((value) => value.class === "S")) {
    assert.ok(!refused.has(day.day), `owner e ${day.day} (S) was refused by shared features`);
  }
});

test("forced native references equal every scheduled result they were compared with", () => {
  const manifest = read("manifest.json");
  const owners = read("owner-results.json").owners;
  for (const [key, check] of Object.entries(manifest.forcedNative.tierNEqualsForced)) {
    assert.equal(check.fits, true, `${key} fits`);
    assert.equal(check.modelEqual, check.modelCompared, `${key} model dates`);
    assert.ok(check.modelCompared >= 1, `${key} has at least one compared model date`);
  }
  // Every owner-date has a reference: a scheduled result, a forced result or a
  // recorded production failure.
  for (const [key, owner] of Object.entries(owners)) {
    assert.ok(owner.fits.tierN || owner.fits.forced?.fits, `${key} fits reference`);
    for (const [day, value] of Object.entries(owner.model)) {
      assert.ok(value.tierN !== null || value.forced !== null, `${key} ${day} has no reference`);
    }
  }
});

test("the dense corpus crosses every bound it is meant to cross", () => {
  const corpus = read("dense-corpus.json");
  assert.equal(corpus.layout, "compact");
  assert.deepEqual(corpus.failures, []);
  assert.ok(corpus.windows.latest > corpus.gates.gcpSinglePassWindowRows);
  assert.ok(corpus.windows.max < corpus.gates.productionMaxWindowedUsageRows);
  const x = corpus.days.filter((day) => day.class === "X");
  assert.ok(x.length >= 1 && x.every((day) => day.canonicalBytes > corpus.gates.gcpDayRecordBytes
    && day.occurrences > corpus.gates.gcpDayOccurrences && day.canonicalBytes <= corpus.gates.v12DayCanonicalBytes));
});

test("no golden string carries a path separator or an email address", () => {
  const visit = (value, where, findings) => {
    if (typeof value === "string") {
      if (/[\\/]/u.test(value)) findings.push(`${where}: path separator`);
      if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u.test(value)) findings.push(`${where}: email`);
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${where}[${index}]`, findings));
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) visit(item, `${where}.${key}`, findings);
  };
  for (const name of ["community-daily-response.json", "preview.json", "owner-results.json", "cache-owner-days.json"]) {
    const findings = [];
    visit(read(name), name, findings);
    assert.deepEqual(findings.slice(0, 5), [], name);
  }
});

test("the per-date expectation matches every date production published", () => {
  const perDate = read("per-date-expected.json");
  assert.deepEqual(perDate.unresolved, []);
  assert.equal(perDate.days.length, 70);
  assert.equal(perDate.publishedDatesEqual.equal, perDate.publishedDatesEqual.compared);
  assert.ok(perDate.preview !== null && perDate.allowanceBreakdowns !== null);
});

// The Node oracle's reproduction of the Q-1 workerd golden (G0) and the Q-1
// corpus's per-date expectation.
const Q1_NODE = resolve(HERE, "../../analytics-v2-test/golden-q1-node");
const readQ1 = (name) => JSON.parse(readFileSync(join(Q1_NODE, name), "utf8"));

test("G0: the Node oracle reproduced the Q-1 workerd golden byte for byte", () => {
  const verify = readQ1("verify.json");
  assert.equal(verify["community-daily-response.json"], true);
  assert.equal(verify["preview.json"], true);
  for (const [table, equal] of Object.entries(verify.publishedRowDigests)) assert.equal(equal, true, table);
  assert.deepEqual(Object.values(verify.sourceDumpShape), [true, true, true, true]);
  for (const key of ["modelPublications", "cacheMarks", "cacheWindowAdjacencies", "previewRow"]) assert.equal(verify[key], true, key);
  const source = readQ1("SOURCE.json");
  for (const [path, blob] of Object.entries(source.oracleFiles)) {
    assert.equal(blobOf(join(REPO_ROOT, path)), blob, `${path} changed since golden-q1-node was generated`);
  }
  const manifest = readQ1("manifest.json");
  for (const [key, check] of Object.entries(manifest.forcedNative.tierNEqualsForced)) {
    assert.equal(check.fits, true, `${key} fits`);
    assert.equal(check.modelEqual, check.modelCompared, `${key} model dates`);
  }
  const perDate = readQ1("per-date-expected.json");
  assert.deepEqual(perDate.unresolved, []);
  assert.equal(perDate.publishedDatesEqual.equal, perDate.publishedDatesEqual.compared);
});
