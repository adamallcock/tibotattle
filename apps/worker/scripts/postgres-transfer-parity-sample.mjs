// PT8-E: the history and manifest digest parity sample
// (design/pt8-lite-design-2026-10-02.md section 7).
//
// The importers prove each table with whole-table digests through ONE shared
// canonical codec, so a symmetric codec error (a number above 2^53, an
// instant format) would pass both sides. This sample recomputes facts per
// owner through INDEPENDENT engine SQL on each side: SQLite over the sealed
// ingestion file, PostgreSQL over the imported target. Values are rendered to
// text by each engine (SQLite integers read as BigInt, PostgreSQL ::text and
// to_char), never through the importers' codec.
//
// Selection is deterministic and kept in memory: participants ordered by
// sha256(sealId \0 'pt8-parity-v1' \0 participant_id), the first K = min(64,
// owners), plus forced members: the densest owner by evidence rows, one owner
// per evidence family class present ('v1.2', 'v1.1', 'v1', 'v0.2', 'mixed';
// a structural class over the sealed families, not analytics-v2's routing
// function) and one owner with a non-active owner link.
//
// Compared classes, per owner:
//   M1  v1.1 and v1.2 day manifests (chunk_day, manifest_digest,
//       expected_chunk_count, state) and chunks (chunk_day, chunk_seq,
//       chunk_digest, envelope_digest, record_count); v1 chunks add revision;
//   M2  v1.1 and v1.2 domain heads (generation_id, revision) and the head
//       domain's manifest_digest;
//   H1  the owner's storage_ingestion_changes chain (sequence, kind, revision);
//   H2  storage_owner_revisions (revision, authority_epoch, state);
//   E1  evidence per owner-day and family: v1 accepted records, v1.1 chunk
//       record counts, v1.2 record rows;
//   E2  v0.2 contributions per day, and records per day with their token sums.
//
// Output is counts only; any mismatch refuses CUTOVER_PARITY_SAMPLE_MISMATCH
// naming the class. No participant id, digest or value leaves this module.

import { createHash } from "node:crypto";

export const PARITY_SAMPLE_SCHEMA = "tibotattle-pt8-parity-sample-v1";
export const PARITY_SAMPLE_DOMAIN = "pt8-parity-v1";
export const PARITY_SAMPLE_MAX_OWNERS = 64;
export const PARITY_CLASSES = Object.freeze(["M1", "M2", "H1", "H2", "E1", "E2"]);
const FAMILY_CLASSES = Object.freeze(["v1.2", "v1.1", "v1", "v0.2", "mixed"]);
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HASH = value => createHash("sha256").update(value).digest("hex");
const TOKEN_COLUMNS = Object.freeze(["input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens",
  "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens"]);

export class ParitySampleError extends Error {
  constructor(code, parityClass = undefined) {
    const safe = PARITY_CLASSES.includes(parityClass) ? parityClass : undefined;
    super(safe === undefined ? code : `${code} [class=${safe}]`);
    this.name = "ParitySampleError";
    this.code = code;
    if (safe !== undefined) this.parityClass = safe;
  }
}

function fail(code, parityClass = undefined) {
  throw new ParitySampleError(code, parityClass);
}

function sqliteRows(database, sql, values = []) {
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...values);
  } catch {
    return fail("CUTOVER_PARITY_SAMPLE_SOURCE_FAILED");
  }
}

async function postgresRows(client, sql, values = []) {
  try {
    return (await client.query(sql, values)).rows;
  } catch {
    return fail("CUTOVER_PARITY_SAMPLE_TARGET_FAILED");
  }
}

/** Engine-rendered value to text: SQLite BigInt or text, PostgreSQL text; null stays null. */
function cell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return fail("CUTOVER_PARITY_SAMPLE_SOURCE_FAILED");
}

function canonical(rows, columns) {
  return HASH(JSON.stringify(rows.map(row => columns.map(column => cell(row[column])))));
}

