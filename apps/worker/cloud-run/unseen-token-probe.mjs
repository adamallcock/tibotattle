#!/usr/bin/env node

/**
 * K-DETECT: the unseen-token probe (E-OPS5, new-model resilience #2).
 *
 * A content-free daily count of the model, speed, tier and plan tokens that
 * one UTC day's typed records carry, against the catalog bundled with this
 * build (@app-usagemonitor/telemetry-contract):
 *
 *   model  REVIEWED_MODEL_CATALOG ids and TELEMETRY_MODEL_IDS
 *   speed  PERFORMANCE_SPEED_MODES
 *   tier   PERFORMANCE_API_SERVICE_TIERS
 *   plan   TELEMETRY_PLAN_TYPES
 *
 * It reads both typed families (the retained v1/v1.1 typed_telemetry_* tables
 * and the v1.2 telemetry_v12_typed_* tables) through typed_telemetry_dictionary,
 * grouped by token: no owner, device, session, account or record identifier
 * is selected, and the output holds counts (and, once listing is allowed,
 * tokens) only. A token the catalog does not name is "unseen" when it fits
 * UNSEEN_TOKEN_GRAMMAR, the v1.x wire grammar (owner decision, round 7 "Name
 * guard"), and "unrecognized" otherwise: an ARN with "/", an email address or
 * anything over 64 characters is counted, never printed. The sentinels
 * ("unknown", "other", "mixed") are catalog members whose shares are reported
 * separately, so a rise in "other" speed (Ultrafast) or "unknown" model shows
 * even when no new token appears.
 *
 * Listing is HELD (UNSEEN_TOKEN_LISTING): the owner's round-3 amendment lets
 * these names pass in plain text, but requires the change that does so to
 * narrow the root AGENTS.md "raw account IDs" invariant and its tests and
 * docs. Until that change lands, the probe reports how many distinct unseen
 * tokens each dimension holds and how many records carry them, and prints no
 * token. The change that narrows the invariant flips UNSEEN_TOKEN_LISTING to
 * "plain"; the bounded listing below is already checked.
 *
 * One JSON line on stdout per run (schema tibotattle-unseen-token-probe-v1),
 * which OPS-5's log-based metric keys on (verdict "unseen" or "clear"); one
 * JSON error line with a closed code and no verdict on stderr otherwise
 * (OPS-5's metric counts only lines with a verdict, so a probe that fails
 * every day goes silent and raises unseen-tokens-silent). Exit 0 when the
 * probe ran (whatever it found), 2 for a usage refusal, 1 for any other
 * failure. The CLI connects only to a local endpoint (PG_TEST_SOCKET, a
 * private /private/tmp/tibotattle-pg-* socket directory, or a loopback
 * PG_TEST_HOST, with PG_TEST_PORT); the scheduled Cloud Run job that runs it
 * against Cloud SQL is D-OPS4's manifest entry (not wired here).
 *
 *   node cloud-run/unseen-token-probe.mjs --schema=<identifier> [--day=YYYY-MM-DD]
 *
 * --day defaults to the previous UTC day.
 */

import { lstat, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERFORMANCE_API_SERVICE_TIERS,
  PERFORMANCE_SPEED_MODES,
  REVIEWED_MODEL_CATALOG,
  REVIEWED_MODEL_CATALOG_VERSION,
  TELEMETRY_MODEL_IDS,
  TELEMETRY_PLAN_TYPES,
} from "@app-usagemonitor/telemetry-contract";

export const UNSEEN_TOKEN_PROBE_SCHEMA = "tibotattle-unseen-token-probe-v1";
export const UNSEEN_TOKEN_DIMENSIONS = Object.freeze(["model", "speed", "tier", "plan"]);
/** Catalog members whose share is reported, not treated as a known identity. */
export const UNSEEN_TOKEN_SENTINELS = Object.freeze(["unknown", "other", "mixed"]);
/**
 * The name guard (owner decision, round 7): exactly the v1.x wire grammar
 * that telemetry-contract enforces on every token (telemetry-v1.1.js TOKEN,
 * telemetry-v1.2.js V12_TOKEN; not exported, so restated here and pinned to
 * both sources by unseen-token-probe.check.mjs). Case is preserved. An ARN
 * with "/", an email address, or anything over 64 characters is
 * "unrecognized": counted, never printed.
 */
