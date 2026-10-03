#!/usr/bin/env node
// REV-SEED: the per-day revision floor (owner decisions round 12 "SEED
// revisions" and round 14).
//
// GCP's community daily publications must continue above the revisions
// Cloudflare published, so a day Cloudflare published at rN continues at
// rN+1 and an aggregate identifier community-daily:<day>:r<n> is never reused
// for different content. Round 14 fixes the shape: a PER-DAY floor, from the
// CURRENT analytics D1 lineage only (no read of the pre-2026-09-12 database),
// loaded INSIDE the PT-8-lite import as the 'analytics-community-history'
// stage before markLive, and a SYNTHETIC floor at the dress rehearsal. The
// production refresh refuses to publish without one
// (ANALYTICS_V2_REVISION_FLOOR_ABSENT, cloud-run/analytics-refresh.mjs), and
// store-publication.ts nextPublishedRevision applies it.
//
// Subcommands (every one prints one content-free JSON line: counts, days and
// sha256 values; never a bookmark, database id, source id or path):
//
//   capture    OWNER, read-only, in H.3 after the seal (the EP-8 fence is
//              verified and quiet). Reads the seal manifest pinned by
//              --seal-id, its inventory, the fence receipt the seal pinned
//              (its 'analytics' entry: the fenced id digest and bookmark) and
//              the owner's 0600 analytics source file, which must name exactly
//              that fenced D1. Then, through the guarded read-only transport,
//              as the NON-sealable read role 'analytics-floor', which admits
//              exactly one pinned statement (cutover-source-seal.mjs
//              CUTOVER_REVISION_FLOOR_STATEMENT): bookmark B0 (must equal the
//              fence pin), the statement, bookmark B1 (must equal B0). Writes
//              revision-floor.json (0400, never overwritten). Without
//              --execute --remote --owner-read-only it is a dry run that reads
//              local files only and spawns nothing.
//   synthetic  The dress rehearsal's floor (round 14), written offline from
//              a seal and the frozen public read (OWN-4 export) taken for it:
//              each frozen day at its frozen revision. Same file format,
//              provenance 'synthetic' and no capture block.
//   check      Offline: validate a floor file at its pinned sha256 against
//              the seal it must be bound to. Writes nothing.
//
// The file (schema tibotattle-cutover-revision-floor-v1) is the canonical
// JSON of { schema, provenance, sealId, fenceReceiptSha256, sourceCommit,
// capturedAt, capture, days, dayCount, maxRevision } plus a newline; its
// sha256 is the floor's identity (floorSha256), which the owner pins in
// pt8-inputs.json. capture is { analyticsDatabaseIdSha256,
// analyticsBookmarkSha256, statementSha256 } for 'captured' and null for
// 'synthetic'. days is [[YYYY-MM-DD, revision], ...] in strictly ascending
// day order, 1..4000 of them, each revision 1..2,000,000,000.
//
// loadRevisionFloorInTransaction is the PT-8-lite stage's writer
// (postgres-production-transfer.mjs): inside the caller's transaction it
// refuses a target that has published any day, inserts the day rows and then
// the singleton provenance row (migration analytics_v2_revision_floor, whose
// triggers enforce the same order and immutability), and reads both back.
// Reloading the identical floor is a no-op that writes nothing; any other
// floor is REVISION_FLOOR_CONFLICT.

import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fencedAnalyticsEntry, readCutoverAnalyticsSource } from "./cutover-admin-history-export.mjs";
import {
  CUTOVER_ANALYTICS_FLOOR_ROLE,
  CUTOVER_REVISION_FLOOR_MAX_DAYS,
  CUTOVER_REVISION_FLOOR_STATEMENT,
  CUTOVER_REVISION_FLOOR_STATEMENT_SHA256,
  CutoverSourceError,
  assertOwnerDirectory,
  canonicalJson,
  containsSignedUrl,
  createWranglerCutoverTransport,
  cutoverFail,
  guardCutoverTransport,
  readCutoverInventory,
  readCutoverSeal,
  readPrivateFile,
  sha256Hex,
  writePrivateFileOnce,
} from "./cutover-source-seal.mjs";

