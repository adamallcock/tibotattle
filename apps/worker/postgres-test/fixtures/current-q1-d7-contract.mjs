/** Pure v3 evidence validation. Saved JSON never establishes native execution.
 * The controller must supply independently captured source/case pins and the
 * pre-candidate expectation digest. Production policies and v2 stay unchanged. */
import { createHash } from "node:crypto";
import { validateCurrentQ1StrictExportRefusal } from "./current-q1-d1-recompute.mjs";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, dirname, normalize } from "node:path";
import { ADMIN_MODEL_HISTORY_CATALOG_VERSION, projectAdminModelHistoryDay } from "@app-usagemonitor/telemetry-contract";

export const CURRENT_Q1_D7_SCHEMAS = Object.freeze({ binding: "current-q1-d7-binding-v1", inputBinding: "current-q1-d7-input-binding-v1",
  conflict: "current-q1-d7-source-conflict-proof-v1", expectation: "current-q1-d7-per-date-expectation-v1",
  reference: "current-q1-d7-case-reference-v1", acceptance: "current-q1-d7-producer-acceptance-v3" });
export const CURRENT_Q1_D7_NORMALIZATIONS = Object.freeze(["days[].revision", "days[].releasedAt",
  "payload.revision", "payload.releasedAt", "payload.aggregateId :r<revision> suffix"]);
export const CURRENT_Q1_D7_BOUNDS = Object.freeze({ bootstrap: 64, settleRounds: 8, delivery: 512,
  daily: 256, dailyConvergence: 4096, forcedDailyPerHead: 64, dailyRetirement: 16, cachePasses: 4096,
  nativeInvocations: 128, nativeStall: 8, nativeQueries: 900, diagnosticDeadlineMs: 30000,
  s9DeadlineMs: 2400000, rootDeadlineMs: 10800000,
  nativeQueryBudgetScope: "per_compute_storage_graph_result_invocation_source_plus_target",
  nativeInvocationBudgetScope: "per_owner_metric_day_scope",
  nativeStallBudgetScope: "consecutive_per_owner_metric_day_scope",
  nativeProductionDeadlineMs: 20000,
  nativeProductionDeadlineScope: "per_compute_storage_graph_result_invocation_cooperative_clock",
  diagnosticDeadlineScope: "per_observed_diagnostic_invocation_wall_clock",
  s9DeadlineScope: "one_controller_child_both_cases_all_phases_wall_clock",
  rootDeadlineScope: "one_complete_outer_gate_wall_clock" });
export const CURRENT_Q1_D7_NOW_MS = 1790856000000;
/** Mandatory current DTO/qualification authorities. Discovery still captures
 * the complete actual transitive closure; this minimum never replaces it. */
export const CURRENT_Q1_D7_REQUIRED_SOURCE_PATHS = Object.freeze([
  "package.json", "pnpm-lock.yaml", "apps/worker/package.json", "apps/worker/package-lock.json",
  "apps/worker/postgres-test/fixtures/current-q1-d7-contract.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-reference.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-recompute.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-native.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-expectation.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d7-case-output.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d1-reference.mjs",
  "apps/worker/postgres-test/fixtures/current-q1-d1-recompute.mjs",
  "apps/worker/scripts/analytics-v2-current-d7-compare.mjs",
  "apps/worker/scripts/current-q1-d7-contract.check.mjs",
  "apps/worker/scripts/s9-rehearsal-diagnostics.mjs",
  "apps/worker/scripts/current-q1-conflict-proof.mjs", "apps/worker/scripts/gcp-fastpath-rehearsal.mjs",
  "apps/worker/src/storage-effective-history.ts", "apps/worker/src/storage-community-graph.ts",
  "apps/worker/src/d1-analytics-export-oracle.ts", "apps/worker/src/index.ts",
  "apps/worker/src/admin-community-allowance.ts", "apps/worker/src/community-allowance.ts",
  "apps/worker/src/public-allowance-breakdowns.ts", "apps/worker/src/storage-community-graph-publication.ts",
  "apps/worker/src/analytics-v2/allowance-projection.ts",
  "apps/worker/src/community-daily-aggregates.ts", "apps/worker/src/community-daily-spend.ts",
  "apps/worker/src/cache-retention-values.ts", "apps/worker/src/analytics-v2/interim-public-read.ts",
  "apps/worker/src/analytics-v2/public-model-metadata-current.ts",
  "apps/worker/src/analytics-v2/public-allowance-breakdowns-v13.ts",
  "apps/worker/src/analytics-v2/public-allowance-breakdowns-v15.ts",
  "packages/telemetry-contract/src/admin-model-history.js", "packages/telemetry-contract/src/model-catalog.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/admin-model-history.js",
  "apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/model-catalog.js",
  ...["accounting", "quota-analysis", "telemetry-contract"].flatMap(name =>
    [`packages/${name}/package.json`, `packages/${name}/index.js`,
      `apps/worker/node_modules/@app-usagemonitor/${name}/package.json`, `apps/worker/node_modules/@app-usagemonitor/${name}/index.js`]),
]);
const ROOT_SOURCE_FILES = new Set(["package.json", "pnpm-lock.yaml"]);
const COPIED_PACKAGES = new Set(["accounting", "quota-analysis", "telemetry-contract"]);
const PACKAGE_SOURCE_ROOTS = new Set(["src", "scripts", "schemas"]);
const PACKAGE_PUBLIC_FILES = new Set(["package.json", "index.js", "index.d.ts"]);
const WORKER_SOURCE_ROOTS = new Set(["src", "scripts", "postgres-test", "cloud-run"]);
const WORKER_JSON_FILES = new Set(["apps/worker/src/d1-provider-schema.json",
  "apps/worker/src/dogfood-sparkle-release-contract.json", "apps/worker/src/sparkle-release-contract.json",
  "apps/worker/src/analytics-v2/kernel-registry.json"]);
const WORKER_MIGRATION_ROOTS = new Set(["migrations", "typed-ingestion-migrations",
  "ingestion-bridge-migrations", "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations", "analytics-migrations", "deletion-ledger-migrations"]);
const WORKER_SOURCE_FILES = new Set(["apps/worker/package.json", "apps/worker/package-lock.json",
  "apps/worker/wrangler.jsonc", "apps/worker/test/helpers/telemetry-v11.ts"]);
const PRIVATE_SEGMENTS = new Set(["private", "secrets", "secret", "credentials", "credential",
  "tokens", "token", "passwords", "password", "keys", "key", "generated-inputs", "private-generated", "raw-history"]);
