#!/usr/bin/env node

// K-DETECT unseen-token probe (cloud-run/unseen-token-probe.mjs), offline:
// the report over synthetic rows (in-grammar unseen names listed by default,
// owner round 11, bounded per dimension; out-of-grammar strings only counted;
// the round-7 name guard pinned to telemetry-contract's wire grammar), the closed arguments,
// the SQL text and the CLI's failure line. The SQL itself and the
// local-endpoint rule are checked against the PostgreSQL 17 suite in
// postgres-test/unseen-token-probe.spec.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bundledTokenCatalog,
  observedDay,
  parseUnseenTokenProbeArguments,
  previousUtcDay,
  UNSEEN_TOKEN_DIMENSIONS,
  UNSEEN_TOKEN_GRAMMAR,
  UNSEEN_TOKEN_LIST_LIMIT,
  UNSEEN_TOKEN_LISTING,
  UNSEEN_TOKEN_PROBE_SCHEMA,
  unseenTokenQuery,
  unseenTokenReport,
} from "./unseen-token-probe.mjs";

const DAY = "2026-10-01";
const isCode = (code) => (error) => error?.code === code;
const PROBE = join(dirname(fileURLToPath(import.meta.url)), "unseen-token-probe.mjs");
const REPOSITORY_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const SYNTHETIC_ARN = "arn:aws:bedrock:us-east-1:000000000000:inference-profile/synthetic";
const SYNTHETIC_EMAIL = "synthetic@example.invalid";
const SAMPLE_ROWS = Object.freeze([
  { dimension: "model", token: "gpt-5.5", records: 40 },
  { dimension: "model", token: "gpt-6.1-sol", records: 7 },
  { dimension: "model", token: "unknown", records: 3 },
  { dimension: "model", token: "arn:aws:bedrock:us-east-1:000000000000:synthetic", records: 2 },
  { dimension: "model", token: SYNTHETIC_ARN, records: 6 },
  { dimension: "model", token: SYNTHETIC_EMAIL, records: 1 },
  { dimension: "speed", token: "standard", records: 30 },
  { dimension: "speed", token: "other", records: 12 },
  { dimension: "speed", token: "ultrafast", records: 5 },
  { dimension: "tier", token: "priority", records: 9 },
  { dimension: "plan", token: "pro", records: 20 },
  { dimension: "plan", token: "promax", records: 1 },
  { dimension: "plan", token: "has space", records: 4 },
  { dimension: "plan", token: "a+b=c", records: 2 },
]);

test("held listing: counts only, no token text, the verdict unchanged", () => {
  const catalog = bundledTokenCatalog();
  assert.ok(catalog.model.has("gpt-5.5") && catalog.model.has("unknown"));
  assert.ok(catalog.plan.has("prolite") && !catalog.plan.has("promax"));
  const report = unseenTokenReport(SAMPLE_ROWS, { day: DAY, catalog, listing: "held" });
  assert.deepEqual([report.schema, report.listing, report.verdict, report.catalogVersion],
    [UNSEEN_TOKEN_PROBE_SCHEMA, "held", "unseen", catalog.version]);
  const text = JSON.stringify(report);
  for (const token of ["gpt-6.1-sol", "ultrafast", "promax", "arn:", "synthetic", "@", "has space", "a+b=c"]) {
    assert.equal(text.includes(token), false, `${token} is never printed while listing is held`);
  }
  for (const entry of Object.values(report.dimensions)) {
    assert.equal(["unseen", "unseenListed", "unseenOverflow"].some((key) => key in entry), false);
  }
  const { model, speed, tier, plan } = report.dimensions;
  assert.deepEqual([model.records, model.distinct, model.sentinels.unknown, model.unseenDistinct, model.unseenRecords,
    model.unrecognized, model.unrecognizedRecords], [59, 6, 3, 2, 9, 2, 7]);
  assert.deepEqual([speed.unseenDistinct, speed.unseenRecords, speed.sentinels.other], [1, 5, 12],
    "the Ultrafast-as-other share is reported");
  assert.deepEqual([tier.unseenDistinct, tier.unrecognized], [0, 0]);
  assert.deepEqual([plan.unseenDistinct, plan.unseenRecords, plan.unrecognized, plan.unrecognizedRecords], [1, 1, 2, 6]);
  assert.equal(report.unseenTotal, (2 + 2) + 1 + 0 + (1 + 2));
  const clear = unseenTokenReport([{ dimension: "model", token: "gpt-5.5", records: 1 }], { day: DAY, listing: "held" });
  assert.deepEqual([clear.verdict, clear.unseenTotal], ["clear", 0]);
  assert.deepEqual(Object.keys(clear.dimensions), [...UNSEEN_TOKEN_DIMENSIONS]);
  assert.throws(() => unseenTokenReport(SAMPLE_ROWS, { day: DAY, listing: "hashed" }),
    isCode("UNSEEN_TOKEN_PROBE_LISTING_INVALID"));
});