export const CUTOVER_REVISION_FLOOR_SCHEMA = "tibotattle-cutover-revision-floor-v1";
export const CUTOVER_REVISION_FLOOR_FILE = "revision-floor.json";
export const REVISION_FLOOR_PROVENANCES = Object.freeze(["captured", "synthetic"]);
/** ANALYTICS_V2_MAX_REVISION_SEED (store-run.ts) and the migration's CHECK. */
export const REVISION_FLOOR_MAX_REVISION = 2_000_000_000;
export const REVISION_FLOOR_MAX_DAYS = CUTOVER_REVISION_FLOOR_MAX_DAYS;
/** The migration's tables (store-run.ts ANALYTICS_V2_REVISION_FLOOR_TABLES and contract.ts publishedDaily; the check pins them equal). */
export const REVISION_FLOOR_TABLES = Object.freeze({
  floor: "analytics_v2_revision_floor",
  source: "analytics_v2_revision_floor_source",
  published: "analytics_v2_published_daily",
});
const MAX_FILE_BYTES = 1024 * 1024;

export const REVISION_FLOOR_ERROR_CODES = Object.freeze([
  "REVISION_FLOOR_BELOW_FROZEN_EXPORT",
  "REVISION_FLOOR_CONFLICT",
  "REVISION_FLOOR_DAY_INVALID",
  "REVISION_FLOOR_EMPTY",
  "REVISION_FLOOR_FILE_INVALID",
  "REVISION_FLOOR_PUBLICATION_EXISTS",
  "REVISION_FLOOR_READBACK_MISMATCH",
  "REVISION_FLOOR_REVISION_INVALID",
  "REVISION_FLOOR_SEAL_MISMATCH",
  "REVISION_FLOOR_TABLE_MISSING",
  "REVISION_FLOOR_TOO_LARGE",
  "REVISION_FLOOR_USAGE",
  "REVISION_FLOOR_WRITE_FAILED",
]);
const ERROR_CODES = new Set(REVISION_FLOOR_ERROR_CODES);
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;

/** The floor's own refusals; the transport and file helpers keep the seal family's CutoverSourceError. */
export class RevisionFloorError extends Error {
  constructor(code, { sqlState = null } = {}) {
    const known = ERROR_CODES.has(code) ? code : "REVISION_FLOOR_USAGE";
    super(known);
    this.name = "RevisionFloorError";
    this.code = known;
    if (typeof sqlState === "string" && SQLSTATE.test(sqlState)) this.sqlState = sqlState;
  }
}

function floorFail(code, details = undefined) {
  throw new RevisionFloorError(code, details);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

/** A real calendar day as YYYY-MM-DD. */
export function isRevisionFloorDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= REVISION_FLOOR_MAX_REVISION;
}

