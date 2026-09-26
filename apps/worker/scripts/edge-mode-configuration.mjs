import { identityDigest, operationError } from "../../../scripts/lib/release-operation.mjs";
import {
  EDGE_UPSTREAM_MODES,
  parseEdgeOriginConfiguration,
  parseEdgeUpstreamMode,
} from "../src/edge-origin-contract.ts";
import {
  PRODUCTION_LIVE_CONFIG_D1_MIGRATIONS_DIRS,
  PRODUCTION_LIVE_CONFIG_SCHEMA,
  createProductionLiveConfigSnapshot,
  productionLiveConfigFingerprint,
} from "./production-live-config.mjs";

/**
 * Edge mode overlay for the typed production deployment.
 *
 * Production is deployed from renderProductionLiveConfig, which rebuilds
 * env.production from the live Cloudflare inventory. The checked-in
 * env.production still names the legacy primary D1 and JSON storage mode, so
 * it is never a configuration source here. This module declares the one change
 * an edge deploy may make on top of that render (applyEdgeModeOverlay), the
 * matching expected post-deploy snapshot (applyEdgeModeSnapshotDelta, which
 * verifyProductionLiveConfig then compares exactly), the post-deploy live check
 * (verifyEdgeModeLiveSnapshot) and the mode transition matrix.
 *
 * Inputs carry live vars and resource identifiers. Nothing here logs, writes a
 * file, or puts a value into an error: errors carry a stable code only.
 */
export const EDGE_MODE_OVERLAY_SCHEMA = "edge-mode-overlay-v1";
export const EDGE_MODES = EDGE_UPSTREAM_MODES;
export const EDGE_MODE_ENTRY_MAIN = "src/edge-entry.ts";
export const EDGE_MODE_VAR = "EDGE_UPSTREAM_MODE";
export const EDGE_MODE_RELEASE_GUARD_BINDING = "RELEASE_GUARD_DB";
export const EDGE_MODE_SPARKLE_BINDING = "SPARKLE_RELEASES";
export const EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR
  = PRODUCTION_LIVE_CONFIG_D1_MIGRATIONS_DIRS[EDGE_MODE_RELEASE_GUARD_BINDING];

/** Vars the gcp overlay sets from the plan, in the edge's own names. */
export const EDGE_MODE_GCP_VARS = Object.freeze({
  upstreamOrigin: "EDGE_UPSTREAM_ORIGIN",
  originAudience: "EDGE_ORIGIN_AUDIENCE",
  invokerServiceAccount: "EDGE_INVOKER_SERVICE_ACCOUNT",
  upstreamHeadersTimeoutSeconds: "EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS",
});

/**
 * Every D1/R2 binding a live production version may carry when the gcp
 * overlay is applied. RELEASE_GUARD_DB is the binding the gcp overlay itself
 * adds, so gcp -> gcp redeploys see it live. Anything else fails closed.
 */
export const EDGE_MODE_KNOWN_STORAGE_BINDINGS = Object.freeze([
  Object.freeze({ name: "ANALYTICS_DB", type: "d1" }),
  Object.freeze({ name: "DELETION_LEDGER", type: "d1" }),
  Object.freeze({ name: "QUARANTINE", type: "r2_bucket" }),
  Object.freeze({ name: EDGE_MODE_RELEASE_GUARD_BINDING, type: "d1" }),
  Object.freeze({ name: EDGE_MODE_SPARKLE_BINDING, type: "r2_bucket" }),
  Object.freeze({ name: "USAGE_MONITOR_DB", type: "d1" }),
]);

/** The only storage bindings a gcp-mode version keeps. */
export const EDGE_MODE_GCP_STORAGE_BINDINGS = Object.freeze([
  Object.freeze({ name: EDGE_MODE_RELEASE_GUARD_BINDING, type: "d1" }),
  Object.freeze({ name: EDGE_MODE_SPARKLE_BINDING, type: "r2_bucket" }),
]);

