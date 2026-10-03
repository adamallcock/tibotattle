// Unit checks for the GCP fast-path rehearsal's options and source-dump
// resolution. Synthetic files only; no database, no network, no refresh.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArguments, resolveRehearsalDump } from "./gcp-fastpath-rehearsal.mjs";

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
  const options = parseArguments(["--golden", "/g/golden", "--staged-primary", "0066_analytics_v2_kernel_stamps.sql",
    "--refresh-workers", "4"]);
  assert.deepEqual([options.stagedPrimary, options.refreshWorkers], [["0066_analytics_v2_kernel_stamps.sql"], 4]);
  for (const argv of [["--staged-primary", "../0066_x.sql"], ["--staged-primary", "kernel.sql"],
    ["--staged-primary", "0066_a.sql", "--staged-primary", "0066_a.sql"], ["--refresh-workers", "0"],
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
