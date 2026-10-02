// W2-SEAL fixtures: a synthetic EP-8 fence receipt pair (apply + verify) in
// a private receipts directory, accepted by cloudflare-writer-fence.mjs's own
// consumer-side reader; a barrier proof as the owner would capture it; and an
// owner 0600 inventory. Every id is synthetic; no provider is contacted.

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_INGESTION_LEDGERS, DEFAULT_LEDGER_LEDGERS } from "./synthetic-sources.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const MINUTE = 60_000;

export const SYNTHETIC_ACCOUNT_ID = "c".repeat(32);
export const SYNTHETIC_SOURCE_COMMIT = "f".repeat(40);
export const SYNTHETIC_D1 = Object.freeze({
  ingestion: "11111111-1111-4111-8111-111111111111",
  analytics: "22222222-2222-4222-8222-222222222222",
  "deletion-ledger": "33333333-3333-4333-8333-333333333333",
  "catchup-control": "44444444-4444-4444-8444-444444444444",
});
export const SYNTHETIC_DATABASE_NAMES = Object.freeze({
  ingestion: "synthetic-ingestion",
  "deletion-ledger": "synthetic-deletion-ledger",
});
export const SYNTHETIC_BOOKMARKS = Object.freeze({
  ingestion: "00000001-11111111-00000042",
  analytics: "00000001-22222222-00000007",
  "deletion-ledger": "00000001-33333333-00000003",
  "catchup-control": "00000001-44444444-00000001",
});

const GRAPHQL_QUERY_SHA256 = Object.freeze({
  d1Writes: "1eaed45e0be7498432fd6c4fed06c14d322f006c9fe60583d14846c6314603d7",
  invocations: "6e9821035c67bf8e0490d39b24c83214cc4e33418500137144620f4cd52939c5",
});

async function writePrivateJson(path, value) {
  const bytes = `${JSON.stringify(value)}\n`;
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return sha256(bytes);
}

/**
 * Write apply-<plan>.json and fence-<sha>.json into a fresh 0700 receipts
 * directory. Options override the verify window, the fenced production
 * commit, the d1 entries and the apply receipt (for the negative cases).
 */
