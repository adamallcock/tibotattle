#!/usr/bin/env node
// PT-2-lite fence consumption (cutover-source-fence.mjs).
//
//   verify-fence      the EP-8 verify receipt (cloudflare-writer-fence.mjs,
//                     read with its own consumer-side reader): production
//                     Worker fenced, writers unscheduled, quiet window and
//                     pinned bookmarks for the ingestion and deletion-ledger
//                     D1s of the owner inventory; plus the HTTP barrier proof
//                     (a GET /api/health barrier body carrying sourceCommit
//                     and a dynamic probe answering 503 MUTATION_BARRIER_ACTIVE
//                     with retry-after 300). Both are files; nothing is fetched.
//   verify-unchanged  re-read every sealed source's bookmark and aggregates
//                     through the injected read-only transport and re-hash the
//                     sealed files; emit flip-evidence.json (0400)
//                     with its sha256 only when everything equals the seal,
//                     else CUTOVER_SOURCE_CHANGED_AFTER_SEAL. The analytics
//                     D1 (never sealed) is bracketed around those reads: its
//                     bookmark, read before and after through the bookmark-only
//                     role 'analytics-bookmark', must both equal the fence
//                     receipt's analytics pin (the bookmark the revision
//                     floor's capture also started from), else
//                     CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE (R19 hardening (c),
//                     REV-SEED design step 4).
//
// Fixed-timestamp EP-8 receipts select fresh common timestamps for all source
// and analytics reads. They emit a non-admissible flip-evidence-draft.json;
// finalize-flip-evidence requires a pinned same-lineage successor receipt whose
// zero-event coverage extends through capture completion. Legacy v2 is unchanged.
//
// Every output is content-free: digests, bookmarks (opaque provider tokens
// the fence receipt already pins), counts, roles and table names.

import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import { beginCapture, finishCapture, readCaptureAnchor, createCaptureDraft, finalizeCaptureDraft, validateCaptureDraft } from "./cutover-capture-proof.mjs";
import { readCloudflareWriterFenceReceipt } from "./cloudflare-writer-fence.mjs";
import { fencedAnalyticsEntry, readCutoverAnalyticsSource } from "./cutover-admin-history-export.mjs";
import {
  CUTOVER_ANALYTICS_BOOKMARK_ROLE,
  CUTOVER_SEALABLE_SOURCES,
  CUTOVER_SOURCE_ROLES,
  CutoverSourceError,
  assertOwnerDirectory,
  canonicalJson,
  containsSignedUrl,
  createWranglerCutoverTransport,
  cutoverFail as fail,
  guardCutoverTransport,
  openSealedSourceFromSeal,
  readCutoverInventory,
  readCutoverSeal,
  readPrivateFile,
  readRemoteUnchangedFacts,
  sha256Hex,
  writePrivateFileOnce,
} from "./cutover-source-seal.mjs";

export const CUTOVER_BARRIER_PROOF_SCHEMA = "tibotattle-cutover-barrier-proof-v1";
export const CUTOVER_FENCE_VERIFICATION_SCHEMA = "tibotattle-cutover-fence-verification-v1";
/** v2 (R19 hardening (c)): the evidence also carries the analytics D1's fenced bookmark, re-read. */
export const CUTOVER_FLIP_EVIDENCE_SCHEMA = "tibotattle-cutover-flip-evidence-v2";
export const CUTOVER_FLIP_FIXED_EVIDENCE_SCHEMA = "tibotattle-cutover-flip-evidence-v3";
export const CUTOVER_BARRIER_RETRY_AFTER = "300";
export const CUTOVER_BARRIER_ERROR_CODE = "MUTATION_BARRIER_ACTIVE";

const SHA256 = /^[0-9a-f]{64}$/u;
const OPAQUE = /^[A-Za-z0-9-]{8,128}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_PROOF_BYTES = 64 * 1024;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!record(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    fail("CUTOVER_BARRIER_PROOF_INVALID");
  }
}