const SOURCE_CODE_FILE = /\.(?:[cm]?js|tsx?|mts)$/u;
function publicPackageTail(packageName, parts) {
  if (parts.length === 1) return PACKAGE_PUBLIC_FILES.has(parts[0]);
  if (parts.length < 2 || !PACKAGE_SOURCE_ROOTS.has(parts[0])) return false;
  return parts[0] === "src" ? /\.js$/u.test(parts.at(-1)) : packageName === "telemetry-contract"
    && (parts[0] === "scripts" ? /\.mjs$/u.test(parts.at(-1)) : /\.schema\.json$/u.test(parts.at(-1)));
}
/** Exact repository-relative paths in reviewed source/config roots. No hidden
 * segment, case-variant credential/private input, foreign copy or traversal. */
export function validCurrentQ1D7SourcePath(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 1024) return false;
  if (ROOT_SOURCE_FILES.has(path)) return true;
  const parts = path.split("/");
  if (parts.some(part => !part || part.startsWith(".")
      || PRIVATE_SEGMENTS.has(part.toLowerCase().split(".")[0]))) return false;
  if (parts.some(part => part.toLowerCase() === "node_modules")) return parts.filter(part => part.toLowerCase() === "node_modules").length === 1
    && parts.slice(0, 4).join("/") === "apps/worker/node_modules/@app-usagemonitor"
    && COPIED_PACKAGES.has(parts[4]) && publicPackageTail(parts[4], parts.slice(5))
    && parts.slice(5).every(part => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(part));
  if (!parts.every(part => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(part))) return false;
  if (WORKER_SOURCE_FILES.has(path)) return true;
  if (parts[0] === "packages") return COPIED_PACKAGES.has(parts[1]) && publicPackageTail(parts[1], parts.slice(2));
  if (parts.slice(0, 2).join("/") !== "apps/worker") return false;
  if (WORKER_SOURCE_ROOTS.has(parts[2])) return parts.length >= 4
    && (parts[2] === "src" ? /\.ts$/u.test(parts.at(-1)) || WORKER_JSON_FILES.has(path)
      : parts[2] === "postgres-test" ? /\.mjs$/u.test(parts.at(-1)) : SOURCE_CODE_FILE.test(parts.at(-1)));
  if (WORKER_MIGRATION_ROOTS.has(parts[2])) return parts.length === 4 && /\.sql$/u.test(parts[3]);
  if (parts[2] === "postgres") return ["migrations", "staged-migrations"].includes(parts[3])
    && ["primary", "ledger"].includes(parts[4]) && parts.length === 6 && /\.sql$/u.test(parts[5]);
  return parts[2] === "vendor" && parts[3] === "analytics-d43c8f92"
    && parts.length >= 5 && (SOURCE_CODE_FILE.test(parts.at(-1))
      || ["MANIFEST.json", "tsconfig.json", "package.json"].includes(parts.at(-1)));
}

const CASES = ["conflictPreserving", "conflictFreePositive"], OWNERS = ["a", "b", "c", "d"];
const NEGATIVE_CORPUS = "be042b9a72c00a8bbeef592619d7d7ab00be5b02a557629340d27bbf36b5521e";
const MODEL_REASONS = new Set(["supported_quota_track_unavailable", "plan_attribution_limit_exceeded",
  "multi_plan_window_unsupported", "multi_provider_window_unsupported", "downsampled_quota_limit_exceeded",
  "windowed_usage_limit_exceeded", "usage_cost_limit_exceeded", "multi_account_window_unsupported",
  "multi_era_window_unsupported", "continuity_track_limit_exceeded", "usage_day_limit_exceeded",
  "invalid_attribution_record", "session_interval_scope_limit_exceeded", "reduced_usage_limit_exceeded",
  "usage_attribution_unresolved"]);
const RUNTIME_BINARIES = Object.freeze({ "darwin/arm64": "b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440",
  "linux/x64": "030a5e93e4f7a022b12a3ec80fecd22af9614356904a05ece6b1b2dbf4c1f588" });
const SHA = /^[a-f0-9]{64}$/u, HEAD = /^[a-f0-9]{40}$/u;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const hash = value => typeof value === "string" && SHA.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function requireFact(fact) { if (!fact) throw Object.assign(new Error("CURRENT_Q1_D7_CONTRACT_INVALID"),
  { code: "CURRENT_Q1_D7_CONTRACT_INVALID" }); }
export function currentQ1D7JsonSha256(value) {
  let text; try { text = JSON.stringify(value); } catch { requireFact(false); }
  requireFact(typeof text === "string"); return createHash("sha256").update(text).digest("hex");
}
function days(from, count) { return Array.from({ length: count }, (_, n) =>
  new Date(Date.parse(from) + n * 86400000).toISOString().slice(0, 10)); }
export function currentQ1D7GraphDays() { return days("2026-07-24", 70); }
export function currentQ1D7PublicDays(binding) {
  validateCurrentQ1D7Binding(binding);
  const today = new Date(binding.runtime.pinnedNowMs).toISOString().slice(0, 10);
  return currentQ1D7GraphDays().filter(day => day < today);
}
function caseOf(binding, caseId) { requireFact(CASES.includes(caseId)); return binding.cases[caseId]; }
function same(value, expected) { requireFact(isDeepStrictEqual(value, expected)); }
function files(value) {
  requireFact(Array.isArray(value) && value.length > 0 && value.length <= 10000);
  let previous = "";
  for (const entry of value) {
    requireFact(exact(entry, ["path", "sha256"]) && typeof entry.path === "string"
      && validCurrentQ1D7SourcePath(entry.path)
      && entry.path > previous && hash(entry.sha256)); previous = entry.path;
  }
}
function scoped(value, binding, caseId) {
  requireFact(value.caseId === caseId && value.bindingSha256 === currentQ1D7JsonSha256(binding));
}

