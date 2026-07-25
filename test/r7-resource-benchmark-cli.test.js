import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../src/cli.js";

function fakeReceipt() {
  return {
    profile: "smoke",
    classification: "synthetic_lifecycle",
    operations: [
      { status: "completed" },
      { status: "interrupted_recovered" },
      { status: "not_run" },
    ],
    determinismEvidence: { status: "passed" },
    receiptSha256: "a".repeat(64),
    networkActivity: "not_measured",
    transportReady: false,
  };
}

test("benchmark-r7 parsing keeps its profile scoped and bounded", () => {
  assert.equal(parseArgs(["benchmark-r7", "--profile", "smoke", "--output", "receipt.json"]).benchmarkProfile, "smoke");
  assert.throws(
    () => parseArgs(["doctor", "--profile", "smoke"]),
    /--profile is available only for benchmark-r7/,
  );
});

test("benchmark-r7 writes an injected receipt and prints only a bounded content-free summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-r7-cli-"));
  const output = join(root, "PRIVATE_PATH_CANARY.json");
  const logs = [];
  const original = console.log;
  console.log = (...values) => logs.push(values.join(" "));
  try {
    await run(["benchmark-r7", "--profile", "smoke", "--output", output], {
      runR7BenchmarkCommand: async () => fakeReceipt(),
    });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), fakeReceipt());
    const rendered = logs.join("\n");
    assert.match(rendered, /R7 benchmark receipt: written/);
    assert.match(rendered, /Operations exercised: 2; recovered after interruption: 1; not run: 1/);
    assert.match(rendered, /Network activity: not_measured; upload disabled: true/);
    assert.equal(rendered.includes(output), false);
    assert.equal(rendered.includes("PRIVATE_PATH_CANARY"), false);
  } finally {
    console.log = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("benchmark-r7 refuses to label the smoke harness as release evidence", async () => {
  await assert.rejects(
    run(["benchmark-r7", "--profile", "release", "--output", "receipt.json"], {
      runR7BenchmarkCommand: async () => fakeReceipt(),
    }),
    /supports only the smoke profile/,
  );
});