/** Live secrets a gcp deploy requires at the edge. */
export const EDGE_MODE_GCP_REQUIRED_SECRETS = Object.freeze([
  "DISTRIBUTION_ANALYTICS_API_TOKEN",
  "EDGE_CLIENT_KEY_SECRET",
  "EDGE_INVOKER_KEY_JSON",
  "SPARKLE_APPCAST_GUARD_TOKEN",
]);

/** Storage-era secrets the owner deletes after the gcp switch (P10). */
export const EDGE_MODE_RETIRED_SECRETS = Object.freeze([
  "ADMIN_IDENTITY_LINK_KEY",
  "APPLE_PRIVATE_KEY",
  "DISTRIBUTION_GITHUB_API_TOKEN",
  "ENVELOPE_PRIVATE_JWK",
  "ENVELOPE_PUBLIC_JWK",
  "GOOGLE_OIDC_CLIENT_SECRET",
  "IDENTITY_LINK_SECRET",
]);

export const EDGE_MODE_PRODUCTION_WORKER_NAME = "app-usagemonitor";
export const EDGE_MODE_PRODUCTION_APEX = "tibotattle.com";
/** The production Worker's custom domains; no edge mode changes them. */
export const EDGE_MODE_PRODUCTION_DOMAINS = Object.freeze([
  "admin.tibotattle.com",
  "tibotattle.com",
  "www.tibotattle.com",
]);

/**
 * Roll-forward matrix. `requiresNoGcpSinceFence` marks the abort path back to
 * worker mode, which is allowed only while no gcp-mode version has been
 * deployed since the fence began. Every other pair is forbidden, including
 * null -> fenced, worker -> gcp and gcp -> worker.
 */
export const EDGE_MODE_TRANSITIONS = Object.freeze([
  Object.freeze({ from: null, to: "worker", requiresNoGcpSinceFence: false }),
  Object.freeze({ from: "worker", to: "worker", requiresNoGcpSinceFence: false }),
  Object.freeze({ from: "worker", to: "fenced", requiresNoGcpSinceFence: false }),
  Object.freeze({ from: "fenced", to: "fenced", requiresNoGcpSinceFence: false }),
  Object.freeze({ from: "fenced", to: "gcp", requiresNoGcpSinceFence: false }),
  Object.freeze({ from: "fenced", to: "worker", requiresNoGcpSinceFence: true }),
  Object.freeze({ from: "gcp", to: "gcp", requiresNoGcpSinceFence: false }),
  Object.freeze({ from: "gcp", to: "fenced", requiresNoGcpSinceFence: false }),
]);

const SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const D1_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HOSTNAME = /^[a-z0-9.-]{1,253}$/u;
const APEX_REFERENCE = /(?:^|[^a-z0-9-])tibotattle\.com(?:$|[^a-z0-9-])/iu;
const GCP_PLAN_KEYS = Object.freeze([
  "invokerServiceAccount",
  "originAudience",
  "releaseGuardDatabase",
  "upstreamHeadersTimeoutSeconds",
  "upstreamOrigin",
]);
const GCP_PLAN_OPTIONAL_KEYS = new Set(["upstreamHeadersTimeoutSeconds"]);
const STORAGE_TYPES = new Set(["d1", "r2_bucket"]);