export function validateCurrentQ1D7Binding(value, independentlyCaptured = value) {
  requireFact(exact(value, ["schemaVersion", "decisionId", "sourceId", "sourceNamespace", "source", "runtime",
    "migrationSha256", "bounds", "cases"]) && value.schemaVersion === CURRENT_Q1_D7_SCHEMAS.binding
    && value.decisionId === "D7" && value.sourceId === "gcp-fastpath-oracle" && value.sourceNamespace === value.sourceId);
  requireFact(exact(value.source, ["head", "files", "sha256"]) && HEAD.test(value.source.head));
  files(value.source.files); same(value.source.sha256, currentQ1D7JsonSha256(value.source.files));
  for (const path of CURRENT_Q1_D7_REQUIRED_SOURCE_PATHS) requireFact(value.source.files.some(file => file.path === path));
  for (const name of ["admin-model-history.js", "model-catalog.js"]) same(
    value.source.files.find(file => file.path === `packages/telemetry-contract/src/${name}`).sha256,
    value.source.files.find(file => file.path === `apps/worker/node_modules/@app-usagemonitor/telemetry-contract/src/${name}`).sha256);
  for (const name of COPIED_PACKAGES) for (const file of ["package.json", "index.js"]) same(
    value.source.files.find(entry => entry.path === `packages/${name}/${file}`).sha256,
    value.source.files.find(entry => entry.path === `apps/worker/node_modules/@app-usagemonitor/${name}/${file}`).sha256);
  requireFact(hash(value.migrationSha256)); same(value.bounds, CURRENT_Q1_D7_BOUNDS);
  requireFact(exact(value.runtime, ["version", "platform", "arch", "binarySha256", "pinnedNowMs", "randomSeed", "sqliteVersion"])
    && value.runtime.version === "v26.2.0" && hash(value.runtime.binarySha256) && value.runtime.binarySha256 === RUNTIME_BINARIES[`${value.runtime.platform}/${value.runtime.arch}`]
    && value.runtime.pinnedNowMs === CURRENT_Q1_D7_NOW_MS && value.runtime.randomSeed === "current-q1-reference"
    && typeof value.runtime.sqliteVersion === "string" && value.runtime.sqliteVersion.length > 0 && value.runtime.sqliteVersion.length <= 64);
  requireFact(exact(value.cases, CASES));
  for (const caseId of CASES) {
    const entry = caseOf(value, caseId);
    requireFact(exact(entry, ["caseId", "corpusCaseId", "corpusSha256", "topologySha256", "admissionSha256", "sourceInvariantSha256",
      "owners", "sourceDays", "recordCount", "primaryRecordCount", "extraAdmissions", "conflictDays", "dailyDays", "modelDays"])
      && entry.caseId === caseId && entry.corpusCaseId === (caseId === CASES[0] ? "conflict-preserving-negative-v2" : "conflict-free-positive-v2")
      && [entry.corpusSha256, entry.topologySha256, entry.admissionSha256, entry.sourceInvariantSha256].every(hash)
      && entry.sourceDays === 170 && entry.recordCount === 14832 && entry.primaryRecordCount === 14830 && entry.extraAdmissions === 2);
    same(entry.owners, OWNERS); same(entry.modelDays, currentQ1D7GraphDays());
    same(entry.conflictDays, caseId === CASES[0] ? ["2026-04-17", "2026-04-18"] : []);
    same(entry.dailyDays, days("2026-04-15", 170).filter(day => !entry.conflictDays.includes(day)));
  }
  requireFact(value.cases.conflictPreserving.corpusSha256 === NEGATIVE_CORPUS
    && value.cases.conflictFreePositive.corpusSha256 !== NEGATIVE_CORPUS
    && value.cases.conflictPreserving.admissionSha256 !== value.cases.conflictFreePositive.admissionSha256
    && value.cases.conflictPreserving.topologySha256 !== value.cases.conflictFreePositive.topologySha256);
  if (independentlyCaptured?.schemaVersion === CURRENT_Q1_D7_SCHEMAS.inputBinding) {
    validateCurrentQ1D7InputBinding(independentlyCaptured);
    const staticProjection = structuredClone(value); staticProjection.schemaVersion = CURRENT_Q1_D7_SCHEMAS.inputBinding;
    for (const caseId of CASES) delete staticProjection.cases[caseId].sourceInvariantSha256;
    same(staticProjection, independentlyCaptured);
  } else same(value, independentlyCaptured);
  return value;
}

/** Static capture before admission. Only the immutable admitted-source
 * invariant is added later, from actual admission, before settle/native/PG. */
export function validateCurrentQ1D7InputBinding(value) {
  requireFact(object(value) && value.schemaVersion === CURRENT_Q1_D7_SCHEMAS.inputBinding && exact(value.cases, CASES));
  const structural = structuredClone(value); structural.schemaVersion = CURRENT_Q1_D7_SCHEMAS.binding;
  for (const caseId of CASES) {
    requireFact(!Object.hasOwn(structural.cases[caseId], "sourceInvariantSha256"));
    structural.cases[caseId].sourceInvariantSha256 = "0".repeat(64);
  }
  validateCurrentQ1D7Binding(structural); return value;
}

/** The observer proves these claims at execution time; this validator checks
 * their closed representation and binds it to independently frozen inputs. */
