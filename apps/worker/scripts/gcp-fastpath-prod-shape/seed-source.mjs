#!/usr/bin/env node
// Seed the production-shaped synthetic corpus through d43c8f92's own admission
// code and seal it for the importer chain (MEAS-SYNTH).
//
//   ~/.nvm/versions/node/v26.2.0/bin/node --max-old-space-size=16384 \
//     apps/worker/scripts/gcp-fastpath-prod-shape/seed-source.mjs \
//       --work-dir <absolute dir outside the repository> [--scale 1] [--owners o01,o02,...]
//
// 1. build.mjs (the dense oracle's) materializes d43c8f92, blob-verified, and
//    bundles it for Node; runtime.mjs pins the clock and seeds every random
//    source, so a run is reproducible;
// 2. every owner of prod-shape-corpus.mjs is seeded through d43c8f92's
//    admission helpers exactly as the dense oracle seeds its owners (a port of
//    oracle.mjs's seeding, unchanged): v1.1 owners through the accountless
//    enrollment and ownership routes or a social device, v1 owners as legacy
//    chunks projected by production's own v1.1-to-v1.0 projection, v1.2 owners
//    through a consented v1.2 device, the mixed owner through a v1.1 device and
//    then a v1.2 device, and the "none" owner as a social participant with a
//    paired device and no evidence;
// 3. ANALYZE (planner statistics only), then production's eligible-owner page
//    gives each owner's routing flags, which are compared with OWN-3;
// 4. seal-sqlite.mjs seals the seeded USAGE_MONITOR_DB for the importers (no
//    JSON dump; see that file) and writes the journal-only dump;
// 5. <work-dir>/corpus-manifest.json: the roster (participant ids, owner
//    digests, flags), per-owner usage counts, record counts, the OWN-3
//    comparison, the sealed file's digest and the timings. Content-free.
//
// No convergence, no golden: this corpus measures the GCP refresh, it is not a
// parity oracle. Local and synthetic only: no network, no production data.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildDenseOracle, DENSE_ORACLE_SOURCE_COMMIT } from "../gcp-fastpath-dense-oracle/build.mjs";
import { installDenseOracleRuntime, setPinnedNow } from "../gcp-fastpath-dense-oracle/runtime.mjs";
import { createProdShapeOwner, dayFormat, OWN3_COUNTS, PROD_SHAPE_ANALYSIS_FROM_DAY, PROD_SHAPE_CORPUS_SCHEMA_VERSION,
  PROD_SHAPE_PINNED_NOW, PROD_SHAPE_REFRESH_NOW, PROD_SHAPE_ROSTER, PROD_SHAPE_SEED, PROD_SHAPE_WINDOW,
  prodShapeSummary } from "./prod-shape-corpus.mjs";
import { sealSqliteFromSqlite, sha256File, writeJournalDump } from "./seal-sqlite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(WORKER_ROOT, "../..");
/** The dense oracle's source identity, so the importers and the origin accept it unchanged. */
const SOURCE_ID = "gcp-fastpath-oracle", NAMESPACE = "gcp-fastpath-oracle";
/** The dense oracle's seeding instant (Q-1's realClockAtSeedMs): every record predates it. */
const SEED_CLOCK_MS = 1_790_839_591_714;
const PINNED_NOW_MS = Date.parse(PROD_SHAPE_PINNED_NOW);
const MIGRATION_DIRECTORIES = Object.freeze({
  TEST_MIGRATIONS: "migrations", TEST_DELETION_LEDGER_MIGRATIONS: "deletion-ledger-migrations",
  TEST_TYPED_INGESTION_MIGRATIONS: "typed-ingestion-migrations", TEST_ANALYTICS_MIGRATIONS: "analytics-migrations",
  TEST_ROUTING_MIGRATIONS: "routing-migrations", TEST_INGESTION_BRIDGE_MIGRATIONS: "ingestion-bridge-migrations",
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: "typed-v11-admission-migrations",
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: "typed-v1-admission-migrations",
  TEST_INGESTION_ISOLATION_MIGRATIONS: "ingestion-isolation-migrations",
});
const DB_FILES = Object.freeze({
  USAGE_MONITOR_DB: "usage-monitor.sqlite", STORAGE_ANALYTICS_DB: "storage-analytics.sqlite",
  DELETION_LEDGER: "deletion-ledger.sqlite", STORAGE_ROUTING_DB: "storage-routing.sqlite",
  STORAGE_INGESTION_A: "storage-ingestion-a.sqlite", STORAGE_INGESTION_B: "storage-ingestion-b.sqlite",
});
const SEEDER_FILES = Object.freeze(["seed-source.mjs", "prod-shape-corpus.mjs", "seal-sqlite.mjs"]);

