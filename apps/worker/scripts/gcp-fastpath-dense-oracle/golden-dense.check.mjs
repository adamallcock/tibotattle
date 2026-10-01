// Integrity checks for the committed dense production-code golden
// (apps/worker/analytics-v2-test/golden-dense). Node 22.13 or later; reads
// JSON and hashes files only, so it runs without the oracle's Node 24.10+
// SQLite adapter. Regenerating the golden is oracle.mjs's job; this check
// proves the committed files are the ones the committed oracle produces
// (blob identities), that the scheduled lanes published every daily day and
// stood still under the lease-expiry probe, that the dense owner took
// production's native paths, that every owner and date has a direct native
// reference equal to every scheduled or forced result it was compared with,
// that the cache-retention reference covers every owner-day, that the corpus
// crossed every bound it is meant to cross, and that no golden string carries
// a path separator or an email address.
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

test("the scheduled lanes published every daily day, stood still under the probe and read the pinned day", () => {
  const manifest = read("manifest.json");
  assert.equal(manifest.schemaVersion, "gcp-fastpath-dense-oracle-manifest-v1");
  assert.equal(manifest.sourceCommit, D43);
  assert.equal(manifest.pinnedNow, "2026-10-01T12:00:00.000Z");
  assert.equal(manifest.now.slice(0, 10), "2026-10-01");
  assert.equal(manifest.nowMs, Date.parse(manifest.now));
  // The graph lane needs hours more for the dense owner; the scheduled run
  // stops once the daily lane is done and the graph results come from the
  // direct native references.
  assert.ok(manifest.convergence.converged === true || manifest.convergence.stoppedBy === "daily-published");
  assert.equal(manifest.convergence.scheduleErrors, 0);
  assert.deepEqual(manifest.leaseExpiryProbe.changedOutputs, []);
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.response.schemaVersion, "community-daily-read-v1.0");
  assert.equal(manifest.response.publishedDays + manifest.conflict.days.length, 170);
  assert.deepEqual(manifest.conflict.publishedDays, []);
  assert.equal(manifest.sourceDump.sourceUnchangedByAnalysis, true);
  assert.match(manifest.sourceDump.jsonSha256, /^[0-9a-f]{64}$/u);
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
  // Today's fits window holds the dense days, so production's graph lane
  // passes no prepared input for it: the native path the direct references
  // compute.
  const windows = manifest.routingEvidence.sharedFeatureWindows.byOwner;
  assert.match(windows.e.notShared["2026-10-01"], /^refused:/u);
  // No window of the dense owner is representable by shared features: each is
  // refused (a refused day or more than 8 MiB of features), or still waits on
  // a day the shared-feature lane had not prepared at capture.
  assert.equal(windows.e.counts["shared-features"] ?? 0, 0);
  for (const state of Object.values(windows.e.notShared)) assert.match(state, /^(refused|missing):/u);
  // The small owners' windows are shared, except owner a's conflict windows
  // (a refused day) and windows waiting on a conflict day's features.
  for (const key of ["a", "b", "c", "d"]) {
    for (const [day, state] of Object.entries(windows[key].notShared)) {
      assert.ok(day >= "2026-07-24" && day <= "2026-07-27", `${key} ${day} ${state}`);
      assert.match(state, key === "a" ? /^refused:prepared_day_refused$/u : /^missing:2026-04-1[78]$/u, `${key} ${day}`);
    }
  }
});