export const UNSEEN_TOKEN_GRAMMAR = /^[A-Za-z0-9._:-]{1,64}$/u;
/**
 * Whether unseen tokens are printed: "held" (counts only) until the change
 * that narrows the root AGENTS.md "raw account IDs" invariant for model,
 * speed, tier and plan names (owner, round-3 amendment) flips it to "plain".
 */
export const UNSEEN_TOKEN_LISTINGS = Object.freeze(["held", "plain"]);
export const UNSEEN_TOKEN_LISTING = "held";
/** At most this many unseen tokens are listed per dimension; the rest are counted. */
export const UNSEEN_TOKEN_LIST_LIMIT = 50;
export const UNSEEN_TOKEN_PROBE_VERDICTS = Object.freeze(["clear", "unseen"]);

const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;

export class UnseenTokenProbeError extends Error {
  constructor(code, { usage = false } = {}) {
    super(code);
    this.name = "UnseenTokenProbeError";
    this.code = code;
    this.usage = usage;
  }
}

function fail(code, options) {
  throw new UnseenTokenProbeError(code, options);
}

/** The catalog bundled with this build, per dimension, with its version. */
export function bundledTokenCatalog() {
  return Object.freeze({
    version: REVIEWED_MODEL_CATALOG_VERSION,
    model: Object.freeze(new Set([...REVIEWED_MODEL_CATALOG.map(({ id }) => id), ...TELEMETRY_MODEL_IDS])),
    speed: Object.freeze(new Set(PERFORMANCE_SPEED_MODES)),
    tier: Object.freeze(new Set(PERFORMANCE_API_SERVICE_TIERS)),
    plan: Object.freeze(new Set(TELEMETRY_PLAN_TYPES)),
  });
}

