#!/usr/bin/env node
// Dense production-code oracle for the GCP fast path (Tier N and Tier F).
//
// Runs d43c8f92's own Worker code, unmodified, under Node over sealed SQLite
// files (cloud-run/sealed-sqlite-d1-adapter.mjs) instead of workerd D1:
//
//   ~/.nvm/versions/node/v26.2.0/bin/node --max-old-space-size=16384 \
//     apps/worker/scripts/gcp-fastpath-dense-oracle/oracle.mjs \
//       --work-dir <absolute dir outside the repository> --corpus dense|q1 [--scale 0.1] \
//       [--golden-out <dir>] [--verify-against <dir>] [--forced-native withheld|all|none] \
//       [--max-ticks N] [--resume <converged work dir>] [--keep-scratch]
//
//  1. build.mjs materializes d43c8f92 (blob-verified) and bundles it for Node;
//  2. runtime.mjs pins the clock and seeds every random source, so a run is
//     reproducible byte for byte;
//  3. seeding goes through d43c8f92's admission helpers exactly as the Q-1
//     oracle (apps/worker/test/gcp-fastpath-oracle.spec.ts on
//     claude/gcp-fp-q1-oracle) did: owners a-d from the Q-1 corpus files, and
//     for --corpus dense, owner e from dense-corpus.mjs through Q-1 owner c's
//     v1.2 path;
//  4. Tier N: the three production scheduled entry points (analytics,
//     publication, cache retention) in Q-1's lane order and cadence until no
//     work progresses for QUIET_TICKS (a progress digest over every analytics
//     table's counts, revisions, generations and sizes, so native checkpoints
//     that advance without publishing still count as progress);
//  5. capture: the public community-daily read, the stored preview, per-owner
//     routing, published model days, graph results, daily owner values, model
//     blocks, shared-feature heads and cache marks; then Q-1's lease-expiry
//     probe;
//  6. Tier F (forced-native.mjs): for every owner, today's fits and model
//     dates through computeStorageGraphResult with production's model-block
//     fallback options (prepared fold and prepared effective usage off, no
//     shared features, result not persisted), re-invoked within production's
//     1,000-statement invocation meter until complete, on a scratch copy whose
//     graph caches are cleared and whose source is opened read-only. `withheld`
//     (the default) covers every date without a Tier N result plus a fixed
//     sample that has one (the Tier N = Tier F check); `all` covers all 70;
//  7. the source dump (Q-1's usage-monitor-db.json format) and its sealed
//     SQLite rebuild through the rehearsal loader (gcp-fastpath-oracle-sqlite.mjs);
//  8. the golden files.
//
// Local and synthetic only: no network, no production data, no secrets.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDenseOracle, DENSE_ORACLE_SOURCE_COMMIT } from "./build.mjs";
import { createDenseOwner, DENSE_CORPUS_DAY_LIST, DENSE_CORPUS_PINNED_NOW, DENSE_CORPUS_SCHEMA_VERSION,
  DENSE_CLASS_DAYS, denseDayClass } from "./dense-corpus.mjs";
import { summarizeDenseCorpus } from "./corpus-summary.mjs";
import { runForcedNative } from "./forced-native.mjs";
import { installDenseOracleRuntime, setPinnedNow } from "./runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(WORKER_ROOT, "../..");
const Q1_CORPUS_DIR = join(WORKER_ROOT, "analytics-v2-test/golden/corpus");
const SOURCE_ID = "gcp-fastpath-oracle", NAMESPACE = "gcp-fastpath-oracle";
/** Q-1's realClockAtSeedMs (dump header): seeding runs at this pinned instant. */
const SEED_CLOCK_MS = 1_790_839_591_714;
const PINNED_NOW_MS = Date.parse(DENSE_CORPUS_PINNED_NOW);
const QUIET_TICKS = 21, PROBE_STEPS = 12, PROBE_STEP_MS = 10 * 60_000;
const MODEL_DATES = 70;
const MIGRATION_DIRECTORIES = Object.freeze({
  TEST_MIGRATIONS: "migrations", TEST_DELETION_LEDGER_MIGRATIONS: "deletion-ledger-migrations",
  TEST_TYPED_INGESTION_MIGRATIONS: "typed-ingestion-migrations", TEST_ANALYTICS_MIGRATIONS: "analytics-migrations",
  TEST_ROUTING_MIGRATIONS: "routing-migrations", TEST_INGESTION_BRIDGE_MIGRATIONS: "ingestion-bridge-migrations",
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: "typed-v11-admission-migrations",
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: "typed-v1-admission-migrations",
  TEST_INGESTION_ISOLATION_MIGRATIONS: "ingestion-isolation-migrations",
});
/** Same as the Q-1 oracle: published analytics columns derived from per-run
 * identifiers. With a seeded runtime they reproduce too, but the GCP compare
 * normalizes them, so the golden keeps Q-1's basis. */
const RUN_SPECIFIC_ANALYTICS_COLUMNS = Object.freeze({
  analytics_cache_retention_day_bands: ["value_key"],
  analytics_cache_retention_day_values: ["carry_digest", "mark_key", "value_key"],
  analytics_community_graph_previews: ["cohort_digest"],
  analytics_community_model_publications: ["cohort_digest"],
});

// ------------------------------------------------------------------ args --

function parseArgs(argv) {
  const options = { workDir: null, corpus: null, scale: 1, goldenOut: null, verifyAgainst: null,
    forcedNative: "withheld", maxTicks: 200_000, keepScratch: false, resume: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index], next = () => argv[++index];
    if (arg === "--work-dir") options.workDir = resolve(next());
    else if (arg === "--corpus") options.corpus = next();
    else if (arg === "--scale") options.scale = Number(next());
    else if (arg === "--golden-out") options.goldenOut = resolve(next());
    else if (arg === "--verify-against") options.verifyAgainst = resolve(next());
    else if (arg === "--forced-native") options.forcedNative = next();
    else if (arg === "--max-ticks") options.maxTicks = Number(next());
    else if (arg === "--keep-scratch") options.keepScratch = true;
    else if (arg === "--resume") options.resume = resolve(next());
    else throw new Error(`DENSE_ORACLE_ARGUMENT_INVALID:${arg}`);
  }
  if (!options.workDir || !isAbsolute(options.workDir) || !relative(REPO_ROOT, options.workDir).startsWith("..")) {
    throw new Error("DENSE_ORACLE_WORK_DIR_INVALID");
  }
  if (!["dense", "q1"].includes(options.corpus)) throw new Error("DENSE_ORACLE_CORPUS_INVALID");
  if (!(options.scale > 0 && options.scale <= 1) || (options.corpus === "q1" && options.scale !== 1)) {
    throw new Error("DENSE_ORACLE_SCALE_INVALID");
  }
  if (!["all", "withheld", "none"].includes(options.forcedNative)) throw new Error("DENSE_ORACLE_FORCED_NATIVE_INVALID");
  if (!Number.isSafeInteger(options.maxTicks) || options.maxTicks < 1) throw new Error("DENSE_ORACLE_MAX_TICKS_INVALID");
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (existsSync(join(options.workDir, "db"))) throw new Error("DENSE_ORACLE_WORK_DIR_NOT_FRESH");
mkdirSync(join(options.workDir, "db"), { recursive: true });
/** --resume <prior work dir>: continue a run of the same corpus and scale that
 * converged and passed its lease-expiry probe (its oracle.log says so), from a
 * clone of its databases. Seeding, convergence and the probe are not repeated;
 * their recorded outcomes are carried over. Every later step reads only the
 * converged state, which a deterministic rerun reproduces exactly. */
