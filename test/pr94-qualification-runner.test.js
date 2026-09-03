import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parsePr94QualificationArguments, publishPr94Receipt, readPr94PrivateFrames,
  runPr94Qualification,
  parsePr94AnalysisEnvelope,
} from "../scripts/qualify-pr94-attribution.mjs";

const arguments_ = ["--allow-private-attribution-comparison", "--before-root", "/synthetic/before",
  "--after-root", "/synthetic/after", "--final-root", "/synthetic/final", "--index", "/synthetic/index.sqlite",
  "--output-dir", "/synthetic/output", "--start-at", "2025-09-02T00:00:00.000Z",
  "--end-at", "2026-09-02T00:00:00.000Z"];
const code = (expected) => (error) => error.code === expected && error.message === expected;
async function fixture(run) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pr94-runner-synthetic-"));
  try { await chmod(directory, 0o700); await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("PR94 runner requires explicit private operation and exact bounded options", () => {
  const parsed = parsePr94QualificationArguments(arguments_);
  assert.equal(parsed.privateOperationApproved, true);
  assert.equal(parsed.timeoutSeconds, 1800);
  assert.equal(parsed.startAt, "2025-09-02T00:00:00.000Z");
  assert.throws(() => parsePr94QualificationArguments(arguments_.slice(1)), code("pr94_approval_required"));
  for (const extra of [["--new-option", "x"], ["--before-root", "/duplicate"],
    ["--timeout-seconds", "0"], ["--timeout-seconds", "3601"], ["--timeout-seconds", "1.2"],
    ["--timeout-seconds", "NaN"], ["--timeout-seconds"]]) {
    assert.throws(() => parsePr94QualificationArguments([...arguments_, ...extra]), code("pr94_arguments_invalid"));
  }
  const badDate = arguments_.map((value) => value === "2025-09-02T00:00:00.000Z" ? "2025-09-02" : value);
  assert.throws(() => parsePr94QualificationArguments(badDate), code("pr94_arguments_invalid"));
  assert.throws(() => parsePr94QualificationArguments(arguments_.map((value) =>
    value === "2025-09-02T00:00:00.000Z" ? "2027-09-02T00:00:00.000Z" : value)), code("pr94_arguments_invalid"));
});

test("PR94 programmatic entry refuses before source or private data access without approval", async () => {
  await assert.rejects(runPr94Qualification({}), code("pr94_approval_required"));
});

test("analysis envelopes propagate only closed fixed diagnostic codes", () => {
  const success = { status: "ok", resultBytes: 256, resultSha256: "a".repeat(64) };
  assert.deepEqual(parsePr94AnalysisEnvelope(JSON.stringify(success)), success);
  assert.throws(() => parsePr94AnalysisEnvelope(JSON.stringify({ status: "error", code: "pr94_calibration_report_fit_mismatch" })),
    code("pr94_calibration_report_fit_mismatch"));
  for (const value of [{ status: "error", code: "private-secret-marker" },
    { status: "error", code: "pr94_analysis_failed", details: "private-secret-marker" },
    { ...success, raw: "private-secret-marker" }, { ...success, resultBytes: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => parsePr94AnalysisEnvelope(JSON.stringify(value)), code("pr94_envelope_invalid"));
  }
});

test("private frame reader is streaming, exact-ended and owner-only", async () => fixture(async (directory) => {
  const path = join(directory, "frames.ndjson");
  const rows = [{ kind: "synthetic", value: 1 }, { kind: "seal", digest: "a".repeat(64) }];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  assert.deepEqual(await Array.fromAsync(readPr94PrivateFrames(path)), rows);
  await chmod(path, 0o644);
  await assert.rejects(Array.fromAsync(readPr94PrivateFrames(path)), code("pr94_path_invalid"));
  await chmod(path, 0o600);
  const alias = join(directory, "alias.ndjson");
  await symlink(path, alias);
  await assert.rejects(Array.fromAsync(readPr94PrivateFrames(alias)), code("pr94_path_invalid"));
}));

test("private frame reader rejects truncated, malformed, empty and over-limit lines", async () => fixture(async (directory) => {
  const path = join(directory, "frames.ndjson");
  for (const body of ['{"kind":"synthetic"}', "bad-json\n", "\n", JSON.stringify({ value: "x".repeat(1024 * 1024) }) + "\n"]) {
    await writeFile(path, body, { mode: 0o600 });
    await assert.rejects(Array.fromAsync(readPr94PrivateFrames(path)), code("pr94_private_frames_invalid"));
  }
}));

test("private frame reader responds to cancellation before and during consumption", async () => fixture(async (directory) => {
  const path = join(directory, "frames.ndjson");
  await writeFile(path, '{"kind":"first"}\n{"kind":"last"}\n', { mode: 0o600 });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(Array.fromAsync(readPr94PrivateFrames(path, pre.signal)), code("pr94_cancelled"));
  const controller = new AbortController();
  const iterator = readPr94PrivateFrames(path, controller.signal);
  assert.deepEqual((await iterator.next()).value, { kind: "first" });
  controller.abort();
  await assert.rejects(iterator.next(), code("pr94_cancelled"));
}));

test("receipt publication is private, no-clobber and leaves no partial file", async () => fixture(async (directory) => {
  const receipt = { status: "synthetic", count: 1 };
  await publishPr94Receipt(directory, receipt);
  const path = join(directory, "comparison.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), receipt);
  const metadata = await lstat(path);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  await assert.rejects(lstat(join(directory, "comparison.partial.json")), { code: "ENOENT" });
  await assert.rejects(publishPr94Receipt(directory, { status: "replacement" }), { code: "EEXIST" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), receipt);
  await assert.rejects(lstat(join(directory, "comparison.partial.json")), { code: "ENOENT" });
}));

test("canceled receipt cannot be published and unrelated partial output is preserved", async () => fixture(async (directory) => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(publishPr94Receipt(directory, { status: "synthetic" }, { signal: controller.signal }), code("pr94_cancelled"));
  await assert.rejects(lstat(join(directory, "comparison.json")), { code: "ENOENT" });
  const partial = join(directory, "comparison.partial.json");
  await writeFile(partial, "preserve", { mode: 0o600 });
  await assert.rejects(publishPr94Receipt(directory, {}), { code: "EEXIST" });
  assert.equal(await readFile(partial, "utf8"), "preserve");
}));

test("late cancellation or close failure revokes the exact just-published receipt", async () => {
  for (const mode of ["cancel", "close-error"]) await fixture(async (directory) => {
    const controller = new AbortController();
    await assert.rejects(publishPr94Receipt(directory, { status: "synthetic" }, {
      signal: controller.signal,
      async closeFile(file) {
        // The commit link exists: cancellation here exercised the former gap
        // after its final check but during asynchronous file cleanup.
        assert.equal((await lstat(join(directory, "comparison.json"))).isFile(), true);
        await file.close();
        if (mode === "cancel") controller.abort();
        else throw Object.assign(new Error("synthetic close failure"), { code: "SYNTHETIC_CLOSE" });
      },
    }), mode === "cancel" ? code("pr94_cancelled") : { code: "SYNTHETIC_CLOSE" });
    await assert.rejects(lstat(join(directory, "comparison.json")), { code: "ENOENT" });
    await assert.rejects(lstat(join(directory, "comparison.partial.json")), { code: "ENOENT" });
  });
});