function isCanonicalInstant(value) {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

/**
 * Validate a list of [day, revision] pairs: 1..4000 of them, strictly
 * ascending real days, revisions 1..2e9. Returns a frozen copy.
 */
export function validateRevisionFloorDays(days) {
  if (!Array.isArray(days)) floorFail("REVISION_FLOOR_FILE_INVALID");
  if (days.length === 0) floorFail("REVISION_FLOOR_EMPTY");
  if (days.length > REVISION_FLOOR_MAX_DAYS) floorFail("REVISION_FLOOR_TOO_LARGE");
  let previous = null;
  const out = [];
  for (const entry of days) {
    if (!Array.isArray(entry) || entry.length !== 2) floorFail("REVISION_FLOOR_FILE_INVALID");
    const [day, revision] = entry;
    // Duplicated or out of order is refused as a day defect.
    if (!isRevisionFloorDay(day) || (previous !== null && day <= previous)) floorFail("REVISION_FLOOR_DAY_INVALID");
    if (!isRevision(revision)) floorFail("REVISION_FLOOR_REVISION_INVALID");
    out.push(Object.freeze([day, revision]));
    previous = day;
  }
  return Object.freeze(out);
}

const BODY_KEYS = Object.freeze(["schema", "provenance", "sealId", "fenceReceiptSha256", "sourceCommit", "capturedAt",
  "capture", "days", "dayCount", "maxRevision"]);
const CAPTURE_KEYS = Object.freeze(["analyticsDatabaseIdSha256", "analyticsBookmarkSha256", "statementSha256"]);

/** Validate a parsed floor body (closed keys and types). Returns it frozen. */
export function validateRevisionFloorBody(value) {
  if (!exactKeys(value, BODY_KEYS) || value.schema !== CUTOVER_REVISION_FLOOR_SCHEMA
      || !REVISION_FLOOR_PROVENANCES.includes(value.provenance)
      || ![value.sealId, value.fenceReceiptSha256].every(item => typeof item === "string" && SHA256.test(item))
      || typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit)
      || !isCanonicalInstant(value.capturedAt)) {
    floorFail("REVISION_FLOOR_FILE_INVALID");
  }
  if (value.provenance === "captured") {
    if (!exactKeys(value.capture, CAPTURE_KEYS)
        || !CAPTURE_KEYS.every(key => typeof value.capture[key] === "string" && SHA256.test(value.capture[key]))
        || value.capture.statementSha256 !== CUTOVER_REVISION_FLOOR_STATEMENT_SHA256) {
      floorFail("REVISION_FLOOR_FILE_INVALID");
    }
  } else if (value.capture !== null) {
    floorFail("REVISION_FLOOR_FILE_INVALID");
  }
  const days = validateRevisionFloorDays(value.days);
  const maxRevision = Math.max(...days.map(([, revision]) => revision));
  if (value.dayCount !== days.length || value.maxRevision !== maxRevision) floorFail("REVISION_FLOOR_FILE_INVALID");
  return Object.freeze({
    ...value,
    capture: value.capture === null ? null : Object.freeze({ ...value.capture }),
    days,
  });
}

/** The exact file text of a floor body (canonical JSON and a newline) and its sha256. */
export function renderRevisionFloorFile(body) {
  const valid = validateRevisionFloorBody(body);
  const text = `${canonicalJson(valid)}\n`;
  return Object.freeze({ text, floorSha256: sha256Hex(text) });
}

/**
 * Parse floor file bytes against the owner's pin: the sha256 first, then
 * canonical form, then the closed body. Returns the body with floorSha256.
 */
export function parseRevisionFloorFile(bytes, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) floorFail("REVISION_FLOOR_USAGE");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
    floorFail("REVISION_FLOOR_FILE_INVALID");
  }
  if (sha256Hex(bytes) !== expectedSha256) floorFail("REVISION_FLOOR_FILE_INVALID");
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    floorFail("REVISION_FLOOR_FILE_INVALID");
  }
  const body = validateRevisionFloorBody(value);
  if (`${canonicalJson(body)}\n` !== text) floorFail("REVISION_FLOOR_FILE_INVALID");
  return Object.freeze({ ...body, floorSha256: expectedSha256 });
}

/** Read a private (0400/0600, owner-owned) floor file at its pinned sha256. */
export async function readRevisionFloorFile({ path, expectedSha256 } = {}) {
  let bytes;
  try {
    bytes = await readPrivateFile(path, MAX_FILE_BYTES, "CUTOVER_ARGUMENT_INVALID");
  } catch {
    floorFail("REVISION_FLOOR_FILE_INVALID");
  }
  return parseRevisionFloorFile(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), expectedSha256);
}