// ------------------------------------------------------------------ args --

function parseArgs(argv) {
  const options = { workDir: null, scale: 1, owners: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index], next = () => argv[++index];
    if (arg === "--work-dir") options.workDir = resolve(next());
    else if (arg === "--scale") options.scale = Number(next());
    else if (arg === "--owners") options.owners = String(next()).split(",").filter(Boolean);
    else throw new Error(`PROD_SHAPE_SEED_ARGUMENT_INVALID:${arg}`);
  }
  if (!options.workDir || !isAbsolute(options.workDir) || !relative(REPO_ROOT, options.workDir).startsWith("..")) {
    throw new Error("PROD_SHAPE_SEED_WORK_DIR_INVALID");
  }
  if (!(options.scale > 0 && options.scale <= 1)) throw new Error("PROD_SHAPE_SEED_SCALE_INVALID");
  if (options.owners !== null && (options.owners.length === 0
    || options.owners.some((key) => !PROD_SHAPE_ROSTER.some((owner) => owner.key === key)))) {
    throw new Error("PROD_SHAPE_SEED_OWNERS_INVALID");
  }
  return options;
}
const options = parseArgs(process.argv.slice(2));
const dbDir = join(options.workDir, "db");
if (existsSync(dbDir)) throw new Error("PROD_SHAPE_SEED_WORK_DIR_NOT_FRESH");
mkdirSync(dbDir, { recursive: true });
const logFd = openSync(join(options.workDir, "seed.log"), "a");
const wallStarted = performance.now();
function note(event, fields = {}) {
  const line = JSON.stringify({ event, wallMs: Math.round(performance.now() - wallStarted), ...fields });
  writeSync(logFd, `${line}\n`);
  console.error(line.length > 600 ? `${line.slice(0, 600)}…` : line);
}
const blobOf = (path) => {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};

// --------------------------------------------------------- build + runtime --

const build = await buildDenseOracle({ workDir: join(options.workDir, "build") });
note("built", { sourceCommit: build.sourceCommit, verifiedFiles: build.verifiedFiles, bundleSha256: build.bundle.sha256 });
installDenseOracleRuntime({ seed: `gcp-fastpath-prod-shape:${options.scale}:${(options.owners ?? ["all"]).join(",")}` });
process.setSourceMapsEnabled(true);
setPinnedNow(SEED_CLOCK_MS);
const P = await import(pathToFileURL(build.bundle.path).href);
const { openSealedSqliteD1 } = await import(pathToFileURL(join(WORKER_ROOT, "cloud-run/sealed-sqlite-d1-adapter.mjs")).href);
const { unstable_splitSqlQuery } = await import(pathToFileURL(join(WORKER_ROOT, "node_modules/wrangler/wrangler-dist/cli.js")).href);

/** readD1Migrations over d43c8f92's directories (the dense oracle's readMigrations). */
function readMigrations(directory) {
  const path = join(build.tree, "apps/worker", directory);
  const names = readdirSync(path).filter((name) => name.endsWith(".sql"));
  names.sort((a, b) => parseInt(a.split("_")[0]) - parseInt(b.split("_")[0]));
  return names.map((name) => ({ name, queries: unstable_splitSqlQuery(readFileSync(join(path, name), "utf8")) }));
}
const MIGRATIONS = Object.fromEntries(Object.entries(MIGRATION_DIRECTORIES).map(([key, dir]) => [key, readMigrations(dir)]));