// Each comparison: the same projection in each dialect, ordered identically
// (text compared under "C" collation in PostgreSQL, BINARY in SQLite).
function comparisons(schema) {
  const t = name => `"${schema}"."${name}"`;
  const day = column => `to_char(${column}, 'YYYY-MM-DD')`;
  const instantDay = column => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const tokenSql = TOKEN_COLUMNS.map(column => `SUM(${column}) AS ${column}`).join(", ");
  const tokenPg = TOKEN_COLUMNS.map(column => `SUM(${column})::text AS ${column}`).join(", ");
  const manifests = (family) => ({
    columns: ["chunk_day", "manifest_digest", "expected_chunk_count", "state"],
    sqlite: `SELECT chunk_day, manifest_digest, expected_chunk_count, state FROM telemetry_${family}_day_manifests
      WHERE participant_id = ? ORDER BY chunk_day, manifest_digest, state`,
    postgres: `SELECT ${day("x.chunk_day")} AS chunk_day, x.manifest_digest, x.expected_chunk_count::text AS expected_chunk_count,
      x.state FROM ${t(`telemetry_${family}_day_manifests`)} x WHERE x.participant_id = $1
      ORDER BY x.chunk_day, x.manifest_digest COLLATE "C", x.state COLLATE "C"`,
  });
  const chunks = (family) => ({
    columns: ["chunk_day", "chunk_seq", "chunk_digest", "envelope_digest", "record_count"],
    sqlite: `SELECT chunk_day, chunk_seq, chunk_digest, envelope_digest, record_count FROM telemetry_${family}_chunks
      WHERE participant_id = ? ORDER BY chunk_day, chunk_seq, chunk_digest`,
    postgres: `SELECT ${day("x.chunk_day")} AS chunk_day, x.chunk_seq::text AS chunk_seq, x.chunk_digest, x.envelope_digest,
      x.record_count::text AS record_count FROM ${t(`telemetry_${family}_chunks`)} x WHERE x.participant_id = $1
      ORDER BY x.chunk_day, x.chunk_seq, x.chunk_digest COLLATE "C"`,
  });
  const heads = (family) => ({
    columns: ["generation_id", "revision", "manifest_digest"],
    sqlite: `SELECT head.generation_id, head.revision, domain.manifest_digest FROM telemetry_${family}_domain_heads head
      LEFT JOIN telemetry_${family}_domains domain ON domain.id = head.generation_id WHERE head.participant_id = ?`,
    postgres: `SELECT head.generation_id, head.revision::text AS revision, domain.manifest_digest
      FROM ${t(`telemetry_${family}_domain_heads`)} head
      LEFT JOIN ${t(`telemetry_${family}_domains`)} domain ON domain.id = head.generation_id
     WHERE head.participant_id = $1`,
  });
  return Object.freeze([
    ["M1", manifests("v11")], ["M1", chunks("v11")], ["M1", manifests("v12")], ["M1", chunks("v12")],
    ["M1", {
      columns: ["chunk_day", "chunk_seq", "revision", "chunk_digest", "envelope_digest", "record_count"],
      sqlite: `SELECT chunk_day, chunk_seq, revision, chunk_digest, envelope_digest, record_count FROM telemetry_v1_chunks
        WHERE participant_id = ? ORDER BY chunk_day, chunk_seq, revision, chunk_digest`,
      postgres: `SELECT ${day("x.chunk_day")} AS chunk_day, x.chunk_seq::text AS chunk_seq, x.revision::text AS revision,
        x.chunk_digest, x.envelope_digest, x.record_count::text AS record_count FROM ${t("telemetry_v1_chunks")} x
       WHERE x.participant_id = $1 ORDER BY x.chunk_day, x.chunk_seq, x.revision, x.chunk_digest COLLATE "C"`,
    }],
    ["M2", heads("v11")], ["M2", heads("v12")],
    ["H1", {
      columns: ["sequence", "kind", "revision"],
      sqlite: `SELECT change.sequence, change.kind, change.revision FROM storage_ingestion_changes change
        JOIN storage_v11_owner_links link ON link.owner_digest = change.owner_digest
       WHERE link.participant_id = ? ORDER BY change.sequence`,
      postgres: `SELECT change.sequence::text AS sequence, change.kind, change.revision::text AS revision
        FROM ${t("storage_ingestion_changes")} change
        JOIN ${t("storage_v11_owner_links")} link ON link.owner_digest = change.owner_digest
       WHERE link.participant_id = $1 ORDER BY change.sequence`,
    }],
    ["H2", {
      columns: ["revision", "authority_epoch", "state"],
      sqlite: `SELECT revision.revision, revision.authority_epoch, revision.state FROM storage_owner_revisions revision
        JOIN storage_v11_owner_links link ON link.owner_digest = revision.owner_digest WHERE link.participant_id = ?
       ORDER BY revision.revision, revision.authority_epoch, revision.state`,
      postgres: `SELECT revision.revision::text AS revision, revision.authority_epoch::text AS authority_epoch, revision.state
        FROM ${t("storage_owner_revisions")} revision
        JOIN ${t("storage_v11_owner_links")} link ON link.owner_digest = revision.owner_digest
       WHERE link.participant_id = $1
         AND revision.source_id = (SELECT source_id FROM ${t("storage_source_state")} WHERE singleton = 1)
       ORDER BY revision.revision, revision.authority_epoch, revision.state COLLATE "C"`,
    }],
    ["E1", {
      columns: ["day", "records"],
      sqlite: `SELECT chunk_day AS day, SUM(accepted_record_count) AS records FROM telemetry_v1_chunks
        WHERE participant_id = ? GROUP BY chunk_day ORDER BY chunk_day`,
      postgres: `SELECT ${day("x.chunk_day")} AS day, SUM(x.accepted_record_count)::text AS records
        FROM ${t("telemetry_v1_chunks")} x WHERE x.participant_id = $1 GROUP BY x.chunk_day ORDER BY x.chunk_day`,
    }],
    ["E1", {
      columns: ["day", "records"],
      sqlite: `SELECT chunk_day AS day, SUM(record_count) AS records FROM telemetry_v11_chunks
        WHERE participant_id = ? GROUP BY chunk_day ORDER BY chunk_day`,
      postgres: `SELECT ${day("x.chunk_day")} AS day, SUM(x.record_count)::text AS records
        FROM ${t("telemetry_v11_chunks")} x WHERE x.participant_id = $1 GROUP BY x.chunk_day ORDER BY x.chunk_day`,
    }],
    ["E1", {
      columns: ["day", "records"],
      sqlite: `SELECT record.observed_day AS day, count(*) AS records FROM telemetry_v12_records record
        JOIN telemetry_v12_chunks chunk ON chunk.id = record.chunk_id WHERE chunk.participant_id = ?
       GROUP BY record.observed_day ORDER BY record.observed_day`,
      postgres: `SELECT record.observed_day::text AS day, count(*)::text AS records
        FROM ${t("telemetry_v12_typed_records")} record
        JOIN ${t("telemetry_v12_chunks")} chunk ON chunk.id = record.chunk_id WHERE chunk.participant_id = $1
       GROUP BY record.observed_day ORDER BY record.observed_day`,
    }],
    ["E2", {
      columns: ["day", "contributions"],
      sqlite: `SELECT substr(created_at, 1, 10) AS day, count(*) AS contributions FROM telemetry_contributions
        WHERE participant_id = ? GROUP BY substr(created_at, 1, 10) ORDER BY 1`,
      postgres: `SELECT ${instantDay("created_at")} AS day, count(*)::text AS contributions
        FROM ${t("telemetry_contributions")} WHERE participant_id = $1 GROUP BY 1 ORDER BY 1`,
    }],
    ["E2", {
      columns: ["day", "records", ...TOKEN_COLUMNS],
      sqlite: `SELECT substr(observed_at, 1, 10) AS day, count(*) AS records, ${tokenSql} FROM telemetry_records
        WHERE participant_id = ? GROUP BY substr(observed_at, 1, 10) ORDER BY 1`,
      postgres: `SELECT ${instantDay("observed_at")} AS day, count(*)::text AS records, ${tokenPg}
        FROM ${t("telemetry_records")} WHERE participant_id = $1 GROUP BY 1 ORDER BY 1`,
    }],
  ]);
}