export function validateCurrentQ1D7SourceConflictProof(value, binding, { sourceWitnesses, windowProofs } = {}) {
  validateCurrentQ1D7Binding(binding);
  requireFact(exact(value, ["schemaVersion", "caseId", "bindingSha256", "scope", "origin", "reader", "fences"])
    && value.schemaVersion === CURRENT_Q1_D7_SCHEMAS.conflict); scoped(value, binding, CASES[0]);
  const s = value.scope;
  requireFact(exact(s, ["owner", "metric", "day", "sourceKind", "dependencyDigest", "keyDigest", "headDigest", "cursorSha256", "checkpointMethod"])
    && s.owner === "a" && s.metric === "model" && currentQ1D7GraphDays().includes(s.day) && s.sourceKind === "effective"
    && [s.dependencyDigest, s.keyDigest, s.headDigest, s.cursorSha256].every(hash)
    && typeof s.checkpointMethod === "string" && /^[A-Za-z0-9._:-]{1,1024}$/u.test(s.checkpointMethod));
  const o = value.origin, module = binding.source.files.find(file => file.path === "apps/worker/src/storage-effective-history.ts");
  requireFact(exact(o, ["label", "moduleSha256", "originProofSha256", "factoryLine", "guardLine", "observerSha256"])
    && o.label === "effective_history_guard_544" && o.factoryLine === 26 && o.guardLine === 544
    && module && o.moduleSha256 === module.sha256 && [o.originProofSha256, o.observerSha256].every(hash)
    && o.observerSha256 === binding.source.files.find(file => file.path === "apps/worker/scripts/current-q1-conflict-proof.mjs")?.sha256);
  const r = value.reader;
  requireFact(exact(r, ["method", "stream", "pageSha256", "rows", "compatibleRows", "conflictRows", "compatibleRowsValid",
    "conflictRecordJsonNull", "conflictEventTimeNull", "cursorMatched", "sourceDay", "sourceWitnessSha256", "associationSha256"])
    && r.method === "effective-telemetry-owner-day-v1" && r.stream === "usage" && hash(r.pageSha256)
    && [r.rows, r.compatibleRows, r.conflictRows].every(integer) && r.rows >= 1 && r.rows <= 200
    && r.compatibleRows + r.conflictRows === r.rows && r.conflictRows >= 1
    && r.compatibleRowsValid === true && r.conflictRecordJsonNull === true && r.conflictEventTimeNull === true && r.cursorMatched === true);
  requireFact(exact(value.fences, ["authorityBeforeSha256", "authorityAfterSha256", "sourceBeforeSha256", "sourceAfterSha256"])
    && Object.values(value.fences).every(hash));
  same(value.fences.authorityBeforeSha256, value.fences.authorityAfterSha256);
  same(value.fences.sourceBeforeSha256, caseOf(binding, CASES[0]).sourceInvariantSha256);
  same(value.fences.sourceAfterSha256, value.fences.sourceBeforeSha256);
  validateSourceWitnesses(sourceWitnesses, binding, CASES[0]);
  validateWindowProofs(windowProofs, sourceWitnesses, binding, CASES[0]);
  const witness = sourceWitnesses.find(w => w.owner === s.owner && w.day === r.sourceDay && w.stream === "usage");
  const window = windowProofs.find(w => w.owner === s.owner && w.day === s.day);
  requireFact(witness && window && r.sourceDay >= window.fromDay && r.sourceDay <= window.throughDay
    && r.sourceWitnessSha256 === currentQ1D7JsonSha256(witness)
    && window.sourceWitnessSha256.includes(r.sourceWitnessSha256));
  const expectedPage = { modelDay: s.day, checkpointMethod: s.checkpointMethod, dependencyDigest: s.dependencyDigest,
    keyDigest: s.keyDigest, headDigest: s.headDigest, cursorSha256: s.cursorSha256, pageSha256: r.pageSha256 };
  requireFact(witness.nativePages.some(page => isDeepStrictEqual(page, expectedPage)));
  same(r.associationSha256, currentQ1D7ConflictAssociationSha256(value, witness));
  return value;
}

/** Digest of the exact current page/source-day/checkpoint association, not
 * execution attestation. Its page must already exist in the independent
 * source witness and its witness must occur in the independent window. */
export function currentQ1D7ConflictAssociationSha256(proof, sourceWitness) {
  return currentQ1D7JsonSha256({ bindingSha256: proof.bindingSha256,
    owner: proof.scope.owner, metric: proof.scope.metric, modelDay: proof.scope.day,
    sourceKind: proof.scope.sourceKind, sourceDay: proof.reader.sourceDay, stream: proof.reader.stream,
    checkpointMethod: proof.scope.checkpointMethod, dependencyDigest: proof.scope.dependencyDigest,
    keyDigest: proof.scope.keyDigest, headDigest: proof.scope.headDigest, cursorSha256: proof.scope.cursorSha256,
    pageSha256: proof.reader.pageSha256, sourceWitnessSha256: currentQ1D7JsonSha256(sourceWitness) });
}

function modelDTO(value) {
  requireFact(object(value) && value.catalogVersion === ADMIN_MODEL_HISTORY_CATALOG_VERSION);
  same(value, projectAdminModelHistoryDay(value));
  requireFact(value.v1ParticipantCount === 4 && value.unsupportedSourceParticipantCount === 0);
}
function native(value, binding, caseId, proofs) {
  requireFact(exact(value, ["owner", "metric", "day", "state", "invocations", "verifiedSha256", "reason", "proofSha256"])
    && OWNERS.includes(value.owner) && value.metric === "model" && caseOf(binding, caseId).modelDays.includes(value.day)
    && integer(value.invocations) && value.invocations >= 1 && value.invocations <= 128);
  if (value.state === "complete") requireFact(hash(value.verifiedSha256) && value.reason === null && value.proofSha256 === null);
  else if (value.state === "not_testable") requireFact(hash(value.verifiedSha256) && MODEL_REASONS.has(value.reason) && value.proofSha256 === null);
  else if (value.state === "expected_source_conflict") {
    requireFact(caseId === CASES[0] && value.verifiedSha256 === null && value.reason === null && hash(value.proofSha256));
    const proof = proofs.find(p => currentQ1D7JsonSha256(p) === value.proofSha256);
    requireFact(proof && proof.scope.owner === value.owner && proof.scope.day === value.day);
  } else requireFact(false);
}
function vector(rows, binding, caseId) {
  requireFact(Array.isArray(rows) && rows.length === 280);
  same(rows.map(row => `${row.owner}/${row.day}`).sort(),
    OWNERS.flatMap(owner => caseOf(binding, caseId).modelDays.map(day => `${owner}/${day}`)).sort());
}

/** Preparation refusal is proved by current canonical reader facts, not by
 * computeAnalyticsV2, ownerRefusals, rehearsal or PG candidate output. */