let handles = null;
const db = {};
async function openDatabases(nowMs, { create = false } = {}) {
  closeDatabases();
  handles = {};
  for (const [binding, file] of Object.entries(DB_FILES)) {
    handles[binding] = openSealedSqliteD1(join(dbDir, file), { create, pinnedNowMs: nowMs });
    db[binding] = handles[binding].database;
    const now = await db[binding].prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").first("now");
    if (now !== new Date(nowMs).toISOString()) throw new Error(`PROD_SHAPE_SQLITE_CLOCK_UNPINNED:${binding}`);
  }
}
function closeDatabases() {
  if (!handles) return;
  for (const handle of Object.values(handles)) handle.close();
  handles = null;
}
const source = () => db.USAGE_MONITOR_DB, target = () => db.STORAGE_ANALYTICS_DB;

/** d43c8f92 wrangler.jsonc top-level vars, as the dense oracle's baseEnv carries them. */
const WRANGLER_VARS = createRequire(join(WORKER_ROOT, "package.json"))("jsonc-parser")
  .parse(readFileSync(join(build.tree, "apps/worker/wrangler.jsonc"), "utf8")).vars;
if (!WRANGLER_VARS || typeof WRANGLER_VARS !== "object") throw new Error("PROD_SHAPE_WRANGLER_VARS");
const allowAll = Object.freeze({ limit: async () => ({ success: true }) });
const RATE_LIMITS = ["ENROLLMENT_RATE_LIMIT", "RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT", "PUBLIC_READ_RATE_LIMIT",
  "UPLOAD_AUTHORIZATION_RATE_LIMIT", "UPLOAD_PRINCIPAL_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT"];
const baseEnv = () => ({ ...WRANGLER_VARS, ENVELOPE_PRIVATE_JWK: "", ENVELOPE_PUBLIC_JWK: "",
  ...Object.fromEntries(Object.keys(DB_FILES).map((binding) => [binding, db[binding]])),
  ...Object.fromEntries(RATE_LIMITS.map((name) => [name, allowAll])), ...MIGRATIONS });

// ---------------------------------------------------------------- seeding --
// A port of the dense oracle's seeding (oracle.mjs, itself the Q-1 oracle's),
// unchanged except that every owner's days stream from prod-shape-corpus.mjs.

const coordinatesDigest = (label) => P.sha256Hex(`gcp-fastpath-prod-shape:${label}`);
async function uploadGrant(principal, label) {
  const envelopeDigest = await coordinatesDigest(`envelope:${label}`);
  const device = await P.authenticateDevice(source(), principal.authorization);
  const upload = await P.createDeviceUploadAuthorization(source(), device, envelopeDigest, 4096);
  const claimed = await P.claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 4096, contentType: "application/json" });
  return { envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId };
}
const r2Key = async (label) => `synthetic-prod-shape-${(await coordinatesDigest(`r2:${label}`)).slice(0, 40)}`;
const chunkRowId = async (label) => `chunk:${(await coordinatesDigest(`chunk:${label}`)).slice(0, 36)}`;
async function pinOwnerDigest(participantId, ownerDigest) {
  await source().prepare(`INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
    VALUES(?,?,'active') ON CONFLICT(participant_id) DO NOTHING`).bind(participantId, ownerDigest).run();
}

async function stageV11Days(principal, days, progress) {
  const ready = [];
  for (const { day, records } of days) {
    const prepared = await P.makeV11Day(day, records, "synthetic-gcp-prod-shape-v11");
    await P.registerTelemetryV11DayManifest(source(), principal, prepared.manifest);
    for (const chunk of prepared.chunks) {
      const label = `v11:${principal.participantId}:${day}:${chunk.chunkId}:${chunk.manifestDigest}`;
      await P.persistTypedV11StagedChunk(source(), principal, chunk, {
        sourceNamespace: NAMESPACE, chunkRowId: await chunkRowId(label), r2Key: await r2Key(label),
        ...await uploadGrant(principal, label),
      });
    }
    ready.push(await P.registerTelemetryV11DayManifest(source(), principal, prepared.manifest));
    progress(day, records);
  }
  if (ready.length === 0) return;
  const predecessor = await P.createTelemetryV11DomainPredecessor(source(), principal);
  const ordered = [...ready].sort((left, right) => left.day.localeCompare(right.day));
  const manifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: ordered[0].day, throughDay: ordered.at(-1).day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map((value) => ({ day: value.day, manifestId: value.manifestId, manifestDigest: value.manifestDigest })),
    manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await P.sha256Hex(P.telemetryV11DomainManifestDigestInput(manifest));
  await P.activateTelemetryV11Domain(source(), principal, manifest);
}