/** The floor must be the one taken for this seal: its id, fence receipt and source commit. */
export function assertRevisionFloorBinding(floor, { sealId, fenceReceiptSha256, sourceCommit } = {}) {
  if (!record(floor) || floor.sealId !== sealId || floor.fenceReceiptSha256 !== fenceReceiptSha256
      || floor.sourceCommit !== sourceCommit) {
    floorFail("REVISION_FLOOR_SEAL_MISMATCH");
  }
  return floor;
}

/** The binding facts a seal fixes (readCutoverSeal's result). */
export function revisionFloorSealFacts(seal) {
  const fenceReceiptSha256 = seal?.manifest?.fence?.fenceReceiptSha256;
  if (typeof seal?.manifest?.sealId !== "string" || typeof fenceReceiptSha256 !== "string"
      || typeof seal?.manifest?.expectedSourceCommit !== "string") {
    floorFail("REVISION_FLOOR_SEAL_MISMATCH");
  }
  return Object.freeze({ sealId: seal.manifest.sealId, fenceReceiptSha256,
    sourceCommit: seal.manifest.expectedSourceCommit });
}

/**
 * The C-IPR cross-check: every day of the frozen export (the revisions the
 * interim read serves verbatim) must have a floor at or above its frozen
 * revision. The export is taken before the fence and the floor after it, so
 * the floor can only be higher; anything lower means the floor is not
 * Cloudflare's maximum, and GCP would republish a served identifier.
 */
export function assertRevisionFloorCoversFrozen(floor, frozenDays) {
  if (!Array.isArray(frozenDays)) floorFail("REVISION_FLOOR_USAGE");
  const byDay = new Map(floor.days);
  let checked = 0;
  for (const item of frozenDays) {
    if (!record(item) || !isRevisionFloorDay(item.day) || !isRevision(item.revision)) floorFail("REVISION_FLOOR_USAGE");
    if (!((byDay.get(item.day) ?? 0) >= item.revision)) floorFail("REVISION_FLOOR_BELOW_FROZEN_EXPORT");
    checked += 1;
  }
  return Object.freeze({ frozenDays: checked });
}

/** Content-free facts about a floor, for receipts. */
export function revisionFloorSummary(floor) {
  return Object.freeze({
    provenance: floor.provenance,
    floorSha256: floor.floorSha256,
    sealId: floor.sealId,
    dayCount: floor.dayCount,
    maxRevision: floor.maxRevision,
    firstDay: floor.days[0][0],
    lastDay: floor.days.at(-1)[0],
  });
}

// ---------------------------------------------------------------------------
// The load (the PT-8-lite 'analytics-community-history' stage).

function quoteIdentifier(name) {
  if (typeof name !== "string" || !SCHEMA_IDENTIFIER.test(name)) floorFail("REVISION_FLOOR_USAGE");
  return `"${name}"`;
}

function daysText(days) {
  return days.map(([day, revision]) => `${day}:${revision}`).join(",");
}

async function query(client, text, values) {
  try {
    return await client.query(text, values);
  } catch (error) {
    if (error instanceof RevisionFloorError) throw error;
    return floorFail("REVISION_FLOOR_WRITE_FAILED", { sqlState: typeof error?.code === "string" ? error.code : null });
  }
}

/**
 * The load's statements inside a transaction the CALLER owns (the PT-8-lite
 * orchestrator's withTransferTransaction on the primary role): both floor
 * tables exist; the stored floor, if any, must be exactly this one (then
 * nothing is written: 'already-loaded'); otherwise no day may be published
 * yet, the day rows are inserted, then the singleton, and both are read back.
 * Throws a RevisionFloorError and leaves the rollback to the caller.
 */