function instantMs(value) {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function publicUrl(value, check) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("CUTOVER_BARRIER_PROOF_INVALID", { check });
  }
  const origin = new URL(DEPLOYMENT_ENDPOINTS.public.origin);
  if (url.protocol !== "https:" || url.host !== origin.host || url.username || url.password || url.hash
      || url.search) {
    fail("CUTOVER_BARRIER_PROOF_INVALID", { check });
  }
  return url;
}

function jsonContentType(value) {
  return typeof value === "string" && /^application\/json(?:;\s*charset=utf-8)?$/iu.test(value);
}

/**
 * The barrier proof: a captured GET /api/health barrier body (status ok,
 * mode migration-mutation-barrier, fenced, storage unqualified, with
 * deployment.sourceCommit) and one dynamic probe answering 503
 * MUTATION_BARRIER_ACTIVE with no-store and retry-after 300.
 */
export function validateBarrierProof(value) {
  exactKeys(value, ["schema", "observedAt", "health", "probe"]);
  if (value.schema !== CUTOVER_BARRIER_PROOF_SCHEMA || instantMs(value.observedAt) === null) {
    fail("CUTOVER_BARRIER_PROOF_INVALID");
  }
  const { health, probe } = value;
  exactKeys(health, ["method", "url", "status", "headers", "body"]);
  const healthUrl = publicUrl(health.url, "health");
  exactKeys(health.headers, ["cache-control", "content-type"]);
  if (health.method !== "GET" || healthUrl.pathname !== "/api/health" || health.status !== 200
      || health.headers["cache-control"] !== "no-store" || !jsonContentType(health.headers["content-type"])) {
    fail("CUTOVER_BARRIER_PROOF_INVALID", { check: "health" });
  }
  exactKeys(health.body, ["status", "mode", "maintenance", "deployment"]);
  exactKeys(health.body.maintenance, ["state", "storageQualified"]);
  exactKeys(health.body.deployment, ["sourceCommit"]);
  if (health.body.status !== "ok" || health.body.mode !== "migration-mutation-barrier"
      || health.body.maintenance.state !== "fenced" || health.body.maintenance.storageQualified !== false
      || typeof health.body.deployment.sourceCommit !== "string" || !COMMIT.test(health.body.deployment.sourceCommit)) {
    fail("CUTOVER_BARRIER_PROOF_INVALID", { check: "health" });
  }
  exactKeys(probe, ["method", "url", "status", "headers", "body"]);
  const probeUrl = publicUrl(probe.url, "probe");
  exactKeys(probe.headers, ["cache-control", "content-type", "retry-after"]);
  if (!["GET", "POST"].includes(probe.method) || !probeUrl.pathname.startsWith("/api/")
      || probeUrl.pathname === "/api/health" || probe.status !== 503
      || probe.headers["cache-control"] !== "no-store" || !jsonContentType(probe.headers["content-type"])
      || probe.headers["retry-after"] !== CUTOVER_BARRIER_RETRY_AFTER) {
    fail("CUTOVER_BARRIER_PROOF_INVALID", { check: "probe" });
  }
  exactKeys(probe.body, ["error"]);
  exactKeys(probe.body.error, ["code", "requestId"]);
  if (probe.body.error.code !== CUTOVER_BARRIER_ERROR_CODE || typeof probe.body.error.requestId !== "string"
      || !UUID.test(probe.body.error.requestId)) {
    fail("CUTOVER_BARRIER_PROOF_INVALID", { check: "probe" });
  }
  return Object.freeze({
    observedAt: value.observedAt,
    sourceCommit: health.body.deployment.sourceCommit,
  });
}

async function readFenceReceipt(path, sha256) {
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) fail("CUTOVER_FENCE_RECEIPT_INVALID");
  try {
    return await readCloudflareWriterFenceReceipt(resolve(String(path)), sha256);
  } catch {
    return fail("CUTOVER_FENCE_RECEIPT_INVALID");
  }
}

/**
 * verify-fence: the EP-8 verify receipt (its own reader proves the closed
 * shape, the private directory, the apply receipt and that the fence was
 * not released) plus the barrier proof, bound to the owner inventory.
 */
