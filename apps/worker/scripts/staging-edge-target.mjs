import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { identityDigest, operationError } from "../../../scripts/lib/release-operation.mjs";
import {
  EDGE_MODE_PRODUCTION_HOSTNAMES,
  EDGE_MODE_PRODUCTION_RELEASE_GUARD_DATABASE_NAME,
  EDGE_MODE_PRODUCTION_WORKER_NAME,
  EDGE_MODE_RELEASE_GUARD_BINDING,
  EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR,
  applyEdgeModeStagingOverlay,
  applyEdgeModeStagingSnapshotDelta,
  edgeModeOverlaySha256,
  edgeModeStagingProductionReferences,
  normalizeEdgeModePlan,
} from "./edge-mode-configuration.mjs";
import {
  FENCE_D1_LABELS,
  FENCE_MIN_QUIET_WINDOW_MINUTES,
  FENCE_PLAN_SCHEMA,
  FENCE_R2_BINDING,
  validateCloudflareWriterFencePlan,
} from "./cloudflare-writer-fence.mjs";
import { createProductionLiveConfigSnapshot } from "./production-live-config.mjs";

/**
 * The staging edge target (STG-DRV): the committed template and its private,
 * non-secret inputs, the production isolation inputs and the refusals they
 * drive (one set of rules for render and deploy), the genesis snapshot, the
 * EP-9 staging overlay bound to its isolation inputs, the operation-target
 * check, and the EP-8 fence plan and gcp plan wrappers.
 *
 * Inputs carry staging resource identifiers, an Access AUD and an email; they
 * are owner-private. Nothing here logs, writes a file or puts a value into an
 * error: errors carry a stable code only. No secret is ever an input.
 */

export const STAGING_EDGE_WORKER_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STAGING_EDGE_TEMPLATE_PATH = join(STAGING_EDGE_WORKER_DIRECTORY, "ops", "staging-edge",
  "staging-edge.template.jsonc");
export const STAGING_EDGE_INPUTS_EXAMPLE_PATH = join(STAGING_EDGE_WORKER_DIRECTORY, "ops", "staging-edge",
  "staging-edge-inputs.example.json");
export const STAGING_EDGE_TEMPLATE_SCHEMA = "staging-edge-template-v1";
export const STAGING_EDGE_INPUTS_SCHEMA = "staging-edge-inputs-v1";
export const STAGING_EDGE_RATE_LIMIT_PROFILES = Object.freeze(["rehearsal", "load"]);
/** The checked-in configs whose Workers, D1s, buckets and hosts staging must never name. */
export const STAGING_EDGE_TRACKED_CONFIG_FILES = Object.freeze(["wrangler.jsonc", "wrangler.dogfood.jsonc"]);
/** The existing staging Worker is not reusable (plan finding 2): it is refused like production. */
export const STAGING_EDGE_REFUSED_WORKER_NAMES = Object.freeze([
  EDGE_MODE_PRODUCTION_WORKER_NAME,
  "app-usagemonitor-staging",
]);
/** The genesis snapshot's version id: no live version exists before the first deploy. */
export const STAGING_EDGE_GENESIS_VERSION_ID = "00000000-0000-4000-8000-000000000000";
const GENESIS_NAMESPACE_ID = "staging-edge-genesis-namespace";
const STAGING_RATE_LIMIT_BINDINGS = Object.freeze([
  "ENROLLMENT_RATE_LIMIT", "RECOVERY_RATE_LIMIT", "CLIENT_ATTEMPT_RATE_LIMIT", "PUBLIC_READ_RATE_LIMIT",
  "UPLOAD_AUTHORIZATION_RATE_LIMIT", "UPLOAD_PRINCIPAL_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT", "PUBLIC_PROBE_RATE_LIMIT", "PUBLIC_PROBE_CLIENT_RATE_LIMIT",
  "SPARKLE_APPCAST_GUARD_RATE_LIMIT",
]);
const OPERATIONAL_RATE_LIMITS = Object.freeze({
  PUBLIC_PROBE_RATE_LIMIT: 60, PUBLIC_PROBE_CLIENT_RATE_LIMIT: 12, SPARKLE_APPCAST_GUARD_RATE_LIMIT: 60,
});

/** The two migration ledgers a staging D1 can carry: Wrangler's and the d1-storage runner's. */
export const STAGING_EDGE_WRANGLER_LEDGER = "d1_migrations";
export const STAGING_EDGE_STORAGE_LEDGER = "d1_storage_migrations";

/**
 * D1 roles: input key, binding, migrations directory (relative to apps/worker)
 * and the ledger that applies them.
 *
 * Analytics takes production's ledger: production's analytics D1 was built by
 * the d1-storage runner and records `d1_storage_migrations` (no
 * `d1_migrations`), and Wrangler's `migrations apply --remote` cannot apply its
 * triggers (its statement splitter ends a trigger at a `CASE ... END;`). Its
 * storage role is `analytics`, the runner's qualified analytics directory.
 *
 * The other roles keep Wrangler's ledger. Ingestion is deliberate: production's
 * ingestion ledger is the typed restore base (`ingestion-restore-base-v1`, 13
 * storage rows), a schema the JSON-topology staging Worker (D-S7) cannot run;
 * staging ingestion carries the `migrations/` chain the JSON Worker needs and
 * makes no ledger-parity claim. The release-guard gate reads Wrangler's ledger
 * (`determinePendingD1Migrations`), and production's deletion ledger and
 * catch-up control D1 are not storage-runner databases.
 */