export async function loadRevisionFloorInTransaction({ client, schema, floor } = {}) {
  if (client === null || typeof client !== "object" || typeof client.query !== "function"
      || !record(floor) || typeof floor.floorSha256 !== "string" || !SHA256.test(floor.floorSha256)) {
    floorFail("REVISION_FLOOR_USAGE");
  }
  const valid = validateRevisionFloorBody(Object.fromEntries(BODY_KEYS.map(key => [key, floor[key]])));
  const quoted = quoteIdentifier(schema);
  const table = name => `${quoted}.${quoteIdentifier(name)}`;
  const present = await query(client, `SELECT to_regclass($1) IS NOT NULL AS floor, to_regclass($2) IS NOT NULL AS source,
      to_regclass($3) IS NOT NULL AS published`,
  [table(REVISION_FLOOR_TABLES.floor), table(REVISION_FLOOR_TABLES.source), table(REVISION_FLOOR_TABLES.published)]);
  const tables = present.rows?.[0];
  if (tables?.floor !== true || tables?.source !== true || tables?.published !== true) floorFail("REVISION_FLOOR_TABLE_MISSING");
  const expectedText = daysText(valid.days);
  const readBack = async () => {
    const source = await query(client, `SELECT provenance, seal_id::text AS seal_id, floor_sha256::text AS floor_sha256,
        day_count, max_revision FROM ${table(REVISION_FLOOR_TABLES.source)} WHERE id = 1`);
    const days = await query(client, `SELECT count(*)::integer AS days, COALESCE(max(revision), 0)::integer AS largest,
        COALESCE(string_agg(to_char(day, 'YYYY-MM-DD') || ':' || revision::text, ',' ORDER BY day), '') AS text
        FROM ${table(REVISION_FLOOR_TABLES.floor)}`);
    return { source: source.rows ?? [], days: days.rows?.[0] };
  };
  const matches = ({ source, days }) => source.length === 1 && source[0].provenance === valid.provenance
    && source[0].seal_id === valid.sealId && source[0].floor_sha256 === floor.floorSha256
    && source[0].day_count === valid.dayCount && source[0].max_revision === valid.maxRevision
    && days?.days === valid.dayCount && days?.largest === valid.maxRevision && days?.text === expectedText;
  const before = await readBack();
  if (before.source.length > 0 || before.days?.days !== 0) {
    if (!matches(before)) floorFail("REVISION_FLOOR_CONFLICT");
    return Object.freeze({ state: "already-loaded", ...revisionFloorSummary(floor) });
  }
  const publication = await query(client, `SELECT EXISTS (SELECT 1 FROM ${table(REVISION_FLOOR_TABLES.published)}) AS published`);
  if (publication.rows?.[0]?.published !== false) floorFail("REVISION_FLOOR_PUBLICATION_EXISTS");
  await query(client, `INSERT INTO ${table(REVISION_FLOOR_TABLES.floor)} (day, revision)
      SELECT day, revision FROM jsonb_to_recordset($1::jsonb) AS row(day date, revision integer)`,
  [JSON.stringify(valid.days.map(([day, revision]) => ({ day, revision })))]);
  await query(client, `INSERT INTO ${table(REVISION_FLOOR_TABLES.source)} (id, provenance, seal_id, floor_sha256,
      fence_receipt_sha256, analytics_bookmark_sha256, source_commit, captured_at, day_count, max_revision)
      VALUES (1, $1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9)`,
  [valid.provenance, valid.sealId, floor.floorSha256, valid.fenceReceiptSha256,
    valid.capture === null ? null : valid.capture.analyticsBookmarkSha256, valid.sourceCommit, valid.capturedAt,
    valid.dayCount, valid.maxRevision]);
  if (!matches(await readBack())) floorFail("REVISION_FLOOR_READBACK_MISMATCH");
  return Object.freeze({ state: "loaded", ...revisionFloorSummary(floor) });
}

// ---------------------------------------------------------------------------
// The capture (owner, read-only, remote).