/** The UTC day a calendar date names, as the typed tables' observed_day. */
export function observedDay(isoDay) {
  if (typeof isoDay !== "string" || !DAY.test(isoDay)) fail("UNSEEN_TOKEN_PROBE_DAY_INVALID", { usage: true });
  const ms = Date.parse(`${isoDay}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== isoDay) {
    fail("UNSEEN_TOKEN_PROBE_DAY_INVALID", { usage: true });
  }
  return ms / DAY_MS;
}

/** The previous UTC day of an instant, as YYYY-MM-DD. */
export function previousUtcDay(nowMs) {
  return new Date((Math.floor(nowMs / DAY_MS) - 1) * DAY_MS).toISOString().slice(0, 10);
}

function quoteIdentifier(value) {
  if (typeof value !== "string" || !SCHEMA_IDENTIFIER.test(value)) {
    fail("UNSEEN_TOKEN_PROBE_SCHEMA_INVALID", { usage: true });
  }
  return `"${value}"`;
}

/**
 * The one read: (dimension, token, records) for one observed_day across both
 * typed families. Plans are read from quota observations and from the plan
 * attribution of usage records. Tokens only; no identifier column is selected.
 */
export function unseenTokenQuery(schema) {
  const s = quoteIdentifier(schema);
  const legacy = (alias) => `${s}.typed_telemetry_records ${alias}`;
  const v12 = (alias) => `${s}.telemetry_v12_typed_records ${alias}`;
  return `SELECT source.dimension, dictionary.value AS token, count(*)::bigint AS records
  FROM (
    SELECT 'model' AS dimension, u.model_id AS id FROM ${legacy("r")}
      JOIN ${s}.typed_telemetry_usage u ON u.record_id = r.id WHERE r.observed_day = $1
    UNION ALL SELECT 'speed', u.speed_mode_id FROM ${legacy("r")}
      JOIN ${s}.typed_telemetry_usage u ON u.record_id = r.id WHERE r.observed_day = $1
    UNION ALL SELECT 'tier', u.api_service_tier_id FROM ${legacy("r")}
      JOIN ${s}.typed_telemetry_usage u ON u.record_id = r.id WHERE r.observed_day = $1
    UNION ALL SELECT 'plan', a.plan_type_id FROM ${legacy("r")}
      JOIN ${s}.typed_telemetry_usage u ON u.record_id = r.id
      JOIN ${s}.typed_telemetry_attributions a ON a.id = u.attribution_id WHERE r.observed_day = $1
    UNION ALL SELECT 'plan', d.plan_type_id FROM ${legacy("r")}
      JOIN ${s}.typed_telemetry_quota q ON q.record_id = r.id
      JOIN ${s}.typed_telemetry_quota_dimensions d ON d.id = q.dimensions_id WHERE r.observed_day = $1
    UNION ALL SELECT 'model', u.model_id FROM ${v12("r")}
      JOIN ${s}.telemetry_v12_typed_usage u ON u.record_id = r.id WHERE r.observed_day = $1
    UNION ALL SELECT 'speed', u.speed_mode_id FROM ${v12("r")}
      JOIN ${s}.telemetry_v12_typed_usage u ON u.record_id = r.id WHERE r.observed_day = $1
    UNION ALL SELECT 'tier', u.api_service_tier_id FROM ${v12("r")}
      JOIN ${s}.telemetry_v12_typed_usage u ON u.record_id = r.id WHERE r.observed_day = $1
    UNION ALL SELECT 'plan', a.plan_type_id FROM ${v12("r")}
      JOIN ${s}.telemetry_v12_typed_usage u ON u.record_id = r.id
      JOIN ${s}.telemetry_v12_typed_attributions a ON a.id = u.attribution_id WHERE r.observed_day = $1
    UNION ALL SELECT 'plan', q.plan_type_id FROM ${v12("r")}
      JOIN ${s}.telemetry_v12_typed_quota q ON q.record_id = r.id WHERE r.observed_day = $1
  ) source
  JOIN ${s}.typed_telemetry_dictionary dictionary ON dictionary.id = source.id
  GROUP BY source.dimension, dictionary.value
  ORDER BY source.dimension, dictionary.value`;
}

/** Reads one day's token counts in a read-only transaction; returns [{dimension, token, records}]. */
export async function readDayTokenCounts(client, { schema, day }) {
  const query = unseenTokenQuery(schema);
  const dayNumber = observedDay(day);
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = await client.query(query, [dayNumber]);
    await client.query("COMMIT");
    return result.rows.map((row) => ({ dimension: row.dimension, token: row.token, records: Number(row.records) }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * The content-free report for one day's (dimension, token, records) rows
 * against a catalog. Pure and deterministic. Per dimension it counts the
 * distinct unseen tokens (unseenDistinct) and their records, and the
 * unrecognized ones; with listing "plain" it also lists the unseen tokens,
 * sorted and bounded (unseen, unseenListed, unseenOverflow). With listing
 * "held", the default, no token is carried at all.
 */
export function unseenTokenReport(rows, { day, catalog = bundledTokenCatalog(), listLimit = UNSEEN_TOKEN_LIST_LIMIT,
  listing = UNSEEN_TOKEN_LISTING }) {
  observedDay(day);
  if (!UNSEEN_TOKEN_LISTINGS.includes(listing)) fail("UNSEEN_TOKEN_PROBE_LISTING_INVALID");
  if (!Array.isArray(rows)) fail("UNSEEN_TOKEN_PROBE_ROWS_INVALID");
  const dimensions = Object.fromEntries(UNSEEN_TOKEN_DIMENSIONS.map((dimension) => [dimension, {
    records: 0, distinct: 0, sentinels: Object.fromEntries(UNSEEN_TOKEN_SENTINELS.map((token) => [token, 0])),
    unseenDistinct: 0, unseenRecords: 0, unrecognized: 0, unrecognizedRecords: 0,
  }]));
  const unseen = Object.fromEntries(UNSEEN_TOKEN_DIMENSIONS.map((dimension) => [dimension, []]));
  for (const row of rows) {
    if (row === null || typeof row !== "object" || !UNSEEN_TOKEN_DIMENSIONS.includes(row.dimension)
        || typeof row.token !== "string" || !Number.isSafeInteger(row.records) || row.records < 1) {
      fail("UNSEEN_TOKEN_PROBE_ROWS_INVALID");
    }
    const entry = dimensions[row.dimension];
    entry.records += row.records;
    entry.distinct += 1;
    if (UNSEEN_TOKEN_SENTINELS.includes(row.token) && catalog[row.dimension].has(row.token)) {
      entry.sentinels[row.token] += row.records;
    } else if (catalog[row.dimension].has(row.token)) {
      continue;
    } else if (!UNSEEN_TOKEN_GRAMMAR.test(row.token)) {
      entry.unrecognized += 1;
      entry.unrecognizedRecords += row.records;
    } else {
      entry.unseenDistinct += 1;
      entry.unseenRecords += row.records;
      unseen[row.dimension].push({ token: row.token, records: row.records });
    }
  }
  let unseenTotal = 0;
  for (const [dimension, entry] of Object.entries(dimensions)) {
    unseenTotal += entry.unseenDistinct + entry.unrecognized;
    if (listing !== "plain") continue;
    const listed = unseen[dimension].sort((left, right) => right.records - left.records
      || (left.token < right.token ? -1 : left.token > right.token ? 1 : 0));
    entry.unseen = listed.slice(0, listLimit);
    entry.unseenListed = entry.unseen.length;
    entry.unseenOverflow = Math.max(0, listed.length - listLimit);
  }
  return Object.freeze({
    schema: UNSEEN_TOKEN_PROBE_SCHEMA,
    day,
    catalogVersion: catalog.version,
    listing,
    dimensions,
    unseenTotal,
    verdict: unseenTotal > 0 ? "unseen" : "clear",
  });
}

/** One probe run over an open client. */
export async function runUnseenTokenProbe(client, { schema, day, catalog = bundledTokenCatalog(),
  listing = UNSEEN_TOKEN_LISTING }) {
  return unseenTokenReport(await readDayTokenCounts(client, { schema, day }), { day, catalog, listing });
}

export function parseUnseenTokenProbeArguments(argv, { nowMs = Date.now() } = {}) {
  const values = new Map();
  for (const argument of argv) {
    const separator = typeof argument === "string" ? argument.indexOf("=") : -1;
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (separator < 3 || !["--schema", "--day"].includes(name) || values.has(name)
        || argument.length === separator + 1) {
      fail("UNSEEN_TOKEN_PROBE_ARGUMENT_INVALID", { usage: true });
    }
    values.set(name, argument.slice(separator + 1));
  }
  if (!values.has("--schema")) fail("UNSEEN_TOKEN_PROBE_ARGUMENT_INVALID", { usage: true });
  quoteIdentifier(values.get("--schema"));
  const day = values.get("--day") ?? previousUtcDay(nowMs);
  observedDay(day);
  return Object.freeze({ schema: values.get("--schema"), day });
}

/** A local endpoint only: a private test socket directory, or a loopback host. */
export async function localProbeEndpoint(env = process.env) {
  const port = Number(env.PG_TEST_PORT ?? "");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("UNSEEN_TOKEN_PROBE_ENDPOINT_FORBIDDEN");
  if (typeof env.PG_TEST_SOCKET === "string" && env.PG_TEST_SOCKET.length > 0) {
    if (!/^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u.test(env.PG_TEST_SOCKET)) {
      fail("UNSEEN_TOKEN_PROBE_ENDPOINT_FORBIDDEN");
    }
    const link = await lstat(env.PG_TEST_SOCKET).catch(() => null);
    const host = await realpath(env.PG_TEST_SOCKET).catch(() => null);
    const metadata = host === null ? null : await stat(host).catch(() => null);
    if (link === null || link.isSymbolicLink() || metadata === null || !metadata.isDirectory()
        || !host.startsWith("/private/tmp/tibotattle-pg-") || (metadata.mode & 0o077) !== 0) {
      fail("UNSEEN_TOKEN_PROBE_ENDPOINT_FORBIDDEN");
    }
    return Object.freeze({ host, port });
  }
  if (["localhost", "127.0.0.1", "::1"].includes(env.PG_TEST_HOST)) return Object.freeze({ host: env.PG_TEST_HOST, port });
  return fail("UNSEEN_TOKEN_PROBE_ENDPOINT_FORBIDDEN");
}

async function main(argv = process.argv.slice(2)) {
  let client;
  try {
    const args = parseUnseenTokenProbeArguments(argv);
    const endpoint = await localProbeEndpoint();
    const { default: pg } = await import("pg");
    client = new pg.Client({ host: endpoint.host, port: endpoint.port, user: process.env.PG_TEST_USER ?? "postgres",
      database: process.env.PG_TEST_DATABASE ?? "postgres", ssl: false,
      ...(process.env.PG_TEST_PASSWORD === undefined ? {} : { password: process.env.PG_TEST_PASSWORD }) });
    await client.connect();
    const report = await runUnseenTokenProbe(client, args);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const code = error instanceof UnseenTokenProbeError ? error.code : "UNSEEN_TOKEN_PROBE_FAILED";
    process.stderr.write(`${JSON.stringify({ schema: UNSEEN_TOKEN_PROBE_SCHEMA, status: "failed", code })}\n`);
    process.exitCode = error?.usage === true ? 2 : 1;
  } finally {
    await client?.end().catch(() => {});
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