export const STAGING_EDGE_D1_ROLES = Object.freeze([
  Object.freeze({ key: "ingestion", binding: "USAGE_MONITOR_DB", migrationsDir: "migrations", fenceLabel: "ingestion",
    ledger: STAGING_EDGE_WRANGLER_LEDGER, storageRole: null }),
  Object.freeze({ key: "analytics", binding: "ANALYTICS_DB", migrationsDir: "analytics-migrations", fenceLabel: "analytics",
    ledger: STAGING_EDGE_STORAGE_LEDGER, storageRole: "analytics" }),
  Object.freeze({ key: "deletionLedger", binding: "DELETION_LEDGER", migrationsDir: "deletion-ledger-migrations",
    fenceLabel: "deletion-ledger", ledger: STAGING_EDGE_WRANGLER_LEDGER, storageRole: null }),
  Object.freeze({ key: "catchupControl", binding: "STORAGE_ANALYTICS_CATCHUP_CONTROL_DB",
    migrationsDir: "ops/staging-edge/catchup-standin/migrations", fenceLabel: "catchup-control",
    ledger: STAGING_EDGE_WRANGLER_LEDGER, storageRole: null }),
  Object.freeze({ key: "releaseGuard", binding: EDGE_MODE_RELEASE_GUARD_BINDING,
    migrationsDir: EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR, fenceLabel: null,
    ledger: STAGING_EDGE_WRANGLER_LEDGER, storageRole: null }),
]);