export async function verifyCutoverFence({
  inventory, fenceReceiptPath, fenceReceiptSha256, barrierProofPath, now = Date.now,
} = {}) {
  if (!record(inventory) || !record(inventory.sources)) fail("CUTOVER_ARGUMENT_INVALID");
  const receipt = await readFenceReceipt(fenceReceiptPath, fenceReceiptSha256);
  if (receipt.productionWorker?.mode !== "fenced"
      || !receipt.fencedScripts.every(script => script.crons.length === 0
        && (script.kind === "cron" ? script.deliveryPaused === null : script.deliveryPaused === true))
      || receipt.analytics.fencedScriptInvocations !== 0) {
    fail("CUTOVER_FENCE_RECEIPT_INVALID");
  }
  const sources = {};
  for (const role of CUTOVER_SOURCE_ROLES) {
    const source = inventory.sources[role];
    const label = CUTOVER_SEALABLE_SOURCES[role].fenceLabel;
    const entry = receipt.d1.find(item => item.label === label);
    if (entry === undefined || entry.idSha256 !== source.databaseIdSha256) fail("CUTOVER_FENCE_SOURCE_MISMATCH", { role });
    sources[role] = Object.freeze({ role, databaseIdSha256: entry.idSha256, bookmark: entry.bookmark });
  }
  const proofBytes = await readPrivateFile(resolve(String(barrierProofPath)), MAX_PROOF_BYTES, "CUTOVER_BARRIER_PROOF_INVALID");
  let proofValue;
  try {
    proofValue = JSON.parse(proofBytes.toString("utf8"));
  } catch {
    fail("CUTOVER_BARRIER_PROOF_INVALID");
  }
  const proof = validateBarrierProof(proofValue);
  const observedMs = instantMs(proof.observedAt);
  const appliedMs = instantMs(receipt.window.appliedAt);
  if (appliedMs === null || observedMs < appliedMs || observedMs > now()) {
    fail("CUTOVER_BARRIER_PROOF_INVALID", { check: "observed-at" });
  }
  // The proof binds to the fenced version only through this commit. EP-8
  // records null when the live DEPLOYMENT_SOURCE_COMMIT binding is absent or
  // invalid; such a Worker cannot answer the barrier health this proof
  // requires, and a null pin would accept a proof captured from any build.
  const pinnedCommit = receipt.productionWorker.sourceCommit;
  if (typeof pinnedCommit !== "string" || !COMMIT.test(pinnedCommit) || pinnedCommit !== proof.sourceCommit) {
    fail("CUTOVER_BARRIER_PROOF_INVALID", { check: "source-commit" });
  }
  const barrierProofSha256 = sha256Hex(proofBytes);
  const summary = Object.freeze({
    schema: CUTOVER_FENCE_VERIFICATION_SCHEMA,
    fenceReceiptSha256,
    barrierProofSha256,
    sourceCommit: proof.sourceCommit,
    window: Object.freeze({ ...receipt.window }),
    sources: Object.freeze(CUTOVER_SOURCE_ROLES.map(role => sources[role])),
  });
  return Object.freeze({
    fenceReceiptSha256,
    barrierProofSha256,
    sourceCommit: proof.sourceCommit,
    sources: Object.freeze(sources),
    summary,
    verificationSha256: sha256Hex(canonicalJson(summary)),
  });
}

/**
 * The analytics D1 verify-unchanged brackets (R19 hardening (c)): the owner's
 * 0600 analytics source file, which must name the D1 the fence receipt (read
 * at the digest the seal pins, by the EP-8 consumer-side reader, which also
 * refuses a released fence) records, and never a sealed D1. Local files only.
 */