async function refuseExisting(path) {
  try {
    await lstat(path);
    cutoverFail("CUTOVER_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof CutoverSourceError) throw error;
    if (error?.code !== "ENOENT") cutoverFail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
  }
}

/** The pinned statement's rows as [day, revision] pairs; anything else is refused. */
function floorRows(rows) {
  if (!Array.isArray(rows)) cutoverFail("CUTOVER_REMOTE_RESPONSE_INVALID");
  if (rows.length > REVISION_FLOOR_MAX_DAYS) floorFail("REVISION_FLOOR_TOO_LARGE");
  return validateRevisionFloorDays(rows.map((row) => {
    if (!exactKeys(row, ["day", "revision"])) cutoverFail("CUTOVER_REMOTE_RESPONSE_INVALID");
    return [row.day, row.revision];
  }));
}

/**
 * Capture the floor (see the file header). An injected `transport` replaces
 * the default Wrangler transport (tests); the default one writes its pinned
 * config into the owner directory and removes it on success and on failure.
 * Nothing is written on any refusal.
 */
export async function captureRevisionFloor({
  inventoryPath,
  manifestPath,
  sealId,
  analyticsSourcePath,
  fenceReceiptPath,
  ownerDirectory,
  execute = false,
  remote = false,
  ownerReadOnly = false,
  transport = undefined,
  spawn = undefined,
  cliPath = undefined,
  environment = undefined,
  now = () => new Date(),
  forbiddenRoots = undefined,
} = {}) {
  const inventory = await readCutoverInventory(inventoryPath);
  const directory = await assertOwnerDirectory(ownerDirectory, forbiddenRoots === undefined ? {} : { forbiddenRoots });
  const seal = await readCutoverSeal({ manifestPath, expectedSealId: sealId });
  if (seal.manifest.inventorySha256 !== inventory.inventorySha256) cutoverFail("CUTOVER_SEAL_MANIFEST_INVALID");
  const facts = revisionFloorSealFacts(seal);
  if (!SHA256.test(facts.fenceReceiptSha256)) cutoverFail("CUTOVER_SEAL_MANIFEST_INVALID");
  const analytics = await readCutoverAnalyticsSource(analyticsSourcePath);
  if (Object.values(inventory.sources).some(sealed => sealed.databaseIdSha256 === analytics.databaseIdSha256)) {
    cutoverFail("CUTOVER_SOURCE_NOT_ALLOWED");
  }
  const fenced = await fencedAnalyticsEntry(fenceReceiptPath, facts.fenceReceiptSha256);
  if (fenced.idSha256 !== analytics.databaseIdSha256) cutoverFail("CUTOVER_FENCE_SOURCE_MISMATCH");
  if (execute !== true) {
    return Object.freeze({ mode: "dry-run", sealId: facts.sealId, fenceReceiptSha256: facts.fenceReceiptSha256,
      analyticsDatabaseIdSha256: analytics.databaseIdSha256, statementSha256: CUTOVER_REVISION_FLOOR_STATEMENT_SHA256 });
  }
  if (remote !== true || ownerReadOnly !== true) cutoverFail("CUTOVER_REMOTE_NOT_AUTHORIZED");
  const path = join(directory, CUTOVER_REVISION_FLOOR_FILE);
  await refuseExisting(path);
  // The transport sees only this one D1, as the pinned read role.
  const source = Object.freeze({ ...analytics, role: CUTOVER_ANALYTICS_FLOOR_ROLE });
  const scope = Object.freeze({ accountId: inventory.accountId, sources: Object.freeze({ [source.role]: source }) });
  const previousUmask = process.umask(0o077);
  let ownedTransport = null;
  try {
    ownedTransport = transport === undefined ? createWranglerCutoverTransport({
      inventory: scope, transportDirectory: directory, spawn, cliPath, environment, remote, ownerReadOnly,
    }) : null;
    const guarded = guardCutoverTransport(transport ?? ownedTransport, scope);
    const b0 = await guarded.bookmark(source);
    if (b0 !== fenced.bookmark) cutoverFail("CUTOVER_SOURCE_BOOKMARK_DRIFT");
    const days = floorRows(await guarded.query(source, CUTOVER_REVISION_FLOOR_STATEMENT));
    const b1 = await guarded.bookmark(source);
    if (b1 !== b0) cutoverFail("CUTOVER_SOURCE_BOOKMARK_DRIFT");
    await ownedTransport?.dispose();
    const capturedAt = new Date(now().getTime()).toISOString();
    const { text, floorSha256 } = renderRevisionFloorFile({
      schema: CUTOVER_REVISION_FLOOR_SCHEMA,
      provenance: "captured",
      ...facts,
      capturedAt,
      capture: { analyticsDatabaseIdSha256: analytics.databaseIdSha256, analyticsBookmarkSha256: sha256Hex(b0),
        statementSha256: CUTOVER_REVISION_FLOOR_STATEMENT_SHA256 },
      days,
      dayCount: days.length,
      maxRevision: Math.max(...days.map(([, revision]) => revision)),
    });
    if (containsSignedUrl(text)) cutoverFail("CUTOVER_SECRET_IN_OUTPUT");
    const written = await writePrivateFileOnce(path, text, 0o400);
    if (written !== floorSha256) cutoverFail("CUTOVER_OWNER_DIRECTORY_UNSAFE");
    return Object.freeze({ mode: "captured", path, floorSha256, dayCount: days.length,
      maxRevision: Math.max(...days.map(([, revision]) => revision)), firstDay: days[0][0], lastDay: days.at(-1)[0] });
  } catch (error) {
    await ownedTransport?.dispose().catch(() => {});
    throw error;
  } finally {
    process.umask(previousUmask);
  }
}

// ---------------------------------------------------------------------------
// The dress rehearsal's synthetic floor and the offline check.

/**
 * Write the dress rehearsal's synthetic floor (round 14) into the owner
 * directory: each day of the frozen export at its frozen revision, bound to
 * the seal. `frozenDays` is the validated export's days ({ day, revision },
 * gcp-interim-public-read-load.mjs checkInterimPublicRead's prepared.frozen).
 */
export async function writeSyntheticRevisionFloor({ manifestPath, sealId, frozenDays, ownerDirectory,
  now = () => new Date(), forbiddenRoots = undefined } = {}) {
  const directory = await assertOwnerDirectory(ownerDirectory, forbiddenRoots === undefined ? {} : { forbiddenRoots });
  const seal = await readCutoverSeal({ manifestPath, expectedSealId: sealId });
  const facts = revisionFloorSealFacts(seal);
  if (!Array.isArray(frozenDays)) floorFail("REVISION_FLOOR_USAGE");
  const days = validateRevisionFloorDays([...frozenDays]
    .map(item => [item?.day, item?.revision])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  const path = join(directory, CUTOVER_REVISION_FLOOR_FILE);
  await refuseExisting(path);
  const { text, floorSha256 } = renderRevisionFloorFile({
    schema: CUTOVER_REVISION_FLOOR_SCHEMA,
    provenance: "synthetic",
    ...facts,
    capturedAt: new Date(now().getTime()).toISOString(),
    capture: null,
    days,
    dayCount: days.length,
    maxRevision: Math.max(...days.map(([, revision]) => revision)),
  });
  const previousUmask = process.umask(0o077);
  try {
    await writePrivateFileOnce(path, text, 0o400);
  } finally {
    process.umask(previousUmask);
  }
  return Object.freeze({ mode: "synthetic", path, floorSha256, dayCount: days.length,
    maxRevision: Math.max(...days.map(([, revision]) => revision)) });
}

/** Offline: the floor file at its pin, bound to the seal. Writes nothing. */
export async function checkRevisionFloor({ floorPath, floorSha256, manifestPath, sealId } = {}) {
  const seal = await readCutoverSeal({ manifestPath, expectedSealId: sealId });
  const floor = assertRevisionFloorBinding(await readRevisionFloorFile({ path: floorPath, expectedSha256: floorSha256 }),
    revisionFloorSealFacts(seal));
  return Object.freeze({ mode: "check", ...revisionFloorSummary(floor) });
}

// ---------------------------------------------------------------------------
// CLI.

const COMMANDS = Object.freeze({
  capture: {
    values: { "--inventory": "inventoryPath", "--seal": "manifestPath", "--seal-id": "sealId",
      "--analytics-source": "analyticsSourcePath", "--fence-receipt": "fenceReceiptPath", "--out": "ownerDirectory" },
    switches: { "--remote": "remote", "--owner-read-only": "ownerReadOnly", "--execute": "execute" },
  },
  synthetic: {
    values: { "--seal": "manifestPath", "--seal-id": "sealId", "--out": "ownerDirectory",
      "--interim-export": "exportPath", "--interim-sha256": "exportSha256", "--interim-captured-at": "capturedAt",
      "--interim-source-commit": "sourceCommit", "--interim-evidence-date": "evidenceDate" },
    switches: {},
  },
  check: {
    values: { "--floor": "floorPath", "--sha256": "floorSha256", "--seal": "manifestPath", "--seal-id": "sealId" },
    switches: {},
  },
});

export function parseRevisionFloorArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !Object.hasOwn(COMMANDS, argv[0])) floorFail("REVISION_FLOOR_USAGE");
  const [command, ...rest] = argv;
  const { values, switches } = COMMANDS[command];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (Object.hasOwn(switches, flag)) {
      if (options[switches[flag]] !== undefined) floorFail("REVISION_FLOOR_USAGE");
      options[switches[flag]] = true;
      continue;
    }
    const key = Object.hasOwn(values, flag) ? values[flag] : undefined;
    const value = rest[index + 1];
    if (key === undefined || options[key] !== undefined || typeof value !== "string" || value.startsWith("--")) {
      floorFail("REVISION_FLOOR_USAGE");
    }
    options[key] = value;
    index += 1;
  }
  for (const key of Object.values(values)) {
    if (options[key] === undefined) floorFail("REVISION_FLOOR_USAGE");
  }
  return Object.freeze({ command, ...options });
}