test("the name guard is exactly the v1.x wire grammar: an ARN with '/' or an email is unrecognized, never listed", () => {
  assert.equal(UNSEEN_TOKEN_GRAMMAR.source, "^[A-Za-z0-9._:-]{1,64}$");
  assert.equal(UNSEEN_TOKEN_GRAMMAR.flags, "u");
  // Pinned to telemetry-contract's own wire grammar (not exported there).
  for (const [path, name] of [["packages/telemetry-contract/src/telemetry-v1.1.js", "TOKEN"],
    ["packages/telemetry-contract/src/telemetry-v1.2.js", "V12_TOKEN"]]) {
    const match = new RegExp(`^const ${name} = /(.+)/u;$`, "mu").exec(readFileSync(join(REPOSITORY_ROOT, path), "utf8"));
    assert.equal(match?.[1], UNSEEN_TOKEN_GRAMMAR.source, path);
  }
  for (const token of [SYNTHETIC_ARN, SYNTHETIC_EMAIL, "a+b=c", "a/b", "a".repeat(65), "", "line\nbreak", "tab\t",
    "quote\"", "émoji"]) {
    assert.equal(UNSEEN_TOKEN_GRAMMAR.test(token), false, JSON.stringify(token));
  }
  for (const token of ["gpt-6.1-sol", "Claude-Opus_5.5", "arn:aws:bedrock:us-east-1:000000000000:synthetic", "a".repeat(64)]) {
    assert.equal(UNSEEN_TOKEN_GRAMMAR.test(token), true, token);
  }
  // The default lists in-grammar unseen tokens (owner, round 11); only
  // grammar-conforming tokens are ever listed.
  assert.equal(UNSEEN_TOKEN_LISTING, "plain", "the owner allowed the probe's log line to list in-grammar names");
  const report = unseenTokenReport(SAMPLE_ROWS, { day: DAY });
  assert.deepEqual(unseenTokenReport(SAMPLE_ROWS, { day: DAY, listing: "plain" }), report);
  assert.equal(report.listing, "plain");
  assert.deepEqual(report.dimensions.model.unseen, [{ token: "gpt-6.1-sol", records: 7 },
    { token: "arn:aws:bedrock:us-east-1:000000000000:synthetic", records: 2 }]);
  assert.deepEqual([report.dimensions.model.unrecognized, report.dimensions.model.unrecognizedRecords], [2, 7]);
  assert.deepEqual(report.dimensions.speed.unseen, [{ token: "ultrafast", records: 5 }]);
  assert.deepEqual(report.dimensions.tier.unseen, []);
  assert.deepEqual(report.dimensions.plan.unseen, [{ token: "promax", records: 1 }]);
  const text = JSON.stringify(report);
  for (const token of [SYNTHETIC_ARN, SYNTHETIC_EMAIL, "inference-profile", "@", "has space", "a+b=c"]) {
    assert.equal(text.includes(token), false, `${token} is counted, never printed`);
  }
  // The held report is the plain one less the listing.
  const held = unseenTokenReport(SAMPLE_ROWS, { day: DAY, listing: "held" });
  const stripped = structuredClone(report);
  stripped.listing = "held";
  for (const entry of Object.values(stripped.dimensions)) {
    delete entry.unseen;
    delete entry.unseenListed;
    delete entry.unseenOverflow;
  }
  assert.deepEqual(held, stripped);
});

test("the report is bounded, deterministic and refuses malformed rows", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ dimension: "model", token: `synthetic-model-${index}`,
    records: 1 + (index % 3) }));
  const report = unseenTokenReport([...many].reverse(), { day: DAY });
  assert.equal(report.listing, "plain");
  assert.deepEqual([report.dimensions.model.unseenListed, report.dimensions.model.unseenOverflow,
    report.dimensions.model.unseenDistinct], [UNSEEN_TOKEN_LIST_LIMIT, 10, 60]);
  assert.equal(report.dimensions.model.unseen.length, UNSEEN_TOKEN_LIST_LIMIT);
  assert.equal(report.unseenTotal, 60);
  assert.deepEqual(unseenTokenReport(many, { day: DAY }), report, "row order does not change the report");
  assert.deepEqual(unseenTokenReport(many, { day: DAY, listing: "held" }),
    unseenTokenReport([...many].reverse(), { day: DAY, listing: "held" }));
  // Listed by records, then by token: the bound keeps the most frequent.
  const records = report.dimensions.model.unseen.map((entry) => entry.records);
  assert.deepEqual(records, [...records].sort((left, right) => right - left));
  for (const rows of [
    [{ dimension: "provider", token: "x", records: 1 }],
    [{ dimension: "model", token: 7, records: 1 }],
    [{ dimension: "model", token: "x", records: 0 }],
    [{ dimension: "model", token: "x", records: 1.5 }],
    "rows",
  ]) {
    assert.throws(() => unseenTokenReport(rows, { day: DAY }), isCode("UNSEEN_TOKEN_PROBE_ROWS_INVALID"));
  }
});