async function fencedAnalyticsSource({ inventory, seal, analyticsSourcePath, fenceReceiptPath }) {
  if (typeof analyticsSourcePath !== "string" || typeof fenceReceiptPath !== "string") fail("CUTOVER_ARGUMENT_INVALID");
  const analytics = await readCutoverAnalyticsSource(analyticsSourcePath);
  if (Object.values(inventory.sources).some(source => source.databaseIdSha256 === analytics.databaseIdSha256)) {
    fail("CUTOVER_SOURCE_NOT_ALLOWED");
  }
  const fenced = await fencedAnalyticsEntry(fenceReceiptPath, seal.manifest.fence.fenceReceiptSha256);
  if (fenced.idSha256 !== analytics.databaseIdSha256) fail("CUTOVER_FENCE_SOURCE_MISMATCH");
  return Object.freeze({ source: Object.freeze({ ...analytics, role: CUTOVER_ANALYTICS_BOOKMARK_ROLE }), fenced });
}

/**
 * verify-unchanged --seal: every bookmark, schema digest and aggregate digest
 * read now through the read-only transport must equal the seal, and every
 * sealed file must still hash to its manifest digest. The analytics D1's
 * bookmark is read before the first and after the last sealed read, through
 * the bookmark-only role (no statement is admitted on it), and both reads
 * must equal the fence receipt's analytics pin
 * (CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE): the revision floor's capture
 * started from that bookmark, so Cloudflare published nothing after it. Only
 * then is the flip evidence written (0400) and its sha256 returned. Without
 * an injected transport the default Wrangler transport runs with the given
 * spawn, CLI path and environment (their defaults when omitted); its pinned
 * configs are removed on success and on failure, so the owner directory then
 * holds only flip-evidence.json, or nothing.
 */