/** The deterministic sample of sealed participant ids (in memory only). */
export function selectParitySample(database, { sealId, maxOwners = PARITY_SAMPLE_MAX_OWNERS } = {}) {
  if (typeof sealId !== "string" || !SHA256.test(sealId)
      || !Number.isSafeInteger(maxOwners) || maxOwners < 1 || maxOwners > 1024) {
    fail("CUTOVER_PARITY_SAMPLE_ARGUMENT_INVALID");
  }
  const order = participantId => HASH(`${sealId}\0${PARITY_SAMPLE_DOMAIN}\0${participantId}`);
  const evidence = sqliteRows(database, `SELECT participant.id AS id,
      (SELECT count(*) FROM telemetry_v1_chunks WHERE participant_id = participant.id) AS v1,
      (SELECT count(*) FROM telemetry_v11_chunks WHERE participant_id = participant.id) AS v11,
      (SELECT count(*) FROM telemetry_v12_chunks WHERE participant_id = participant.id) AS v12,
      (SELECT count(*) FROM telemetry_contributions WHERE participant_id = participant.id) AS v02,
      (SELECT count(*) FROM storage_v11_owner_links WHERE participant_id = participant.id AND state <> 'active') AS inactive
    FROM participants participant`);
  const owners = evidence.map(row => {
    const families = [["v1", row.v1], ["v1.1", row.v11], ["v1.2", row.v12], ["v0.2", row.v02]]
      .filter(([, n]) => n > 0n).map(([name]) => name);
    return {
      id: String(row.id),
      key: order(String(row.id)),
      rows: row.v1 + row.v11 + row.v12 + row.v02,
      family: families.length === 0 ? "none" : families.length === 1 ? families[0] : "mixed",
      inactiveLink: row.inactive > 0n,
    };
  }).sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const chosen = new Map(owners.slice(0, Math.min(maxOwners, owners.length)).map(owner => [owner.id, owner]));
  const forced = [];
  if (owners.length > 0) {
    forced.push(owners.reduce((best, owner) => (owner.rows > best.rows ? owner : best)));
  }
  for (const family of FAMILY_CLASSES) {
    const owner = owners.find(candidate => candidate.family === family);
    if (owner !== undefined) forced.push(owner);
  }
  const inactive = owners.find(owner => owner.inactiveLink);
  if (inactive !== undefined) forced.push(inactive);
  for (const owner of forced) chosen.set(owner.id, owner);
  const classes = Object.fromEntries(FAMILY_CLASSES.map(family => [family,
    [...chosen.values()].some(owner => owner.family === family)]));
  return Object.freeze({
    owners: Object.freeze([...chosen.values()].sort((left, right) => (left.key < right.key ? -1 : 1)).map(owner => owner.id)),
    population: owners.length,
    forced: forced.length,
    familiesCovered: Object.freeze(classes),
    inactiveLinkCovered: inactive !== undefined,
  });
}

