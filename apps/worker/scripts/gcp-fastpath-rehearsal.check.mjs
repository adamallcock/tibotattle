// Unit checks for the GCP fast-path rehearsal's options and source-dump
// resolution. Synthetic files only; no database, no network, no refresh.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArguments, resolveRehearsalDump, syntheticRehearsalFloorDays } from "./gcp-fastpath-rehearsal.mjs";

const refused = (code) => (error) => error?.code === code;

test("--dense holds the golden to its own per-date expectation and owner references", () => {
  const options = parseArguments(["--golden", "/g/golden-dense", "--dense", "--dump", "/d/usage-monitor-db.json"]);
  assert.equal(options.dense, true);
  assert.equal(options.perDateExpected, "/g/golden-dense/per-date-expected.json");
  assert.equal(options.ownerReference, "/g/golden-dense");
  assert.equal(options.dump, "/d/usage-monitor-db.json");
  assert.equal(options.refreshTimeoutMinutes, 30);
  for (const extra of [["--per-date-expected", "/x.json"], ["--owner-reference", "/x"]]) {
    assert.throws(() => parseArguments(["--golden", "/g", "--dense", ...extra]), refused("REHEARSAL_ARGUMENT_INVALID"));
  }
});

test("the Q-1 rehearsal takes optional per-date and owner references", () => {
  const options = parseArguments(["--golden", "/g/golden", "--per-date-expected", "/n/per-date-expected.json",
    "--owner-reference", "/n"]);
  assert.deepEqual([options.dense, options.perDateExpected, options.ownerReference, options.dump],
    [false, "/n/per-date-expected.json", "/n", null]);
});

test("K-CORE-A: staged primary migrations and compute Workers are opt-in and bounded", () => {
  const plain = parseArguments(["--golden", "/g/golden"]);
  assert.deepEqual([plain.stagedPrimary, plain.refreshWorkers], [[], 1]);
  const options = parseArguments(["--golden", "/g/golden", "--staged-primary", "0911_analytics_v2_run_stamps.sql",
    "--refresh-workers", "4"]);
  assert.deepEqual([options.stagedPrimary, options.refreshWorkers], [["0911_analytics_v2_run_stamps.sql"], 4]);
  for (const argv of [["--staged-primary", "../0911_x.sql"], ["--staged-primary", "kernel.sql"],
    ["--staged-primary", "0911_a.sql", "--staged-primary", "0911_a.sql"], ["--refresh-workers", "0"],
    ["--refresh-workers", "17"], ["--refresh-workers", "2.5"]]) {
    assert.throws(() => parseArguments(["--golden", "/g", ...argv]), refused("REHEARSAL_ARGUMENT_INVALID"), argv.join(" "));
  }
});

test("options are closed and bounded", () => {
  assert.throws(() => parseArguments([]), refused("REHEARSAL_GOLDEN_REQUIRED"));
  for (const argv of [["--golden"], ["--golden", "/g", "--dump"], ["--golden", "/g", "--dump", "--dense"],
    ["--golden", "/g", "--unknown"], ["--golden", "/g", "--refresh-timeout-minutes", "0"],
    ["--golden", "/g", "--refresh-timeout-minutes", "721"], ["--golden", "/g", "--refresh-timeout-minutes", "1.5"],
    ["--golden", "/g", "--reuse-schema", "public"],
    ["--golden", "/g", "--reuse-schema", "typed_legacy_transfer_rehearsal_target_fastpath_XYZ"]]) {
    assert.throws(() => parseArguments(argv), (error) => /^REHEARSAL_/u.test(error?.code ?? ""), argv.join(" "));
  }
  assert.equal(parseArguments(["--golden", "/g", "--refresh-timeout-minutes", "720"]).refreshTimeoutMinutes, 720);
  assert.equal(parseArguments(["--golden", "/g", "--reuse-schema",
    "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d"]).reuseSchema,
  "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d");
});

test("an external dump must match the digest the golden manifest pins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gcp-fastpath-rehearsal-check-"));
  try {
    const golden = join(directory, "golden");
    await mkdir(golden);
    const dump = join(directory, "usage-monitor-db.json");
    const bytes = '{"schema":[],"tables":[]}\n';
    await writeFile(dump, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(await resolveRehearsalDump({ golden, dump, manifest: { sourceDump: { jsonSha256: sha256 } } }),
      { path: dump, sha256, pinned: true });
    await assert.rejects(resolveRehearsalDump({ golden, dump, manifest: { sourceDump: { jsonSha256: "0".repeat(64) } } }),
      refused("REHEARSAL_DUMP_DIGEST_MISMATCH"));
    await assert.rejects(resolveRehearsalDump({ golden, dump, manifest: {} }), refused("REHEARSAL_DUMP_UNPINNED"));
    await assert.rejects(resolveRehearsalDump({ golden, dump: null, manifest: {} }), refused("REHEARSAL_DUMP_MISSING"));
    // A committed dump is used as it is; giving another one as well is ambiguous.
    await mkdir(join(golden, "dump"));
    await writeFile(join(golden, "dump", "usage-monitor-db.json"), bytes);
    assert.deepEqual(await resolveRehearsalDump({ golden, dump: null, manifest: {} }),
      { path: join(golden, "dump", "usage-monitor-db.json"), sha256, pinned: false });
    await assert.rejects(resolveRehearsalDump({ golden, dump, manifest: { sourceDump: { jsonSha256: sha256 } } }),
      refused("REHEARSAL_DUMP_AMBIGUOUS"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("REV-SEED: the synthetic revision floor option is a fresh-schema rehearsal of a pure floor", () => {
  assert.equal(parseArguments(["--golden", "/g/golden"]).syntheticRevisionFloor, false);
  assert.equal(parseArguments(["--golden", "/g/golden", "--synthetic-revision-floor"]).syntheticRevisionFloor, true);
  assert.throws(() => parseArguments(["--golden", "/g", "--synthetic-revision-floor", "--reuse-schema",
    "typed_legacy_transfer_rehearsal_target_fastpath_0a1b2c3d"]), (error) => error?.code === "REHEARSAL_ARGUMENT_INVALID");
  const days = Array.from({ length: 15 }, (_, index) => ({ day: `2026-09-${String(index + 1).padStart(2, "0")}`, revision: 1 }));
  const floor = syntheticRehearsalFloorDays([...days].reverse());
  assert.equal(floor.length, 13, "each seventh day has no floor");
  assert.deepEqual(floor.slice(0, 7), [["2026-09-01", 1], ["2026-09-02", 2], ["2026-09-03", 3], ["2026-09-04", 4],
    ["2026-09-05", 5], ["2026-09-06", 1], ["2026-09-08", 3]]);
  assert.deepEqual(syntheticRehearsalFloorDays(days), floor, "a pure function of the golden");
});


test("MODEL-BLOCKS flags are bounded pure rehearsal pass-throughs", () => {
  const options = parseArguments(["--golden", "/g", "--refresh-model-block-size", "14", "--refresh-model-fanout", "all"]);
  assert.equal(options.refreshModelBlockSize, 14);
  assert.equal(options.refreshModelFanOut, "all");
  for (const flags of [["--refresh-model-block-size", "0"], ["--refresh-model-block-size", "71"],
    ["--refresh-model-block-size", "1.5"], ["--refresh-model-fanout", "sometimes"]]) {
    assert.throws(() => parseArguments(["--golden", "/g", ...flags]), refused("REHEARSAL_ARGUMENT_INVALID"));
  }
});