const prior = (() => {
  if (options.resume === null) return null;
  const events = {};
  for (const line of readFileSync(join(options.resume, "oracle.log"), "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const event = JSON.parse(line);
    events[event.event] = event;
  }
  if (!events.converged?.converged || !events.probe || events.probe.changedOutputs.length !== 0 || !events.seeded
    || !events.corpus) throw new Error("DENSE_ORACLE_RESUME_SOURCE_INCOMPLETE");
  for (const file of readdirSync(join(options.resume, "db"))) {
    copyFileSync(join(options.resume, "db", file), join(options.workDir, "db", file), fsConstants.COPYFILE_FICLONE);
  }
  return events;
})();
/** Git blob ids of the oracle files as this process loaded them (SOURCE.json). */
const ORACLE_FILES = ["oracle.mjs", "build.mjs", "runtime.mjs", "forced-native.mjs", "dense-corpus.mjs",
  "corpus-summary.mjs", "entry.ts", "shims/cloudflare-workers.mjs", "shims/cloudflare-test.mjs"];
const blobOf = (path) => {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
const LOADED_BLOBS = Object.freeze(Object.fromEntries(ORACLE_FILES.map((name) =>
  [`apps/worker/scripts/gcp-fastpath-dense-oracle/${name}`, blobOf(join(HERE, name))])));
const ADAPTER_BLOB = blobOf(join(WORKER_ROOT, "cloud-run/sealed-sqlite-d1-adapter.mjs"));
const logPath = join(options.workDir, "oracle.log");
const logFd = openSync(logPath, "a");
const realConsole = { log: console.log.bind(console), error: console.error.bind(console),
  info: console.info.bind(console), warn: console.warn.bind(console) };
const wallStarted = performance.now();
function note(event, fields = {}) {
  const line = JSON.stringify({ event, wallMs: Math.round(performance.now() - wallStarted), ...fields });
  writeSync(logFd, `${line}\n`);
  realConsole.error(line.length > 600 ? `${line.slice(0, 600)}…` : line);
}

// --------------------------------------------------------- build + runtime --

const build = await buildDenseOracle({ workDir: join(options.workDir, "build") });
note("built", { sourceCommit: build.sourceCommit, verifiedFiles: build.verifiedFiles, bundleSha256: build.bundle.sha256 });
const runtime = installDenseOracleRuntime({ seed: `gcp-fastpath-dense-oracle:${options.corpus}:${options.scale}` });
process.setSourceMapsEnabled(true);
setPinnedNow(SEED_CLOCK_MS);
const P = await import(pathToFileURL(build.bundle.path).href);
const { openSealedSqliteD1 } = await import(pathToFileURL(join(WORKER_ROOT, "cloud-run/sealed-sqlite-d1-adapter.mjs")).href);
const { unstable_splitSqlQuery } = await import(pathToFileURL(join(WORKER_ROOT, "node_modules/wrangler/wrangler-dist/cli.js")).href);
const { rebuildOracleSqlite, privacyScan } = await import(pathToFileURL(join(WORKER_ROOT, "scripts/gcp-fastpath-oracle-sqlite.mjs")).href);

/** readD1Migrations (vitest-pool-workers 0.18.8 dist/pool/index.mjs) over d43c8f92's directories. */
function readMigrations(directory) {
  const path = join(build.tree, "apps/worker", directory);
  const names = readdirSync(path).filter((name) => name.endsWith(".sql"));
  names.sort((a, b) => parseInt(a.split("_")[0]) - parseInt(b.split("_")[0]));
  return names.map((name) => ({ name, queries: unstable_splitSqlQuery(readFileSync(join(path, name), "utf8")) }));
}
const MIGRATIONS = Object.fromEntries(Object.entries(MIGRATION_DIRECTORIES).map(([key, dir]) => [key, readMigrations(dir)]));

// ------------------------------------------------------------- databases --

const DB_FILES = Object.freeze({
  USAGE_MONITOR_DB: "usage-monitor.sqlite", STORAGE_ANALYTICS_DB: "storage-analytics.sqlite",
  DELETION_LEDGER: "deletion-ledger.sqlite", STORAGE_ROUTING_DB: "storage-routing.sqlite",
  STORAGE_INGESTION_A: "storage-ingestion-a.sqlite", STORAGE_INGESTION_B: "storage-ingestion-b.sqlite",
});
const dbDir = join(options.workDir, "db");
let handles = null;
const db = {};
/** (Re)open every binding with SQLite's own clock pinned at `nowMs`, and prove the pin. */
async function openDatabases(nowMs, { create = false } = {}) {
  closeDatabases();
  handles = {};
  for (const [binding, file] of Object.entries(DB_FILES)) {
    handles[binding] = openSealedSqliteD1(join(dbDir, file), { create, pinnedNowMs: nowMs });
    db[binding] = handles[binding].database;
    const now = await db[binding].prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").first("now");
    if (now !== new Date(nowMs).toISOString()) throw new Error(`DENSE_ORACLE_SQLITE_CLOCK_UNPINNED:${binding}`);
  }
}
function closeDatabases() {
  if (!handles) return;
  for (const handle of Object.values(handles)) handle.close();
  handles = null;
}
const source = () => db.USAGE_MONITOR_DB, target = () => db.STORAGE_ANALYTICS_DB;
const bindings = () => ({ source: source(), target: target(), sourceId: SOURCE_ID, sourceNamespace: NAMESPACE });

/** d43c8f92 wrangler.jsonc top-level vars, as the vitest `env` carried them. */
const WRANGLER_VARS = createRequire(join(WORKER_ROOT, "package.json"))("jsonc-parser")
  .parse(readFileSync(join(build.tree, "apps/worker/wrangler.jsonc"), "utf8")).vars;
if (!WRANGLER_VARS || typeof WRANGLER_VARS !== "object") throw new Error("DENSE_ORACLE_WRANGLER_VARS");
const allowAll = Object.freeze({ limit: async () => ({ success: true }) });
const RATE_LIMITS = ["ENROLLMENT_RATE_LIMIT", "RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT", "PUBLIC_READ_RATE_LIMIT",
  "UPLOAD_AUTHORIZATION_RATE_LIMIT", "UPLOAD_PRINCIPAL_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT"];
/** The vitest `env` the Q-1 oracle spread into its runtime envs: wrangler vars,
 * the six D1 bindings, allow-all rate limiters and the migration lists. */
const baseEnv = () => ({ ...WRANGLER_VARS, ENVELOPE_PRIVATE_JWK: "", ENVELOPE_PUBLIC_JWK: "",
  ...Object.fromEntries(Object.keys(DB_FILES).map((binding) => [binding, db[binding]])),
  ...Object.fromEntries(RATE_LIMITS.map((name) => [name, allowAll])), ...MIGRATIONS });

// ------------------------------------------------------------------ corpus --

function loadQ1Corpus() {
  const index = JSON.parse(readFileSync(join(Q1_CORPUS_DIR, "corpus.json"), "utf8"));
  const owners = index.owners.map((owner) => {
    const shard = JSON.parse(readFileSync(join(Q1_CORPUS_DIR, index.shards[owner.key]), "utf8"));
    if (shard.key !== owner.key || shard.days.length !== owner.dayCount) throw new Error("DENSE_ORACLE_Q1_SHARD_INVALID");
    return { ...owner, days: shard.days };
  });
  const sha256 = createHash("sha256").update(JSON.stringify([index, ...owners.map((owner) =>
    JSON.parse(readFileSync(join(Q1_CORPUS_DIR, index.shards[owner.key]), "utf8")))])).digest("hex");
  return { ...index, owners, sha256 };
}
const q1 = loadQ1Corpus();
if (q1.schemaVersion !== "gcp-fastpath-oracle-corpus-v1" || q1.sourceCommit !== DENSE_ORACLE_SOURCE_COMMIT
  || q1.pinnedNow !== DENSE_CORPUS_PINNED_NOW) throw new Error("DENSE_ORACLE_Q1_CORPUS_INVALID");
const dense = options.corpus === "dense" ? createDenseOwner({ pricer: P.priceTelemetryUsageEvent, scale: options.scale }) : null;
const corpusOwners = [...q1.owners, ...(dense ? [dense.spec] : [])];
note("corpus", { owners: corpusOwners.map((owner) => owner.key), dense: dense?.spec ?? null });

// ---------------------------------------------------------------- seeding --
// A port of the Q-1 oracle's seeding (gcp-fastpath-oracle.spec.ts), unchanged
// except that owner e's days stream from the generator.

const coordinatesDigest = (label) => P.sha256Hex(`gcp-fastpath-oracle:${label}`);
async function uploadGrant(principal, label) {
  const envelopeDigest = await coordinatesDigest(`envelope:${label}`);
  const device = await P.authenticateDevice(source(), principal.authorization);
  const upload = await P.createDeviceUploadAuthorization(source(), device, envelopeDigest, 4096);
  const claimed = await P.claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 4096, contentType: "application/json" });
  return { envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId };
}
const r2Key = async (label) => `synthetic-oracle-${(await coordinatesDigest(`r2:${label}`)).slice(0, 40)}`;
const chunkRowId = async (label) => `chunk:${(await coordinatesDigest(`chunk:${label}`)).slice(0, 36)}`;
async function pinOwnerDigest(participantId, ownerDigest) {
  await source().prepare(`INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
    VALUES(?,?,'active') ON CONFLICT(participant_id) DO NOTHING`).bind(participantId, ownerDigest).run();
}

async function stageV11Days(principal, days) {
  const ready = [];
  for (const { day, records } of days) {
    const prepared = await P.makeV11Day(day, records, "synthetic-gcp-oracle-v11");
    await P.registerTelemetryV11DayManifest(source(), principal, prepared.manifest);
    for (const chunk of prepared.chunks) {
      const label = `v11:${principal.participantId}:${day}:${chunk.chunkId}:${chunk.manifestDigest}`;
      await P.persistTypedV11StagedChunk(source(), principal, chunk, {
        sourceNamespace: NAMESPACE, chunkRowId: await chunkRowId(label), r2Key: await r2Key(label),
        ...await uploadGrant(principal, label),
      });
    }
    ready.push(await P.registerTelemetryV11DayManifest(source(), principal, prepared.manifest));
  }
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

/** Q-1's stageV12Days over an iterable of days, so owner e streams one day at a time. */
async function stageV12Days(device, days, progress = () => {}) {
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
          parserVersion: "synthetic-gcp-oracle-v12", consent, records: rows });
      }
    }
    const manifest = { schemaVersion: "telemetry-day-manifest-v1.2", day,
      parserVersion: "synthetic-gcp-oracle-v12", consent,
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
    progress(day, chunks.length);
  }
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

async function insertV1Days(device, days) {
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
          chunkDigest: await P.sha256Hex(P.canonicalJson(page)), parserVersion: "synthetic-gcp-oracle-v1",
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
  }
}

