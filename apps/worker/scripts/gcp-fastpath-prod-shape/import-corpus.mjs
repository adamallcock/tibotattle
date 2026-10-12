// Import a sealed production-shaped corpus (seed-source.mjs output) into one
// fast-path rehearsal target schema through the reviewed importer chain
// (gcp-fastpath-rehearsal.mjs loadFastpathRehearsalImporters), the chain the
// local rehearsal and the GCP seed run. measure-local.mjs imports into a local
// PostgreSQL 17; the GCP seed (gcp-fastpath-seed.mjs --sealed-corpus) imports
// into the fast-path test database through prodShapeImporters.
//
// Differences from the rehearsal's import, all recorded in the receipt:
//   - the sealed source comes from seal-sqlite.mjs (no JSON dump: a
//     production-scale dump does not fit a V8 string) and the journal stage
//     reads seal-sqlite.mjs's journal-only dump;
//   - the T-1 copies' per-table bound is raised to PROD_SHAPE_MAX_SOURCE_TABLE_ROWS
//     (typed_v11_record_proofs holds one row per v1.1 record, about
//     5.5 million here); they still hold each table in memory, so the caller
//     needs a large heap;
//   - every table of the target is ANALYZEd after the import, so the refresh
//     plans against statistics in both places instead of racing autovacuum.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { fastpathRehearsalSchemas, loadFastpathRehearsalImporters } from "../gcp-fastpath-rehearsal.mjs";
import { PROD_SHAPE_REFRESH_NOW } from "./prod-shape-corpus.mjs";

export const PROD_SHAPE_MAX_SOURCE_TABLE_ROWS = 20_000_000;
export const PROD_SHAPE_MANIFEST_VERSION = "gcp-fastpath-prod-shape-manifest-v1";

function fail(code, detail) {
  throw Object.assign(new Error(detail === undefined ? code : `${code}: ${detail}`), { code });
}

/**
 * The seed work directory's manifest, sealed source and journal dump
 * (read-only): what the GCP seed reads from a golden, for this corpus.
 */
export async function readProdShapeCorpus(corpusDir) {
  const manifest = JSON.parse(await readFile(join(corpusDir, "corpus-manifest.json"), "utf8"));
  if (manifest?.schemaVersion !== PROD_SHAPE_MANIFEST_VERSION || !Array.isArray(manifest.owners)
      || manifest.owners.length === 0 || manifest.sealed?.sealReady !== true
      || !/^[0-9a-f]{64}$/u.test(manifest.sealed?.sha256 ?? "") || manifest.corpus?.refreshNow !== PROD_SHAPE_REFRESH_NOW) {
    fail("PROD_SHAPE_CORPUS_MANIFEST_INVALID");
  }
  const journalPath = join(corpusDir, "sealed", "journal-dump.json");
  const journalSha256 = createHash("sha256").update(await readFile(journalPath)).digest("hex");
  if (journalSha256 !== manifest.journal?.sha256) fail("PROD_SHAPE_JOURNAL_DIGEST_MISMATCH");
  return Object.freeze({
    manifest,
    sealedSource: Object.freeze({ path: join(corpusDir, "sealed", "usage-monitor-db.sqlite"),
      expectedSha256: manifest.sealed.sha256 }),
    journalPath,
    sealedSha256: manifest.sealed.sha256,
    nowIso: PROD_SHAPE_REFRESH_NOW,
    sourceIdentity: Object.freeze({ ...manifest.sourceIdentity }),
    roster: manifest.owners.map(({ participantId, ownerDigest }) => ({ participantId, ownerDigest })),
  });
}

function quoteIdentifier(name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(name)) fail("PROD_SHAPE_IDENTIFIER_INVALID");
  return `"${name}"`;
}

/**
 * loadFastpathRehearsalImporters with the corpus's per-table bound, then
 * ANALYZE of every table in the target. Takes and returns exactly what the
 * loader does (the importer steps), plus `analyze`; `timings` gains
 * "analyze". `cloudFastpathTarget` is forwarded unchanged.
 */
export async function prodShapeImporters(args) {
  const steps = await loadFastpathRehearsalImporters({ ...args, maxSourceTableRows: PROD_SHAPE_MAX_SOURCE_TABLE_ROWS });
  const started = performance.now();
  const tables = await args.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
    [args.schema]);
  for (const { tablename } of tables.rows) {
    await args.pool.query(`ANALYZE ${quoteIdentifier(args.schema)}.${quoteIdentifier(tablename)}`);
  }
  if (args.timings) args.timings.analyze = Math.round(performance.now() - started);
  return { ...steps, analyze: { tables: tables.rows.length }, maxSourceTableRows: PROD_SHAPE_MAX_SOURCE_TABLE_ROWS };
}

/** Import into a migrated local target (measure-local.mjs). Returns the content-free receipt. */
export async function importProdShapeCorpus({ pool, suffix, corpus, workDirectory, log = () => {} }) {
  const { schema, controlSchema } = fastpathRehearsalSchemas(suffix);
  const timings = {};
  log(`# importing the production-shaped corpus into ${schema}`);
  const started = performance.now();
  const steps = await prodShapeImporters({ pool, schema, controlSchema, suffix, sealedSource: corpus.sealedSource,
    dumpPath: corpus.journalPath, workDirectory, roster: corpus.roster, timings });
  timings.total = Math.round(performance.now() - started);
  const verification = steps.importVerification;
  if (verification === null || typeof verification !== "object"
      || !Object.values(verification).every((entry) => entry?.equal === true)) {
    fail("PROD_SHAPE_IMPORT_VERIFICATION_FAILED", JSON.stringify(verification));
  }
  const sizes = await pool.query(`SELECT pg_total_relation_size(c.oid)::bigint AS bytes FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p')`, [schema]);
  return Object.freeze({
    schema, controlSchema,
    corpus: { sealedSha256: corpus.sealedSha256, scale: corpus.manifest.corpus.scale,
      owners: corpus.manifest.owners.length, totals: corpus.manifest.totals },
    maxSourceTableRows: steps.maxSourceTableRows, importedRows: steps.importedRows,
    importVerification: verification, analyzedTables: steps.analyze.tables,
    schemaBytes: sizes.rows.reduce((sum, row) => sum + Number(row.bytes), 0), timingsMs: timings,
  });
}