test("the list bound cannot be raised, and the worst-case line stays small", () => {
  for (const listLimit of [UNSEEN_TOKEN_LIST_LIMIT + 1, -1, 1.5, "5", null, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => unseenTokenReport(SAMPLE_ROWS, { day: DAY, listLimit }),
      isCode("UNSEEN_TOKEN_PROBE_LIST_LIMIT_INVALID"), String(listLimit));
  }
  // A smaller bound lists fewer; zero lists none and still counts everything.
  const none = unseenTokenReport(SAMPLE_ROWS, { day: DAY, listLimit: 0 });
  assert.deepEqual([none.dimensions.model.unseen, none.dimensions.model.unseenOverflow,
    none.dimensions.model.unseenDistinct], [[], 2, 2]);
  assert.equal(none.verdict, "unseen");
  // Worst case: every dimension holds 200 distinct 64-character unseen tokens.
  const worst = UNSEEN_TOKEN_DIMENSIONS.flatMap((dimension) => Array.from({ length: 200 }, (_, index) => ({
    dimension, token: `${dimension}-${String(index).padStart(3, "0")}-`.padEnd(64, "x"), records: 1_000_000 + index,
  })));
  const line = unseenTokenReport(worst, { day: DAY });
  for (const dimension of UNSEEN_TOKEN_DIMENSIONS) {
    assert.equal(line.dimensions[dimension].unseen.length, UNSEEN_TOKEN_LIST_LIMIT);
    assert.equal(line.dimensions[dimension].unseenOverflow, 200 - UNSEEN_TOKEN_LIST_LIMIT);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(line)) < 32 * 1024, "one probe line stays under 32 KiB");
});

test("an out-of-grammar string is never listed, even when it is the only unseen value or floods a dimension", () => {
  const outside = [SYNTHETIC_ARN, SYNTHETIC_EMAIL, "has space", "a+b=c", "a".repeat(65), "line\nbreak", "quote\"",
    "émoji", "tab\t", "a/b"];
  const flood = outside.flatMap((token, index) => UNSEEN_TOKEN_DIMENSIONS.map((dimension) => ({
    dimension, token, records: 100 + index,
  })));
  const report = unseenTokenReport(flood, { day: DAY });
  assert.equal(report.listing, "plain");
  assert.equal(report.verdict, "unseen", "out-of-grammar strings still raise the verdict");
  for (const dimension of UNSEEN_TOKEN_DIMENSIONS) {
    const entry = report.dimensions[dimension];
    assert.deepEqual([entry.unseen, entry.unseenListed, entry.unseenOverflow, entry.unseenDistinct],
      [[], 0, 0, 0], dimension);
    assert.equal(entry.unrecognized, outside.length);
  }
  const text = JSON.stringify(report);
  for (const token of outside) {
    assert.equal(text.includes(JSON.stringify(token).slice(1, -1)), false, `${JSON.stringify(token)} is never printed`);
  }
  for (const fragment of ["arn:aws", "example.invalid", "inference-profile", "@", "has space", "a+b=c", "aaaaaaaaaa"]) {
    assert.equal(text.includes(fragment), false, fragment);
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

test("a failed run writes one closed failure line with no verdict, so OPS-5 counts it as silence", () => {
  const run = spawnSync(process.execPath, [PROBE, "--schema=synthetic_schema", "--force"], {
    encoding: "utf8", env: { PATH: "" }, timeout: 30_000,
  });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, "");
  const lines = run.stderr.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { schema: UNSEEN_TOKEN_PROBE_SCHEMA, status: "failed",
    code: "UNSEEN_TOKEN_PROBE_ARGUMENT_INVALID" });
  // A run with no local endpoint fails closed before connecting, the same way.
  const refused = spawnSync(process.execPath, [PROBE, "--schema=synthetic_schema"], {
    encoding: "utf8", env: { PATH: "" }, timeout: 30_000,
  });
  assert.equal(refused.status, 1);
  assert.deepEqual(JSON.parse(refused.stderr), { schema: UNSEEN_TOKEN_PROBE_SCHEMA, status: "failed",
    code: "UNSEEN_TOKEN_PROBE_ENDPOINT_FORBIDDEN" });
});