/** The input key of a role, from its key or its hyphenated file form (`deletion-ledger`). */
function stagingEdgeRole(name) {
  const role = STAGING_EDGE_D1_ROLES.find((entry) => entry.key === name
    || entry.key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`) === name);
  return role ?? fail("D1_ROLE_UNKNOWN");
}

/**
 * The only tool that may apply a role's migrations. Wrangler is refused for a
 * storage-ledger role (analytics), and the storage runner for the others, so
 * no rendered command or config can write the wrong ledger.
 */
export function stagingEdgeMigrationTool(roleName, tool) {
  const role = stagingEdgeRole(roleName);
  if (tool === "wrangler" && role.ledger === STAGING_EDGE_STORAGE_LEDGER) fail("MIGRATION_REQUIRES_STORAGE_RUNNER");
  if (tool === "storage" && role.ledger !== STAGING_EDGE_STORAGE_LEDGER) fail("MIGRATION_REQUIRES_WRANGLER");
  if (tool !== "wrangler" && tool !== "storage") fail("MIGRATION_TOOL_INVALID");
  return role;
}

const HEX32 = /^[0-9a-f]{32}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ACCESS_TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const CRON = /^\S+(?:\s+\S+){4}$/u;
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/gu;
const INPUT_KEYS = Object.freeze(["access", "accountId", "d1", "edgeWorkerName", "origin", "publicHostname",
  "quietWindowMinutes", "r2", "rateLimitProfile", "schema", "standInCron", "standInWorkerName"]);
const ORIGIN_KEYS = new Set(["invokerServiceAccount", "originAudience", "upstreamHeadersTimeoutSeconds", "upstreamOrigin"]);

function fail(code) {
  throw operationError(`STAGING_EDGE_${code}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!object(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail(code);
}

function stagingName(value, code) {
  if (typeof value !== "string" || !RESOURCE_NAME.test(value) || !value.includes("staging")) fail(code);
  return value;
}

function hostname(value) {
  if (typeof value !== "string" || value.length > 253) fail("INPUTS_INVALID");
  const labels = value.split(".");
  if (labels.length < 3 || labels.some((label) => !HOST_LABEL.test(label))
      || !labels.slice(0, -2).some((label) => label.includes("staging"))) {
    fail("HOSTNAME_NOT_STAGING");
  }
  return value;
}

/**
 * Validate the owner's private inputs (closed schema). Every Worker, D1 and
 * bucket name must contain "staging", the public hostname needs a "staging"
 * label below its zone, and `origin` is null until the staging origin exists.
 */
export function parseStagingEdgeInputs(value) {
  exactKeys(value, INPUT_KEYS, "INPUTS_INVALID");
  if (value.schema !== STAGING_EDGE_INPUTS_SCHEMA || !HEX32.test(value.accountId ?? "")) fail("INPUTS_INVALID");
  const edgeWorkerName = stagingName(value.edgeWorkerName, "NAME_NOT_STAGING");
  const standInWorkerName = stagingName(value.standInWorkerName, "NAME_NOT_STAGING");
  if (edgeWorkerName === standInWorkerName) fail("INPUTS_INVALID");
  const publicHostname = hostname(value.publicHostname);
  exactKeys(value.access, ["adminEmail", "aud", "teamDomain"], "INPUTS_INVALID");
  if (!ACCESS_TEAM_DOMAIN.test(value.access.teamDomain ?? "") || !HEX64.test(value.access.aud ?? "")
      || typeof value.access.adminEmail !== "string" || value.access.adminEmail.length > 254
      || !EMAIL.test(value.access.adminEmail)) {
    fail("INPUTS_INVALID");
  }
  exactKeys(value.d1, STAGING_EDGE_D1_ROLES.map((role) => role.key), "INPUTS_INVALID");
  const d1 = {};
  for (const role of STAGING_EDGE_D1_ROLES) {
    const entry = value.d1[role.key];
    exactKeys(entry, ["id", "name"], "INPUTS_INVALID");
    if (!UUID.test(entry.id ?? "")) fail("INPUTS_INVALID");
    d1[role.key] = Object.freeze({ id: entry.id, name: stagingName(entry.name, "NAME_NOT_STAGING") });
  }
  const databases = Object.values(d1);
  if (new Set(databases.map((entry) => entry.id)).size !== databases.length
      || new Set(databases.map((entry) => entry.name)).size !== databases.length) {
    fail("INPUTS_INVALID");
  }
  exactKeys(value.r2, ["quarantine", "sparkleReleases"], "INPUTS_INVALID");
  const r2 = Object.freeze({
    quarantine: stagingName(value.r2.quarantine, "NAME_NOT_STAGING"),
    sparkleReleases: stagingName(value.r2.sparkleReleases, "NAME_NOT_STAGING"),
  });
  if (r2.quarantine === r2.sparkleReleases) fail("INPUTS_INVALID");
  if (!STAGING_EDGE_RATE_LIMIT_PROFILES.includes(value.rateLimitProfile)) fail("INPUTS_INVALID");
  if (typeof value.standInCron !== "string" || value.standInCron.length > 64 || !CRON.test(value.standInCron)) {
    fail("INPUTS_INVALID");
  }
  if (!Number.isSafeInteger(value.quietWindowMinutes) || value.quietWindowMinutes < FENCE_MIN_QUIET_WINDOW_MINUTES
      || value.quietWindowMinutes > 1_440) {
    fail("INPUTS_INVALID");
  }
  let origin = null;
  if (value.origin !== null) {
    if (!object(value.origin) || Object.keys(value.origin).some((key) => !ORIGIN_KEYS.has(key))) fail("INPUTS_INVALID");
    origin = Object.freeze({ ...value.origin });
  }
  const parsed = Object.freeze({
    schema: STAGING_EDGE_INPUTS_SCHEMA,
    accountId: value.accountId,
    edgeWorkerName,
    standInWorkerName,
    publicHostname,
    adminHostname: `admin.${publicHostname}`,
    access: Object.freeze({ ...value.access }),
    d1: Object.freeze(d1),
    r2,
    rateLimitProfile: value.rateLimitProfile,
    standInCron: value.standInCron,
    quietWindowMinutes: value.quietWindowMinutes,
    origin,
  });
  PARSED_INPUTS.add(parsed);
  return parsed;
}

const PARSED_INPUTS = new WeakSet();

/** Parsed inputs as they are, or raw inputs through parseStagingEdgeInputs. */
export function resolveStagingEdgeInputs(inputs) {
  return object(inputs) && PARSED_INPUTS.has(inputs) ? inputs : parseStagingEdgeInputs(inputs);
}

const parsedInputs = resolveStagingEdgeInputs;

function environments(config) {
  if (!object(config)) fail("TRACKED_CONFIG_INVALID");
  const envs = object(config.env) ? Object.values(config.env) : [];
  if (envs.some((environment) => !object(environment))) fail("TRACKED_CONFIG_INVALID");
  return [config, ...envs];
}

function routeHost(route) {
  const pattern = typeof route === "string" ? route : route?.pattern;
  return typeof pattern === "string" ? pattern.split("/", 1)[0].replace(/^\*\.?/u, "").toLowerCase() : null;
}

function addAll(set, values) {
  for (const value of values) if (typeof value === "string" && value.length > 0) set.add(value);
}

/** The fixed reserved names and every environment of the checked-in configs. */
function trackedReferences(trackedConfigs) {
  if (!Array.isArray(trackedConfigs) || trackedConfigs.length === 0) fail("TRACKED_CONFIG_INVALID");
  const references = {
    workerNames: new Set(STAGING_EDGE_REFUSED_WORKER_NAMES),
    hostnames: new Set(EDGE_MODE_PRODUCTION_HOSTNAMES),
    databaseIds: new Set(),
    databaseNames: new Set([EDGE_MODE_PRODUCTION_RELEASE_GUARD_DATABASE_NAME]),
    bucketNames: new Set(),
    rateLimitNamespaces: new Set(),
    values: new Set(),
  };
  for (const config of trackedConfigs) {
    for (const environment of environments(config)) {
      addAll(references.workerNames, [environment.name]);
      for (const entry of Array.isArray(environment.d1_databases) ? environment.d1_databases : []) {
        addAll(references.databaseIds, [entry?.database_id]);
        addAll(references.databaseNames, [entry?.database_name]);
      }
      for (const entry of Array.isArray(environment.r2_buckets) ? environment.r2_buckets : []) {
        addAll(references.bucketNames, [entry?.bucket_name]);
      }
      for (const entry of Array.isArray(environment.ratelimits) ? environment.ratelimits : []) {
        addAll(references.rateLimitNamespaces, [String(entry?.namespace_id ?? "")]);
      }
      for (const route of Array.isArray(environment.routes) ? environment.routes : []) {
        addAll(references.hostnames, [routeHost(route)]);
      }
      for (const [name, text] of Object.entries(object(environment.vars) ? environment.vars : {})) {
        if (name.endsWith("_BUCKET")) addAll(references.bucketNames, [text]);
      }
    }
  }
  return references;
}

/**
 * A production capture: the production Worker's own, in the account the
 * staging edge shares with production (its Custom Domains sit in the
 * production zone). Another Worker's or another account's capture would empty
 * the refused set of every live production reference, so it is refused.
 */
function productionCapture(inventory, accountId) {
  let snapshot;
  try {
    snapshot = createProductionLiveConfigSnapshot(inventory);
  } catch {
    return fail("PRODUCTION_INPUT_INVALID");
  }
  if (snapshot.workerName !== EDGE_MODE_PRODUCTION_WORKER_NAME) fail("PRODUCTION_INVENTORY_NOT_PRODUCTION");
  if (snapshot.accountId !== accountId) fail("PRODUCTION_ACCOUNT_MISMATCH");
  return snapshot;
}

/**
 * The owner-private production EP-8 fence plan, validated by the fence's own
 * validator. It is the only evidence of the production data resources that
 * the production Worker does not bind (the catch-up control D1) and of the
 * other production writers. Its production Worker and account must be
 * production's, and every label production binds (ingestion, analytics,
 * deletion-ledger, the quarantine bucket) must be what the production
 * captures bind, which is EP-8's own label rule.
 */
function productionFencePlan(plan, accountId, snapshots) {
  let validated;
  try {
    validated = validateCloudflareWriterFencePlan(plan);
  } catch {
    return fail("PRODUCTION_FENCE_PLAN_INVALID");
  }
  if (validated.productionWorker !== EDGE_MODE_PRODUCTION_WORKER_NAME || validated.accountId !== accountId) {
    fail("PRODUCTION_FENCE_PLAN_MISMATCH");
  }
  const proven = new Set();
  for (const snapshot of snapshots) {
    for (const binding of snapshot.bindings) {
      const label = Object.keys(FENCE_D1_LABELS).find((key) => FENCE_D1_LABELS[key].owner === "production"
        && FENCE_D1_LABELS[key].binding === binding.name);
      if (binding.type === "d1" && label !== undefined) {
        if (binding.database_id !== validated.d1[label]) fail("PRODUCTION_FENCE_PLAN_MISMATCH");
        proven.add(label);
      }
      if (binding.type === "r2_bucket" && binding.name === FENCE_R2_BINDING) {
        if (binding.bucket_name !== validated.r2.bucket) fail("PRODUCTION_FENCE_PLAN_MISMATCH");
        proven.add(FENCE_R2_BINDING);
      }
    }
  }
  const required = [...Object.keys(FENCE_D1_LABELS).filter((key) => FENCE_D1_LABELS[key].owner === "production"),
    FENCE_R2_BINDING];
  if (required.some((label) => !proven.has(label))) fail("PRODUCTION_FENCE_PLAN_MISMATCH");
  return validated;
}

/**
 * The production isolation inputs every render and every deploy take, under
 * one set of rules, and the references a staging target must not name:
 *
 * - the fixed reserved names and every environment of the checked-in configs;
 * - EP-9's references (edgeModeStagingProductionReferences): the production
 *   capture and the optional pre-gcp baseline, each the production Worker's in
 *   the staging account, with EP-9's own rules (a baseline after the gcp
 *   switch, the production gcp plan or an explicit null, refused once
 *   production binds gcp values);
 * - the production EP-8 fence plan: its four D1s (including the catch-up
 *   control D1 only another production Worker binds), its bucket and every
 *   script it names.
 */
export function resolveStagingEdgeIsolation({
  inputs, trackedConfigs, productionInventory, productionBaselineInventory, productionPlan, productionFencePlan: fencePlan,
} = {}) {
  const target = parsedInputs(inputs);
  const references = trackedReferences(trackedConfigs);
  const productionSnapshot = productionCapture(productionInventory, target.accountId);
  const productionBaselineSnapshot = productionBaselineInventory === undefined
    ? undefined
    : productionCapture(productionBaselineInventory, target.accountId);
  if (productionPlan === undefined) fail("PRODUCTION_INPUT_INVALID");
  const production = edgeModeStagingProductionReferences({
    productionSnapshot, productionBaselineSnapshot, productionPlan, trackedConfig: trackedConfigs[0],
    stagingAccountId: target.accountId,
  });
  addAll(references.workerNames, production.workerNames);
  addAll(references.hostnames, production.hosts);
  addAll(references.databaseIds, production.databaseIds);
  addAll(references.databaseNames, production.databaseNames);
  addAll(references.bucketNames, production.bucketNames);
  addAll(references.rateLimitNamespaces, production.rateLimitNamespaces);
  addAll(references.values, production.values);
  const fence = productionFencePlan(fencePlan, target.accountId,
    [productionSnapshot, ...(productionBaselineSnapshot === undefined ? [] : [productionBaselineSnapshot])]);
  addAll(references.workerNames, [fence.productionWorker, ...fence.fencedScripts.map((script) => script.name),
    ...fence.outOfScopeScripts.map((script) => script.name)]);
  addAll(references.databaseIds, Object.values(fence.d1));
  addAll(references.bucketNames, [fence.r2.bucket]);
  return Object.freeze({
    target,
    productionSnapshot,
    productionBaselineSnapshot,
    productionPlan,
    productionFencePlanSha256: fence.planSha256,
    references,
  });
}

function originHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuse a staging target that names any production reference, before
 * anything is rendered, and return its resolved isolation. Render and deploy
 * both run it with the same inputs. EP-9's overlay repeats the check on the
 * rendered config, the live staging snapshot and the gcp plan; this one also
 * covers the stand-in Worker, the catch-up and guard D1s, the rate-limit
 * profile and the origin values before any of them is written.
 */
export function assertStagingEdgeTarget({ inputs, template, trackedConfigs, ...production } = {}) {
  const isolation = resolveStagingEdgeIsolation({ inputs, trackedConfigs, ...production });
  const { target, references } = isolation;
  if ([target.edgeWorkerName, target.standInWorkerName].some((name) => references.workerNames.has(name))) {
    fail("PRODUCTION_WORKER");
  }
  if ([target.publicHostname, target.adminHostname].some((host) => references.hostnames.has(host))) {
    fail("PRODUCTION_HOSTNAME");
  }
  const databases = Object.values(target.d1);
  if (databases.some((entry) => references.databaseIds.has(entry.id) || references.databaseNames.has(entry.name))) {
    fail("PRODUCTION_DATABASE");
  }
  if ([target.r2.quarantine, target.r2.sparkleReleases].some((bucket) => references.bucketNames.has(bucket))) {
    fail("PRODUCTION_BUCKET");
  }
  if (target.origin !== null) {
    const values = [target.origin.upstreamOrigin, target.origin.originAudience, target.origin.invokerServiceAccount];
    if (values.some((value) => references.values.has(value))
        || [target.origin.upstreamOrigin, target.origin.originAudience].some((value) => references.hostnames.has(originHost(value)))) {
      fail("PRODUCTION_ORIGIN");
    }
  }
  if (template !== undefined) {
    const profile = templateProfile(template, target.rateLimitProfile);
    if (profile.some((entry) => references.rateLimitNamespaces.has(entry.namespace_id))) fail("PRODUCTION_RATE_LIMIT");
  }
  return isolation;
}

/**
 * The checks an executed operation's own target.json must pass before any
 * read with the operator's token: a staging-named Worker in a valid account
 * that is not a reserved or checked-in Worker, with staging domains only.
 */
export function assertStagingOperationTarget({ target, trackedConfigs } = {}) {
  exactKeys(target, ["accountId", "edgeWorkerName", "expectedDomains"], "OPERATION_TARGET_INVALID");
  if (!HEX32.test(target.accountId ?? "") || !Array.isArray(target.expectedDomains)
      || target.expectedDomains.length > 2) {
    fail("OPERATION_TARGET_INVALID");
  }
  const references = trackedReferences(trackedConfigs);
  if (references.workerNames.has(stagingName(target.edgeWorkerName, "NAME_NOT_STAGING"))) fail("PRODUCTION_WORKER");
  if (target.expectedDomains.some((host) => references.hostnames.has(hostname(host)))) fail("PRODUCTION_HOSTNAME");
  return target;
}

/** Parse the committed template (JSONC). */
export function parseStagingEdgeTemplate(text) {
  const errors = [];
  const value = parse(text, errors);
  if (errors.length > 0 || !object(value) || value.schema !== STAGING_EDGE_TEMPLATE_SCHEMA
      || !object(value.edgeWorker) || !object(value.standInWorker) || !object(value.rateLimitProfiles)) {
    fail("TEMPLATE_INVALID");
  }
  for (const profile of STAGING_EDGE_RATE_LIMIT_PROFILES) templateProfile(value, profile);
  return value;
}

export async function readStagingEdgeTemplate(path = STAGING_EDGE_TEMPLATE_PATH) {
  return parseStagingEdgeTemplate(await readFile(path, "utf8"));
}

export async function readStagingEdgeTrackedConfigs(workerDirectory = STAGING_EDGE_WORKER_DIRECTORY) {
  const configs = [];
  for (const file of STAGING_EDGE_TRACKED_CONFIG_FILES) {
    const errors = [];
    const config = parse(await readFile(join(workerDirectory, file), "utf8"), errors);
    if (errors.length > 0 || !object(config)) fail("TRACKED_CONFIG_INVALID");
    configs.push(config);
  }
  return configs;
}

function templateProfile(template, name) {
  const profile = template?.rateLimitProfiles?.[name];
  if (!Array.isArray(profile) || profile.length !== STAGING_RATE_LIMIT_BINDINGS.length
      || profile.some((entry) => !object(entry) || typeof entry.name !== "string"
        || typeof entry.namespace_id !== "string" || !object(entry.simple))
      || new Set(profile.map((entry) => entry.name)).size !== STAGING_RATE_LIMIT_BINDINGS.length
      || new Set(profile.map((entry) => entry.namespace_id)).size !== STAGING_RATE_LIMIT_BINDINGS.length
      || STAGING_RATE_LIMIT_BINDINGS.some((name) => !profile.some((entry) => entry.name === name))
      || profile.some((entry) => Object.hasOwn(OPERATIONAL_RATE_LIMITS, entry.name)
        && (entry.simple.limit !== OPERATIONAL_RATE_LIMITS[entry.name] || entry.simple.period !== 60))) {
    fail("TEMPLATE_INVALID");
  }
  return profile;
}

function substitute(value, values) {
  if (typeof value === "string") {
    const whole = /^\{\{([A-Z0-9_]+)\}\}$/u.exec(value);
    if (whole !== null && Object.hasOwn(values, whole[1]) && typeof values[whole[1]] !== "string") {
      return structuredClone(values[whole[1]]);
    }
    return value.replace(PLACEHOLDER, (match, name) => {
      if (!Object.hasOwn(values, name) || typeof values[name] !== "string") fail("TEMPLATE_PLACEHOLDER_UNRESOLVED");
      return values[name];
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, values));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, values)]));
  return value;
}