async function createAccountlessPrincipal(owner) {
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
  if (enrolled.status !== 201) throw new Error(`DENSE_ORACLE_ACCOUNTLESS_ENROLLMENT:${enrolled.status}:${await enrolled.text()}`);
  // The route mints the participant ID with crypto.randomUUID(); pin that one
  // draw to the corpus value (Q-1's stack test) and prove it was the draw used.
  const pinned = owner.participantId.replace(/^participant:/u, "");
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
    if (owned.status !== 201) throw new Error(`DENSE_ORACLE_ACCOUNTLESS_OWNERSHIP:${owned.status}`);
  } finally { crypto.randomUUID = original; }
  const participantId = await source().prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
    .bind(deviceId).first("participant_id");
  if (participantId !== owner.participantId || pinnedDraws !== 1) throw new Error("DENSE_ORACLE_ACCOUNTLESS_PIN_FAILED");
  await pinOwnerDigest(participantId, owner.pinnedOwnerDigest);
  return { participantId, deviceId, authorization };
}

async function seedOwner(owner) {
  if (owner.kind === "accountless") {
    const principal = await createAccountlessPrincipal(owner);
    await stageV11Days(principal, owner.days);
    return principal.participantId;
  }
  const participantId = owner.participantId;
  if (owner.key === "c" || owner.key === "e") {
    const device = await P.createV11DeviceFixture(source(), { participantId });
    await pinOwnerDigest(participantId, owner.pinnedOwnerDigest);
    await P.grantTelemetryV12Consent(source(), device, P.telemetryV12RequiredConsent());
    if (owner.key === "c") await stageV12Days(device, owner.days);
    else {
      let chunks = 0;
      await stageV12Days(device, dense.days(), (day, count) => {
        chunks += count;
        if (day.endsWith("-01") || DENSE_CLASS_DAYS.X.includes(day)) note("seed-e", { day, chunks });
      });
    }
    return participantId;
  }
  const legacyDays = owner.days.flatMap((day) => day.v1Extra ? [{ day: day.day, records: day.v1Extra }] : []);
  if (owner.key === "d") {
    const v1 = await P.createV11DeviceFixture(source(), { participantId });
    await pinOwnerDigest(participantId, owner.pinnedOwnerDigest);
    await insertV1Days(v1, legacyDays);
    const v11 = await P.createV11DeviceFixture(source(), { participantId, grant: true });
    await stageV11Days(v11, owner.days);
    return participantId;
  }
  const device = await P.createV11DeviceFixture(source(), { participantId, grant: true });
  await pinOwnerDigest(participantId, owner.pinnedOwnerDigest);
  await stageV11Days(device, owner.days);
  const legacy = await P.createV11DeviceFixture(source(), { participantId });
  await insertV1Days(legacy, legacyDays);
  return participantId;
}

// ----------------------------------------------------------- convergence --

const SCHEDULE_ENV = () => ({
  STORAGE_ANALYTICS_MODE: "enabled", PUBLIC_ANALYTICS_MODE: "enabled",
  STORAGE_SOURCE_ID: SOURCE_ID, TELEMETRY_STORAGE_NAMESPACE: NAMESPACE,
  STORAGE_INGESTION_DB: source(), STORAGE_ANALYTICS_DB: target(), DELETION_LEDGER: db.DELETION_LEDGER,
});
/** Q-1's deployed refresh topology. */
const ANALYTICS_ENV = () => ({ ...SCHEDULE_ENV(), STORAGE_ANALYTICS_SHARED_FEATURES: "enabled",
  STORAGE_ANALYTICS_MODEL_BLOCKS: "enabled", PUBLICATION_LANE_EXTERNAL: "enabled" });
const PUBLICATION_ENV = () => ({ ...SCHEDULE_ENV(), PUBLICATION_LANE: "enabled",
  STORAGE_ANALYTICS_SHARED_FEATURES: "enabled", STORAGE_ANALYTICS_MODEL_BLOCKS: "disabled" });
const CACHE_ENV = () => ({ CACHE_RETENTION_BUILD: "enabled", CACHE_RETENTION_SHARED_FEATURES: "enabled",
  STORAGE_SOURCE_ID: SOURCE_ID, TELEMETRY_STORAGE_NAMESPACE: NAMESPACE,
  STORAGE_INGESTION_DB: source(), STORAGE_ANALYTICS_DB: target() });

/** Q-1's targetFingerprint: per-table counts plus revision/sequence sums. */
async function targetFingerprint() {
  const tables = (await target().prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name LIKE 'analytics_%' AND name NOT LIKE 'analytics_admin_%' ORDER BY name`).all()).results.map((row) => row.name);
  const counts = await target().batch(tables.map((name) => target().prepare(`SELECT COUNT(*) AS n FROM "${name}"`)));
  const extra = {
    dailyRevisions: "SELECT COALESCE(SUM(revision),0) AS n FROM analytics_community_daily_publications",
    modelRevisions: "SELECT COALESCE(SUM(revision),0) AS n FROM analytics_community_model_publications",
    previewRevision: "SELECT COALESCE(MAX(revision),0) AS n FROM analytics_community_graph_previews",
    cursor: "SELECT COALESCE(SUM(sequence),0) AS n FROM analytics_source_cursors",
    blocksComplete: "SELECT COUNT(*) AS n FROM analytics_model_blocks WHERE state='complete'",
    scan: "SELECT COALESCE(SUM(revision),0)+COALESCE(SUM(current_position),0)+COALESCE(SUM(history_position),0) AS n FROM analytics_community_graph_scan",
  };
  const extras = await target().batch(Object.values(extra).map((sql) => target().prepare(sql)));
  const value = (result) => result.results[0].n;
  return { ...Object.fromEntries(tables.map((name, index) => [name.replace(/^analytics_/u, ""), value(counts[index])])),
    ...Object.fromEntries(Object.keys(extra).map((key, index) => [`=${key}`, value(extras[index])])) };
}

/** Work progress: every analytics table's row count, the sum of each integer
 * column (revisions, generations, cursors, part counts, byte counts) other than
 * timestamps, and the total length of each text column. Checkpoint heads,
 * model blocks and shared-feature heads also contribute their exact keys,
 * generations, digests and states. Unchanged means no lane did any work.
 * Rotation state that moves on every pass whether or not anything is computed
 * is left out (measured on the Q-1 corpus after convergence): the graph scan
 * position, the shared-feature sweep cursor, the cache owner cursor, a work
 * selection's re-selection counter and claim tokens. */
const ROTATION_TABLES = new Set(["analytics_community_graph_scan", "analytics_shared_feature_sweep_cursor",
  "analytics_cache_retention_owner_cursor"]);
const ROTATION_COLUMNS = new Set(["analytics_community_graph_work_selection.selection_revision"]);
let progressQueries = null;
async function progressDigest() {
  if (progressQueries === null) {
    const tables = (await target().prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name LIKE 'analytics_%' AND name NOT LIKE 'analytics_admin_%' ORDER BY name`).all()).results.map((row) => row.name)
      .filter((table) => !ROTATION_TABLES.has(table));
    progressQueries = [];
    for (const table of tables) {
      const columns = (await target().prepare("SELECT name,type FROM pragma_table_info(?) ORDER BY cid").bind(table).all()).results;
      const terms = ["COUNT(*)"];
      for (const column of columns) {
        if (/(_ms|_at)$/u.test(column.name) || column.name === "claim_token"
          || ROTATION_COLUMNS.has(`${table}.${column.name}`)) continue;
        if (/INT/iu.test(column.type)) terms.push(`TOTAL("${column.name}")`);
        // Payload text is covered by its row, revision and byte-count columns;
        // reading every checkpoint part each tick would dominate the run.
        else if (/TEXT/iu.test(column.type) && !/_parts$/u.test(table) && !/^payload|_json$/u.test(column.name)) {
          terms.push(`TOTAL(length("${column.name}"))`);
        }
      }
      progressQueries.push(`SELECT '${table}' AS t,${terms.join("||','||")} AS v FROM "${table}"`);
    }
    progressQueries.push(`SELECT 'heads' AS t,COALESCE(group_concat(key_digest||':'||COALESCE(generation,'-')||':'||retired,','),'') AS v
      FROM (SELECT * FROM analytics_history_checkpoint_heads ORDER BY key_digest)`);
    progressQueries.push(`SELECT 'blocks' AS t,COALESCE(group_concat(job_key||':'||head_revision||':'||state||':'||COALESCE(checkpoint_digest,'-'),','),'') AS v
      FROM (SELECT * FROM analytics_model_blocks ORDER BY job_key)`);
    progressQueries.push(`SELECT 'features' AS t,COALESCE(group_concat(job_key||':'||head_revision||':'||state,','),'') AS v
      FROM (SELECT * FROM analytics_shared_feature_days ORDER BY job_key)`);
  }
  const hash = createHash("sha256");
  for (const sql of progressQueries) {
    const row = await target().prepare(sql).first();
    hash.update(`${row.t}=${row.v}\n`);
  }
  return hash.digest("hex");
}