function fail(code) {
  throw operationError(`EDGE_MODE_${code}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJson(value, code) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fail(code);
  }
}

/**
 * The bytes a typed deploy writes for an overlaid (private) config, identical
 * to production-deploy's own serialization. Key order is deliberately the
 * render's: verifyProductionLiveConfig compares some nested runtime objects by
 * their JSON text, so a key-sorted config would read back as runtime drift.
 * The overlay is a pure function of (render, mode, plan), so equal inputs give
 * equal bytes; the pinned identity is edgeModeOverlaySha256.
 */
export function serializeEdgeModeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function requiredMode(mode) {
  const parsed = parseEdgeUpstreamMode(mode);
  if (parsed === null) fail("INVALID");
  return parsed;
}

/**
 * Closed plan: null (or {}) for worker and fenced; for gcp exactly
 * {upstreamOrigin, originAudience, invokerServiceAccount,
 * releaseGuardDatabase: {id, name}} plus optional integer
 * upstreamHeadersTimeoutSeconds. Values are validated with the edge's own
 * parser, so a plan the edge would refuse never renders.
 */
export function normalizeEdgeModePlan({ mode, plan } = {}) {
  const edgeMode = requiredMode(mode);
  if (edgeMode !== "gcp") {
    if (plan === undefined || plan === null || (object(plan) && Object.keys(plan).length === 0)) {
      return null;
    }
    return fail("PLAN_INVALID");
  }
  if (!object(plan)) fail("PLAN_INVALID");
  const keys = Object.keys(plan);
  if (keys.some((key) => !GCP_PLAN_KEYS.includes(key))
      || GCP_PLAN_KEYS.some((key) => !GCP_PLAN_OPTIONAL_KEYS.has(key) && !own(plan, key))) {
    fail("PLAN_INVALID");
  }
  const timeout = plan.upstreamHeadersTimeoutSeconds;
  if (timeout !== undefined && !Number.isSafeInteger(timeout)) fail("PLAN_INVALID");
  const settings = {
    [EDGE_MODE_GCP_VARS.upstreamOrigin]: plan.upstreamOrigin,
    [EDGE_MODE_GCP_VARS.originAudience]: plan.originAudience,
    [EDGE_MODE_GCP_VARS.invokerServiceAccount]: plan.invokerServiceAccount,
    [EDGE_MODE_GCP_VARS.upstreamHeadersTimeoutSeconds]: timeout,
  };
  const parsed = parseEdgeOriginConfiguration((name) => settings[name]);
  if (parsed === null || parsed.upstreamOrigin !== plan.upstreamOrigin) fail("PLAN_INVALID");
  const guard = plan.releaseGuardDatabase;
  if (!object(guard) || Object.keys(guard).sort().join(",") !== "id,name"
      || typeof guard.id !== "string" || !UUID.test(guard.id)
      || typeof guard.name !== "string" || !D1_NAME.test(guard.name)) {
    fail("PLAN_INVALID");
  }
  return Object.freeze({
    upstreamOrigin: parsed.upstreamOrigin,
    originAudience: parsed.audience,
    invokerServiceAccount: parsed.invokerServiceAccount,
    upstreamHeadersTimeoutSeconds: parsed.upstreamHeadersTimeoutSeconds,
    releaseGuardDatabase: Object.freeze({ id: guard.id, name: guard.name }),
  });
}

/** sha256 of the canonical {schema, mode, plan}; the typed operation pins it. */
export function edgeModeOverlaySha256({ mode, plan } = {}) {
  const edgeMode = requiredMode(mode);
  return identityDigest({
    schema: EDGE_MODE_OVERLAY_SCHEMA,
    mode: edgeMode,
    plan: normalizeEdgeModePlan({ mode: edgeMode, plan }),
  });
}

function gcpVars(plan) {
  return {
    [EDGE_MODE_GCP_VARS.upstreamOrigin]: plan.upstreamOrigin,
    [EDGE_MODE_GCP_VARS.originAudience]: plan.originAudience,
    [EDGE_MODE_GCP_VARS.invokerServiceAccount]: plan.invokerServiceAccount,
    [EDGE_MODE_GCP_VARS.upstreamHeadersTimeoutSeconds]: String(plan.upstreamHeadersTimeoutSeconds),
  };
}

function knownStorage({ name, type }, allowed) {
  return allowed.some((entry) => entry.name === name && entry.type === type);
}

/**
 * The gcp preconditions shared by the config overlay and the snapshot delta,
 * over the live storage bindings ({name, type, id?}) and secret names.
 */
function assertGcpPreconditions({ storage, secrets, plan }) {
  if (storage.some((binding) => !knownStorage(binding, EDGE_MODE_KNOWN_STORAGE_BINDINGS))) {
    fail("UNKNOWN_STORAGE_BINDING");
  }
  if (EDGE_MODE_GCP_REQUIRED_SECRETS.some((name) => !secrets.includes(name))) {
    fail("SECRET_MISSING");
  }
  if (!storage.some((binding) => binding.name === EDGE_MODE_SPARKLE_BINDING
      && binding.type === "r2_bucket")) {
    fail("RETAINED_BINDING_MISSING");
  }
  // The guard D1 must be its own database, never a data D1 being unbound.
  if (storage.some((binding) => binding.type === "d1"
      && binding.name !== EDGE_MODE_RELEASE_GUARD_BINDING
      && binding.id === plan.releaseGuardDatabase.id)) {
    fail("PLAN_INVALID");
  }
}

function environmentShape(environment) {
  if (!object(environment) || !object(environment.vars) || !object(environment.secrets)
      || !Array.isArray(environment.secrets.required)
      || !Array.isArray(environment.d1_databases) || !Array.isArray(environment.r2_buckets)
      || !object(environment.triggers)
      || environment.d1_databases.some((entry) => !object(entry) || typeof entry.binding !== "string")
      || environment.r2_buckets.some((entry) => !object(entry) || typeof entry.binding !== "string")
      || environment.secrets.required.some((name) => typeof name !== "string")) {
    fail("CONFIG_INVALID");
  }
}

function overlayEnvironment(environment, mode, plan) {
  environmentShape(environment);
  const result = cloneJson(environment, "CONFIG_INVALID");
  const declaredVars = mode === "gcp" ? [EDGE_MODE_VAR, ...Object.values(EDGE_MODE_GCP_VARS)] : [EDGE_MODE_VAR];
  if (result.secrets.required.some((name) => declaredVars.includes(name))) fail("CONFIG_INVALID");
  result.main = EDGE_MODE_ENTRY_MAIN;
  if (mode === "gcp") {
    const storage = [
      ...result.d1_databases.map((entry) => ({ name: entry.binding, type: "d1", id: entry.database_id })),
      ...result.r2_buckets.map((entry) => ({ name: entry.binding, type: "r2_bucket" })),
    ];
    assertGcpPreconditions({ storage, secrets: result.secrets.required, plan });
    result.vars = { ...result.vars, ...gcpVars(plan) };
    result.d1_databases = [{
      binding: EDGE_MODE_RELEASE_GUARD_BINDING,
      database_id: plan.releaseGuardDatabase.id,
      database_name: plan.releaseGuardDatabase.name,
      migrations_dir: EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR,
    }];
    result.r2_buckets = result.r2_buckets.filter((entry) => entry.binding === EDGE_MODE_SPARKLE_BINDING);
    result.triggers = { ...result.triggers, crons: [] };
  }
  result.vars = { ...result.vars, [EDGE_MODE_VAR]: mode };
  return result;
}

/**
 * Overlay a renderProductionLiveConfig result for `mode`. Only env.production
 * changes: every mode sets main and EDGE_UPSTREAM_MODE; gcp also sets the
 * origin vars and reduces storage to RELEASE_GUARD_DB and SPARKLE_RELEASES
 * with no crons, keeping assets, rate limits, the Durable Object binding and
 * its migrations, routes, vars and secrets.
 */
export function applyEdgeModeOverlay({ renderedConfig, mode, plan } = {}) {
  const edgeMode = requiredMode(mode);
  const normalizedPlan = normalizeEdgeModePlan({ mode: edgeMode, plan });
  if (!object(renderedConfig) || !object(renderedConfig.env) || !object(renderedConfig.env.production)) {
    fail("CONFIG_INVALID");
  }
  const config = cloneJson(renderedConfig, "CONFIG_INVALID");
  config.env.production = overlayEnvironment(config.env.production, edgeMode, normalizedPlan);
  return {
    config,
    overlaySha256: edgeModeOverlaySha256({ mode: edgeMode, plan: normalizedPlan }),
  };
}

function snapshotInventory(snapshot) {
  const bindings = snapshot.bindings.map((binding) => binding.type === "d1"
    ? { ...binding, id: binding.database_id }
    : binding);
  return {
    accountId: snapshot.accountId,
    workerName: snapshot.workerName,
    version: { id: snapshot.versionId, resources: { script_runtime: snapshot.runtime, bindings } },
    settings: {
      ...snapshot.settings,
      compatibility_date: snapshot.runtime.compatibility_date,
      compatibility_flags: snapshot.runtime.compatibility_flags,
      usage_model: snapshot.runtime.usage_model,
      limits: snapshot.runtime.limits,
      cache_options: snapshot.runtime.cache_options,
      bindings,
    },
    schedules: { schedules: snapshot.crons.map((cron) => ({ cron })) },
    subdomain: snapshot.subdomain,
    routes: snapshot.routes,
    domains: snapshot.domains,
    namespaces: snapshot.namespaces,
  };
}

/** Re-derive a typed snapshot; a tampered or stale fingerprint is refused. */
function canonicalSnapshot(snapshot, code = "SNAPSHOT_INVALID") {
  if (!object(snapshot) || snapshot.schema !== PRODUCTION_LIVE_CONFIG_SCHEMA) fail(code);
  let normalized;
  try {
    normalized = createProductionLiveConfigSnapshot(snapshotInventory(snapshot));
  } catch {
    return fail(code);
  }
  if (snapshot.fingerprint !== undefined && snapshot.fingerprint !== normalized.fingerprint) fail(code);
  return normalized;
}

function storageBindings(snapshot) {
  return snapshot.bindings.filter((binding) => STORAGE_TYPES.has(binding.type))
    .map((binding) => ({ name: binding.name, type: binding.type, id: binding.database_id }));
}

function secretNames(snapshot) {
  return snapshot.bindings.filter((binding) => binding.type === "secret_text").map((binding) => binding.name);
}

function plainText(snapshot, name) {
  const binding = snapshot.bindings.find((entry) => entry.name === name);
  return binding?.type === "plain_text" ? binding.text : undefined;
}

function deltaSnapshot(live, mode, plan) {
  const declaredVars = mode === "gcp" ? [EDGE_MODE_VAR, ...Object.values(EDGE_MODE_GCP_VARS)] : [EDGE_MODE_VAR];
  if (live.bindings.some((binding) => declaredVars.includes(binding.name) && binding.type !== "plain_text")) {
    fail("SNAPSHOT_INVALID");
  }
  let bindings = live.bindings.filter((binding) => !declaredVars.includes(binding.name));
  let crons = live.crons;
  if (mode === "gcp") {
    assertGcpPreconditions({ storage: storageBindings(live), secrets: secretNames(live), plan });
    bindings = bindings.filter((binding) => !STORAGE_TYPES.has(binding.type)
      || (binding.name === EDGE_MODE_SPARKLE_BINDING && binding.type === "r2_bucket"));
    bindings.push(
      ...Object.entries(gcpVars(plan)).map(([name, text]) => ({ name, type: "plain_text", text })),
      {
        name: EDGE_MODE_RELEASE_GUARD_BINDING,
        type: "d1",
        database_id: plan.releaseGuardDatabase.id,
        database_name: plan.releaseGuardDatabase.name,
      },
    );
    crons = [];
  }
  bindings.push({ name: EDGE_MODE_VAR, type: "plain_text", text: mode });
  // Re-derived through the typed snapshot normalizer, so the binding and route
  // objects keep its key order, which verifyProductionLiveConfig compares.
  const { fingerprint: ignored, ...unfingerprinted } = canonicalSnapshot({ ...live, bindings, crons, fingerprint: undefined });
  return { ...unfingerprinted, fingerprint: productionLiveConfigFingerprint(unfingerprinted) };
}

/**
 * The expected post-deploy snapshot for `mode`: the live snapshot plus exactly
 * the overlay's binding and cron changes, with its fingerprint recomputed, so
 * verifyProductionLiveConfig({snapshot: expected, candidateConfig: overlaid})
 * accepts the declared delta and nothing else.
 */
export function applyEdgeModeSnapshotDelta({ snapshot, mode, plan } = {}) {
  const edgeMode = requiredMode(mode);
  const normalizedPlan = normalizeEdgeModePlan({ mode: edgeMode, plan });
  return deltaSnapshot(canonicalSnapshot(snapshot), edgeMode, normalizedPlan);
}

/**
 * The live mode of a typed snapshot: null when EDGE_UPSTREAM_MODE is absent
 * (every pre-edge version), else the mode. A present but unknown value is
 * refused rather than read as absent.
 */
export function liveEdgeMode(snapshot) {
  const live = canonicalSnapshot(snapshot);
  const binding = live.bindings.find((entry) => entry.name === EDGE_MODE_VAR);
  if (binding === undefined) return null;
  if (binding.type !== "plain_text") fail("LIVE_INVALID");
  const mode = parseEdgeUpstreamMode(binding.text);
  if (mode === null) fail("LIVE_INVALID");
  return mode;
}

export function assertEdgeModeTransition({ liveMode, targetMode, gcpEverDeployedSinceFence } = {}) {
  const transition = EDGE_MODE_TRANSITIONS.find((entry) => entry.from === liveMode && entry.to === targetMode);
  if (transition === undefined
      || (transition.requiresNoGcpSinceFence && gcpEverDeployedSinceFence !== false)) {
    fail("TRANSITION_FORBIDDEN");
  }
  return transition;
}

function verification(ok, code, warnings) {
  return { ok, code, warnings };
}

function singleActiveVersion(deployment, versionId) {
  return object(deployment) && Array.isArray(deployment.versions)
    && deployment.versions.length === 1 && object(deployment.versions[0])
    && deployment.versions[0].version_id === versionId
    && deployment.versions[0].percentage === 100;
}

function expectedHostnames(value) {
  if (!Array.isArray(value) || value.length === 0
      || value.some((hostname) => typeof hostname !== "string" || !HOSTNAME.test(hostname))
      || new Set(value).size !== value.length) {
    fail("INPUT_INVALID");
  }
  return [...value].sort();
}

/**
 * Post-deploy check of a captured live snapshot. The caller supplies the
 * Cloudflare deployment ({versions: [{version_id, percentage}]}), the expected
 * source commit and, off production, the expected custom domains. Returns
 * {ok, code, warnings}; retired storage secrets still present in gcp mode are
 * a RETIRED_SECRET_PRESENT warning, never a failure.
 */
export function verifyEdgeModeLiveSnapshot({
  snapshot,
  mode,
  deployment,
  sourceCommit,
  expectedDomains = EDGE_MODE_PRODUCTION_DOMAINS,
} = {}) {
  const warnings = [];
  try {
    const edgeMode = requiredMode(mode);
    const live = canonicalSnapshot(snapshot);
    const domains = expectedHostnames(expectedDomains);
    if (typeof sourceCommit !== "string" || !SHA.test(sourceCommit)) fail("INPUT_INVALID");
    if (edgeMode === "gcp") {
      const retained = EDGE_MODE_RETIRED_SECRETS.filter((name) => secretNames(live).includes(name));
      if (retained.length > 0) warnings.push({ code: "RETIRED_SECRET_PRESENT", names: retained });
    }
    if (!singleActiveVersion(deployment, live.versionId)) {
      return verification(false, "EDGE_MODE_DEPLOYMENT_NOT_SINGLE", warnings);
    }
    if (live.sourceCommit !== sourceCommit) return verification(false, "EDGE_MODE_SOURCE_MISMATCH", warnings);
    if (liveEdgeMode(live) !== edgeMode) return verification(false, "EDGE_MODE_MISMATCH", warnings);
    if (JSON.stringify(live.domains.map((domain) => domain.hostname).sort()) !== JSON.stringify(domains)) {
      return verification(false, "EDGE_MODE_DOMAINS_CHANGED", warnings);
    }
    if (edgeMode === "gcp") {
      const storage = storageBindings(live);
      if (storage.some((binding) => !knownStorage(binding, EDGE_MODE_GCP_STORAGE_BINDINGS))) {
        return verification(false, "EDGE_MODE_GCP_STORAGE_BINDING_PRESENT", warnings);
      }
      if (EDGE_MODE_GCP_STORAGE_BINDINGS.some((binding) => !knownStorage(binding, storage))) {
        return verification(false, "EDGE_MODE_RETAINED_BINDING_MISSING", warnings);
      }
      if (live.crons.length !== 0) return verification(false, "EDGE_MODE_GCP_CRONS_PRESENT", warnings);
      if (EDGE_MODE_GCP_REQUIRED_SECRETS.some((name) => !secretNames(live).includes(name))) {
        return verification(false, "EDGE_MODE_SECRET_MISSING", warnings);
      }
      if (parseEdgeOriginConfiguration((name) => plainText(live, name)) === null) {
        return verification(false, "EDGE_MODE_GCP_CONFIGURATION_INVALID", warnings);
      }
    }
    return verification(true, null, warnings);
  } catch (error) {
    const code = typeof error?.code === "string" && error.code.startsWith("EDGE_MODE_")
      ? error.code
      : "EDGE_MODE_VERIFY_FAILED";
    return verification(false, code, warnings);
  }
}

// ---------------------------------------------------------------------------
// Staging variant

function stagingReferences({ productionSnapshot, trackedConfig }) {
  const production = canonicalSnapshot(productionSnapshot, "STAGING_INPUT_INVALID");
  const references = {
    workerNames: new Set([EDGE_MODE_PRODUCTION_WORKER_NAME, production.workerName]),
    databaseIds: new Set(),
    databaseNames: new Set(),
    bucketNames: new Set(),
    values: new Set(),
  };
  for (const binding of production.bindings) {
    if (binding.type === "d1") {
      references.databaseIds.add(binding.database_id);
      if (binding.database_name !== undefined) references.databaseNames.add(binding.database_name);
    }
    if (binding.type === "r2_bucket") references.bucketNames.add(binding.bucket_name);
    if (binding.type === "plain_text" && Object.values(EDGE_MODE_GCP_VARS).includes(binding.name)
        && binding.name !== EDGE_MODE_GCP_VARS.upstreamHeadersTimeoutSeconds) {
      references.values.add(binding.text);
    }
  }
  if (trackedConfig !== undefined) {
    if (!object(trackedConfig)) fail("STAGING_INPUT_INVALID");
    const tracked = trackedConfig.env?.production;
    if (object(tracked)) {
      if (typeof tracked.name === "string") references.workerNames.add(tracked.name);
      for (const entry of Array.isArray(tracked.d1_databases) ? tracked.d1_databases : []) {
        if (typeof entry?.database_id === "string") references.databaseIds.add(entry.database_id);
        if (typeof entry?.database_name === "string") references.databaseNames.add(entry.database_name);
      }
      for (const entry of Array.isArray(tracked.r2_buckets) ? tracked.r2_buckets : []) {
        if (typeof entry?.bucket_name === "string") references.bucketNames.add(entry.bucket_name);
      }
    }
  }
  return references;
}

function assertStagingIsolation({ snapshot, environment, plan, references }) {
  const refuse = () => fail("STAGING_PRODUCTION_REFERENCE");
  const names = [snapshot.workerName];
  const databaseIds = [];
  const databaseNames = [];
  const buckets = [];
  const hosts = [...snapshot.domains.map((domain) => domain.hostname), ...snapshot.routes.map((route) => route.pattern)];
  const texts = [];
  for (const binding of snapshot.bindings) {
    if (binding.type === "d1") {
      databaseIds.push(binding.database_id);
      if (binding.database_name !== undefined) databaseNames.push(binding.database_name);
    }
    if (binding.type === "r2_bucket") buckets.push(binding.bucket_name);
    if (binding.type === "durable_object_namespace" && binding.script_name !== undefined) names.push(binding.script_name);
    if (binding.type === "plain_text") texts.push(binding.text);
  }
  if (environment !== undefined) {
    environmentShape(environment);
    names.push(environment.name);
    for (const entry of environment.d1_databases) {
      databaseIds.push(entry.database_id);
      if (entry.database_name !== undefined) databaseNames.push(entry.database_name);
    }
    for (const entry of environment.r2_buckets) buckets.push(entry.bucket_name);
    for (const entry of object(environment.durable_objects) && Array.isArray(environment.durable_objects.bindings)
      ? environment.durable_objects.bindings : []) {
      if (entry?.script_name !== undefined) names.push(entry.script_name);
    }
    for (const route of Array.isArray(environment.routes) ? environment.routes : []) {
      hosts.push(typeof route === "string" ? route : route?.pattern);
    }
    texts.push(...Object.values(environment.vars));
  }
  if (plan !== null) {
    databaseIds.push(plan.releaseGuardDatabase.id);
    databaseNames.push(plan.releaseGuardDatabase.name);
    texts.push(plan.upstreamOrigin, plan.originAudience, plan.invokerServiceAccount);
  }
  if (names.some((name) => references.workerNames.has(name))
      || databaseIds.some((id) => references.databaseIds.has(id))
      || databaseNames.some((name) => references.databaseNames.has(name))
      || buckets.some((bucket) => references.bucketNames.has(bucket))
      || hosts.some((host) => typeof host !== "string" || APEX_REFERENCE.test(host))
      || texts.some((text) => typeof text !== "string" || APEX_REFERENCE.test(text)
        || references.values.has(text) || references.bucketNames.has(text)
        || references.databaseIds.has(text) || references.workerNames.has(text))) {
    refuse();
  }
}

/**
 * The staging rehearsal overlay: the same change as applyEdgeModeOverlay on a
 * typed render of the staging Worker (its env.production, or the root of an
 * environment-less render). The staging snapshot, the rendered environment and
 * the plan must not name a production Worker, D1 database, R2 bucket, edge
 * origin value or the tibotattle.com apex; productionSnapshot (and optionally
 * the tracked config's env.production) supplies the refused set.
 */
export function applyEdgeModeStagingOverlay({
  renderedConfig, snapshot, mode, plan, productionSnapshot, trackedConfig,
} = {}) {
  const edgeMode = requiredMode(mode);
  const normalizedPlan = normalizeEdgeModePlan({ mode: edgeMode, plan });
  const references = stagingReferences({ productionSnapshot, trackedConfig });
  const staging = canonicalSnapshot(snapshot, "STAGING_INPUT_INVALID");
  if (!object(renderedConfig)) fail("CONFIG_INVALID");
  const config = cloneJson(renderedConfig, "CONFIG_INVALID");
  const nested = object(config.env?.production);
  const environment = nested ? config.env.production : config;
  assertStagingIsolation({ snapshot: staging, environment, plan: normalizedPlan, references });
  const overlaid = overlayEnvironment(environment, edgeMode, normalizedPlan);
  const result = nested ? { ...config, env: { ...config.env, production: overlaid } } : overlaid;
  return {
    config: result,
    overlaySha256: edgeModeOverlaySha256({ mode: edgeMode, plan: normalizedPlan }),
  };
}

/** The staging counterpart of applyEdgeModeSnapshotDelta, with the same refusals. */
export function applyEdgeModeStagingSnapshotDelta({
  snapshot, mode, plan, productionSnapshot, trackedConfig,
} = {}) {
  const edgeMode = requiredMode(mode);
  const normalizedPlan = normalizeEdgeModePlan({ mode: edgeMode, plan });
  const references = stagingReferences({ productionSnapshot, trackedConfig });
  const staging = canonicalSnapshot(snapshot, "STAGING_INPUT_INVALID");
  assertStagingIsolation({ snapshot: staging, environment: undefined, plan: normalizedPlan, references });
  return deltaSnapshot(staging, edgeMode, normalizedPlan);
}