export async function writeFenceReceiptFixture({
  directory, appliedAtMs = Date.now() - 40 * MINUTE, bookmarks = SYNTHETIC_BOOKMARKS, d1Ids = SYNTHETIC_D1,
  sourceCommit = SYNTHETIC_SOURCE_COMMIT, mutate = null, released = false,
} = {}) {
  const receipts = join(directory, "fence-receipts");
  await mkdir(receipts, { mode: 0o700 });
  await chmod(receipts, 0o700);
  const planSha256 = sha256("w2-seal-synthetic-fence-plan");
  const planReceiptSha256 = sha256("w2-seal-synthetic-fence-plan-receipt");
  const r2 = { bucketSha256: sha256("bucket"), inventorySha256: sha256("inventory"), objects: 2, bytes: 24 };
  const apply = {
    schema: "cloudflare-writer-fence-apply-v1",
    planSha256,
    planReceiptSha256,
    fingerprintSha256: sha256("fingerprint"),
    startedAtMs: appliedAtMs - 1000,
    appliedAtMs,
    quietWindowMinutes: 15,
    analyticsDrainAttested: true,
    productionWorker: { deploymentId: "synthetic-deployment-0001", versionId: randomUUID(), mode: "fenced" },
    r2Baseline: r2,
    priorState: [{ script: "synthetic-analytics", action: "clear-schedules", before: { crons: ["* * * * *"] } }],
    fencedState: [{ script: "synthetic-analytics", kind: "cron", crons: [], deliveryPaused: null }],
    mutationsIssued: 1,
  };
  const applyReceiptSha256 = await writePrivateJson(join(receipts, `apply-${planReceiptSha256}.json`), apply);
  const start = appliedAtMs + 15 * MINUTE;
  const end = start + 20 * MINUTE;
  const fence = {
    schema: "cloudflare-writer-fence-receipt-v1",
    planSha256,
    planReceiptSha256,
    applyReceiptSha256,
    accountSha256: sha256(`account:${"c".repeat(32)}`),
    verifiedAt: new Date(end).toISOString(),
    productionWorker: { name: "synthetic-production", deploymentId: "synthetic-deployment-0001",
      versionId: randomUUID(), mode: "fenced", sourceCommit },
    fencedScripts: [{ name: "synthetic-analytics", kind: "cron", crons: [], deliveryPaused: null }],
    window: { appliedAt: new Date(appliedAtMs).toISOString(), quietWindowMinutes: 15,
      start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    d1: ["ingestion", "analytics", "deletion-ledger", "catchup-control"].map(label => ({
      label, idSha256: sha256(`d1:${d1Ids[label]}`), bookmark: bookmarks[label],
    })),
    r2,
    analytics: {
      querySha256: { ...GRAPHQL_QUERY_SHA256 },
      window: { start: new Date(start).toISOString(), end: new Date(end - 5 * MINUTE).toISOString(), lagMinutes: 5 },
      d1: ["ingestion", "analytics", "deletion-ledger", "catchup-control"].map(label => ({ label, rowsWritten: 0, writeQueries: 0 })),
      fencedScriptInvocations: 0,
    },
  };
  if (mutate !== null) mutate(fence);
  const path = join(receipts, "fence-synthetic.json");
  const fenceSha256 = await writePrivateJson(path, fence);
  if (released) await writePrivateJson(join(receipts, `release-${planReceiptSha256}.json`), { schema: "released" });
  return { path, sha256: fenceSha256, receipt: fence, observedAfterMs: appliedAtMs };
}

/** The owner-captured barrier proof. */
export async function writeBarrierProofFixture({
  directory, observedAtMs = Date.now() - 10 * MINUTE, sourceCommit = SYNTHETIC_SOURCE_COMMIT, mutate = null,
  name = "barrier-proof.json",
} = {}) {
  const proof = {
    schema: "tibotattle-cutover-barrier-proof-v1",
    observedAt: new Date(observedAtMs).toISOString(),
    health: {
      method: "GET",
      url: "https://tibotattle.com/api/health",
      status: 200,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
      body: { status: "ok", mode: "migration-mutation-barrier", maintenance: { state: "fenced", storageQualified: false },
        deployment: { sourceCommit } },
    },
    probe: {
      method: "POST",
      url: "https://tibotattle.com/api/v1/telemetry/contributions",
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "retry-after": "300" },
      body: { error: { code: "MUTATION_BARRIER_ACTIVE", requestId: randomUUID() } },
    },
  };
  if (mutate !== null) mutate(proof);
  const path = join(directory, name);
  const proofSha256 = await writePrivateJson(path, proof);
  return { path, sha256: proofSha256, proof };
}

/** The owner inventory (0600). */
export async function writeInventoryFixture({
  directory, commit, ingestionLedgers = DEFAULT_INGESTION_LEDGERS, ledgerLedgers = DEFAULT_LEDGER_LEDGERS,
  mutate = null, name = "inventory.json",
} = {}) {
  const inventory = {
    schema: "tibotattle-cutover-inventory-v1",
    accountId: SYNTHETIC_ACCOUNT_ID,
    expectedSourceCommit: commit,
    sources: [
      { role: "ingestion", binding: "USAGE_MONITOR_DB", databaseName: SYNTHETIC_DATABASE_NAMES.ingestion,
        databaseId: SYNTHETIC_D1.ingestion, ledgers: ingestionLedgers },
      { role: "deletion-ledger", binding: "DELETION_LEDGER", databaseName: SYNTHETIC_DATABASE_NAMES["deletion-ledger"],
        databaseId: SYNTHETIC_D1["deletion-ledger"], ledgers: ledgerLedgers },
    ],
  };
  if (mutate !== null) mutate(inventory);
  const path = join(directory, name);
  await writePrivateJson(path, inventory);
  return { path, inventory };
}