/**
 * Run the sample. `database` is the open, verified sealed ingestion database;
 * `client` a PostgreSQL client inside the transfer handle's transaction;
 * `schema` the application schema. Returns counts and a result digest;
 * refuses CUTOVER_PARITY_SAMPLE_MISMATCH on the first class with a mismatch
 * after the whole sample has run (the counts name every class).
 */
export async function runParitySample({ database, client, schema, sealId, maxOwners = PARITY_SAMPLE_MAX_OWNERS } = {}) {
  if (typeof schema !== "string" || !IDENTIFIER.test(schema) || client === null || typeof client?.query !== "function") {
    fail("CUTOVER_PARITY_SAMPLE_ARGUMENT_INVALID");
  }
  const sample = selectParitySample(database, { sealId, maxOwners });
  const plan = comparisons(schema);
  const mismatches = Object.fromEntries(PARITY_CLASSES.map(name => [name, 0]));
  const compared = Object.fromEntries(PARITY_CLASSES.map(name => [name, 0]));
  const digest = createHash("sha256");
  digest.update(`${PARITY_SAMPLE_SCHEMA}\0${sealId}\0`);
  for (const owner of sample.owners) {
    for (const [parityClass, comparison] of plan) {
      const source = canonical(sqliteRows(database, comparison.sqlite, [owner]), comparison.columns);
      const target = canonical(await postgresRows(client, comparison.postgres, [owner]), comparison.columns);
      compared[parityClass] += 1;
      if (source !== target) mismatches[parityClass] += 1;
      digest.update(`${parityClass}\0${source}\0${target}\n`);
    }
  }
  const result = Object.freeze({
    schema: PARITY_SAMPLE_SCHEMA,
    sampledOwners: sample.owners.length,
    population: sample.population,
    forced: sample.forced,
    familiesCovered: sample.familiesCovered,
    inactiveLinkCovered: sample.inactiveLinkCovered,
    comparisons: Object.freeze(compared),
    mismatches: Object.freeze(mismatches),
    resultSha256: digest.digest("hex"),
  });
  const failed = PARITY_CLASSES.find(name => mismatches[name] > 0);
  if (failed !== undefined) {
    const error = new ParitySampleError("CUTOVER_PARITY_SAMPLE_MISMATCH", failed);
    error.result = result;
    throw error;
  }
  return result;
}