export async function verifyCutoverUnchanged({
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
  if (seal.manifest.inventorySha256 !== inventory.inventorySha256) fail("CUTOVER_SEAL_MANIFEST_INVALID");
  const analytics = await fencedAnalyticsSource({ inventory, seal, analyticsSourcePath, fenceReceiptPath });
  const anchor = await readCaptureAnchor({ fenceReceiptPath, fenceReceiptSha256: seal.manifest.fence.fenceReceiptSha256 });
  await readCutoverSeal({ manifestPath, expectedSealId: sealId, originalFenceReceiptPath: fenceReceiptPath });
  if (anchor.fixed && (anchor.receipt.accountSha256 !== sha256Hex(`account:${inventory.accountId}`)
      || anchor.receipt.productionWorker.sourceCommit !== seal.manifest.fence.sourceCommit))
    fail("CUTOVER_FENCE_SOURCE_MISMATCH");
  for (const role of CUTOVER_SOURCE_ROLES) {
    const sealed = await openSealedSourceFromSeal(seal, role);
    try {
      await sealed.verify();
    } finally {
      sealed.close();
    }
  }
  if (execute !== true) {
    return Object.freeze({ mode: "dry-run", sealId, sources: CUTOVER_SOURCE_ROLES.length });
  }
  if (remote !== true || ownerReadOnly !== true) fail("CUTOVER_REMOTE_NOT_AUTHORIZED");
  // The transport sees the sealed sources and, as the bookmark-only role, the analytics D1.
  const scope = Object.freeze({ ...inventory,
    sources: Object.freeze({ ...inventory.sources, [CUTOVER_ANALYTICS_BOOKMARK_ROLE]: analytics.source }) });
  let ownedTransport = null;
  try {
    ownedTransport = transport === undefined ? createWranglerCutoverTransport({
      inventory: scope, transportDirectory: directory, spawn, cliPath, environment, remote, ownerReadOnly,
    }) : null;
    const guarded = guardCutoverTransport(transport ?? ownedTransport, scope);
    const captureContext = anchor.fixed ? await beginCapture({ anchor, guarded, now,
      sources: [...CUTOVER_SOURCE_ROLES.map(role => ({ fenceLabel: role, source: inventory.sources[role] })),
        { fenceLabel: "analytics", source: analytics.source }] }) : null;
    const analyticsBefore = anchor.fixed ? analytics.fenced.bookmark : await guarded.bookmark(analytics.source);
    if (analyticsBefore !== analytics.fenced.bookmark) fail("CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE");
    const sources = [];
    for (const role of CUTOVER_SOURCE_ROLES) {
      const sealedSource = seal.sources[role];
      let facts;
      try {
        facts = await readRemoteUnchangedFacts(guarded, inventory.sources[role], sealedSource,
          anchor.fixed ? { timestamp: captureContext.startedAt } : undefined);
      } catch (error) {
        if (error instanceof CutoverSourceError && error.code === "CUTOVER_REMOTE_SQL_NOT_SELECT") throw error;
        if (error instanceof CutoverSourceError && error.code === "CUTOVER_SOURCE_NOT_ALLOWED") throw error;
        if (error instanceof CutoverSourceError && error.code === "CUTOVER_OUTPUT_EXISTS") throw error;
        fail("CUTOVER_SOURCE_CHANGED_AFTER_SEAL", { role });
      }
      if (!facts.matches) fail("CUTOVER_SOURCE_CHANGED_AFTER_SEAL", { role });
      sources.push(Object.freeze({
        role,
        databaseIdSha256: sealedSource.databaseIdSha256,
        bookmark: facts.bookmark,
        schemaSha256: facts.schemaSha256,
        aggregatesSha256: facts.aggregatesSha256,
        sealedSha256: sealedSource.sealedSha256,
      }));
    }
    const capture = anchor.fixed ? await finishCapture(captureContext, { now }) : null;
    const analyticsAfter = anchor.fixed ? analytics.fenced.bookmark : await guarded.bookmark(analytics.source);
    if (analyticsAfter !== analyticsBefore) fail("CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE");
    await ownedTransport?.dispose();
    const verifiedAt = now().toISOString();
    const evidence = {
      schema: anchor.fixed ? CUTOVER_FLIP_FIXED_EVIDENCE_SCHEMA : CUTOVER_FLIP_EVIDENCE_SCHEMA,
      sealId,
      inventorySha256: inventory.inventorySha256,
      fenceReceiptSha256: seal.manifest.fence.fenceReceiptSha256,
      verifiedAt,
      sources,
      analytics: Object.freeze({ databaseIdSha256: analytics.fenced.idSha256, bookmark: analyticsAfter }),
    };
    const output = anchor.fixed ? createCaptureDraft({ kind: "flip-evidence", body: evidence, anchor, capture }) : evidence;
    const text = `${canonicalJson(output)}\n`;
    if (containsSignedUrl(text)) fail("CUTOVER_SECRET_IN_OUTPUT");
    // One verification per owner directory: an existing flip-evidence.json
    // is CUTOVER_OUTPUT_EXISTS, never overwritten.
    const path = join(directory, anchor.fixed ? "flip-evidence-draft.json" : "flip-evidence.json");
    const flipEvidenceSha256 = await writePrivateFileOnce(path, text, 0o400);
    return Object.freeze({ mode: anchor.fixed ? "draft" : "verified", path, flipEvidenceSha256, ...(anchor.fixed ? { draftSha256: flipEvidenceSha256 } : {}), evidence: Object.freeze(output) });
  } catch (error) {
    await ownedTransport?.dispose().catch(() => {});
    throw error;
  }
}

/** Closed content-free final body validation before publishing an immutable artifact. */
function validateFixedFlipBody(body, proof) {
  const invalid = () => fail("CUTOVER_CAPTURE_PROOF_INVALID");
  const closed = (value, keys) => {
    if (!record(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) invalid();
  };
  closed(body, ["schema", "sealId", "inventorySha256", "fenceReceiptSha256", "verifiedAt", "sources", "analytics"]);
  if (body.schema !== CUTOVER_FLIP_FIXED_EVIDENCE_SCHEMA
      || [body.sealId, body.inventorySha256, body.fenceReceiptSha256].some(value => typeof value !== "string" || !SHA256.test(value))
      || body.fenceReceiptSha256 !== proof.originalFenceReceiptSha256
      || instantMs(body.verifiedAt) === null || instantMs(body.verifiedAt) < instantMs(proof.capture.completedAt)
      || !Array.isArray(body.sources) || body.sources.length !== CUTOVER_SOURCE_ROLES.length) invalid();
  for (const [index, source] of body.sources.entries()) {
    closed(source, ["role", "databaseIdSha256", "bookmark", "schemaSha256", "aggregatesSha256", "sealedSha256"]);
    if (source.role !== CUTOVER_SOURCE_ROLES[index] || typeof source.bookmark !== "string" || !OPAQUE.test(source.bookmark)
        || [source.databaseIdSha256, source.schemaSha256, source.aggregatesSha256, source.sealedSha256]
          .some(value => typeof value !== "string" || !SHA256.test(value))) invalid();
  }
  closed(body.analytics, ["databaseIdSha256", "bookmark"]);
  if (typeof body.analytics.databaseIdSha256 !== "string" || !SHA256.test(body.analytics.databaseIdSha256)
      || typeof body.analytics.bookmark !== "string" || !OPAQUE.test(body.analytics.bookmark)) invalid();
  const roles = [...body.sources.map(source => ({ role: source.role, label: source.role,
    databaseIdSha256: source.databaseIdSha256, bookmarkSha256: sha256Hex(source.bookmark) })),
    { role: CUTOVER_ANALYTICS_BOOKMARK_ROLE, label: "analytics", databaseIdSha256: body.analytics.databaseIdSha256,
      bookmarkSha256: sha256Hex(body.analytics.bookmark) }];
  if (canonicalJson(roles) !== canonicalJson(proof.capture.roles)) invalid();
}

/** Finalize a prospective draft only after a same-lineage EP-8 successor covers all reads. */
export async function finalizeCutoverFlipEvidence({ draftPath, draftSha256, fenceReceiptPath,
  successorFenceReceiptPath, successorFenceReceiptSha256, ownerDirectory, forbiddenRoots = undefined } = {}) {
  if (!SHA256.test(draftSha256 ?? "") || !SHA256.test(successorFenceReceiptSha256 ?? "")) fail("CUTOVER_ARGUMENT_INVALID");
  const directory = await assertOwnerDirectory(ownerDirectory, forbiddenRoots === undefined ? {} : { forbiddenRoots });
  const bytes = await readPrivateFile(draftPath, 1024 * 1024, "CUTOVER_CAPTURE_PROOF_INVALID");
  if (sha256Hex(bytes) !== draftSha256) fail("CUTOVER_CAPTURE_PROOF_INVALID");
  let draft;
  try { draft = JSON.parse(bytes.toString("utf8")); } catch { fail("CUTOVER_CAPTURE_PROOF_INVALID"); }
  validateCaptureDraft(draft);
  if (!bytes.equals(Buffer.from(`${canonicalJson(draft)}\n`))) fail("CUTOVER_CAPTURE_PROOF_INVALID");
  if (draft.kind !== "flip-evidence" || draft.body?.schema !== CUTOVER_FLIP_FIXED_EVIDENCE_SCHEMA)
    fail("CUTOVER_CAPTURE_PROOF_INVALID");
  const { body, proof } = await finalizeCaptureDraft({ draft, originalFenceReceiptPath: fenceReceiptPath,
    successorFenceReceiptPath, successorFenceReceiptSha256 });
  validateFixedFlipBody(body, proof);
  const evidence = { ...body, captureProof: proof };
  const text = `${canonicalJson(evidence)}\n`;
  if (containsSignedUrl(text)) fail("CUTOVER_SECRET_IN_OUTPUT");
  const path = join(directory, "flip-evidence.json");
  const flipEvidenceSha256 = await writePrivateFileOnce(path, text, 0o400);
  return Object.freeze({ mode: "verified", path, flipEvidenceSha256, evidence: Object.freeze(evidence) });
}

// ---------------------------------------------------------------------------
// CLI.

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["verify-fence", "verify-unchanged", "finalize-flip-evidence"].includes(command)) fail("CUTOVER_ARGUMENT_INVALID");
  const values = { "--inventory": "inventoryPath", "--fence-receipt": "fenceReceiptPath",
    "--fence-sha256": "fenceReceiptSha256", "--barrier-proof": "barrierProofPath", "--seal": "manifestPath",
    "--draft": "draftPath", "--draft-sha256": "draftSha256", "--successor-fence-receipt": "successorFenceReceiptPath",
    "--successor-fence-sha256": "successorFenceReceiptSha256", "--seal-id": "sealId", "--analytics-source": "analyticsSourcePath", "--out": "ownerDirectory" };
  const switches = { "--remote": "remote", "--owner-read-only": "ownerReadOnly", "--execute": "execute" };
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (Object.hasOwn(switches, flag)) {
      if (options[switches[flag]] !== undefined) fail("CUTOVER_ARGUMENT_INVALID");
      options[switches[flag]] = true;
      continue;
    }
    const key = values[flag];
    const value = rest[index + 1];
    if (key === undefined || options[key] !== undefined || typeof value !== "string" || value.startsWith("--")) {
      fail("CUTOVER_ARGUMENT_INVALID");
    }
    options[key] = value;
    index += 1;
  }
  const finalKeys = ["draftPath", "draftSha256", "successorFenceReceiptPath", "successorFenceReceiptSha256"];
  if (command !== "finalize-flip-evidence" && finalKeys.some(key => options[key] !== undefined)) fail("CUTOVER_ARGUMENT_INVALID");
  if (command === "finalize-flip-evidence" && Object.keys(options).some(key => !["command", ...finalKeys, "fenceReceiptPath", "ownerDirectory"].includes(key))) fail("CUTOVER_ARGUMENT_INVALID");
  if (command !== "finalize-flip-evidence" && !options.inventoryPath) fail("CUTOVER_ARGUMENT_INVALID");
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.command === "finalize-flip-evidence") {
    const result = await finalizeCutoverFlipEvidence({ ...options,
      draftPath: options.draftPath === undefined ? undefined : resolve(options.draftPath),
      fenceReceiptPath: options.fenceReceiptPath === undefined ? undefined : resolve(options.fenceReceiptPath),
      successorFenceReceiptPath: options.successorFenceReceiptPath === undefined ? undefined : resolve(options.successorFenceReceiptPath),
      ownerDirectory: options.ownerDirectory === undefined ? undefined : resolve(options.ownerDirectory) });
    process.stdout.write(`${JSON.stringify({ command: options.command, mode: result.mode, flipEvidenceSha256: result.flipEvidenceSha256 })}\n`);
    return;
  }
  if (options.command === "verify-fence") {
    const inventory = await readCutoverInventory(resolve(options.inventoryPath));
    const result = await verifyCutoverFence({ inventory, fenceReceiptPath: options.fenceReceiptPath,
      fenceReceiptSha256: options.fenceReceiptSha256, barrierProofPath: options.barrierProofPath });
    process.stdout.write(`${JSON.stringify({ command: options.command, verificationSha256: result.verificationSha256,
      fenceReceiptSha256: result.fenceReceiptSha256, barrierProofSha256: result.barrierProofSha256 })}\n`);
    return;
  }
  const result = await verifyCutoverUnchanged({
    inventoryPath: resolve(options.inventoryPath),
    manifestPath: options.manifestPath === undefined ? undefined : resolve(options.manifestPath),
    sealId: options.sealId,
    analyticsSourcePath: options.analyticsSourcePath === undefined ? undefined : resolve(options.analyticsSourcePath),
    fenceReceiptPath: options.fenceReceiptPath === undefined ? undefined : resolve(options.fenceReceiptPath),
    ownerDirectory: options.ownerDirectory === undefined ? undefined : resolve(options.ownerDirectory),
    execute: options.execute === true,
    remote: options.remote === true,
    ownerReadOnly: options.ownerReadOnly === true,
  });
  process.stdout.write(`${JSON.stringify(result.mode === "draft"
    ? { command: options.command, mode: result.mode, draftSha256: result.draftSha256 }
    : result.mode === "verified" ? { command: options.command, mode: result.mode, flipEvidenceSha256: result.flipEvidenceSha256 }
    : { command: options.command, mode: result.mode })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof CutoverSourceError ? error.message : "CUTOVER_FAILED"}\n`);
    process.exitCode = 1;
  });
}