const lanes = () => [
  ["analytics", (minuteMs) => P.runStorageAnalyticsSchedule(ANALYTICS_ENV(), { nowMs: minuteMs })],
  ["publication", (minuteMs) => P.runStoragePublicationSchedule(PUBLICATION_ENV(), { nowMs: minuteMs })],
  ["cache", (minuteMs) => P.runCacheRetentionDaySchedule(CACHE_ENV(), { nowMs: minuteMs })],
];

/** Intercept the Worker's JSON console lines: tally failures (Q-1's rules) and
 * the analytics lane's long-pass statement use; keep everything else quiet. */
function interceptConsole(failures, errors, laneStats) {
  console.log = (line) => {
    if (typeof line !== "string" || !line.startsWith("{")) return;
    try {
      const event = JSON.parse(line);
      if (event.event === "cache_retention_day_schedule") {
        const lane = `cache:${String(event.state)}:${String(event.reason)}${Number(event.refused) > 0 ? ":refused" : ""}`;
        failures.set(lane, (failures.get(lane) ?? 0) + 1);
        return;
      }
      if (event.event === "storage_analytics_long_schedule" || event.event === "storage_analytics_schedule") {
        const key = `${event.event}:${String(event.state)}:${String(event.reason)}`;
        laneStats.set(key, (laneStats.get(key) ?? 0) + 1);
      }
      const failure = event.event === "storage_analytics_lane_failure"
        ? `${String(event.event)}:${String(event.lane)}:${String(event.phase)}:${String(event.reason)}`
        : event.graphFailure ? `graphFailure:${String(event.graphFailure.phase)}:${String(event.graphFailure.reason)}` : null;
      if (failure) failures.set(failure, (failures.get(failure) ?? 0) + 1);
    } catch { /* not a schedule event */ }
  };
  console.error = (line) => { errors.push(String(line).slice(0, 2_000)); };
  console.info = () => {};
  console.warn = () => {};
}
function restoreConsole() { Object.assign(console, realConsole); }

async function converge() {
  const failures = new Map(), errors = [], laneStats = new Map(), laneMs = { analytics: 0, publication: 0, cache: 0 };
  let quiet = 0, previous = null, tick = 0, slowest = { ms: 0, tick: -1, lane: null };
  const started = performance.now();
  const progress = [];
  interceptConsole(failures, errors, laneStats);
  try {
    for (; tick < options.maxTicks && quiet < QUIET_TICKS; tick++) {
      const minuteMs = PINNED_NOW_MS + (tick + 1) * 60_000;
      for (const [lane, run] of lanes()) {
        const laneStarted = performance.now();
        try { await run(minuteMs); } catch (failure) {
          errors.push(`${lane}:${failure instanceof Error ? failure.message : String(failure)}`);
        }
        const ms = performance.now() - laneStarted;
        laneMs[lane] += ms;
        if (ms > slowest.ms) slowest = { ms: Math.round(ms), tick, lane };
      }
      const digest = await progressDigest();
      quiet = digest === previous ? quiet + 1 : 0;
      previous = digest;
      if (tick % 10 === 0 || quiet > 0) {
        const print = await targetFingerprint();
        const entry = { tick, ms: Math.round(performance.now() - started), quiet,
          daily: print.community_daily_publications, queue: print.community_daily_queue,
          results: print.community_graph_results, models: print.community_model_publications,
          preview: print["=previewRevision"], cacheValues: print.cache_retention_day_values,
          blocks: print["=blocksComplete"], heads: print.history_checkpoint_heads, parts: print.history_checkpoint_parts,
          features: print.shared_feature_days, errors: errors.length };
        progress.push(entry);
        if (tick % 25 === 0 || quiet === QUIET_TICKS) note("tick", { ...entry, laneMs: Object.fromEntries(Object.entries(laneMs)
          .map(([key, value]) => [key, Math.round(value)])), failures: Object.fromEntries(failures) });
      }
    }
  } finally { restoreConsole(); }
  return { ticks: tick, converged: quiet >= QUIET_TICKS, errors, failures: Object.fromEntries(failures),
    laneStats: Object.fromEntries(laneStats), laneMs: Object.fromEntries(Object.entries(laneMs).map(([k, v]) => [k, Math.round(v)])),
    slowestLane: slowest, progress: progress.slice(-60), elapsedMs: Math.round(performance.now() - started) };
}

/** Q-1's lease-expiry probe: advance the clock (JS and SQLite) in ten-minute
 * steps within the same UTC day and prove no published output moves. */
const CONVERGENCE_KEYS = new Set(["community_daily_publications", "community_daily_queue", "community_daily_heads",
  "community_daily_owners", "community_model_publications", "community_graph_previews",
  "community_graph_publication_state", "community_graph_results", "cache_retention_day_values",
  "cache_retention_day_bands", "cache_retention_day_marks", "source_cursors", "applied_events", "owner_state",
  "v11_owner_heads", "v11_day_references", "v1_chunk_values", "model_blocks", "=dailyRevisions", "=modelRevisions",
  "=previewRevision", "=cursor", "=blocksComplete"]);
