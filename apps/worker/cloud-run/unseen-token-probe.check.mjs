#!/usr/bin/env node

// K-DETECT unseen-token probe (cloud-run/unseen-token-probe.mjs), offline:
// the report over synthetic rows (listing held by default; the round-7 name
// guard pinned to telemetry-contract's wire grammar), the closed arguments,
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

test("by default the report holds the listing: counts only, no token text, the verdict unchanged", () => {
  assert.equal(UNSEEN_TOKEN_LISTING, "held",
    "plain-text listing is a separate step that waits for the scheduled probe (D-OPS4) and the owner's confirmation");
  const catalog = bundledTokenCatalog();
  assert.ok(catalog.model.has("gpt-5.5") && catalog.model.has("unknown"));
  assert.ok(catalog.plan.has("prolite") && !catalog.plan.has("promax"));
  const report = unseenTokenReport(SAMPLE_ROWS, { day: DAY, catalog });
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
  const clear = unseenTokenReport([{ dimension: "model", token: "gpt-5.5", records: 1 }], { day: DAY });
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
  // Even with listing allowed, only grammar-conforming tokens are listed.
  const report = unseenTokenReport(SAMPLE_ROWS, { day: DAY, listing: "plain" });
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
  const held = unseenTokenReport(SAMPLE_ROWS, { day: DAY });
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
  const report = unseenTokenReport([...many].reverse(), { day: DAY, listing: "plain" });
  assert.deepEqual([report.dimensions.model.unseenListed, report.dimensions.model.unseenOverflow,
    report.dimensions.model.unseenDistinct], [50, 10, 60]);
  assert.equal(report.unseenTotal, 60);
  assert.deepEqual(unseenTokenReport(many, { day: DAY, listing: "plain" }), report, "row order does not change the report");
  assert.deepEqual(unseenTokenReport(many, { day: DAY }), unseenTokenReport([...many].reverse(), { day: DAY }));
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