function validateSourceWitnesses(value, binding, caseId) {
  requireFact(Array.isArray(value));
  if (caseId === CASES[1]) { same(value, []); return; }
  const c = caseOf(binding, caseId), coordinates = c.conflictDays.flatMap(day => ["quota", "session", "usage"].map(stream => `${day}/${stream}`)).sort();
  same(value.map(w => `${w.day}/${w.stream}`).sort(), coordinates);
  for (const w of value) {
    requireFact(exact(w, ["owner", "day", "stream", "method", "pageCount", "rows", "compatibleRows", "conflictRows", "complete",
      "cursorOrderValid", "occurrenceMatched", "compatibleRowsValid", "conflictRecordJsonNull", "conflictEventTimeNull",
      "sourceInvariantSha256", "readerEvidenceSha256", "nativePages"])
      && w.owner === "a" && w.method === "effective-telemetry-owner-day-v1" && integer(w.pageCount) && w.pageCount >= 1 && w.pageCount <= 256
      && [w.rows, w.compatibleRows, w.conflictRows].every(integer) && w.compatibleRows + w.conflictRows === w.rows && w.rows <= w.pageCount * 50
      && w.complete === true && w.cursorOrderValid === true && w.compatibleRowsValid === true
      && w.sourceInvariantSha256 === c.sourceInvariantSha256 && hash(w.readerEvidenceSha256));
    requireFact(Array.isArray(w.nativePages) && w.nativePages.length <= 70
      && new Set(w.nativePages.map(page => page.modelDay)).size === w.nativePages.length);
    for (const page of w.nativePages) requireFact(exact(page, ["modelDay", "checkpointMethod", "dependencyDigest", "keyDigest", "headDigest", "cursorSha256", "pageSha256"])
      && c.modelDays.includes(page.modelDay) && typeof page.checkpointMethod === "string" && /^[A-Za-z0-9._:-]{1,1024}$/u.test(page.checkpointMethod)
      && [page.dependencyDigest, page.keyDigest, page.headDigest, page.cursorSha256, page.pageSha256].every(hash));
    if (w.stream === "usage") requireFact(w.conflictRows === 1 && w.occurrenceMatched === true
      && w.conflictRecordJsonNull === true && w.conflictEventTimeNull === true);
    else requireFact(w.nativePages.length === 0 && w.conflictRows === 0 && w.occurrenceMatched === false
      && w.conflictRecordJsonNull === false && w.conflictEventTimeNull === false);
  }
}
function validateWindowProofs(value, witnesses, binding, caseId) {
  requireFact(Array.isArray(value));
  if (caseId === CASES[1]) { same(value, []); return; }
  const c = caseOf(binding, caseId);
  const affected = c.modelDays.filter(day => c.conflictDays.some(d => d >= new Date(Date.parse(day) - 100 * 86400000).toISOString().slice(0, 10) && d <= day));
  same(value.map(p => p.day), affected);
  for (const p of value) {
    requireFact(exact(p, ["owner", "day", "fromDay", "throughDay", "reason", "derivation", "sourceWindowSha256", "sourceWitnessSha256"])
      && p.owner === "a" && p.reason === "source_window_conflict" && p.derivation === "current-canonical-reader-window-predicate"
      && hash(p.sourceWindowSha256));
    same(p.fromDay, new Date(Date.parse(p.day) - 100 * 86400000).toISOString().slice(0, 10)); same(p.throughDay, p.day);
    same(p.sourceWitnessSha256, witnesses.filter(w => w.day >= p.fromDay && w.day <= p.throughDay).map(currentQ1D7JsonSha256));
    requireFact(p.sourceWitnessSha256.length >= 3);
  }
}

/** Expectation input is current canonical readers/reducers/factories only.
 * These structural claims are not execution attestation. An accepted digest
 * captured BEFORE any candidate run is required for comparison consumption. */
export function validateCurrentQ1D7PerDateExpectation(value, binding, { expectedSha256 } = {}) {
  validateCurrentQ1D7Binding(binding);
  requireFact(exact(value, ["schemaVersion", "caseId", "bindingSha256", "derivation", "producedBeforeCandidate", "candidateInputs",
    "ownerEvidenceSha256", "days", "ownerEvidence", "sourceWitnesses", "windowProofs", "sourceConflictProofs", "unresolved"])
    && value.schemaVersion === CURRENT_Q1_D7_SCHEMAS.expectation && CASES.includes(value.caseId)
    && value.derivation === "current-canonical-reader-reducer-factories" && value.producedBeforeCandidate === true
    && value.candidateInputs === false && hash(expectedSha256) && expectedSha256 === currentQ1D7JsonSha256(value));
  scoped(value, binding, value.caseId); same(value.unresolved, []);
  requireFact(Array.isArray(value.days)); same(value.days.map(row => row.day), caseOf(binding, value.caseId).modelDays);
  for (const row of value.days) modelDTO(row);
  validateSourceWitnesses(value.sourceWitnesses, binding, value.caseId);
  validateWindowProofs(value.windowProofs, value.sourceWitnesses, binding, value.caseId);
  requireFact(Array.isArray(value.sourceConflictProofs));
  if (value.caseId === CASES[1]) same(value.sourceConflictProofs, []);
  for (const proof of value.sourceConflictProofs) validateCurrentQ1D7SourceConflictProof(proof, binding,
    { sourceWitnesses: value.sourceWitnesses, windowProofs: value.windowProofs });
  requireFact(new Set(value.sourceConflictProofs.map(currentQ1D7JsonSha256)).size === value.sourceConflictProofs.length);
  vector(value.ownerEvidence, binding, value.caseId);
  same(value.ownerEvidenceSha256, currentQ1D7JsonSha256(value.ownerEvidence));
  for (const evidence of value.ownerEvidence) {
    requireFact(exact(evidence, ["owner", "day", "classification", "resultSha256", "reason", "windowProofSha256", "conflictProofSha256"])
      && ["fitted", "unstable", "stale", "refused"].includes(evidence.classification));
    if (evidence.conflictProofSha256 !== null) {
      const window = value.windowProofs.find(p => currentQ1D7JsonSha256(p) === evidence.windowProofSha256);
      const origin = value.sourceConflictProofs.find(p => currentQ1D7JsonSha256(p) === evidence.conflictProofSha256);
      requireFact(value.caseId === CASES[0] && evidence.classification === "refused" && evidence.reason === null
        && evidence.resultSha256 === null && window && origin && window.owner === evidence.owner && window.day === evidence.day
        && origin.scope.owner === evidence.owner && origin.scope.day === evidence.day);
    } else requireFact(evidence.windowProofSha256 === null && hash(evidence.resultSha256)
      && (evidence.classification === "refused" ? MODEL_REASONS.has(evidence.reason) : evidence.reason === null));
  }
  for (const proof of value.windowProofs) requireFact(value.ownerEvidence.some(e => e.owner === proof.owner
    && e.day === proof.day && e.windowProofSha256 === currentQ1D7JsonSha256(proof)));
  for (const proof of value.sourceConflictProofs) requireFact(value.ownerEvidence.some(e => e.owner === proof.scope.owner
    && e.day === proof.scope.day && e.conflictProofSha256 === currentQ1D7JsonSha256(proof)));
  for (const row of value.days) {
    const group = value.ownerEvidence.filter(e => e.day === row.day);
    for (const [classification, key] of [["fitted", "fittedParticipantCount"], ["unstable", "unstableParticipantCount"],
      ["stale", "staleParticipantCount"], ["refused", "refusedParticipantCount"]])
      same(row[key], group.filter(e => e.classification === classification).length);
  }
  return value;
}