async function stageV12Days(device, days, progress) {
  const consent = P.telemetryV12RequiredConsent();
  const ready = [];
  for (const { day, records } of days) {
    const chunks = [];
    for (const stream of ["quota", "session", "usage"]) {
      const selected = records[stream];
      for (let offset = 0; offset < selected.length; offset += 200) {
        const rows = selected.slice(offset, offset + 200);
        chunks.push({ schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
          chunkId: `${stream}:${day}:${offset / 200}`, chunkRevision: 1,
          chunkDigest: await P.sha256Hex(P.canonicalTelemetryV12Json(rows)),
          parserVersion: "synthetic-gcp-prod-shape-v12", consent, records: rows });
      }
    }
    const manifest = { schemaVersion: "telemetry-day-manifest-v1.2", day,
      parserVersion: "synthetic-gcp-prod-shape-v12", consent,
      chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest,
        recordCount: chunk.records.length })), excluded: { quota: 0, session: 0, usage: 0 },
      manifestDigest: "0".repeat(64) };
    manifest.manifestDigest = await P.sha256Hex(P.telemetryV12DayManifestDigestInput(manifest));
    await P.registerTelemetryV12DayManifest(source(), device, manifest);
    for (const chunk of chunks) {
      chunk.manifestDigest = manifest.manifestDigest;
      const label = `v12:${device.participantId}:${day}:${chunk.chunkId}:${manifest.manifestDigest}`;
      await P.persistTelemetryV12StagedChunk(source(), device, chunk, {
        chunkRowId: await chunkRowId(label), r2Key: await r2Key(label), ...await uploadGrant(device, label) });
    }
    ready.push(await P.registerTelemetryV12DayManifest(source(), device, manifest));
    progress(day, records);
  }
  if (ready.length === 0) return;
  const now = Date.now();
  const predecessor = await P.createTelemetryV12DomainPredecessor(source(), device, now);
  const ordered = [...ready].sort((left, right) => left.day.localeCompare(right.day));
  const manifest = { schemaVersion: "telemetry-domain-manifest-v1.2",
    fromDay: ordered[0].day, throughDay: ordered.at(-1).day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map((value) => ({ day: value.day, manifestId: value.manifestId, manifestDigest: value.manifestDigest })),
    manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await P.sha256Hex(P.telemetryV12DomainManifestDigestInput(manifest));
  await P.activateTelemetryV12Domain(source(), device, manifest, now);
}

async function insertV1Days(device, days, progress) {
  for (const { day, records } of days) {
    for (const stream of ["quota", "session", "usage"]) {
      const projected = records[stream].map((record) => {
        const value = P.telemetryV11LegacyProjection(stream, record);
        if (!value) throw new Error("synthetic v1 projection missing");
        return JSON.parse(value.canonicalRecord);
      });
      for (let offset = 0, seq = 0; offset < projected.length; offset += 200, seq++) {
        const page = projected.slice(offset, offset + 200);
        const chunk = P.parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0",
          chunkId: `${stream}:${day}:${seq}`, chunkRevision: 1,
          chunkDigest: await P.sha256Hex(P.canonicalJson(page)), parserVersion: "synthetic-gcp-prod-shape-v1",
          consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
            fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
            privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records: page });
        const label = `v1:${device.participantId}:${day}:${stream}:${seq}`;
        const prior = await P.currentTelemetryV1Chunk(source(), device.participantId, device.deviceId, stream, day, seq);
        if (prior) throw new Error("synthetic v1 chunk already present");
        await P.insertTypedTelemetryV1Chunk(source(), {
          chunkRowId: await chunkRowId(label), participantId: device.participantId, deviceId: device.deviceId,
          chunk, ...await uploadGrant(device, label), r2Key: await r2Key(label),
          createdAt: new Date().toISOString(), supersedes: null,
        }, NAMESPACE);
      }
    }
    progress(day, records);
  }
}