async function main(argv) {
  const options = parseRevisionFloorArguments(argv);
  let result;
  if (options.command === "capture") {
    result = await captureRevisionFloor({
      inventoryPath: resolve(options.inventoryPath), manifestPath: resolve(options.manifestPath), sealId: options.sealId,
      analyticsSourcePath: resolve(options.analyticsSourcePath), fenceReceiptPath: resolve(options.fenceReceiptPath),
      ownerDirectory: resolve(options.ownerDirectory), execute: options.execute === true, remote: options.remote === true,
      ownerReadOnly: options.ownerReadOnly === true,
    });
  } else if (options.command === "synthetic") {
    // The frozen export's own validator (C-IPR), loaded only here: it is TypeScript.
    const { checkInterimPublicRead, readInterimExportFile } = await import("./gcp-interim-public-read-load.mjs");
    const { prepared } = await checkInterimPublicRead({ exportBytes: await readInterimExportFile(options.exportPath),
      sha256: options.exportSha256, capturedAt: options.capturedAt, sourceCommit: options.sourceCommit,
      evidenceDate: options.evidenceDate });
    result = await writeSyntheticRevisionFloor({ manifestPath: resolve(options.manifestPath), sealId: options.sealId,
      frozenDays: prepared.frozen.days, ownerDirectory: resolve(options.ownerDirectory) });
  } else {
    result = await checkRevisionFloor({ floorPath: resolve(options.floorPath), floorSha256: options.floorSha256,
      manifestPath: resolve(options.manifestPath), sealId: options.sealId });
  }
  const { path: _path, sealId: _sealId, ...printable } = result;
  process.stdout.write(`${JSON.stringify({ command: options.command, ...printable })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof CutoverSourceError || error instanceof RevisionFloorError
      ? error.message : (typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.code)
        ? error.code : "REVISION_FLOOR_FAILED")}\n`);
    process.exitCode = error?.code === "REVISION_FLOOR_USAGE" ? 2 : 1;
  });
}