/** DTO byte equality belongs to the comparator, not this structural gate.
 * Snapshot hashes bind exact producer bytes without broad schema bypasses. */
export function validateCurrentQ1D7CaseReference(value, binding, { expectation, expectedExpectationSha256 } = {}) {
  validateCurrentQ1D7Binding(binding);
  requireFact(exact(value, ["schemaVersion", "caseId", "bindingSha256", "sourceInvariantSha256", "admissionSha256", "graphDays",
    "publicationInventory", "nativeEvidence", "conflictProofs", "currentFits", "strictExport", "state", "unresolved", "snapshot", "snapshotSha256", "pgInputSha256", "bootstrapPreservation"])
    && value.schemaVersion === CURRENT_Q1_D7_SCHEMAS.reference && CASES.includes(value.caseId));
  scoped(value, binding, value.caseId); const c = caseOf(binding, value.caseId);
  same(value.sourceInvariantSha256, { before: c.sourceInvariantSha256, after: c.sourceInvariantSha256 });
  same(value.admissionSha256, c.admissionSha256); same(value.graphDays, c.modelDays);
  requireFact(value.state === "complete"); same(value.unresolved, []);
  requireFact(Array.isArray(value.conflictProofs) && value.conflictProofs.length <= 280);
  validateCurrentQ1D7PerDateExpectation(expectation, binding, { expectedSha256: expectedExpectationSha256 });
  same(expectation.caseId, value.caseId);
  for (const p of value.conflictProofs) validateCurrentQ1D7SourceConflictProof(p, binding,
    { sourceWitnesses: expectation.sourceWitnesses, windowProofs: expectation.windowProofs });
  requireFact(new Set(value.conflictProofs.map(currentQ1D7JsonSha256)).size === value.conflictProofs.length);
  if (value.caseId === CASES[1]) same(value.conflictProofs, []);
  vector(value.nativeEvidence, binding, value.caseId);
  for (const e of value.nativeEvidence) native(e, binding, value.caseId, value.conflictProofs);
  if (value.caseId === CASES[0]) requireFact(value.nativeEvidence.some(e => e.state === "expected_source_conflict"));
  requireFact(value.conflictProofs.every(p => value.nativeEvidence.some(e => e.proofSha256 === currentQ1D7JsonSha256(p))));
  requireFact(Array.isArray(value.publicationInventory)); same(value.publicationInventory.map(e => e.day), c.modelDays);
  for (const p of value.publicationInventory) requireFact(exact(p, ["day", "state", "sha256"])
    && (p.state === "published" && hash(p.sha256) || value.caseId === CASES[0] && p.state === "withheld" && p.sha256 === null));
  if (value.caseId === CASES[0]) requireFact(value.publicationInventory.some(p => p.state === "withheld"));
  requireFact(Array.isArray(value.currentFits) && value.currentFits.length === 4);
  same(value.currentFits.map(e => e.owner).sort(), OWNERS);
  for (const e of value.currentFits) requireFact(exact(e, ["owner", "state", "verifiedSha256"])
    && e.state === "complete" && hash(e.verifiedSha256));
  validateCurrentQ1D7BootstrapPreservation(value.bootstrapPreservation, binding, value.caseId);
  validateCurrentQ1D7StrictExportProof(value.strictExport, binding, value.caseId);
  requireFact(exact(value.snapshot, ["publicResponse", "adminPreview"]) && exact(value.snapshot.publicResponse, ["status", "body"])
    && value.snapshot.publicResponse.status === 200 && object(value.snapshot.publicResponse.body)
    && object(value.snapshot.adminPreview) && hash(value.pgInputSha256) && value.snapshotSha256 === currentQ1D7JsonSha256(value.snapshot));
  validateCurrentQ1D7PerDateExpectation(expectation, binding, { expectedSha256: expectedExpectationSha256 });
  same(expectation.caseId, value.caseId);
  for (const e of value.nativeEvidence.filter(e => e.state !== "expected_source_conflict")) {
    const expected = expectation.ownerEvidence.find(p => p.owner === e.owner && p.day === e.day);
    requireFact(expected && expected.resultSha256 === e.verifiedSha256 && (e.state === "not_testable"
      ? expected.classification === "refused" && expected.reason === e.reason
      : expected.classification !== "refused" && expected.reason === null));
  }
  // Exact native failure and independent current-source window proof must
  // associate the same owner/day. They remain distinct proof routes.
  const unavailable = value.nativeEvidence.filter(e => e.state === "expected_source_conflict");
  const expectedUnavailable = expectation.ownerEvidence.filter(e => e.conflictProofSha256 !== null);
  same(unavailable.map(e => `${e.owner}/${e.day}`).sort(), expectedUnavailable.map(e => `${e.owner}/${e.day}`).sort());
  for (const e of unavailable) requireFact(expectedUnavailable.some(p => p.owner === e.owner && p.day === e.day
    && p.conflictProofSha256 === e.proofSha256));
  const missingDays = [...new Set(unavailable.map(e => e.day))].sort();
  same(value.publicationInventory.filter(p => p.state === "withheld").map(p => p.day), missingDays);
  return value;
}

const BOOTSTRAP_TABLES = ["community_public_source_bootstrap", "community_daily_aggregate_rebuilds", "community_current_analysis_queue"];
const BOOTSTRAP_CAPTURE_KEYS = ["fullSourceCaptureSha256", "sourceInvariantSha256", "schemaSha256", "rawAdmissionsSha256",
  "nonOperationalTablesSha256", "controlsSha256", "auditSha256", "otherSequencesSha256"];
export function currentQ1D7BootstrapTransitionSha256(proof, entry) {
  return currentQ1D7JsonSha256({ caseId: proof.caseId, bindingSha256: proof.bindingSha256,
    admissionSha256: proof.admissionSha256, sourceModuleSha256: proof.sourceModuleSha256,
    operation: proof.operation, table: entry.table, beforeSha256: entry.beforeSha256, afterSha256: entry.afterSha256 });
}
export function currentQ1D7BootstrapRawAdmissionsSha256(proof, capture) {
  return currentQ1D7JsonSha256({ caseId: proof.caseId, admissionSha256: proof.admissionSha256,
    tablesSha256: capture.nonOperationalTablesSha256 });
}

/** Exact canonical bootstrap is a separate preservation proof, never a broad
 * source-invariant waiver. Its full before capture stays owner-private. */