async function leaseExpiryProbe() {
  const keys = (print) => Object.fromEntries(Object.entries(print).filter(([key]) => CONVERGENCE_KEYS.has(key)));
  const before = keys(await targetFingerprint());
  const changed = new Set(), errors = [];
  interceptConsole(new Map(), errors, new Map());
  try {
    for (let step = 1; step <= PROBE_STEPS; step++) {
      const nowMs = PINNED_NOW_MS + step * PROBE_STEP_MS;
      setPinnedNow(nowMs);
      await openDatabases(nowMs);
      const minuteMs = nowMs + (step % 2 === 1 ? 60_000 : 0);
      for (const [lane, run] of lanes()) {
        try { await run(minuteMs); } catch (failure) {
          errors.push(`${lane}:${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      const after = keys(await targetFingerprint());
      for (const key of Object.keys(after)) if (after[key] !== before[key]) changed.add(key);
    }
  } finally {
    restoreConsole();
    setPinnedNow(PINNED_NOW_MS);
    await openDatabases(PINNED_NOW_MS);
  }
  return { steps: PROBE_STEPS, stepMinutes: PROBE_STEP_MS / 60_000,
    through: new Date(PINNED_NOW_MS + PROBE_STEPS * PROBE_STEP_MS).toISOString(),
    changedOutputs: [...changed].sort(), errors: errors.length };
}

// ------------------------------------------------------------------ dumps --

/** One SQLite file in Q-1's dump format (gcp-fastpath-oracle.spec.ts dumpTables
 * and dumpText), streamed to `outPath`: schema, every table's rows ordered by
 * every column, blobs as {$blob}, integral reals as {$real}, sqlite_sequence. */
function dumpDatabase(path, outPath, header, filter = () => true) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END,name`).all();
    const fd = openSync(outPath, "w");
    const tables = [];
    const counts = {};
    const hash = createHash("sha256");
    let buffered = [], bufferedBytes = 0;
    const flush = () => { if (buffered.length > 0) { writeSync(fd, buffered.join("")); buffered = []; bufferedBytes = 0; } };
    const write = (text) => { buffered.push(text); bufferedBytes += text.length; hash.update(text); if (bufferedBytes > 4_000_000) flush(); };
    const kept = schema.filter((entry) => !entry.name.startsWith("_cf_") && !entry.name.startsWith("sqlite_")
      && filter(entry.tbl_name)).map(({ type, name, tbl_name, sql }) => ({ type, name, table: tbl_name, sql }));
    write(`{"header":${JSON.stringify(header)},\n "schema":[\n${kept.map((entry) => `  ${JSON.stringify(entry)}`).join(",\n")}\n ],\n`);
    const sequencePresent = database.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get();
    const sequences = sequencePresent ? database.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all()
      .map((row) => ({ name: row.name, seq: Number(row.seq) })) : [];
    write(` "sqliteSequence":${JSON.stringify(sequences)},\n "tables":[\n`);
    let firstTable = true;
    for (const entry of schema) {
      if (entry.type !== "table" || entry.name.startsWith("_cf_") || entry.name.startsWith("sqlite_") || !filter(entry.name)) continue;
      const columns = database.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(entry.name).map((row) => row.name);
      const rowCount = Number(database.prepare(`SELECT COUNT(*) AS n FROM "${entry.name}"`).get().n);
      if (rowCount === 0) continue;
      const select = database.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(",")},
        ${columns.map((column) => `typeof("${column}")`).join(",")} FROM "${entry.name}" ORDER BY ${columns.map((column) => `"${column}"`).join(",")}`);
      select.setReadBigInts(true);
      select.setReturnArrays(true);
      write(`${firstTable ? "" : ",\n"}  {"name":${JSON.stringify(entry.name)},"rowCount":${rowCount},\n   "sql":${JSON.stringify(entry.sql)},\n   "columns":${JSON.stringify(columns)},\n   "rows":[\n`);
      firstTable = false;
      let written = 0;
      for (const raw of select.iterate()) {
        const cells = columns.map((_, index) => {
          const value = raw[index], kind = raw[index + columns.length];
          if (kind === "blob") return { $blob: Buffer.from(value).toString("hex") };
          if (kind === "integer") {
            if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("DENSE_ORACLE_DUMP_INTEGER_UNSAFE");
            return Number(value);
          }
          if (kind === "real") return Number.isInteger(value) ? { $real: value } : value;
          return value;
        });
        write(`${written === 0 ? "" : ",\n"}    ${JSON.stringify(cells)}`);
        written++;
      }
      if (written !== rowCount) throw new Error("DENSE_ORACLE_DUMP_ROW_COUNT");
      write("\n   ]}");
      tables.push(entry.name);
      counts[entry.name] = rowCount;
    }
    write("\n ]\n}\n");
    flush();
    closeSync(fd);
    return { path: outPath, bytes: statSync(outPath).size, sha256: hash.digest("hex"), tables: tables.length,
      rows: Object.values(counts).reduce((n, count) => n + count, 0), rowCounts: counts,
      schemaSha256: createHash("sha256").update(JSON.stringify(kept)).digest("hex"),
      rowCountsSha256: createHash("sha256").update(JSON.stringify(counts)).digest("hex") };
  } finally { database.close(); }
}

// -------------------------------------------------------------- capture --

const today = new Date(PINNED_NOW_MS).toISOString().slice(0, 10);
const modelDates = Array.from({ length: MODEL_DATES }, (_, index) =>
  new Date(PINNED_NOW_MS - (MODEL_DATES - 1 - index) * 86_400_000).toISOString().slice(0, 10));
const pretty = (value) => `${JSON.stringify(value, null, 1)}\n`;
const sha256Text = (text) => createHash("sha256").update(text).digest("hex");

// ------------------------------------------------------------------- run --

const header = { oracle: "gcp-fastpath-dense", sourceCommit: DENSE_ORACLE_SOURCE_COMMIT, corpus: options.corpus,
  scale: options.scale, nowMs: PINNED_NOW_MS, seedClockMs: SEED_CLOCK_MS, synthetic: true,
  runtime: { node: process.version, sqlite: process.versions.sqlite, adapter: "cloud-run/sealed-sqlite-d1-adapter.mjs" } };

let seedMs, convergence, participants, sourceBeforeAnalysis;
if (prior === null) {
  await openDatabases(SEED_CLOCK_MS, { create: true });
  const seedStarted = performance.now();
  await P.initializeSharedAnalyticsCorpusDatabases(source(), target(), MIGRATIONS, SOURCE_ID, NAMESPACE);
  await (await import(pathToFileURL(join(HERE, "shims/cloudflare-test.mjs")).href))
    .applyD1Migrations(db.DELETION_LEDGER, MIGRATIONS.TEST_DELETION_LEDGER_MIGRATIONS);
  if (await source().prepare("SELECT state FROM telemetry_usage_correction_runtime WHERE id=1").first("state") !== q1.correctionRuntimeState) {
    throw new Error("DENSE_ORACLE_CORRECTION_STATE");
  }
  participants = new Map();
  for (const owner of corpusOwners) {
    const ownerStarted = performance.now();
    participants.set(owner.key, await seedOwner(owner));
    note("seeded-owner", { key: owner.key, ms: Math.round(performance.now() - ownerStarted) });
  }
  seedMs = Math.round(performance.now() - seedStarted);
  note("seeded", { seedMs, owners: corpusOwners.length });

  // Query-planner statistics for the seeded source (performance only): without
  // sqlite_stat1, SQLite joins v1.2 records through (manifest_id, stream) rather
  // than chunk_id inside the effective dependency query, which is quadratic in a
  // dense day's chunks (measured: 4.6 s against 0.47 s per execution for owner e
  // at --scale 0.1). Statistics change plans, not SQL results; sqlite_* tables are
  // outside the source dump; G0 reproduces the Q-1 golden with them in place.
  closeDatabases();
  const analyzeStarted = performance.now();
  const database = new DatabaseSync(join(dbDir, DB_FILES.USAGE_MONITOR_DB));
  try { database.exec("ANALYZE"); } finally { database.close(); }
  sourceBeforeAnalysis = sourceContentDigest();
  note("analyzed", { ms: Math.round(performance.now() - analyzeStarted), sourceDigest: sourceBeforeAnalysis });

  // Analysis, publication and reads see one frozen instant, JS and SQLite alike.
  setPinnedNow(PINNED_NOW_MS);
  await openDatabases(PINNED_NOW_MS);
  convergence = await converge();
  note("converged", { ticks: convergence.ticks, converged: convergence.converged, elapsedMs: convergence.elapsedMs,
    errors: convergence.errors.length, failures: convergence.failures, laneMs: convergence.laneMs,
    laneStats: convergence.laneStats, slowestLane: convergence.slowestLane });
} else {
  if (JSON.stringify(prior.corpus.owners) !== JSON.stringify(corpusOwners.map((owner) => owner.key))
    || JSON.stringify(prior.corpus.dense) !== JSON.stringify(dense?.spec ?? null)) throw new Error("DENSE_ORACLE_RESUME_CORPUS_MISMATCH");
  seedMs = prior.seeded.seedMs;
  participants = new Map(corpusOwners.map((owner) => [owner.key, owner.participantId]));
  sourceBeforeAnalysis = prior.analyzed?.sourceDigest ?? null;
  convergence = { ticks: prior.converged.ticks, converged: true, elapsedMs: prior.converged.elapsedMs,
    errors: Array.from({ length: prior.converged.errors }, () => "recorded in the resumed run"),
    failures: prior.converged.failures, laneMs: prior.converged.laneMs, laneStats: prior.converged.laneStats ?? null,
    slowestLane: prior.converged.slowestLane ?? null, progress: [], resumedFrom: options.resume };
  setPinnedNow(PINNED_NOW_MS);
  await openDatabases(PINNED_NOW_MS);
  note("resumed", { from: options.resume, ticks: convergence.ticks });
}
const ownerPage = await P.readStorageCommunityOwnerPage(source());
if (ownerPage.length !== corpusOwners.length) throw new Error("DENSE_ORACLE_OWNER_PAGE");
const flags = new Map(ownerPage.map((owner) => [owner.participantId, owner]));
for (const owner of corpusOwners) {
  if (!flags.has(participants.get(owner.key))) throw new Error("DENSE_ORACLE_PARTICIPANT_UNPINNED");
}

function sourceContentDigest() {
  // Every source table's rows, in a stable order, through a private read-only connection.
  const database = new DatabaseSync(join(dbDir, DB_FILES.USAGE_MONITOR_DB), { readOnly: true });
  try {
    const hash = createHash("sha256");
    for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const columns = database.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name).map((row) => `"${row.name}"`);
      const statement = database.prepare(`SELECT ${columns.join(",")} FROM "${name}" ORDER BY ${columns.join(",")}`);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      hash.update(`${name}\n`);
      for (const row of statement.iterate()) hash.update(JSON.stringify(row, (_, value) => typeof value === "bigint" ? `${value}n`
        : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value));
    }
    return hash.digest("hex");
  } finally { database.close(); }
}

// Direct publisher calls on the converged state (expected: unchanged).
const publishedModelDays = (await target().prepare(`SELECT day FROM analytics_community_model_publications
  WHERE source_id=? ORDER BY day`).bind(SOURCE_ID).all()).results.map((row) => row.day);
const directModel = {};
interceptConsole(new Map(), [], new Map());
try {
  for (const day of publishedModelDays) directModel[day] = (await P.publishStorageCommunityModelDay(bindings(), { day })).state;
} finally { restoreConsole(); }
const directPreview = await P.publishStorageCommunityGraphPreview(bindings());

const nowMs = Date.now();
const publicEnv = { ...baseEnv(), ENVIRONMENT: "synthetic-development", TELEMETRY_STORAGE_MODE: "typed",
  TELEMETRY_STORAGE_NAMESPACE: NAMESPACE, ANALYTICS_DB: target() };
const fromDay = DENSE_CORPUS_DAY_LIST[0], throughDay = DENSE_CORPUS_DAY_LIST.at(-1);
const response = await P.handleRequest(new Request(`https://oracle.example.test/api/v1/community/daily?from=${fromDay}&to=${throughDay}`), publicEnv);
if (response.status !== 200) throw new Error(`DENSE_ORACLE_PUBLIC_READ:${response.status}`);
const body = await response.json();
const preview = await P.readPublishedStorageCommunityAdminPreview(bindings(), nowMs);
const previewRow = await target().prepare(`SELECT revision,method,generated_at,inputs_current,snapshot_source_epoch
  FROM analytics_community_graph_previews WHERE source_id=?`).bind(SOURCE_ID).first();

const dailyRouting = (await target().prepare(`SELECT owner_digest,source_format,COUNT(*) AS days
  FROM analytics_community_daily_owners WHERE source_id=? GROUP BY owner_digest,source_format ORDER BY owner_digest,source_format`)
  .bind(SOURCE_ID).all()).results;
const graphRouting = (await target().prepare(`SELECT owner_digest,metric,source_kind,COUNT(*) AS results
  FROM analytics_community_graph_results WHERE source_id=? GROUP BY owner_digest,metric,source_kind
  ORDER BY owner_digest,metric,source_kind`).bind(SOURCE_ID).all()).results;
const publishedDays = body.days.map((day) => day.day);
const roster = corpusOwners.map((owner) => {
  const page = flags.get(participants.get(owner.key));
  const effective = page.hasEffective;
  return { key: owner.key, kind: owner.kind, planType: owner.planType, storage: owner.storage,
    ownerDigest: page.ownerDigest, pinnedOwnerDigest: owner.pinnedOwnerDigest,
    flags: { hasV1: page.hasV1, hasV11: page.hasV11, hasV12: page.hasV12, hasLegacy: page.hasLegacy, hasEffective: effective },
    expectedSourceRouting: effective ? "effective" : page.hasV11 ? "v1.1" : page.hasV1 ? page.hasLegacy ? "mixed" : "v1" : "v0.2",
    dailySourceFormats: dailyRouting.filter((row) => row.owner_digest === page.ownerDigest)
      .map(({ source_format, days }) => ({ sourceFormat: source_format, days })),
    graphSources: graphRouting.filter((row) => row.owner_digest === page.ownerDigest)
      .map(({ metric, source_kind, results }) => ({ metric, sourceKind: source_kind, results })) };
});
const digestKey = new Map(roster.map((owner) => [owner.ownerDigest, owner.key]));
const ownerKey = (digest) => digestKey.get(digest) ?? "unknown";
const blocks = (await target().prepare(`SELECT owner_digest,state,COUNT(*) AS n FROM analytics_model_blocks
  WHERE source_id=? GROUP BY owner_digest,state ORDER BY owner_digest,state`).bind(SOURCE_ID).all()).results
  .map(({ owner_digest, ...row }) => ({ owner: ownerKey(owner_digest), ...row }));
const cacheMarks = (await target().prepare(`SELECT owner_digest,source_layout,COUNT(*) AS n,MIN(day) AS first,MAX(day) AS last
  FROM analytics_cache_retention_day_marks WHERE source_id=? GROUP BY owner_digest,source_layout ORDER BY owner_digest`)
  .bind(SOURCE_ID).all()).results.map(({ owner_digest, ...row }) => ({ owner: ownerKey(owner_digest), ...row }));
const missingModelDates = modelDates.filter((day) => !publishedModelDays.includes(day));
const modelResultOwners = new Map();
for (const row of (await target().prepare(`SELECT owner_digest,day FROM analytics_community_graph_results
  WHERE source_id=? AND metric='model' ORDER BY day,owner_digest`).bind(SOURCE_ID).all()).results) {
  modelResultOwners.set(row.day, [...(modelResultOwners.get(row.day) ?? []), ownerKey(row.owner_digest)].sort());
}
// Routing evidence: shared-feature heads per owner and state, model-block
// policies, checkpoint keys, daily owner formats.
const sharedFeatureRouting = (await target().prepare(`SELECT owner_digest,state,COUNT(*) AS n,MIN(day) AS first,MAX(day) AS last
  FROM analytics_shared_feature_days WHERE source_id=? GROUP BY owner_digest,state ORDER BY owner_digest,state`)
  .bind(SOURCE_ID).all()).results.map(({ owner_digest, ...row }) => ({ owner: ownerKey(owner_digest), ...row }));
const sharedFeatureRefusedDays = (await target().prepare(`SELECT owner_digest,day FROM analytics_shared_feature_days
  WHERE source_id=? AND state='refused' ORDER BY owner_digest,day`).bind(SOURCE_ID).all()).results
  .reduce((map, row) => ({ ...map, [ownerKey(row.owner_digest)]: [...(map[ownerKey(row.owner_digest)] ?? []), row.day] }), {});
const checkpointHeads = (await target().prepare(`SELECT COUNT(*) AS heads,SUM(retired) AS retired FROM analytics_history_checkpoint_heads`).first());
const checkpointParts = (await target().prepare(`SELECT COUNT(*) AS parts,COALESCE(SUM(payload_bytes),0) AS bytes,
  COALESCE(MAX(part_index),-1) AS maxPartIndex FROM analytics_history_checkpoint_parts`).first());
const cacheRetention = body.cacheRetention;
note("captured", { publishedDays: publishedDays.length, modelDays: publishedModelDays.length,
  allowanceState: body.allowanceState, preview: preview !== null, missingModelDates: missingModelDates.length });

const probe = prior === null ? await leaseExpiryProbe()
  : Object.fromEntries(Object.entries(prior.probe).filter(([key]) => key !== "event" && key !== "wallMs"));
if (prior === null) note("probe", probe);
const sourceAfterAnalysis = sourceContentDigest();

// Per-owner Tier N results (graph results and daily owner values).
const tierNGraph = (await target().prepare(`SELECT owner_digest,metric,day,source_kind,payload_json,payload_sha256
  FROM analytics_community_graph_results WHERE source_id=? ORDER BY owner_digest,metric,day`).bind(SOURCE_ID).all()).results;
const dailyOwnerRows = (await target().prepare(`SELECT owner_digest,day,source_format,complete,values_json
  FROM analytics_community_daily_owners WHERE source_id=? ORDER BY owner_digest,day`).bind(SOURCE_ID).all()).results;
const cacheValueRows = (await target().prepare(`SELECT v.owner_digest,v.day,v.method_version,v.model,v.effort,v.adjacencies,v.sessions,
  m.source_layout,b.band,b.adjacencies AS band_adjacencies,b.reused_more_than_half,b.matched_or_exceeded,b.unordered_ties,
  b.excluded_insufficient_evidence,b.excluded_context_contracted,b.sessions AS band_sessions
  FROM analytics_cache_retention_day_values v JOIN analytics_cache_retention_day_marks m ON m.mark_key=v.mark_key
  JOIN analytics_cache_retention_day_bands b ON b.value_key=v.value_key
  WHERE v.source_id=? ORDER BY v.owner_digest,v.day,m.source_layout,v.model,v.effort,b.band`).bind(SOURCE_ID).all()).results;

const queuedDailyDays = (await target().prepare(`SELECT day FROM analytics_community_daily_queue WHERE source_id=? ORDER BY day`)
  .bind(SOURCE_ID).all()).results.map((row) => row.day);
const finalFingerprint = await targetFingerprint();

// ----------------------------------------------------------------- Tier F --
closeDatabases();
let forced = {};
let forcedCost = null;
/** `withheld`: every model date without a Tier N result for that owner (the
 * dates production withholds), plus a fixed sample of dates that have one
 * (first, last and three between) for the Tier N = Tier F check. */
const FORCED_SAMPLE = [modelDates[0], modelDates[17], modelDates[34], modelDates[51], modelDates.at(-1)];
const forcedDatesFor = (key) => {
  if (options.forcedNative === "all") return modelDates;
  const digest = roster.find((owner) => owner.key === key)?.ownerDigest;
  const have = new Set(tierNGraph.filter((row) => row.owner_digest === digest && row.metric === "model").map((row) => row.day));
  return modelDates.filter((day) => !have.has(day) || FORCED_SAMPLE.includes(day));
};
if (options.forcedNative !== "none") {
  interceptConsole(new Map(), [], new Map());
  try {
    const run = await runForcedNative({ P, openSealedSqliteD1, dbDir, scratchDir: join(options.workDir, "scratch-forced"),
      files: { source: DB_FILES.USAGE_MONITOR_DB, target: DB_FILES.STORAGE_ANALYTICS_DB },
      bindings: { sourceId: SOURCE_ID, sourceNamespace: NAMESPACE }, nowMs: PINNED_NOW_MS, today, modelDates,
      ownerKeyOf: ownerKey, datesFor: forcedDatesFor, keepScratch: options.keepScratch,
      onOwner: (key, entry) => {
        restoreConsole();
        note("forced-owner", { key, fits: entry.fits.state,
          model: Object.values(entry.model).reduce((n, value) => ({ ...n, [value.state]: (n[value.state] ?? 0) + 1 }), {}),
          ms: Object.values(entry.model).reduce((n, value) => n + value.cost.ms, entry.fits.cost.ms) });
        interceptConsole(new Map(), [], new Map());
      } });
    forced = run.results;
    forcedCost = run.cost;
  } finally { restoreConsole(); }
}

// --------------------------------------------------------- source dump --
const dumpDir = join(options.workDir, "dump");
mkdirSync(dumpDir, { recursive: true });
const usageDump = dumpDatabase(join(dbDir, DB_FILES.USAGE_MONITOR_DB), join(dumpDir, "usage-monitor-db.json"),
  { ...header, database: "USAGE_MONITOR_DB", reproducible: ["all"] });
note("dumped", { bytes: usageDump.bytes, sha256: usageDump.sha256, rows: usageDump.rows });
const publishedTables = new Set(["analytics_community_daily_publications", "analytics_community_model_publications",
  "analytics_community_graph_previews", "analytics_community_graph_publication_state",
  "analytics_cache_retention_day_values", "analytics_cache_retention_day_bands"]);
const analyticsDump = dumpDatabase(join(dbDir, DB_FILES.STORAGE_ANALYTICS_DB), join(dumpDir, "storage-analytics-db.json"),
  { ...header, database: "STORAGE_ANALYTICS_DB", scope: "published-rows-only", runSpecificColumns: RUN_SPECIFIC_ANALYTICS_COLUMNS },
  (name) => publishedTables.has(name));
// The rehearsal loader (rebuildOracleSqlite) must accept the dump: rebuild and seal it.
let sealed = null;
const V8_MAX_STRING = 536_870_888;
if (usageDump.bytes < V8_MAX_STRING) {
  const sealedPath = join(dumpDir, "usage-monitor-db.sqlite");
  rmSync(sealedPath, { force: true });
  const receipt = rebuildOracleSqlite(join(dumpDir, "usage-monitor-db.json"), sealedPath);
  sealed = { sha256: receipt.sha256, bytes: receipt.bytes, integrityCheck: receipt.integrityCheck,
    sealReady: receipt.sealReady, populatedTables: receipt.populatedTables,
    missingSealedTables: receipt.sealedSourceTables.missing, node: process.version };
  note("sealed", sealed);
} else {
  sealed = { refused: "dump_exceeds_v8_string_limit", bytes: usageDump.bytes };
  note("sealed", sealed);
}

// ------------------------------------------------------------- golden --
const publishedRowDigests = {};
{
  const dump = JSON.parse(readFileSync(join(dumpDir, "storage-analytics-db.json"), "utf8"));
  for (const table of dump.tables) {
    const drop = new Set(RUN_SPECIFIC_ANALYTICS_COLUMNS[table.name] ?? []);
    const keep = table.columns.flatMap((column, index) => drop.has(column) ? [] : [index]);
    const rows = table.rows.map((row) => JSON.stringify(keep.map((index) => row[index]))).sort();
    publishedRowDigests[table.name] = { rows: table.rowCount,
      sha256: sha256Text(JSON.stringify({ columns: keep.map((index) => table.columns[index]), rows })) };
  }
}

const ownerResults = {};
for (const owner of roster) {
  const graph = tierNGraph.filter((row) => row.owner_digest === owner.ownerDigest);
  const tierNFits = graph.find((row) => row.metric === "fits" && row.day === today) ?? null;
  const forcedOwner = forced[owner.key] ?? null;
  const model = {};
  for (const day of modelDates) {
    const tierN = graph.find((row) => row.metric === "model" && row.day === day) ?? null;
    const f = forcedOwner?.model[day] ?? null;
    model[day] = {
      tierN: tierN ? { sourceKind: tierN.source_kind, sha256: sha256Text(tierN.payload_json) } : null,
      forced: f === null ? null : f.state === "complete" ? { sourceKind: f.sourceKind, sha256: sha256Text(f.payload),
        result: JSON.parse(f.payload) } : { state: f.state, reason: f.reason ?? f.code, failure: f.failure ?? null },
      equal: tierN && f?.state === "complete" ? tierN.payload_json === f.payload : null,
    };
  }
  const daily = Object.fromEntries(dailyOwnerRows.filter((row) => row.owner_digest === owner.ownerDigest)
    .map((row) => [row.day, { sourceFormat: row.source_format, complete: row.complete, values: JSON.parse(row.values_json) }]));
  ownerResults[owner.key] = {
    ownerDigest: owner.ownerDigest, routing: owner.expectedSourceRouting,
    fits: {
      tierN: tierNFits ? { sourceKind: tierNFits.source_kind, sha256: sha256Text(tierNFits.payload_json),
        fits: JSON.parse(tierNFits.payload_json) } : null,
      forced: forcedOwner === null ? null : forcedOwner.fits.state === "complete" ? { sourceKind: forcedOwner.fits.sourceKind,
        sha256: sha256Text(forcedOwner.fits.payload), fits: JSON.parse(forcedOwner.fits.payload) }
        : { state: forcedOwner.fits.state, reason: forcedOwner.fits.reason ?? forcedOwner.fits.code },
      equal: tierNFits && forcedOwner?.fits.state === "complete" ? tierNFits.payload_json === forcedOwner.fits.payload : null,
    },
    model, daily,
  };
}
// Native-path page counts: the effective reader pages each observed day's
// quota and usage streams at 200 rows, so a window costs the sum of
// ceil(rows/200) over its days for each stream.
const denseSummary = dense ? summarizeDenseCorpus({ P, owner: dense, scale: options.scale }) : null;
const dayCounts = new Map(q1.owners.map((owner) => [owner.key, new Map(owner.days.map((day) => [day.day, {
  usage: day.records.usage.length + (day.v1Extra?.usage.length ?? 0), quota: day.records.quota.length + (day.v1Extra?.quota.length ?? 0) }]))]));
if (denseSummary) dayCounts.set("e", new Map(denseSummary.days.map((day) => [day.day, { usage: day.usage, quota: day.quota }])));
const windowPages = (key, day) => {
  const counts = dayCounts.get(key);
  const window = P.modelHistoryWindow(day);
  let usage = 0, quota = 0, rows = 0;
  for (let at = Date.parse(`${window.fromDay}T00:00:00.000Z`); at <= Date.parse(`${window.day}T00:00:00.000Z`); at += 86_400_000) {
    const value = counts?.get(new Date(at).toISOString().slice(0, 10));
    if (!value) continue;
    usage += Math.ceil(value.usage / 200); quota += Math.ceil(value.quota / 200); rows += value.usage;
  }
  return { usagePages: usage, quotaPages: quota, usageRows: rows };
};
const forcedSummary = Object.fromEntries(Object.entries(forced).map(([key, value]) => [key, {
  pages: { fits: windowPages(key, today), modelDates: Object.keys(value.model).reduce((n, day) => {
    const pages = windowPages(key, day);
    return { usagePages: n.usagePages + pages.usagePages, quotaPages: n.quotaPages + pages.quotaPages, dates: n.dates + 1 };
  }, { usagePages: 0, quotaPages: 0, dates: 0 }) },
  fits: value.fits.state, model: Object.values(value.model).reduce((n, item) => ({ ...n, [item.state]: (n[item.state] ?? 0) + 1 }), {}),
  failures: Object.fromEntries(Object.entries(value.model).filter(([, item]) => item.state !== "complete")
    .map(([day, item]) => [day, item.reason ?? item.code])),
  cost: { ms: Object.values(value.model).reduce((n, item) => n + item.cost.ms, value.fits.cost.ms),
    statements: Object.values(value.model).reduce((n, item) => n + item.cost.statements, value.fits.cost.statements),
    invocations: Object.values(value.model).reduce((n, item) => n + item.cost.invocations, value.fits.cost.invocations),
    maxCheckpointBytes: Math.max(value.fits.cost.maxCheckpointBytes, ...Object.values(value.model).map((item) => item.cost.maxCheckpointBytes)),
    fits: value.fits.cost },
}]));
const tierNEqualsForced = Object.fromEntries(Object.entries(ownerResults).map(([key, value]) => [key, {
  fits: value.fits.equal,
  modelCompared: Object.values(value.model).filter((item) => item.equal !== null).length,
  modelEqual: Object.values(value.model).filter((item) => item.equal === true).length,
}]));

const cacheByOwnerDay = {};
for (const row of cacheValueRows) {
  const key = `${ownerKey(row.owner_digest)}:${row.day}`;
  (cacheByOwnerDay[key] ??= []).push({ layout: row.source_layout, method: row.method_version, model: row.model,
    effort: row.effort, band: row.band, adjacencies: row.band_adjacencies, reusedMoreThanHalf: row.reused_more_than_half,
    matchedOrExceeded: row.matched_or_exceeded, unorderedTies: row.unordered_ties,
    excludedInsufficientEvidence: row.excluded_insufficient_evidence,
    excludedContextContracted: row.excluded_context_contracted, sessions: row.band_sessions });
}

const corpusSummary = { schemaVersion: options.corpus === "dense" ? DENSE_CORPUS_SCHEMA_VERSION : q1.schemaVersion,
  q1: { path: "apps/worker/analytics-v2-test/golden/corpus/corpus.json", sha256: q1.sha256, recordCounts: q1.recordCounts },
  dense: dense ? { generator: "apps/worker/scripts/gcp-fastpath-dense-oracle/dense-corpus.mjs", scale: options.scale,
    spec: dense.spec, classes: Object.fromEntries(["Q", "X", "H", "M", "L"].map((kind) =>
      [kind, DENSE_CORPUS_DAY_LIST.filter((day) => denseDayClass(day) === kind).length])) } : null };

const manifest = {
  schemaVersion: "gcp-fastpath-dense-oracle-manifest-v1",
  oracle: "production-code (d43c8f92 Worker modules bundled for Node over the sealed SQLite D1 adapter; D1 seeded through admission helpers; scheduled entry points driven to convergence; forced native references)",
  sourceCommit: DENSE_ORACLE_SOURCE_COMMIT,
  build: { verifiedFiles: build.verifiedFiles, listingSha256: build.listingSha256, entrySha256: build.entry.sha256,
    esbuildVersion: build.esbuildVersion, dependencies: build.dependencies },
  corpus: corpusSummary,
  nowMs, now: new Date(nowMs).toISOString(), pinnedNow: DENSE_CORPUS_PINNED_NOW, seedClock: new Date(SEED_CLOCK_MS).toISOString(),
  correctionRuntimeState: q1.correctionRuntimeState,
  sqliteStatistics: "ANALYZE on the seeded source before analysis (query plans only; sqlite_* tables are not dumped)",
  topology: {
    analytics: { STORAGE_ANALYTICS_SHARED_FEATURES: "enabled", STORAGE_ANALYTICS_MODEL_BLOCKS: "enabled", PUBLICATION_LANE_EXTERNAL: "enabled" },
    publication: { PUBLICATION_LANE: "enabled", STORAGE_ANALYTICS_SHARED_FEATURES: "enabled", STORAGE_ANALYTICS_MODEL_BLOCKS: "disabled" },
    cache: { CACHE_RETENTION_BUILD: "enabled", CACHE_RETENTION_SHARED_FEATURES: "enabled", shards: 1 },
    graphDayProjection: "disabled (deployment default)",
    basis: "Q-1's reading of the production-scheduled-analytics-deploy refresh plan at d43c8f92; not verified against live configuration",
  },
  convergence: { converged: convergence.converged, scheduleErrors: convergence.errors.length, quietTicks: QUIET_TICKS,
    rule: "progress digest (counts, integer sums, text lengths, checkpoint/block/feature heads of every analytics table) unchanged for quietTicks consecutive ticks" },
  directPublisherCalls: { preview: directPreview.state, modelDays: Object.values(directModel).reduce(
    (n, state) => ({ ...n, [state]: (n[state] ?? 0) + 1 }), {}) },
  owners: roster,
  routingEvidence: { sharedFeatures: sharedFeatureRouting, sharedFeatureRefusedDays,
    checkpointHeads, checkpointParts, modelBlocks: blocks },
  modelPublications: {
    expectedDates: modelDates.length, published: publishedModelDays.length, missing: missingModelDates,
    ownersWithResultOnMissingDates: Object.fromEntries(missingModelDates.map((day) => [day, modelResultOwners.get(day) ?? []])),
  },
  conflict: { owner: q1.conflict.owner, occurrenceId: q1.conflict.occurrenceId, days: q1.conflict.days,
    publishedDays: q1.conflict.days.filter((day) => publishedDays.includes(day)) },
  duplicate: q1.duplicate,
  response: { status: response.status, cacheControl: response.headers.get("cache-control"),
    schemaVersion: body.schemaVersion, allowanceState: body.allowanceState, allowanceReadState: body.allowanceReadState,
    publishedDays: publishedDays.length, modelPublicationDays: publishedModelDays.length, previewRow },
  forcedNative: options.forcedNative !== "none" ? { scope: options.forcedNative, sampleDates: FORCED_SAMPLE, configuration: "computeStorageGraphResult(preparedFold:false, preparedEffectiveUsage:false, persistResult:false, no sharedFeatures), re-invoked at production's 1,000-statement invocation meter until complete, on a scratch copy with every graph cache cleared and a read-only source; production's model-block fallback",
    owners: forcedSummary, tierNEqualsForced } : null,
  cacheRetention: { marks: cacheMarks,
    windowAdjacencies: Object.fromEntries((cacheRetention?.windows ?? []).map((window) =>
      [window.window, window.bands.reduce((n, band) => n + band.adjacencies, 0)])) },
  parityBasis: { runSpecificColumns: RUN_SPECIFIC_ANALYTICS_COLUMNS, publishedRowDigests },
  leaseExpiryProbe: probe,
  sourceDump: { tables: usageDump.tables, rows: usageDump.rows, schemaSha256: usageDump.schemaSha256,
    rowCountsSha256: usageDump.rowCountsSha256, jsonBytes: usageDump.bytes, jsonSha256: usageDump.sha256,
    sealedSqlite: sealed, sourceUnchangedByAnalysis: sourceBeforeAnalysis === null ? null : sourceBeforeAnalysis === sourceAfterAnalysis,
    reproduce: `node --max-old-space-size=16384 apps/worker/scripts/gcp-fastpath-dense-oracle/oracle.mjs --work-dir <dir> --corpus ${options.corpus}${options.scale === 1 ? "" : ` --scale ${options.scale}`}` },
};
const diagnostics = { header: { ...header, seedMs, convergenceMs: convergence.elapsedMs, forcedCost,
  wallMs: Math.round(performance.now() - wallStarted), randomBytesDrawn: runtime.randomBytesDrawn() },
  convergence, directPreview, directModel, cacheMarks, graphRouting, blocks,
  queuedDailyDays, finalFingerprint };

const outDir = options.goldenOut ?? join(options.workDir, "golden");
mkdirSync(outDir, { recursive: true });
const files = {
  "community-daily-response.json": pretty(body),
  "preview.json": pretty(preview),
  "manifest.json": pretty(manifest),
  "owner-results.json": pretty({ schemaVersion: "gcp-fastpath-dense-owner-results-v1", sourceCommit: DENSE_ORACLE_SOURCE_COMMIT,
    nowMs, today, modelDates, owners: ownerResults }),
  "cache-owner-days.json": pretty({ schemaVersion: "gcp-fastpath-dense-cache-owner-days-v1", basis: "Tier N cache-retention values as production's interleaved lanes left them (see manifest.cacheRetention.marks)", ownerDays: cacheByOwnerDay }),
};
if (denseSummary) {
  if (denseSummary.failures.length > 0) note("corpus-gate-failures", { failures: denseSummary.failures });
  files["dense-corpus.json"] = pretty(denseSummary);
}
// SOURCE.json: what produced these files, so a reader can regenerate and check them.
files["SOURCE.json"] = pretty({
  schemaVersion: "gcp-fastpath-dense-golden-source-v1",
  note: "Produced by the dense production-code oracle (Tier N scheduled lanes and Tier F forced native) running d43c8f92's Worker code unmodified under Node over sealed SQLite files. Regenerate with the command below; never edit by hand.",
  sourceCommit: DENSE_ORACLE_SOURCE_COMMIT,
  command: manifest.sourceDump.reproduce + (options.goldenOut ? ` --golden-out ${relative(REPO_ROOT, options.goldenOut)}` : ""),
  oracleFiles: LOADED_BLOBS,
  adapter: { path: "apps/worker/cloud-run/sealed-sqlite-d1-adapter.mjs", blob: ADAPTER_BLOB },
  resumedFrom: prior === null ? null : "a converged run of the same oracle files, corpus and scale (--resume)",
  q1Corpus: { path: "apps/worker/analytics-v2-test/golden/corpus/", sha256: q1.sha256 },
  build: { verifiedFiles: build.verifiedFiles, listingSha256: build.listingSha256, bundleSha256: build.bundle.sha256,
    esbuildVersion: build.esbuildVersion, dependencies: build.dependencies },
  runtime: header.runtime,
  dump: { note: "Not committed when larger than ~50 MB; the command above regenerates it byte for byte into <work-dir>/dump/.",
    usageMonitorJson: { bytes: usageDump.bytes, sha256: usageDump.sha256 },
    usageMonitorSealedSqlite: sealed,
    storageAnalyticsJson: { bytes: analyticsDump.bytes, sha256: analyticsDump.sha256 } },
});
for (const [name, text] of Object.entries(files)) writeFileSync(join(outDir, name), text);
writeFileSync(join(options.workDir, "diagnostics.json"), pretty(diagnostics));
const privacy = privacyScan([join(outDir, "community-daily-response.json"), join(outDir, "preview.json")]);
note("golden", { outDir, files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: sha256Text(text) }])),
  privacy: { ok: privacy.ok, findings: privacy.findingCount } });

if (options.verifyAgainst) {
  // Byte equality of every golden file present in the reference directory; for
  // a Q-1 golden (G0) also its publishedRowDigests and sourceDumpShape.
  const verdict = {};
  for (const name of Object.keys(files)) {
    const path = join(options.verifyAgainst, name);
    if (existsSync(path)) verdict[name] = readFileSync(path, "utf8") === files[name];
  }
  const reference = JSON.parse(readFileSync(join(options.verifyAgainst, "manifest.json"), "utf8"));
  if (reference.schemaVersion === "gcp-fastpath-oracle-manifest-v1") {
    delete verdict["manifest.json"];
    const q1Digests = reference.parityBasis.publishedRowDigests;
    verdict.publishedRowDigests = Object.fromEntries(Object.keys({ ...q1Digests, ...publishedRowDigests }).map((table) =>
      [table, JSON.stringify(q1Digests[table] ?? null) === JSON.stringify(publishedRowDigests[table] ?? null)]));
    verdict.sourceDumpShape = { tables: reference.sourceDumpShape.tables === usageDump.tables,
      rows: reference.sourceDumpShape.rows === usageDump.rows,
      schemaSha256: reference.sourceDumpShape.schemaSha256 === usageDump.schemaSha256,
      rowCountsSha256: reference.sourceDumpShape.rowCountsSha256 === usageDump.rowCountsSha256 };
    verdict.modelPublications = JSON.stringify(reference.modelPublications.missing) === JSON.stringify(missingModelDates);
    verdict.cacheMarks = JSON.stringify(reference.parityBasis.cacheRetention.marks)
      === JSON.stringify([...cacheMarks].sort((left, right) => `${left.owner}:${left.source_layout}`.localeCompare(`${right.owner}:${right.source_layout}`)));
    verdict.cacheWindowAdjacencies = JSON.stringify(reference.parityBasis.cacheRetention.windowAdjacencies)
      === JSON.stringify(manifest.cacheRetention.windowAdjacencies);
    verdict.previewRow = JSON.stringify(reference.response.previewRow) === JSON.stringify(previewRow);
  }
  writeFileSync(join(options.workDir, "verify.json"), pretty(verdict));
  note("verify", verdict);
}
closeSync(logFd);
