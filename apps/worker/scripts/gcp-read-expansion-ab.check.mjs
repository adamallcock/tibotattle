import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compareExpansionRead, DEFAULT_BASE } from "./gcp-read-expansion-ab.mjs";

test("A/B harness pins an exact base, two module graphs, read-only snapshot and aggregate-only receipt", async () => {
  assert.match(DEFAULT_BASE, /^[0-9a-f]{40}$/u);
  const source = await readFile(new URL("./gcp-read-expansion-ab.mjs", import.meta.url), "utf8");
  assert.match(source, /pg_export_snapshot/u);
  assert.match(source, /SET TRANSACTION SNAPSHOT/u);
  assert.match(source, /REPEATABLE READ READ ONLY/u);
  assert.match(source, /fingerprint output\/refusal bytes differ/u);
  assert.match(source, /await readers.close/u);
  assert.doesNotMatch(source, /console\.log\([^\n]*(ownerDigest|rows|options)/u);
});

function countingReaders({ failure = false, reasonOnly = false, occurrenceValue } = {}) {
  const calls = [];
  const returnedValues = new Map();
  const readers = Object.fromEntries(["base", "candidate"].map((name) => [name, { occurrences: {
    async readOwnerOccurrences() {
      calls.push(`${name}:occurrences`);
      if (failure) throw Object.assign(new Error("synthetic driver detail"),
        { [reasonOnly ? "reason" : "code"]: "ANALYTICS_V2_SOURCE_LIMIT" });
      const value = occurrenceValue ?? new Map([["2026-09-28", [{ status: "compatible", sourceCount: 200 }]]]);
      returnedValues.set(name, value);
      return value;
    },
    async readOwnerDayFingerprints() {
      calls.push(`${name}:fingerprints`);
      return new Map([["2026-09-28", "a".repeat(64)]]);
    },
  } }]));
  return { readers, calls, returnedValues };
}

test("retained occurrence assertions keep exact reads and the default aggregate-only result", async () => {
  for (const failure of [false, true]) {
    const plain = countingReaders({ failure });
    const expected = await compareExpansionRead(plain.readers, {}, { stream: "usage" });
    assert.deepEqual(Object.keys(expected), ["occurrenceSha256", "fingerprintSha256"]);
    for (const value of Object.values(expected)) assert.match(value, /^[0-9a-f]{64}$/u);
    const inspected = countingReaders({ failure });
    const asserted = [];
    const actual = await compareExpansionRead(inspected.readers, {}, { stream: "usage" }, (name, outcome, retained) => {
      asserted.push(name);
      if (failure) {
        assert.deepEqual(outcome, { error: { name: "Error", code: "ANALYTICS_V2_SOURCE_LIMIT" } });
        assert.deepEqual(retained, { code: "ANALYTICS_V2_SOURCE_LIMIT" });
        assert.ok(Object.isFrozen(outcome.error));
      } else {
        assert.equal(retained.value, inspected.returnedValues.get(name));
        assert.deepEqual(retained.value.get("2026-09-28"),
          [{ status: "compatible", sourceCount: 200 }]);
      }
      assert.ok(Object.isFrozen(outcome));
    });
    assert.deepEqual(asserted, ["base", "candidate"]);
    assert.deepEqual(actual, expected);
    assert.deepEqual(inspected.calls, ["base:occurrences", "candidate:occurrences", "base:fingerprints", "candidate:fingerprints"]);
    assert.deepEqual(plain.calls, inspected.calls);
  }
});

test("reason-only parity normalization cannot satisfy an original-code refusal assertion", async () => {
  const reasonOnly = countingReaders({ failure: true, reasonOnly: true });
  const coded = countingReaders({ failure: true });
  assert.deepEqual(await compareExpansionRead(reasonOnly.readers, {}, { stream: "usage" }),
    await compareExpansionRead(coded.readers, {}, { stream: "usage" }),
    "default closed parity normalization remains unchanged");
  const inspected = countingReaders({ failure: true, reasonOnly: true });
  await assert.rejects(compareExpansionRead(inspected.readers, {}, { stream: "usage" }, (_name, outcome, retained) => {
    assert.equal(outcome.error.code, "ANALYTICS_V2_SOURCE_LIMIT");
    assert.equal(retained.code, "ANALYTICS_V2_SOURCE_LIMIT");
  }), (error) => error?.code === "ERR_ASSERTION" && error.actual === undefined
    && error.expected === "ANALYTICS_V2_SOURCE_LIMIT");
  assert.deepEqual(inspected.calls, ["base:occurrences", "candidate:occurrences"]);
});

test("retained success assertions reject return types and fields hidden by serialization", async () => {
  const compatible = { status: "compatible", sourceCount: 200 };
  for (const [occurrenceValue, expectedCode] of [
    [[["2026-09-28", [compatible]]], undefined],
    [new Map([["2026-09-28", [{ status: "invalid", sourceCount: 199, toJSON: () => compatible }]]]), "ERR_ASSERTION"],
  ]) {
    const { readers } = countingReaders({ occurrenceValue });
    await assert.rejects(compareExpansionRead(readers, {}, { stream: "usage" }, (_name, _outcome, retained) => {
      const rows = retained.value.get("2026-09-28");
      assert.ok(rows.every((row) => row.status === "compatible" && row.sourceCount === 200));
    }), (error) => expectedCode === undefined ? error instanceof TypeError : error?.code === expectedCode);
  }
});

test("serialization failure cannot masquerade as an actual reader refusal", async () => {
  const occurrenceValue = new Map([["2026-09-28", [{ toJSON() {
    throw Object.assign(new Error("synthetic serialization failure"), { code: "ANALYTICS_V2_SOURCE_LIMIT" });
  } }]]]);
  const serialized = countingReaders({ occurrenceValue });
  const rejected = countingReaders({ failure: true });
  assert.deepEqual(await compareExpansionRead(serialized.readers, {}, { stream: "usage" }),
    await compareExpansionRead(rejected.readers, {}, { stream: "usage" }),
    "default normalization retains its existing serialization failure behavior");
  await assert.rejects(compareExpansionRead(serialized.readers, {}, { stream: "usage" }, (_name, outcome, retained) => {
    assert.equal(outcome.error.code, "ANALYTICS_V2_SOURCE_LIMIT");
    assert.equal(retained.value, occurrenceValue);
    assert.equal(retained.code, "ANALYTICS_V2_SOURCE_LIMIT");
  }), (error) => error?.code === "ERR_ASSERTION" && error.actual === undefined
    && error.expected === "ANALYTICS_V2_SOURCE_LIMIT");
});

test("a retained occurrence assertion failure propagates without read-error normalization", async () => {
  const { readers, calls } = countingReaders();
  const failure = new Error("synthetic assertion failure");
  await assert.rejects(compareExpansionRead(readers, {}, { stream: "usage" }, async () => { throw failure; }),
    (error) => error === failure);
  assert.deepEqual(calls, ["base:occurrences", "candidate:occurrences"]);
});