export function validateCurrentQ1D7BootstrapPreservation(value, binding, caseId) {
  validateCurrentQ1D7Binding(binding); const c = caseOf(binding, caseId);
  requireFact(exact(value, ["schemaVersion", "actual", "caseId", "bindingSha256", "admissionSha256", "sourceModuleSha256", "operation",
    "iterations", "pageSize", "completed", "beforeCompleted", "before", "after", "operationalTables", "queueSequence"])
    && value.schemaVersion === "current-q1-d7-bootstrap-preservation-v1" && value.actual === true
    && value.admissionSha256 === c.admissionSha256 && value.operation === "drainCommunityPublicSourceBootstrap"
    && value.sourceModuleSha256 === binding.source.files.find(f => f.path === "apps/worker/src/community-daily-aggregates.ts")?.sha256
    && hash(value.sourceModuleSha256) && integer(value.iterations) && value.iterations >= 1 && value.iterations <= CURRENT_Q1_D7_BOUNDS.bootstrap
    && value.pageSize === 32 && value.completed === true && typeof value.beforeCompleted === "boolean");
  scoped(value, binding, caseId);
  for (const capture of [value.before, value.after]) {
    requireFact(exact(capture, BOOTSTRAP_CAPTURE_KEYS) && Object.values(capture).every(hash));
    same(capture.rawAdmissionsSha256, currentQ1D7BootstrapRawAdmissionsSha256(value, capture));
  }
  for (const key of BOOTSTRAP_CAPTURE_KEYS.filter(k => !["fullSourceCaptureSha256", "sourceInvariantSha256"].includes(k)))
    same(value.before[key], value.after[key]);
  same(value.after.sourceInvariantSha256, c.sourceInvariantSha256);
  requireFact(Array.isArray(value.operationalTables)); same(value.operationalTables.map(t => t.table), BOOTSTRAP_TABLES);
  for (const entry of value.operationalTables) {
    requireFact(exact(entry, ["table", "beforeSha256", "afterSha256", "transitionProofSha256", "transitionVerified"])
      && [entry.beforeSha256, entry.afterSha256, entry.transitionProofSha256].every(hash) && entry.transitionVerified === true);
    same(entry.transitionProofSha256, currentQ1D7BootstrapTransitionSha256(value, entry));
  }
  const q = value.queueSequence;
  requireFact(exact(q, ["table", "before", "after", "transitionProofSha256", "transitionVerified"])
    && q.table === "community_current_analysis_queue" && (q.before === null || integer(q.before))
    && (q.after === null || integer(q.after)) && q.transitionVerified === true
    && (q.before === null || q.after !== null && q.after >= q.before));
  same(q.transitionProofSha256, currentQ1D7BootstrapTransitionSha256(value, { table: "sqlite_sequence:community_current_analysis_queue",
    beforeSha256: currentQ1D7JsonSha256(q.before), afterSha256: currentQ1D7JsonSha256(q.after) }));
  if (value.beforeCompleted) {
    same(value.before, value.after); same(q.before, q.after);
    for (const t of value.operationalTables) same(t.beforeSha256, t.afterSha256);
  } else {
    requireFact(value.operationalTables[0].beforeSha256 !== value.operationalTables[0].afterSha256
      && value.before.fullSourceCaptureSha256 !== value.after.fullSourceCaptureSha256
      && value.before.sourceInvariantSha256 !== value.after.sourceInvariantSha256);
  }
  return value;
}

export function currentQ1D7ExportQueueReceiptSha256(proof) {
  return currentQ1D7JsonSha256({ caseId: proof.caseId, bindingSha256: proof.bindingSha256,
    context: proof.context, queuedRows: proof.queuedRows, orderedQueueDays: proof.orderedQueueDays });
}
/** Negative proof reuses the original closed typed-refusal validator. Positive
 * proof binds a validated full original oracle's digest/context/quiescence.
 * A summary is a structural handoff; runtime validation remains mandatory. */
export function validateCurrentQ1D7StrictExportProof(value, binding, caseId) {
  validateCurrentQ1D7Binding(binding); const c = caseOf(binding, caseId);
  requireFact(exact(value, ["schemaVersion", "actual", "caseId", "bindingSha256", "state", "context", "queuedRows", "orderedQueueDays",
    "queueReceiptSha256", "steps", "refusalProof", "successProof", "receiptSha256"])
    && value.schemaVersion === "current-q1-d7-strict-export-proof-v1" && value.actual === true);
  scoped(value, binding, caseId); const ctx = value.context;
  requireFact(exact(ctx, ["sourceId", "sourceNamespace", "pinnedNowMs", "sourceInvariantSha256", "sourceModuleSha256", "cohortMembers",
    "cohortSha256", "fenceSha256", "selectionSha256"])
    && ctx.sourceId === binding.sourceId && ctx.sourceNamespace === binding.sourceNamespace && ctx.pinnedNowMs === binding.runtime.pinnedNowMs
    && ctx.sourceInvariantSha256 === c.sourceInvariantSha256 && ctx.cohortMembers === 4
    && ctx.sourceModuleSha256 === binding.source.files.find(f => f.path === "apps/worker/src/d1-analytics-export-oracle.ts")?.sha256
    && [ctx.sourceModuleSha256, ctx.cohortSha256, ctx.fenceSha256, ctx.selectionSha256].every(hash));
  same(value.queueReceiptSha256, currentQ1D7ExportQueueReceiptSha256(value));
  if (caseId === CASES[0]) {
    requireFact(value.state === "expected_conflict_refusal" && value.queuedRows === 2 && value.successProof === null);
    same(value.orderedQueueDays, c.conflictDays); same(value.steps, ["fence"]);
    try { validateCurrentQ1StrictExportRefusal(value.refusalProof); } catch { requireFact(false); }
    same(value.receiptSha256, currentQ1D7JsonSha256(value.refusalProof));
  } else {
    requireFact(value.state === "successful" && value.queuedRows === 0 && value.refusalProof === null);
    same(value.orderedQueueDays, []);
    same(value.steps, ["fence", "quiescence", "cohort", "selection", "cache_retention_resume", "daily_forced", "graph_forced", "cache_retention_rebuild"]);
    const proof = value.successProof;
    requireFact(exact(proof, ["schemaVersion", "actual", "oracleSchema", "oracleSha256", "moduleDigest", "context", "quiescence"])
      && proof.schemaVersion === "current-q1-d7-oracle-success-v1" && proof.actual === true
      && proof.oracleSchema === "analytics-history-oracle-v2" && hash(proof.oracleSha256) && proof.moduleDigest === binding.source.sha256);
    same(proof.context, ctx); const q = proof.quiescence;
    requireFact(exact(q, ["queueRows", "staleHeadIdle", "cursorSequence", "journalMax", "deliveredTerminal", "sourceTerminal",
      "pendingErasureJobs", "cacheRetentionIncompleteDays"]) && q.queueRows === 0 && q.staleHeadIdle === true
      && [q.cursorSequence, q.journalMax, q.deliveredTerminal, q.sourceTerminal].every(integer)
      && q.cursorSequence === q.journalMax && q.deliveredTerminal >= q.sourceTerminal
      && q.pendingErasureJobs === 0 && q.cacheRetentionIncompleteDays === 0);
    same(value.receiptSha256, currentQ1D7JsonSha256(proof));
  }
  return value;
}