test("every owner and date has a direct native reference equal to every result it was compared with", () => {
  const manifest = read("manifest.json");
  const results = read("owner-results.json");
  assert.equal(results.modelDates.length, 70);
  assert.deepEqual(manifest.directNative.referenceMismatches, []);
  for (const [key, owner] of Object.entries(results.owners)) {
    assert.ok(owner.fits.direct?.fits, `${key} fits has no direct reference`);
    assert.notEqual(owner.fits.directEqualsTierN, false, `${key} fits`);
    for (const day of results.modelDates) {
      const value = owner.model[day];
      // A complete composition, or a production failure recorded as such.
      assert.ok(value.direct?.result || value.direct?.state === "failed", `${key} ${day} has no direct reference`);
      assert.notEqual(value.directEqualsTierN, false, `${key} ${day} direct != scheduled`);
      assert.notEqual(value.directEqualsForced, false, `${key} ${day} direct != forced`);
    }
  }
  // The lane replay produced results for the small owners: the direct
  // references were compared with each of them.
  for (const key of ["a", "b", "c", "d"]) {
    const agreement = manifest.directNative.referenceAgreement[key];
    assert.ok(agreement.directEqualsTierN.compared >= 1, `${key} was never compared with the replay`);
    assert.equal(agreement.directEqualsTierN.equal, agreement.directEqualsTierN.compared, key);
  }
  if (manifest.directImport) {
    const recomputed = manifest.directImport.recomputedInThisProcess;
    assert.deepEqual(recomputed.mismatched, []);
    assert.equal(recomputed.equal, recomputed.scopes);
    assert.ok(recomputed.denseOwnerDates.length >= 1);
  }
});

test("the cache-retention reference covers every owner-day and agrees with the settled lane", () => {
  const manifest = read("manifest.json");
  const reference = read("cache-reference.json");
  const days = Object.entries(reference.days);
  assert.equal(days.length, manifest.cacheRetention.reference.ownerDays);
  // Every owner-day of every owner (170 corpus days each) was built or its
  // production outcome recorded; a built day with usage has values.
  for (const key of ["a", "b", "c", "d", "e"]) {
    assert.equal(days.filter(([day]) => day.startsWith(`${key}:`)).length, 170, key);
  }
  for (const [day, outcome] of days) {
    assert.ok(["built", "refused", "deferred", "failed"].includes(outcome.state), day);
    // Values exist only for built days, as all ten bands of each (model, effort) group.
    const rows = reference.ownerDays[day] ?? [];
    if (outcome.state !== "built") assert.equal(rows.length, 0, day);
    const groups = new Map();
    for (const row of rows) groups.set(`${row.model}:${row.effort}`, (groups.get(`${row.model}:${row.effort}`) ?? 0) + 1);
    for (const [group, bands] of groups) assert.equal(bands, 10, `${day} ${group}`);
  }
  const agreement = manifest.cacheRetention.reference.settledAgreement;
  assert.ok(agreement.compared >= 1);
  assert.deepEqual(agreement.mismatched, []);
  assert.equal(agreement.equal, agreement.compared);
  // The settled lane publishes the same values with shared features on and off.
  assert.ok(["complete", "stalled"].includes(manifest.cacheRetention.settledLane.lane.outcome));
  assert.equal(manifest.cacheRetention.settledLane.modes.equal, true);
  assert.deepEqual(manifest.response.settled.differsFromReplayOnlyIn, ["cacheRetention"]);
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
  for (const name of ["community-daily-response.json", "community-daily-response-settled.json", "preview.json",
    "owner-results.json", "cache-owner-days.json", "cache-reference.json"]) {
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

test("owners a to d keep their Q-1 results beside the dense owner", () => {
  // Owners a to d are the Q-1 corpus byte for byte. Seeding owner e moves the
  // source's global mutation epoch, which only the run-specific
  // inputFingerprint carries (a normalized field in every comparison).
  const dense = read("owner-results.json").owners;
  const q1 = readQ1("owner-results.json").owners;
  const result = (entry) => entry.direct?.result ?? entry.tierN?.result ?? entry.forced?.result ?? null;
  const normalized = (value) => value === null ? null : JSON.stringify({ ...value, inputFingerprint: null });
  for (const key of ["a", "b", "c", "d"]) {
    assert.equal(JSON.stringify(dense[key].fits.direct.fits), JSON.stringify(q1[key].fits.direct?.fits ?? q1[key].fits.tierN.fits), `${key} fits`);
    for (const day of Object.keys(q1[key].model)) {
      const want = result(q1[key].model[day]), got = result(dense[key].model[day]);
      if (want === null) {
        assert.equal(got, null, `${key} ${day}`);
        assert.equal(dense[key].model[day].direct.state, "failed", `${key} ${day}`);
      } else assert.equal(normalized(got), normalized(want), `${key} ${day}`);
    }
  }
});

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