function absoluteMigrationConfig({ inputs, role, workerDirectory }) {
  const database = inputs.d1[role.key];
  return {
    name: `${inputs.edgeWorkerName}-migrations-${role.key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
    account_id: inputs.accountId,
    compatibility_date: "2026-07-26",
    d1_databases: [{
      binding: role.binding,
      database_name: database.name,
      database_id: database.id,
      migrations_dir: join(workerDirectory, role.migrationsDir),
    }],
  };
}

/**
 * Render the committed template with the private inputs: the staging edge
 * config the typed render rebuilds (env.production holds the staging Worker),
 * the stand-in Worker config, one Wrangler migration config per Wrangler-ledger
 * D1 and one storage-runner target per storage-ledger D1. Paths a Wrangler
 * config outside the repository needs (the stand-in's main and every
 * migrations_dir) are made absolute; the edge config keeps its repository-
 * relative main and assets, which the candidate writer resolves.
 */
export function renderStagingEdgeTemplate({ template, inputs, workerDirectory = STAGING_EDGE_WORKER_DIRECTORY } = {}) {
  const target = parsedInputs(inputs);
  const parsedTemplate = object(template) && template.schema === STAGING_EDGE_TEMPLATE_SCHEMA
    ? template
    : fail("TEMPLATE_INVALID");
  const values = {
    ACCOUNT_ID: target.accountId,
    EDGE_WORKER_NAME: target.edgeWorkerName,
    STAND_IN_WORKER_NAME: target.standInWorkerName,
    PUBLIC_HOSTNAME: target.publicHostname,
    ADMIN_HOSTNAME: target.adminHostname,
    ACCESS_TEAM_DOMAIN: target.access.teamDomain,
    ACCESS_AUD: target.access.aud,
    ACCESS_ADMIN_EMAIL: target.access.adminEmail,
    D1_INGESTION_NAME: target.d1.ingestion.name,
    D1_INGESTION_ID: target.d1.ingestion.id,
    D1_ANALYTICS_NAME: target.d1.analytics.name,
    D1_ANALYTICS_ID: target.d1.analytics.id,
    D1_DELETION_LEDGER_NAME: target.d1.deletionLedger.name,
    D1_DELETION_LEDGER_ID: target.d1.deletionLedger.id,
    D1_CATCHUP_CONTROL_NAME: target.d1.catchupControl.name,
    D1_CATCHUP_CONTROL_ID: target.d1.catchupControl.id,
    R2_QUARANTINE: target.r2.quarantine,
    R2_SPARKLE_RELEASES: target.r2.sparkleReleases,
    STAND_IN_CRON: target.standInCron,
    RATE_LIMITS: templateProfile(parsedTemplate, target.rateLimitProfile),
  };
  const edgeTracked = substitute(parsedTemplate.edgeWorker, values);
  const standIn = substitute(parsedTemplate.standInWorker, values);
  if (JSON.stringify([edgeTracked, standIn]).includes("{{")) fail("TEMPLATE_PLACEHOLDER_UNRESOLVED");
  if (!object(edgeTracked.env?.production) || edgeTracked.env.production.name !== target.edgeWorkerName
      || edgeTracked.name !== target.edgeWorkerName || standIn.name !== target.standInWorkerName) {
    fail("TEMPLATE_INVALID");
  }
  standIn.main = join(workerDirectory, standIn.main);
  for (const database of standIn.d1_databases) database.migrations_dir = join(workerDirectory, database.migrations_dir);
  // A Wrangler migration config (with a migrations_dir) exists only for a
  // Wrangler-ledger role; a storage-ledger role gets a runner target instead.
  const migrationConfigs = STAGING_EDGE_D1_ROLES.filter((role) => role.ledger === STAGING_EDGE_WRANGLER_LEDGER)
    .map((role) => Object.freeze({
      role: stagingEdgeMigrationTool(role.key, "wrangler").key,
      binding: role.binding,
      databaseName: target.d1[role.key].name,
      config: absoluteMigrationConfig({ inputs: target, role, workerDirectory }),
    }));
  const storageTargets = STAGING_EDGE_D1_ROLES.filter((role) => role.ledger === STAGING_EDGE_STORAGE_LEDGER)
    .map((role) => Object.freeze({
      role: stagingEdgeMigrationTool(role.key, "storage").key,
      storageRole: role.storageRole,
      binding: role.binding,
      databaseName: target.d1[role.key].name,
      ledger: role.ledger,
    }));
  return Object.freeze({ inputs: target, edgeTracked, standIn, migrationConfigs: Object.freeze(migrationConfigs),
    storageTargets: Object.freeze(storageTargets) });
}

function rawInventory(snapshotLike) {
  const bindings = snapshotLike.bindings.map((binding) => binding.type === "d1"
    ? { ...binding, id: binding.database_id }
    : binding);
  return {
    accountId: snapshotLike.accountId,
    workerName: snapshotLike.workerName,
    version: { id: snapshotLike.versionId, resources: { script_runtime: snapshotLike.runtime, bindings } },
    settings: {
      ...snapshotLike.settings,
      compatibility_date: snapshotLike.runtime.compatibility_date,
      compatibility_flags: snapshotLike.runtime.compatibility_flags,
      usage_model: snapshotLike.runtime.usage_model,
      limits: snapshotLike.runtime.limits,
      cache_options: snapshotLike.runtime.cache_options,
      bindings,
    },
    schedules: { schedules: snapshotLike.crons.map((cron) => ({ cron })) },
    subdomain: snapshotLike.subdomain,
    routes: snapshotLike.routes,
    domains: snapshotLike.domains,
    namespaces: snapshotLike.namespaces,
  };
}

/** The provider-shaped inventory of a typed snapshot (the inverse of createProductionLiveConfigSnapshot). */
export function stagingEdgeInventoryOf(snapshot) {
  if (!object(snapshot) || !Array.isArray(snapshot.bindings)) fail("SNAPSHOT_INVALID");
  return rawInventory(snapshot);
}

/**
 * The declared snapshot of the rendered staging config before its first
 * deploy: what a live capture of exactly that config would read, with a fixed
 * genesis version id and Durable Object namespace and no
 * DEPLOYMENT_SOURCE_COMMIT or EDGE_UPSTREAM_MODE (so its live mode is null and
 * only null -> worker reaches it). It carries the declared secret names; the
 * genesis deploy installs them from the owner's --secrets-file. Observability
 * stays the declared form: the genesis live check compares the candidate
 * config with the capture, where only Cloudflare's pinned observability
 * defaults (production-live-config.mjs) fill an undeclared field.
 */
export function createStagingGenesisInventory({ edgeTracked, inputs } = {}) {
  const target = parsedInputs(inputs);
  const environment = edgeTracked?.env?.production;
  if (!object(environment) || environment.name !== target.edgeWorkerName) fail("TEMPLATE_INVALID");
  const migrations = environment.migrations ?? edgeTracked.migrations;
  const bindings = [
    ...Object.entries(environment.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    ...environment.secrets.required.map((name) => ({ name, type: "secret_text" })),
    ...environment.d1_databases.map((entry) => ({
      name: entry.binding, type: "d1", database_id: entry.database_id, database_name: entry.database_name,
    })),
    ...environment.r2_buckets.map((entry) => ({ name: entry.binding, type: "r2_bucket", bucket_name: entry.bucket_name })),
    ...environment.ratelimits.map((entry) => ({
      name: entry.name, type: "ratelimit", namespace_id: entry.namespace_id, simple: entry.simple,
    })),
    ...environment.durable_objects.bindings.map((entry) => ({
      name: entry.name, type: "durable_object_namespace", namespace_id: GENESIS_NAMESPACE_ID, class_name: entry.class_name,
    })),
    { name: environment.assets.binding, type: "assets" },
  ];
  const runtime = {
    migration_tag: migrations.at(-1).tag,
    assets: {
      not_found_handling: environment.assets.not_found_handling,
      raw_run_worker_first: environment.assets.run_worker_first,
      serve_directly: false,
    },
    compatibility_date: environment.compatibility_date,
    compatibility_flags: environment.compatibility_flags,
    usage_model: "standard",
    limits: environment.limits,
    cache_options: { enabled: environment.cache.enabled, cross_version_cache: environment.cache.cross_version_cache },
  };
  return rawInventory({
    accountId: target.accountId,
    workerName: target.edgeWorkerName,
    versionId: STAGING_EDGE_GENESIS_VERSION_ID,
    runtime,
    bindings,
    settings: {
      placement: {},
      tags: [],
      tail_consumers: environment.tail_consumers,
      logpush: environment.logpush,
      observability: environment.observability,
      annotations: {},
    },
    crons: environment.triggers.crons,
    subdomain: { enabled: environment.workers_dev, previews_enabled: environment.preview_urls },
    routes: [],
    domains: environment.routes.map((route) => ({ hostname: route.pattern })),
    namespaces: environment.durable_objects.bindings.map((entry) => ({
      id: GENESIS_NAMESPACE_ID,
      name: `${target.edgeWorkerName}_${entry.class_name}`,
      script: target.edgeWorkerName,
      class: entry.class_name,
      use_sqlite: true,
    })),
  });
}

export function createStagingGenesisSnapshot(options) {
  try {
    return createProductionLiveConfigSnapshot(createStagingGenesisInventory(options));
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("STAGING_EDGE_")) throw error;
    return fail("TEMPLATE_INVALID");
  }
}

/**
 * EP-9's staging variant as an E10 overlay (production-edge-mode.mjs
 * createEdgeModeConfigTools / prepareEdgeModeDeployment), bound to the
 * production isolation inputs: the canonical production snapshot, the optional
 * pre-gcp production baseline, and the production gcp plan or an explicit
 * null. `trackedConfig` is the checked-in wrangler.jsonc.
 */
export function createStagingEdgeOverlay({ productionSnapshot, productionBaselineSnapshot, productionPlan, expectedDomains } = {}) {
  if (productionPlan === undefined || !Array.isArray(expectedDomains)) fail("PRODUCTION_INPUT_INVALID");
  const isolation = { productionSnapshot, productionBaselineSnapshot, productionPlan };
  return Object.freeze({
    target: "staging",
    expectedDomains: Object.freeze([...expectedDomains].sort()),
    config: ({ renderedConfig, snapshot, mode, plan, trackedConfig }) => applyEdgeModeStagingOverlay({
      renderedConfig, snapshot, mode, plan, trackedConfig, ...isolation,
    }).config,
    expected: ({ snapshot, mode, plan, trackedConfig }) => applyEdgeModeStagingSnapshotDelta({
      snapshot, mode, plan, trackedConfig, ...isolation,
    }),
  });
}

/**
 * Render for the render subcommand, with the isolation the genesis deploy
 * applies: assertStagingEdgeTarget's isolation (its result), then EP-9's own
 * guard on the snapshot the rendered edge config declares. Render --write
 * therefore refuses what deploy refuses before any file is written.
 */
export function renderStagingEdgeTarget({ template, isolation, trackedConfigs, workerDirectory = STAGING_EDGE_WORKER_DIRECTORY } = {}) {
  if (!object(isolation) || !Array.isArray(trackedConfigs) || trackedConfigs.length === 0) fail("TRACKED_CONFIG_INVALID");
  const { target } = isolation;
  const rendered = renderStagingEdgeTemplate({ template, inputs: target, workerDirectory });
  const overlay = createStagingEdgeOverlay({
    productionSnapshot: isolation.productionSnapshot,
    productionBaselineSnapshot: isolation.productionBaselineSnapshot,
    productionPlan: isolation.productionPlan,
    expectedDomains: [target.publicHostname, target.adminHostname],
  });
  overlay.expected({
    snapshot: createStagingGenesisSnapshot({ edgeTracked: rendered.edgeTracked, inputs: target }),
    mode: "worker",
    plan: null,
    trackedConfig: trackedConfigs[0],
  });
  return rendered;
}

/** The EP-8 fence plan for the staging edge (plan Phase G), validated by the fence's own validator. */
export function buildStagingFencePlan(inputs) {
  const target = parsedInputs(inputs);
  const plan = {
    schema: FENCE_PLAN_SCHEMA,
    accountId: target.accountId,
    productionWorker: target.edgeWorkerName,
    fencedScripts: [{ name: target.standInWorkerName, kind: "cron", expectedCrons: [target.standInCron] }],
    dataResources: [
      ...STAGING_EDGE_D1_ROLES.filter((role) => role.fenceLabel !== null)
        .map((role) => ({ kind: "d1", id: target.d1[role.key].id, label: role.fenceLabel })),
      { kind: "r2", bucket: target.r2.quarantine },
    ],
    outOfScopeScripts: [],
    quietWindowMinutes: target.quietWindowMinutes,
  };
  let validated;
  try {
    validated = validateCloudflareWriterFencePlan(plan);
  } catch {
    return fail("FENCE_PLAN_INVALID");
  }
  return Object.freeze({ plan, planSha256: validated.planSha256 });
}

/**
 * The staging gcp plan (plan section 5.2) from the inputs' origin and the
 * staging release-guard D1, validated by EP-9's own plan normalizer. Returns
 * null while the staging origin is unset.
 */
export function buildStagingGcpPlan(inputs) {
  const target = parsedInputs(inputs);
  if (target.origin === null) return null;
  const plan = {
    upstreamOrigin: target.origin.upstreamOrigin,
    originAudience: target.origin.originAudience,
    invokerServiceAccount: target.origin.invokerServiceAccount,
    releaseGuardDatabase: { id: target.d1.releaseGuard.id, name: target.d1.releaseGuard.name },
    ...(target.origin.upstreamHeadersTimeoutSeconds === undefined
      ? {}
      : { upstreamHeadersTimeoutSeconds: target.origin.upstreamHeadersTimeoutSeconds }),
  };
  try {
    normalizeEdgeModePlan({ mode: "gcp", plan });
  } catch {
    return fail("GCP_PLAN_INVALID");
  }
  return Object.freeze({ plan, overlaySha256: edgeModeOverlaySha256({ mode: "gcp", plan }) });
}

/** A content-free digest of the inputs, for receipts. */
export function stagingEdgeInputsSha256(inputs) {
  return identityDigest(parsedInputs(inputs));
}