/** Owner-only local handoff descriptor. File bytes/ownership/sealing are the
 * producer/controller's separate runtime gate; this pure validator never opens
 * files or equates saved metadata with executed export proof. */
export function validateCurrentQ1D7PgCaseInput(value, binding, caseId, { expectedDirectory } = {}) {
  validateCurrentQ1D7Binding(binding); const c = caseOf(binding, caseId);
  requireFact(exact(value, ["schemaVersion", "corpusCaseId", "corpusSha256", "admissionSha256", "sourceId", "sourceNamespace",
    "sourceInvariantSha256", "selectionSha256", "fenceSha256", "ingestion", "journal"])
    && value.schemaVersion === "current-q1-d7-pg-case-input-v1" && value.corpusCaseId === c.corpusCaseId
    && value.corpusSha256 === c.corpusSha256 && value.admissionSha256 === c.admissionSha256
    && value.sourceId === binding.sourceId && value.sourceNamespace === binding.sourceNamespace
    && value.sourceInvariantSha256 === c.sourceInvariantSha256 && [value.selectionSha256, value.fenceSha256].every(hash));
  for (const file of [value.ingestion, value.journal]) requireFact(exact(file, ["path", "sha256", "bytes"])
    && typeof file.path === "string" && isAbsolute(file.path) && normalize(file.path) === file.path && !file.path.includes("\0")
    && hash(file.sha256) && integer(file.bytes) && file.bytes > 0);
  requireFact(value.ingestion.path !== value.journal.path && dirname(value.ingestion.path) === dirname(value.journal.path));
  if (expectedDirectory !== undefined) requireFact(typeof expectedDirectory === "string" && isAbsolute(expectedDirectory)
    && normalize(expectedDirectory) === expectedDirectory && dirname(value.ingestion.path) === expectedDirectory);
  return value;
}

export function assessCurrentQ1D7Qualification({ binding, cases, expectations, expectationSha256, pgInputs }) {
  try {
    validateCurrentQ1D7Binding(binding); requireFact(exact(cases, CASES) && exact(expectations, CASES) && exact(expectationSha256, CASES) && exact(pgInputs, CASES));
    for (const caseId of CASES) {
      same(cases[caseId].caseId, caseId); same(expectations[caseId].caseId, caseId);
      validateCurrentQ1D7PgCaseInput(pgInputs[caseId], binding, caseId);
      same(cases[caseId].pgInputSha256, currentQ1D7JsonSha256(pgInputs[caseId]));
      validateCurrentQ1D7CaseReference(cases[caseId], binding, { expectation: expectations[caseId],
        expectedExpectationSha256: expectationSha256[caseId] });
    }
    return { state: "structurally_complete", establishesNativeExecution: false, reasons: [] };
  } catch { return { state: "unresolved", establishesNativeExecution: false, reasons: ["current_d7_evidence_incomplete"] }; }
}

export function validateCurrentQ1D7ProducerAcceptance(value, { inputBinding, binding, cases, expectations, expectationSha256, pgInputs, expectedController } = {}) {
  validateCurrentQ1D7InputBinding(inputBinding);
  validateCurrentQ1D7Binding(binding, inputBinding);
  const assessment = assessCurrentQ1D7Qualification({ binding, cases, expectations, expectationSha256, pgInputs });
  requireFact(assessment.state === "structurally_complete");
  requireFact(exact(value, ["schemaVersion", "evidenceScope", "cryptographicExecutionAttestation", "actualHelperInvocation",
    "resultReturnedAfterOwnedCleanup", "accepted", "bindingSha256", "inputBindingSha256", "sourceHead", "sourceSha256", "controller", "caseReceipts"])
    && value.schemaVersion === CURRENT_Q1_D7_SCHEMAS.acceptance
    && value.evidenceScope === "direct-source-pinned-producer-controller" && value.cryptographicExecutionAttestation === false
    && value.actualHelperInvocation === true && value.resultReturnedAfterOwnedCleanup === true && value.accepted === true
    && value.bindingSha256 === currentQ1D7JsonSha256(binding) && value.inputBindingSha256 === currentQ1D7JsonSha256(inputBinding) && value.sourceHead === binding.source.head
    && value.sourceSha256 === binding.source.sha256);
  const pinnedController = binding.source.files.find(file => file.path === "apps/worker/scripts/gcp-fastpath-rehearsal.mjs");
  requireFact(pinnedController && exact(pinnedController, ["path", "sha256"]) && hash(pinnedController.sha256));
  same(value.controller, pinnedController);
  if (expectedController !== undefined) same(expectedController, pinnedController);
  requireFact(exact(value.caseReceipts, CASES));
  for (const caseId of CASES) {
    const r = value.caseReceipts[caseId];
    requireFact(exact(r, ["referenceSha256", "expectationSha256", "corpusSha256", "admissionSha256", "sourceInvariantSha256", "pgInputSha256", "bootstrapPreservationSha256", "strictExportSha256"]));
    same(r, { referenceSha256: currentQ1D7JsonSha256(cases[caseId]), expectationSha256: expectationSha256[caseId],
      corpusSha256: caseOf(binding, caseId).corpusSha256, admissionSha256: caseOf(binding, caseId).admissionSha256,
      sourceInvariantSha256: caseOf(binding, caseId).sourceInvariantSha256, pgInputSha256: currentQ1D7JsonSha256(pgInputs[caseId]),
      bootstrapPreservationSha256: currentQ1D7JsonSha256(cases[caseId].bootstrapPreservation),
      strictExportSha256: currentQ1D7JsonSha256(cases[caseId].strictExport) });
  }
  return { acceptance: value, establishesNativeExecution: false };
}
