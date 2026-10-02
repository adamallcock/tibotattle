#!/usr/bin/env node

// K-DETECT unseen-token probe (cloud-run/unseen-token-probe.mjs), offline:
// the report over synthetic rows, the closed arguments and the SQL text. The
// SQL itself and the local-endpoint rule are checked against the PostgreSQL 17
// suite in postgres-test/unseen-token-probe.spec.mjs.

import assert from "node:assert/strict";
import test from "node:test";
import {
  bundledTokenCatalog,
  observedDay,
  parseUnseenTokenProbeArguments,
  previousUtcDay,
  UNSEEN_TOKEN_DIMENSIONS,
  UNSEEN_TOKEN_GRAMMAR,
  UNSEEN_TOKEN_PROBE_SCHEMA,
  unseenTokenQuery,
  unseenTokenReport,
} from "./unseen-token-probe.mjs";

const DAY = "2026-10-01";
const isCode = (code) => (error) => error?.code === code;

test("the report counts unseen tokens per dimension against the bundled catalog, in plain text", () => {
  const catalog = bundledTokenCatalog();
  assert.ok(catalog.model.has("gpt-5.5") && catalog.model.has("unknown"));
  assert.ok(catalog.plan.has("prolite") && !catalog.plan.has("promax"));
  const report = unseenTokenReport([
    { dimension: "model", token: "gpt-5.5", records: 40 },
    { dimension: "model", token: "gpt-6.1-sol", records: 7 },
    { dimension: "model", token: "unknown", records: 3 },
    { dimension: "model", token: "arn:aws:bedrock:us-east-1:000000000000:synthetic/x", records: 2 },
    { dimension: "speed", token: "standard", records: 30 },
    { dimension: "speed", token: "other", records: 12 },
    { dimension: "speed", token: "ultrafast", records: 5 },
    { dimension: "tier", token: "priority", records: 9 },
    { dimension: "plan", token: "pro", records: 20 },
    { dimension: "plan", token: "promax", records: 1 },
    { dimension: "plan", token: "has space", records: 4 },
  ], { day: DAY, catalog });
  assert.equal(report.schema, UNSEEN_TOKEN_PROBE_SCHEMA);
  assert.equal(report.verdict, "unseen");
  assert.equal(report.catalogVersion, catalog.version);
  assert.deepEqual(report.dimensions.model.unseen, [{ token: "gpt-6.1-sol", records: 7 },
    { token: "arn:aws:bedrock:us-east-1:000000000000:synthetic/x", records: 2 }]);
  assert.deepEqual([report.dimensions.model.records, report.dimensions.model.distinct,
    report.dimensions.model.sentinels.unknown], [52, 4, 3]);
  assert.deepEqual(report.dimensions.speed.unseen, [{ token: "ultrafast", records: 5 }]);
  assert.equal(report.dimensions.speed.sentinels.other, 12, "the Ultrafast-as-other share is reported");
  assert.deepEqual(report.dimensions.tier.unseen, []);
  assert.deepEqual(report.dimensions.plan.unseen, [{ token: "promax", records: 1 }]);
  assert.deepEqual([report.dimensions.plan.unrecognized, report.dimensions.plan.unrecognizedRecords], [1, 4]);
  assert.doesNotMatch(JSON.stringify(report), /has space/u, "a token outside the grammar is counted, never printed");
  assert.equal(report.unseenTotal, 2 + 1 + 0 + 2);
  const clear = unseenTokenReport([{ dimension: "model", token: "gpt-5.5", records: 1 }], { day: DAY });
  assert.deepEqual([clear.verdict, clear.unseenTotal], ["clear", 0]);
  assert.deepEqual(Object.keys(clear.dimensions), [...UNSEEN_TOKEN_DIMENSIONS]);
});

test("the report is bounded, deterministic and refuses malformed rows", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ dimension: "model", token: `synthetic-model-${index}`,
    records: 1 + (index % 3) }));
  const report = unseenTokenReport([...many].reverse(), { day: DAY });
  assert.deepEqual([report.dimensions.model.unseenListed, report.dimensions.model.unseenOverflow], [50, 10]);
  assert.equal(report.unseenTotal, 60);
  assert.deepEqual(unseenTokenReport(many, { day: DAY }), report, "row order does not change the report");
  for (const rows of [
    [{ dimension: "provider", token: "x", records: 1 }],
    [{ dimension: "model", token: 7, records: 1 }],
    [{ dimension: "model", token: "x", records: 0 }],
    [{ dimension: "model", token: "x", records: 1.5 }],
    "rows",
  ]) {
    assert.throws(() => unseenTokenReport(rows, { day: DAY }), isCode("UNSEEN_TOKEN_PROBE_ROWS_INVALID"));
  }
  for (const token of ["a".repeat(65), "", "line\nbreak", "tab\t", "quote\"", "émoji"]) {
    assert.equal(UNSEEN_TOKEN_GRAMMAR.test(token), false, JSON.stringify(token));
  }
});

test("arguments are closed; the day defaults to the previous UTC day and the schema is an identifier", () => {
  const nowMs = Date.parse("2026-10-02T00:30:00Z");
  assert.deepEqual(parseUnseenTokenProbeArguments(["--schema=tibotattle"], { nowMs }),
    { schema: "tibotattle", day: "2026-10-01" });
  assert.equal(previousUtcDay(Date.parse("2026-10-02T23:59:59Z")), "2026-10-01");
  assert.equal(observedDay("1970-01-02"), 1);
  for (const argv of [[], ["--schema="], ["--schema=Bad-Name"], ["--schema=x", "--schema=y"], ["--schema=x", "--day=2026-02-30"],
    ["--schema=x", "--day=yesterday"], ["--schema=x", "--force"], ["--schema=x;DROP"]]) {
    assert.throws(() => parseUnseenTokenProbeArguments(argv, { nowMs }), (error) => error?.usage === true
      && /^UNSEEN_TOKEN_PROBE_(?:ARGUMENT|SCHEMA|DAY)_INVALID$/u.test(error.code), argv.join(" "));
  }
  assert.throws(() => unseenTokenQuery('x"; DROP SCHEMA y; --'), isCode("UNSEEN_TOKEN_PROBE_SCHEMA_INVALID"));
  const sql = unseenTokenQuery("synthetic_schema");
  assert.doesNotMatch(sql, /owner_id|device_id|session_id|account_track|occurrence_id|canonical_digest|chunk_id\b(?! =)/u,
    "only tokens and counts are selected");
  assert.match(sql, /GROUP BY source\.dimension, dictionary\.value/u);
});