async function createAccountlessPrincipal(spec) {
  const deviceId = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const bytes = new Uint8Array(prefix.length + secret.length); bytes.set(prefix); bytes.set(secret, prefix.length);
  const deviceSecretHash = await P.sha256Hex(bytes), authorization = `Device um_device_${deviceId}.${P.encodeBase64Url(secret)}`;
  bytes.fill(0); secret.fill(0);
  const runtimeEnv = { ...baseEnv(), ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" };
  const request = (path, body, auth = "") => P.handleRequest(new Request(`https://oracle.example.test${path}`, {
    method: "POST", headers: { origin: "https://oracle.example.test", "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
  }), runtimeEnv);
  const enrolled = await request("/api/v1/accountless/enrollment", { schemaVersion: "accountless-enrollment-v0.1", deviceId,
    deviceSecretHash, policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" });
  if (enrolled.status !== 201) throw new Error(`PROD_SHAPE_ACCOUNTLESS_ENROLLMENT:${enrolled.status}`);
  // The route mints the participant id with crypto.randomUUID(); pin that one
  // draw to the corpus value (the oracle's construction) and prove it was used.
  const pinned = spec.participantId.replace(/^participant:/u, "");
  const original = crypto.randomUUID;
  let pinnedDraws = 0;
  crypto.randomUUID = () => {
    if ((new Error().stack ?? "").includes("accountless-ownership")) { pinnedDraws++; return pinned; }
    return original();
  };
  try {
    const owned = await request("/api/v1/accountless/ownership", { schemaVersion: "accountless-upload-owner-v0.1",
      policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1",
      telemetrySchemaVersion: "telemetry-contribution-v1.1" }, authorization);
    if (owned.status !== 201) throw new Error(`PROD_SHAPE_ACCOUNTLESS_OWNERSHIP:${owned.status}`);
  } finally { crypto.randomUUID = original; }
  const participantId = await source().prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
    .bind(deviceId).first("participant_id");
  if (participantId !== spec.participantId || pinnedDraws !== 1) throw new Error("PROD_SHAPE_ACCOUNTLESS_PIN_FAILED");
  await pinOwnerDigest(participantId, spec.pinnedOwnerDigest);
  return { participantId, deviceId, authorization };
}

const EMPTY_RECORDS = Object.freeze({ quota: Object.freeze([]), session: Object.freeze([]), usage: Object.freeze([]) });
/** The mixed owner's v1.1 domain: its v1.1 days, then empty days through the corpus day (its predecessor reaches today). */
function* mixedV11Days(owner) {
  for (const value of owner.days()) yield value.format === "v11" ? value : { day: value.day, format: "v11", records: EMPTY_RECORDS };
}
/** The mixed owner's v1.2 domain: its v1.2 days. */
function* mixedV12Days(owner) {
  for (const value of owner.days()) if (value.format === "v12") yield value;
}

/** Seed one owner by its routing; returns its record counts. */
async function seedOwner(owner) {
  const spec = owner.spec;
  const counts = { days: 0, quota: 0, session: 0, usage: 0 };
  let lastNoted = performance.now();
  const progress = (day, records) => {
    counts.days++;
    for (const stream of ["quota", "session", "usage"]) counts[stream] += records[stream].length;
    if (performance.now() - lastNoted > 60_000) {
      lastNoted = performance.now();
      note("seed-progress", { key: spec.key, day, ...counts });
    }
  };
  if (spec.routing === "none") {
    // A signed-in social participant that never uploaded: eligible, no
    // evidence, and no owner link (production mints one at the first head).
    await P.createV11DeviceFixture(source(), { participantId: spec.participantId });
    return counts;
  }
  if (spec.routing === "v1.1" && spec.kind === "accountless") {
    await stageV11Days(await createAccountlessPrincipal(spec), owner.days(), progress);
    return counts;
  }
  const participantId = spec.participantId;
  if (spec.routing === "v1.1") {
    const device = await P.createV11DeviceFixture(source(), { participantId, grant: true });
    await pinOwnerDigest(participantId, spec.pinnedOwnerDigest);
    await stageV11Days(device, owner.days(), progress);
  } else if (spec.routing === "v1") {
    const device = await P.createV11DeviceFixture(source(), { participantId });
    await pinOwnerDigest(participantId, spec.pinnedOwnerDigest);
    await insertV1Days(device, owner.days(), progress);
  } else if (spec.routing === "v1.2") {
    const device = await P.createV11DeviceFixture(source(), { participantId });
    await pinOwnerDigest(participantId, spec.pinnedOwnerDigest);
    await P.grantTelemetryV12Consent(source(), device, P.telemetryV12RequiredConsent());
    await stageV12Days(device, owner.days(), progress);
  } else if (spec.routing === "mixed") {
    const v11 = await P.createV11DeviceFixture(source(), { participantId, grant: true });
    await pinOwnerDigest(participantId, spec.pinnedOwnerDigest);
    await stageV11Days(v11, mixedV11Days(owner), progress);
    const v12 = await P.createV11DeviceFixture(source(), { participantId });
    await P.grantTelemetryV12Consent(source(), v12, P.telemetryV12RequiredConsent());
    await stageV12Days(v12, mixedV12Days(owner), progress);
  } else {
    throw new Error(`PROD_SHAPE_ROUTING_INVALID:${spec.routing}`);
  }
  return counts;
}

// ------------------------------------------------------------------- run --

const roster = PROD_SHAPE_ROSTER.filter((owner) => options.owners === null || options.owners.includes(owner.key));
const plannedSummary = new Map(prodShapeSummary(options.scale).map((row) => [row.key, row]));
await openDatabases(SEED_CLOCK_MS, { create: true });
const seedStarted = performance.now();
await P.initializeSharedAnalyticsCorpusDatabases(source(), target(), MIGRATIONS, SOURCE_ID, NAMESPACE);
await (await import(pathToFileURL(join(HERE, "../gcp-fastpath-dense-oracle/shims/cloudflare-test.mjs")).href))
  .applyD1Migrations(db.DELETION_LEDGER, MIGRATIONS.TEST_DELETION_LEDGER_MIGRATIONS);
// The v1.1 transport is accepted in production; d43c8f92's device fixture
// accepts it the same way (createV11DeviceFixture with grant), which the dense
// oracle relies on by seeding a granted social owner before any accountless
// one. Accept it up front so the seeding order does not matter.
await source().prepare("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'").run();
const correctionRuntime = await source().prepare("SELECT state FROM telemetry_usage_correction_runtime WHERE id=1").first("state");
if (correctionRuntime !== OWN3_COUNTS.correctionRuntime) throw new Error("PROD_SHAPE_CORRECTION_STATE");
note("corpus", { schemaVersion: PROD_SHAPE_CORPUS_SCHEMA_VERSION, scale: options.scale, owners: roster.length,
  correctionRuntime });
const seeded = [];
for (const entry of roster) {
  const started = performance.now();
  note("seeding-owner", { key: entry.key, routing: entry.routing, kind: entry.kind });
  const owner = createProdShapeOwner(entry, { pricer: P.priceTelemetryUsageEvent, scale: options.scale });
  const generatedMs = Math.round(performance.now() - started);
  const counts = await seedOwner(owner);
  const planned = plannedSummary.get(entry.key);
  if (counts.usage !== planned.totalUsage || owner.spec.usageEvents !== planned.totalUsage) {
    throw new Error(`PROD_SHAPE_USAGE_COUNT_MISMATCH:${entry.key}`);
  }
  seeded.push({ spec: owner.spec, counts, planned });
  note("seeded-owner", { key: entry.key, routing: entry.routing, kind: entry.kind, ...counts, generatedMs,
    ms: Math.round(performance.now() - started) });
}
const seedMs = Math.round(performance.now() - seedStarted);
note("seeded", { seedMs, owners: seeded.length });

// Planner statistics (performance only; sqlite_* tables are outside the seal).
closeDatabases();
const analyzeStarted = performance.now();
{
  const database = new DatabaseSync(join(dbDir, DB_FILES.USAGE_MONITOR_DB));
  try { database.exec("ANALYZE"); } finally { database.close(); }
}
note("analyzed", { ms: Math.round(performance.now() - analyzeStarted) });

// Production's eligible-owner page: each owner's routing flags.
setPinnedNow(PINNED_NOW_MS);
await openDatabases(PINNED_NOW_MS);
const page = await P.readStorageCommunityOwnerPage(source());
closeDatabases();
const byParticipant = new Map(page.map((row) => [row.participantId, row]));
const routingOf = (row) => row === undefined ? "not-eligible"
  : !row.hasEffective ? "none"
  : row.hasV11 && row.hasV12 ? "mixed"
  : row.hasV12 ? "v1.2" : row.hasV11 ? "v1.1" : row.hasV1 ? (row.hasLegacy ? "v1+legacy" : "v1") : "v0.2";
const owners = seeded.map(({ spec, counts, planned }) => {
  const row = byParticipant.get(spec.participantId);
  return { key: spec.key, kind: spec.kind, planType: spec.planType, participantId: spec.participantId,
    ownerDigest: row?.ownerDigest ?? null, pinnedOwnerDigest: spec.pinnedOwnerDigest,
    expectedRouting: spec.routing, routing: routingOf(row),
    flags: row === undefined ? null : { hasV1: Boolean(row.hasV1), hasV11: Boolean(row.hasV11), hasV12: Boolean(row.hasV12),
      hasLegacy: Boolean(row.hasLegacy), hasEffective: Boolean(row.hasEffective) },
    models: spec.models, peakPercent: spec.peakPercent, capacityScale: spec.capacityScale,
    firstDay: spec.firstDay, lastDay: spec.lastDay, days: counts.days,
    usage: { window: planned.windowUsage, windowByFormat: planned.windowUsageByFormat,
      beforeWindow: planned.beforeWindowUsage, analysisHorizon: planned.analysisHorizonUsage, total: planned.totalUsage,
      maxDay: planned.maxDayUsage },
    records: { quota: counts.quota, session: counts.session, usage: counts.usage,
      total: counts.quota + counts.session + counts.usage } };
});
const routingCounts = {};
for (const owner of owners) routingCounts[owner.routing] = (routingCounts[owner.routing] ?? 0) + 1;
const windowOver = Object.fromEntries(Object.keys(OWN3_COUNTS.windowOver).map((threshold) => {
  const n = Number(threshold);
  return [threshold, [
    owners.filter((owner) => Math.max(...Object.values(owner.usage.windowByFormat)) > n).length,
    owners.filter((owner) => owner.usage.window > n).length]];
}));
note("routing", { routingCounts, eligible: page.length, mismatched: owners.filter((owner) =>
  owner.routing !== owner.expectedRouting).map((owner) => ({ key: owner.key, expected: owner.expectedRouting,
  actual: owner.routing })) });

// Seal for the importers, and the journal-only dump.
const sealDir = join(options.workDir, "sealed");
mkdirSync(sealDir, { recursive: true });
const sealStarted = performance.now();
const sealed = sealSqliteFromSqlite(join(dbDir, DB_FILES.USAGE_MONITOR_DB), join(sealDir, "usage-monitor-db.sqlite"));
note("sealed", { sha256: sealed.sha256, bytes: sealed.bytes, rows: sealed.rows, sealReady: sealed.sealReady,
  missingSealedTables: sealed.sealedSourceTables.missing, ms: Math.round(performance.now() - sealStarted) });
if (!sealed.sealReady) throw new Error("PROD_SHAPE_SEAL_NOT_READY");
const header = { corpus: PROD_SHAPE_CORPUS_SCHEMA_VERSION, sourceCommit: DENSE_ORACLE_SOURCE_COMMIT, scale: options.scale,
  nowMs: PINNED_NOW_MS, seedClockMs: SEED_CLOCK_MS, synthetic: true, sealedSha256: sealed.sha256 };
const journal = writeJournalDump(join(dbDir, DB_FILES.USAGE_MONITOR_DB), join(sealDir, "journal-dump.json"), header);
note("journal", journal);

const totals = owners.reduce((sum, owner) => ({
  windowUsage: sum.windowUsage + owner.usage.window, beforeWindowUsage: sum.beforeWindowUsage + owner.usage.beforeWindow,
  analysisHorizonUsage: sum.analysisHorizonUsage + owner.usage.analysisHorizon, usage: sum.usage + owner.records.usage,
  quota: sum.quota + owner.records.quota, session: sum.session + owner.records.session,
  records: sum.records + owner.records.total }),
{ windowUsage: 0, beforeWindowUsage: 0, analysisHorizonUsage: 0, usage: 0, quota: 0, session: 0, records: 0 });
const largest = owners.reduce((best, owner) => owner.usage.window > (best?.usage.window ?? -1) ? owner : best, null);
const fullRoster = options.owners === null;
const own3 = {
  expected: OWN3_COUNTS,
  actual: { eligibleOwners: page.length, routing: routingCounts,
    windowOwners: owners.filter((owner) => owner.usage.window > 0).length, windowOver,
    maxWindowRows: largest?.usage.window ?? 0, largestOwnerAllHistoryRecords: largest?.records.total ?? 0,
    correctionRuntime },
};
own3.matches = fullRoster && options.scale === 1 ? {
  eligibleOwners: own3.actual.eligibleOwners === OWN3_COUNTS.eligibleOwners,
  routing: Object.entries(OWN3_COUNTS.routing).every(([name, n]) => (routingCounts[name] ?? 0) === n),
  windowOwners: own3.actual.windowOwners === OWN3_COUNTS.windowOwners,
  windowOver: Object.entries(OWN3_COUNTS.windowOver).every(([threshold, [lo, hi]]) =>
    windowOver[threshold][0] === lo && windowOver[threshold][1] === hi),
  maxWindowRows: own3.actual.maxWindowRows === OWN3_COUNTS.maxWindowRows,
  largestOwnerAllHistoryRecords: Math.abs(own3.actual.largestOwnerAllHistoryRecords
    - OWN3_COUNTS.largestOwnerAllHistoryRecords) / OWN3_COUNTS.largestOwnerAllHistoryRecords < 0.05,
  correctionRuntime: correctionRuntime === OWN3_COUNTS.correctionRuntime,
} : null;
const manifest = {
  schemaVersion: "gcp-fastpath-prod-shape-manifest-v1",
  corpus: { schemaVersion: PROD_SHAPE_CORPUS_SCHEMA_VERSION, seed: PROD_SHAPE_SEED, scale: options.scale,
    owners: options.owners ?? "all", window: PROD_SHAPE_WINDOW, analysisFromDay: PROD_SHAPE_ANALYSIS_FROM_DAY,
    pinnedNow: PROD_SHAPE_PINNED_NOW, refreshNow: PROD_SHAPE_REFRESH_NOW, synthetic: true },
  sourceCommit: DENSE_ORACLE_SOURCE_COMMIT,
  seederFiles: Object.fromEntries(SEEDER_FILES.map((name) =>
    [`apps/worker/scripts/gcp-fastpath-prod-shape/${name}`, blobOf(join(HERE, name))])),
  build: { verifiedFiles: build.verifiedFiles, bundleSha256: build.bundle.sha256 },
  runtime: { node: process.version, sqlite: process.versions.sqlite },
  sourceIdentity: { sourceId: SOURCE_ID, sourceNamespace: NAMESPACE },
  seedClockMs: SEED_CLOCK_MS, nowMs: PINNED_NOW_MS, now: PROD_SHAPE_PINNED_NOW,
  correctionRuntimeState: correctionRuntime,
  own3, totals,
  owners,
  sealed: { sha256: sealed.sha256, bytes: sealed.bytes, rows: sealed.rows, tables: sealed.tables,
    schemaSha256: sealed.schemaSha256, integrityCheck: sealed.integrityCheck, sealReady: sealed.sealReady,
    seededFileSha256: sha256File(join(dbDir, DB_FILES.USAGE_MONITOR_DB)) },
  journal: { sha256: journal.sha256, bytes: journal.bytes, rows: journal.rows },
  timingsMs: { seed: seedMs, wall: Math.round(performance.now() - wallStarted) },
};
writeFileSync(join(options.workDir, "corpus-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
note("done", { manifest: join(options.workDir, "corpus-manifest.json"), totals, own3Matches: own3.matches });
