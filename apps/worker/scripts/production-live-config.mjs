import { createHash } from "node:crypto";
import { operationError } from "../../../scripts/lib/release-operation.mjs";

/**
 * A private, read-only Cloudflare inventory used to reconstruct the effective
 * production Wrangler configuration. The inventory deliberately keeps values
 * in memory for rendering, but this module never logs or includes them in an
 * error/result object. Callers must persist it only in an owner-private file.
 */
export const PRODUCTION_LIVE_CONFIG_SCHEMA = "production-live-config-v1";
export const PRODUCTION_LIVE_CONFIG_SOURCE_BINDING = "DEPLOYMENT_SOURCE_COMMIT";

const SHA = /^[0-9a-f]{40}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const NAME = /^[A-Za-z0-9_-]{1,63}$/u;
const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/u;
const SUPPORTED_BINDINGS = new Set([
  "assets",
  "d1",
  "durable_object_namespace",
  "plain_text",
  "r2_bucket",
  "ratelimit",
  "secret_text",
]);
const RUNTIME_KEYS = Object.freeze([
  "assets",
  "cache_options",
  "compatibility_date",
  "compatibility_flags",
  "limits",
  "migration_tag",
  "usage_model",
]);
const SETTINGS_RUNTIME_KEYS = Object.freeze([
  "cache_options",
  "compatibility_date",
  "compatibility_flags",
  "limits",
  "usage_model",
]);
const CONFIG_RESOURCE_KEYS = Object.freeze([
  "assets",
  "d1_databases",
  "durable_objects",
  "ratelimits",
  "r2_buckets",
  "secrets",
  "vars",
]);
const UNSUPPORTED_CONFIG_RESOURCE_KEYS = Object.freeze([
  "agent_memory",
  "analytics_engine_datasets",
  "artifacts",
  "browser",
  "dispatch_namespaces",
  "hyperdrive",
  "images",
  "kv_namespaces",
  "mtls_certificates",
  "pipelines",
  "queues",
  "send_email",
  "secrets_store_secrets",
  "services",
  "stream",
  "version_metadata",
  "vectorize",
  "unsafe",
  "vpc_networks",
  "vpc_services",
  "worker_loaders",
  "workflows",
]);
const UNSUPPORTED_CONFIG_KEYS = Object.freeze(["annotations", "tags", "usage_model"]);

function fail(code) {
  throw operationError(`PRODUCTION_LIVE_CONFIG_${code}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredObject(value, code) {
  if (!object(value)) fail(code);
  return value;
}

function requiredString(value, code, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384
      || (pattern !== null && !pattern.test(value))) {
    fail(code);
  }
  return value;
}

function requiredBoolean(value, code) {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function requiredFiniteInteger(value, code, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function cloneJson(value, code = "VALUE_INVALID") {
  try {
    const copy = structuredClone(value);
    JSON.stringify(copy);
    return copy;
  } catch {
    fail(code);
  }
}

function sorted(values) {
  return [...values].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function identifier(value, code = "IDENTIFIER_INVALID") {
  if (typeof value !== "string" || value.length === 0 || value.length > 128
      || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    fail(code);
  }
  return value;
}

function uuidOrHex32(value, code = "IDENTIFIER_INVALID") {
  if (typeof value !== "string" || !(UUID.test(value) || HEX32.test(value))) {
    fail(code);
  }
  return value;
}

function normalizeRateLimit(binding) {
  const namespaceId = identifier(binding.namespace_id, "BINDING_INVALID");
  const simple = requiredObject(binding.simple, "BINDING_INVALID");
  if (Object.keys(simple).sort().join(",") !== "limit,period") {
    fail("BINDING_INVALID");
  }
  const limit = requiredFiniteInteger(simple.limit, "BINDING_INVALID", { min: 1 });
  if (![10, 60].includes(simple.period)) fail("BINDING_INVALID");
  return {
    name: requiredString(binding.name, "BINDING_INVALID", NAME),
    type: binding.type,
    namespace_id: namespaceId,
    simple: { limit, period: simple.period },
  };
}

function normalizeBinding(binding) {
  requiredObject(binding, "BINDING_INVALID");
  const type = requiredString(binding.type, "BINDING_INVALID");
  if (!SUPPORTED_BINDINGS.has(type)) fail("BINDING_TYPE_UNSUPPORTED");
  const name = requiredString(binding.name, "BINDING_INVALID", NAME);
  if (type === "plain_text") {
    assertBindingKeys(binding, ["name", "text", "type"]);
    return { name, type, text: requiredString(binding.text, "BINDING_INVALID") };
  }
  if (type === "secret_text") {
    assertBindingKeys(binding, ["name", "type"]);
    return { name, type };
  }
  if (type === "assets") {
    assertBindingKeys(binding, ["name", "type"]);
    return { name, type };
  }
  if (type === "d1") {
    assertBindingKeys(binding, ["database_id", "id", "name", "type"], ["database_name"]);
    const aliases = [binding.id, binding.database_id]
      .filter((value) => value !== undefined);
    if (aliases.length === 0 || aliases.some((value) => typeof value !== "string")
        || new Set(aliases).size !== 1) {
      fail("BINDING_INVALID");
    }
    const result = {
      name,
      type,
      database_id: uuidOrHex32(aliases[0], "BINDING_INVALID"),
    };
    if (binding.database_name !== undefined) {
      result.database_name = requiredString(binding.database_name, "BINDING_INVALID");
    }
    return result;
  }
  if (type === "r2_bucket") {
    assertBindingKeys(binding, ["bucket_name", "name", "type"], ["jurisdiction"]);
    const result = {
      name,
      type,
      bucket_name: requiredString(binding.bucket_name, "BINDING_INVALID"),
    };
    if (binding.jurisdiction !== undefined) {
      result.jurisdiction = requiredString(binding.jurisdiction, "BINDING_INVALID");
    }
    return result;
  }
  if (type === "durable_object_namespace") {
    assertBindingKeys(binding, ["class_name", "name", "namespace_id", "type"], ["environment", "script_name"]);
    const result = {
      name,
      type,
      namespace_id: identifier(binding.namespace_id, "BINDING_INVALID"),
      class_name: requiredString(binding.class_name, "BINDING_INVALID", NAME),
    };
    if (binding.script_name !== undefined) {
      result.script_name = requiredString(binding.script_name, "BINDING_INVALID", NAME);
    }
    if (binding.environment !== undefined) {
      result.environment = requiredString(binding.environment, "BINDING_INVALID", NAME);
    }
    return result;
  }
  assertBindingKeys(binding, ["name", "namespace_id", "simple", "type"]);
  return normalizeRateLimit({ ...binding, name });
}

function assertBindingKeys(binding, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => own(binding, key))
      || Object.keys(binding).some((key) => !allowed.has(key))) {
    fail("BINDING_INVALID");
  }
}

function normalizeBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > 512) {
    fail("BINDINGS_MISSING");
  }
  const normalized = bindings.map(normalizeBinding);
  const names = normalized.map((binding) => binding.name);
  if (new Set(names).size !== names.length) fail("BINDING_DUPLICATE");
  return sorted(normalized);
}

function bindingsByName(bindings) {
  return new Map(bindings.map((binding) => [binding.name, binding]));
}

function bindingsEquivalent(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function normalizeRuntime(runtime) {
  requiredObject(runtime, "RUNTIME_MISSING");
  if (Object.keys(runtime).sort().join(",") !== [...RUNTIME_KEYS].sort().join(",")) {
    fail("RUNTIME_INVALID");
  }
  const assets = requiredObject(runtime.assets, "RUNTIME_INVALID");
  const assetKeys = Object.keys(assets).filter((key) => key !== "base_path").sort();
  if (assetKeys.join(",") !== "not_found_handling,raw_run_worker_first,serve_directly"
      || (own(assets, "base_path") && assets.base_path !== "/")) {
    fail("RUNTIME_INVALID");
  }
  const limits = requiredObject(runtime.limits, "RUNTIME_INVALID");
  if (Object.keys(limits).sort().join(",") !== "cpu_ms") {
    fail("RUNTIME_INVALID");
  }
  const cache = requiredObject(runtime.cache_options, "RUNTIME_INVALID");
  if (Object.keys(cache).sort().join(",") !== "cross_version_cache,enabled") {
    fail("RUNTIME_INVALID");
  }
  return {
    migration_tag: requiredString(runtime.migration_tag, "RUNTIME_INVALID", NAME),
    assets: {
      not_found_handling: requiredString(assets.not_found_handling, "RUNTIME_INVALID"),
      raw_run_worker_first: requiredBoolean(assets.raw_run_worker_first, "RUNTIME_INVALID"),
      serve_directly: requiredBoolean(assets.serve_directly, "RUNTIME_INVALID"),
    },
    compatibility_date: requiredString(runtime.compatibility_date, "RUNTIME_INVALID", /^\d{4}-\d{2}-\d{2}$/u),
    compatibility_flags: normalizeStringArray(runtime.compatibility_flags, "RUNTIME_INVALID"),
    usage_model: requiredString(runtime.usage_model, "RUNTIME_INVALID", NAME),
    limits: { cpu_ms: requiredFiniteInteger(limits.cpu_ms, "RUNTIME_INVALID", { min: 1 }) },
    cache_options: {
      enabled: requiredBoolean(cache.enabled, "RUNTIME_INVALID"),
      cross_version_cache: requiredBoolean(cache.cross_version_cache, "RUNTIME_INVALID"),
    },
  };
}

function normalizeStringArray(value, code) {
  if (!Array.isArray(value) || value.length > 256
      || value.some((entry) => typeof entry !== "string" || entry.length > 512)) {
    fail(code);
  }
  return [...new Set(value)].sort();
}

function normalizeSettings(settings, runtime, versionBindings) {
  requiredObject(settings, "SETTINGS_MISSING");
  for (const key of SETTINGS_RUNTIME_KEYS) {
    if (!own(settings, key)) fail("SETTINGS_MISSING");
  }
  const settingsRuntime = normalizeRuntime({
    assets: runtime.assets,
    cache_options: settings.cache_options,
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    limits: settings.limits,
    migration_tag: runtime.migration_tag,
    usage_model: settings.usage_model,
  });
  if (JSON.stringify(settingsRuntime.cache_options) !== JSON.stringify(runtime.cache_options)
      || settingsRuntime.compatibility_date !== runtime.compatibility_date
      || JSON.stringify(settingsRuntime.compatibility_flags) !== JSON.stringify(runtime.compatibility_flags)
      || JSON.stringify(settingsRuntime.limits) !== JSON.stringify(runtime.limits)
      || settingsRuntime.usage_model !== runtime.usage_model) {
    fail("SETTINGS_RUNTIME_DRIFT");
  }
  if (!Array.isArray(settings.bindings)) fail("SETTINGS_BINDINGS_MISSING");
  const settingsBindings = normalizeBindings(settings.bindings);
  if (!bindingsEquivalent(settingsBindings, versionBindings)) {
    fail("SETTINGS_BINDINGS_DRIFT");
  }
  if (!own(settings, "placement") || !object(settings.placement)
      || !own(settings, "tags") || !Array.isArray(settings.tags)
      || !own(settings, "tail_consumers") || !Array.isArray(settings.tail_consumers)
      || !own(settings, "logpush") || typeof settings.logpush !== "boolean"
      || !own(settings, "observability") || !object(settings.observability)
      || !own(settings, "annotations") || !object(settings.annotations)) {
    fail("SETTINGS_MISSING");
  }
  return {
    placement: cloneJson(settings.placement, "SETTINGS_INVALID"),
    tags: cloneJson(settings.tags, "SETTINGS_INVALID"),
    tail_consumers: cloneJson(settings.tail_consumers, "SETTINGS_INVALID"),
    logpush: settings.logpush,
    observability: normalizeObservability(settings.observability),
    annotations: cloneJson(settings.annotations, "SETTINGS_INVALID"),
  };
}

// The Workers settings API exposes redact_query_string alongside the
// observability payload, but Wrangler's declarative config does not accept
// that API-only field. Keep the fields Wrangler can round-trip and deliberately
// omit the API-only value instead of emitting an invalid config file.
function normalizeObservability(value) {
  requiredObject(value, "SETTINGS_INVALID");
  const result = {};
  for (const key of ["enabled", "head_sampling_rate"]) {
    if (value[key] !== undefined) {
      result[key] = key === "enabled"
        ? requiredBoolean(value[key], "SETTINGS_INVALID")
        : normalizedSamplingRate(value[key]);
    }
  }
  for (const section of ["logs", "traces"]) {
    if (value[section] === undefined) continue;
    const source = requiredObject(value[section], "SETTINGS_INVALID");
    const target = {};
    for (const key of ["enabled", "head_sampling_rate", "invocation_logs", "persist", "destinations"]) {
      if (source[key] === undefined) continue;
      if (key === "enabled" || key === "invocation_logs" || key === "persist") {
        target[key] = requiredBoolean(source[key], "SETTINGS_INVALID");
      } else if (key === "head_sampling_rate") {
        if (typeof source[key] !== "number" || !Number.isFinite(source[key])
            || source[key] < 0 || source[key] > 1) fail("SETTINGS_INVALID");
        target[key] = source[key];
      } else {
        target[key] = normalizeStringArray(source[key], "SETTINGS_INVALID");
      }
    }
    result[section] = target;
  }
  return result;
}

function normalizedSamplingRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("SETTINGS_INVALID");
  }
  return value;
}

function normalizeSchedules(schedules) {
  const rows = Array.isArray(schedules)
    ? schedules
    : schedules?.schedules ?? schedules?.crons;
  if (!Array.isArray(rows) || rows.length > 64) fail("SCHEDULES_MISSING");
  const crons = rows.map((row) => {
    if (typeof row === "string") return requiredString(row, "SCHEDULES_INVALID", /^\S+(?:\s+\S+){4}$/u);
    requiredObject(row, "SCHEDULES_INVALID");
    return requiredString(row.cron, "SCHEDULES_INVALID", /^\S+(?:\s+\S+){4}$/u);
  });
  if (new Set(crons).size !== crons.length) fail("SCHEDULE_DUPLICATE");
  return [...crons].sort();
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes) || routes.length > 256) fail("ROUTES_MISSING");
  const result = routes.map((route) => {
    if (typeof route === "string") {
      return { pattern: requiredString(route, "ROUTES_INVALID") };
    }
    requiredObject(route, "ROUTES_INVALID");
    const pattern = requiredString(route.pattern, "ROUTES_INVALID");
    const normalized = { pattern };
    if (route.custom_domain !== undefined) {
      normalized.custom_domain = requiredBoolean(route.custom_domain, "ROUTES_INVALID");
    }
    return normalized;
  });
  const keys = result.map((route) => JSON.stringify(route));
  if (new Set(keys).size !== keys.length) fail("ROUTE_DUPLICATE");
  return sorted(result);
}

function normalizeDomains(domains, workerName) {
  if (!Array.isArray(domains) || domains.length > 256) fail("DOMAINS_MISSING");
  const result = domains.map((domain) => {
    requiredObject(domain, "DOMAINS_INVALID");
    const hostname = requiredString(domain.hostname, "DOMAINS_INVALID", HOSTNAME);
    if (domain.service !== undefined && domain.service !== workerName) fail("DOMAINS_INVALID");
    if (domain.environment !== undefined && domain.environment !== "production") fail("DOMAINS_INVALID");
    if (domain.enabled !== undefined && domain.enabled !== true) fail("DOMAINS_INVALID");
    if (domain.previews_enabled !== undefined && domain.previews_enabled !== false) fail("DOMAINS_INVALID");
    return { hostname };
  });
  if (new Set(result.map((domain) => domain.hostname)).size !== result.length) {
    fail("DOMAIN_DUPLICATE");
  }
  return sorted(result);
}

function normalizeSubdomain(subdomain) {
  requiredObject(subdomain, "SUBDOMAIN_MISSING");
  return {
    enabled: requiredBoolean(subdomain.enabled, "SUBDOMAIN_INVALID"),
    previews_enabled: requiredBoolean(subdomain.previews_enabled, "SUBDOMAIN_INVALID"),
  };
}

function normalizeNamespaces(namespaces, workerName, bindings) {
  if (!Array.isArray(namespaces) || namespaces.length > 256) fail("NAMESPACES_MISSING");
  const rows = namespaces.map((namespace) => {
    requiredObject(namespace, "NAMESPACES_INVALID");
    return {
      id: identifier(namespace.id, "NAMESPACES_INVALID"),
      name: requiredString(namespace.name, "NAMESPACES_INVALID"),
      script: requiredString(namespace.script, "NAMESPACES_INVALID", NAME),
      class: requiredString(namespace.class, "NAMESPACES_INVALID", NAME),
      use_sqlite: requiredBoolean(namespace.use_sqlite, "NAMESPACES_INVALID"),
    };
  });
  const bound = bindings.filter((binding) => binding.type === "durable_object_namespace");
  for (const binding of bound) {
    const matches = rows.filter((row) => row.id === binding.namespace_id);
    if (matches.length !== 1 || matches[0].script !== workerName
        || matches[0].class !== binding.class_name || matches[0].use_sqlite !== true) {
      fail("NAMESPACE_BINDING_DRIFT");
    }
  }
  return sorted(rows.filter((row) => row.script === workerName));
}

function routeConfig(snapshot) {
  const domainRoutes = snapshot.domains.map(({ hostname }) => ({
    pattern: hostname,
    custom_domain: true,
  }));
  const routes = [...snapshot.routes, ...domainRoutes];
  const seen = new Set();
  const deduped = [];
  for (const route of routes) {
    const key = JSON.stringify(route);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(route);
  }
  return sorted(deduped);
}

function configEnvironment(config) {
  requiredObject(config, "CONFIG_INVALID");
  if (object(config.env?.production)) return config.env.production;
  return config;
}

function normalizeConfigBindings(config) {
  const result = [];
  const vars = config.vars;
  if (!object(vars)) fail("CONFIG_VARS_INVALID");
  for (const [name, text] of Object.entries(vars)) {
    result.push({
      name: requiredString(name, "CONFIG_VARS_INVALID", NAME),
      type: "plain_text",
      text: requiredString(text, "CONFIG_VARS_INVALID"),
    });
  }
  if (!Array.isArray(config.secrets?.required)) fail("CONFIG_SECRETS_INVALID");
  for (const name of config.secrets.required) {
    result.push({ name: requiredString(name, "CONFIG_SECRETS_INVALID", NAME), type: "secret_text" });
  }
  if (!Array.isArray(config.d1_databases)) fail("CONFIG_D1_INVALID");
  for (const entry of config.d1_databases) {
    requiredObject(entry, "CONFIG_D1_INVALID");
    const { binding, ...fields } = entry;
    result.push(normalizeBinding({
      ...fields,
      name: binding,
      type: "d1",
      id: fields.id ?? fields.database_id,
    }));
  }
  if (!Array.isArray(config.r2_buckets)) fail("CONFIG_R2_INVALID");
  for (const entry of config.r2_buckets) {
    requiredObject(entry, "CONFIG_R2_INVALID");
    const { binding, ...fields } = entry;
    result.push(normalizeBinding({ ...fields, name: binding, type: "r2_bucket" }));
  }
  if (!Array.isArray(config.ratelimits)) fail("CONFIG_RATELIMIT_INVALID");
  for (const entry of config.ratelimits) result.push(normalizeBinding({ ...entry, type: "ratelimit" }));
  if (!object(config.durable_objects) || !Array.isArray(config.durable_objects.bindings)) {
    fail("CONFIG_DURABLE_OBJECTS_INVALID");
  }
  for (const entry of config.durable_objects.bindings) {
    requiredObject(entry, "CONFIG_DURABLE_OBJECTS_INVALID");
    result.push({
      name: requiredString(entry.name, "CONFIG_DURABLE_OBJECTS_INVALID", NAME),
      type: "durable_object_namespace",
      namespace_id: "config-do-identity",
      class_name: requiredString(entry.class_name, "CONFIG_DURABLE_OBJECTS_INVALID", NAME),
      ...(entry.script_name === undefined ? {} : { script_name: requiredString(entry.script_name, "CONFIG_DURABLE_OBJECTS_INVALID", NAME) }),
      ...(entry.environment === undefined ? {} : { environment: requiredString(entry.environment, "CONFIG_DURABLE_OBJECTS_INVALID", NAME) }),
    });
  }
  if (!object(config.assets)) fail("CONFIG_ASSETS_INVALID");
  result.push({
    name: requiredString(config.assets.binding, "CONFIG_ASSETS_INVALID", NAME),
    type: "assets",
  });
  const names = result.map((binding) => binding.name);
  if (new Set(names).size !== names.length) fail("CONFIG_BINDING_DUPLICATE");
  return sorted(result);
}

function comparableBindings(bindings, { omitSource = false } = {}) {
  return sorted(bindings
    .filter((binding) => !(omitSource && binding.name === PRODUCTION_LIVE_CONFIG_SOURCE_BINDING))
    .map((binding) => {
      if (binding.type === "durable_object_namespace") {
        const { namespace_id: ignored, ...rest } = binding;
        return rest;
      }
      if (binding.type === "d1") {
        const { database_name: ignored, ...rest } = binding;
        return rest;
      }
      return binding;
    }));
}

function comparableRuntime(runtime) {
  return {
    assets: runtime.assets,
    cache_options: runtime.cache_options,
    compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.compatibility_flags,
    limits: runtime.limits,
    migration_tag: runtime.migration_tag,
    usage_model: runtime.usage_model,
  };
}

function comparableSettings(settings) {
  return {
    logpush: settings.logpush,
    observability: settings.observability,
    placement: settings.placement,
    tail_consumers: settings.tail_consumers,
  };
}

function comparableSnapshot(snapshot) {
  return {
    accountId: snapshot.accountId,
    bindings: comparableBindings(snapshot.bindings, { omitSource: true }),
    crons: snapshot.crons,
    domains: snapshot.domains,
    namespaces: snapshot.namespaces,
    routes: snapshot.routes,
    runtime: comparableRuntime(snapshot.runtime),
    settings: comparableSettings(snapshot.settings),
    subdomain: snapshot.subdomain,
    workerName: snapshot.workerName,
  };
}

function candidateComparable({ config, snapshot }) {
  const environment = configEnvironment(config);
  // This routine profile supports only the existing single SQLite namespace
  // declaration. A matching final tag must not hide added/deleted/renamed
  // classes or extra migration steps. Broader DO evolution is a separate gate.
  const migration = environment.migrations?.[0];
  const classes = snapshot.bindings.filter(binding => binding.type === "durable_object_namespace")
    .map(binding => binding.class_name).sort();
  if (!Array.isArray(environment.migrations) || environment.migrations.length !== 1
    || !object(migration) || Object.keys(migration).sort().join(",") !== "new_sqlite_classes,tag"
    || migration.tag !== snapshot.runtime.migration_tag
    || !Array.isArray(migration.new_sqlite_classes)
    || JSON.stringify([...migration.new_sqlite_classes].sort()) !== JSON.stringify(classes)) {
    fail("CONFIG_MIGRATIONS_INVALID");
  }
  const candidateBindings = normalizeConfigBindings(environment);
  const expectedBindings = comparableBindings(snapshot.bindings, { omitSource: true });
  const actualBindings = comparableBindings(candidateBindings, { omitSource: true });
  const actualVars = new Map(candidateBindings
    .filter((binding) => binding.type === "plain_text")
    .map((binding) => [binding.name, binding.text]));
  if (actualVars.get(PRODUCTION_LIVE_CONFIG_SOURCE_BINDING) === undefined) fail("CONFIG_SOURCE_MISSING");
  const sourceCommit = actualVars.get(PRODUCTION_LIVE_CONFIG_SOURCE_BINDING);
  const rootAccountId = config.account_id;
  const environmentAccountId = environment.account_id;
  if ((rootAccountId !== undefined && rootAccountId !== snapshot.accountId)
      || (environmentAccountId !== undefined && environmentAccountId !== snapshot.accountId)) {
    fail("CONFIG_ACCOUNT_DRIFT");
  }
  const accountId = environmentAccountId ?? rootAccountId;
  if (accountId !== snapshot.accountId) fail("CONFIG_ACCOUNT_DRIFT");
  const expectedVarNames = snapshot.bindings
    .filter((binding) => binding.type === "plain_text" && binding.name !== PRODUCTION_LIVE_CONFIG_SOURCE_BINDING)
    .map((binding) => binding.name)
    .sort();
  const actualVarNames = [...actualVars.keys()]
    .filter((name) => name !== PRODUCTION_LIVE_CONFIG_SOURCE_BINDING)
    .sort();
  if (JSON.stringify(expectedVarNames) !== JSON.stringify(actualVarNames)) fail("CONFIG_VARS_DRIFT");
  const runtime = {
    migration_tag: Array.isArray(environment.migrations) && environment.migrations.length > 0
      ? requiredString(environment.migrations.at(-1)?.tag, "CONFIG_MIGRATIONS_INVALID", NAME)
      : fail("CONFIG_MIGRATIONS_INVALID"),
    assets: {
      not_found_handling: requiredString(environment.assets.not_found_handling, "CONFIG_ASSETS_INVALID"),
      raw_run_worker_first: requiredBoolean(environment.assets.run_worker_first, "CONFIG_ASSETS_INVALID"),
      serve_directly: snapshot.runtime.assets.serve_directly,
    },
    compatibility_date: requiredString(environment.compatibility_date, "CONFIG_RUNTIME_INVALID", /^\d{4}-\d{2}-\d{2}$/u),
    compatibility_flags: normalizeStringArray(environment.compatibility_flags, "CONFIG_RUNTIME_INVALID"),
    usage_model: snapshot.runtime.usage_model,
    limits: cloneJson(environment.limits, "CONFIG_RUNTIME_INVALID"),
    cache_options: cloneJson(environment.cache, "CONFIG_RUNTIME_INVALID"),
  };
  if (!object(runtime.limits) || !object(runtime.cache_options)) fail("CONFIG_RUNTIME_INVALID");
  const settings = {
    placement: environment.placement === undefined
      ? {}
      : cloneJson(environment.placement, "CONFIG_SETTINGS_INVALID"),
    tail_consumers: cloneJson(environment.tail_consumers, "CONFIG_SETTINGS_INVALID"),
    logpush: requiredBoolean(environment.logpush, "CONFIG_SETTINGS_INVALID"),
    observability: normalizeObservability(environment.observability),
  };
  return {
    bindings: actualBindings,
    crons: normalizeSchedules(environment.triggers),
    domains: snapshot.domains,
    namespaces: snapshot.namespaces,
    routes: normalizeRoutes(environment.routes ?? []),
    runtime,
    settings,
    subdomain: {
      enabled: requiredBoolean(environment.workers_dev, "CONFIG_SUBDOMAIN_INVALID")
        ? true
        : false,
      previews_enabled: requiredBoolean(environment.preview_urls, "CONFIG_SUBDOMAIN_INVALID"),
    },
    workerName: requiredString(environment.name, "CONFIG_NAME_INVALID", NAME),
    accountId,
    sourceCommit,
    expectedBindings,
  };
}

function checkUnsupportedResources(environment) {
  if (UNSUPPORTED_CONFIG_KEYS.some((key) => environment[key] !== undefined)) {
    fail("CONFIG_SETTING_UNSUPPORTED");
  }
  for (const key of UNSUPPORTED_CONFIG_RESOURCE_KEYS) {
    if (environment[key] !== undefined) fail("CONFIG_RESOURCE_UNSUPPORTED");
  }
  for (const key of CONFIG_RESOURCE_KEYS) {
    if (environment[key] === undefined) fail("CONFIG_RESOURCE_MISSING");
  }
}

function assertRuntimeMatches(actual, expected) {
  if (JSON.stringify(comparableRuntime(actual)) !== JSON.stringify(comparableRuntime(expected))) {
    fail("CONFIG_RUNTIME_DRIFT");
  }
}

function assertCandidateMatches({ candidate, snapshot, sourceCommit }) {
  if (candidate.sourceCommit !== sourceCommit || !SHA.test(sourceCommit)) fail("CONFIG_SOURCE_INVALID");
  if (candidate.accountId !== snapshot.accountId) fail("CONFIG_ACCOUNT_DRIFT");
  if (candidate.workerName !== snapshot.workerName) fail("CONFIG_NAME_DRIFT");
  if (JSON.stringify(candidate.bindings) !== JSON.stringify(comparableBindings(snapshot.bindings, { omitSource: true }))) {
    fail("CONFIG_BINDING_DRIFT");
  }
  if (JSON.stringify(candidate.routes) !== JSON.stringify(routeConfig(snapshot))) fail("CONFIG_ROUTE_DRIFT");
  if (JSON.stringify(candidate.crons) !== JSON.stringify(snapshot.crons)) fail("CONFIG_CRON_DRIFT");
  assertRuntimeMatches(candidate.runtime, snapshot.runtime);
  if (digest(candidate.settings) !== digest(comparableSettings(snapshot.settings))) fail("CONFIG_SETTINGS_DRIFT");
  if (JSON.stringify(candidate.subdomain) !== JSON.stringify(snapshot.subdomain)) fail("CONFIG_SUBDOMAIN_DRIFT");
}

/**
 * Validate and canonicalize the raw, private inventory captured from the
 * Cloudflare version/settings/routes/schedules APIs. No source values are
 * emitted by this function's errors or digest result.
 */
export function createProductionLiveConfigSnapshot(inventory) {
  requiredObject(inventory, "INVENTORY_MISSING");
  const accountId = requiredString(inventory.accountId, "INVENTORY_INVALID", HEX32);
  const workerName = requiredString(inventory.workerName, "INVENTORY_INVALID", NAME);
  const version = requiredObject(inventory.version, "VERSION_MISSING");
  const versionId = requiredString(version.id, "VERSION_INVALID", UUID);
  const resources = requiredObject(version.resources, "VERSION_RESOURCES_MISSING");
  const runtime = normalizeRuntime(resources.script_runtime);
  const bindings = normalizeBindings(resources.bindings);
  const settings = normalizeSettings(inventory.settings, runtime, bindings);
  const crons = normalizeSchedules(inventory.schedules);
  const subdomain = normalizeSubdomain(inventory.subdomain);
  const routes = normalizeRoutes(inventory.routes);
  const domains = normalizeDomains(inventory.domains, workerName);
  const namespaces = normalizeNamespaces(inventory.namespaces, workerName, bindings);
  const source = bindings.find((binding) => binding.name === PRODUCTION_LIVE_CONFIG_SOURCE_BINDING);
  if (source !== undefined && source.type !== "plain_text") fail("SOURCE_BINDING_INVALID");
  if (source !== undefined && !SHA.test(source.text)) fail("SOURCE_BINDING_INVALID");
  const snapshot = {
    schema: PRODUCTION_LIVE_CONFIG_SCHEMA,
    accountId,
    workerName,
    versionId,
    runtime,
    bindings,
    settings,
    crons,
    subdomain,
    routes,
    domains,
    namespaces,
    sourceCommit: source?.text ?? null,
  };
  return {
    ...snapshot,
    fingerprint: digest(comparableSnapshot(snapshot)),
  };
}

/**
 * Render a complete config that can be passed to Wrangler with
 * `--env production`. Only the production environment is replaced; staging
 * and root configuration remain source-owned. The resulting object contains
 * live plain vars and resource identifiers and must therefore stay private.
 */
export function renderProductionLiveConfig({ trackedConfig, snapshot, sourceCommit }) {
  const inventoryBindings = snapshot?.schema === PRODUCTION_LIVE_CONFIG_SCHEMA
    ? snapshot.bindings.map((binding) => binding.type === "d1"
      ? { ...binding, id: binding.database_id }
      : binding)
    : null;
  const normalized = createProductionLiveConfigSnapshot(snapshot.schema === PRODUCTION_LIVE_CONFIG_SCHEMA
    ? {
      accountId: snapshot.accountId,
      workerName: snapshot.workerName,
      version: { id: snapshot.versionId, resources: { script_runtime: snapshot.runtime, bindings: inventoryBindings } },
      settings: {
        ...snapshot.settings,
        compatibility_date: snapshot.runtime.compatibility_date,
        compatibility_flags: snapshot.runtime.compatibility_flags,
        usage_model: snapshot.runtime.usage_model,
        limits: snapshot.runtime.limits,
        cache_options: snapshot.runtime.cache_options,
        bindings: inventoryBindings,
      },
      schedules: { schedules: snapshot.crons.map((cron) => ({ cron })) },
      subdomain: snapshot.subdomain,
      routes: snapshot.routes,
      domains: snapshot.domains,
      namespaces: snapshot.namespaces,
    }
    : snapshot);
  if (!SHA.test(sourceCommit)) fail("SOURCE_INVALID");
  requiredObject(trackedConfig, "CONFIG_INVALID");
  const original = configEnvironment(trackedConfig);
  checkUnsupportedResources(original);
  if (original.name !== normalized.workerName) fail("CONFIG_NAME_DRIFT");
  const base = cloneJson(original, "CONFIG_INVALID");
  const existingD1 = new Map((base.d1_databases ?? []).map((entry) => [entry.binding, entry]));
  const existingR2 = new Map((base.r2_buckets ?? []).map((entry) => [entry.binding, entry]));
  const existingDo = new Map((base.durable_objects?.bindings ?? []).map((entry) => [entry.name, entry]));
  const d1_databases = normalized.bindings.filter((binding) => binding.type === "d1").map((binding) => ({
    binding: binding.name,
    database_id: binding.database_id,
    // A typed deployment must not carry the legacy JSON migration directory.
    // A database name is retained only when the checked-in ID is identical;
    // otherwise the stale name could make the generated config misleading.
    ...(existingD1.get(binding.name)?.database_id === binding.database_id
      && existingD1.get(binding.name)?.database_name !== undefined
      ? { database_name: existingD1.get(binding.name).database_name }
      : {}),
  }));
  const r2_buckets = normalized.bindings.filter((binding) => binding.type === "r2_bucket").map((binding) => ({
    binding: binding.name,
    bucket_name: binding.bucket_name,
    ...(binding.jurisdiction === undefined ? {} : { jurisdiction: binding.jurisdiction }),
  }));
  const durableBindings = normalized.bindings.filter((binding) => binding.type === "durable_object_namespace").map((binding) => ({
    name: binding.name,
    class_name: binding.class_name,
    ...(binding.script_name === undefined ? (existingDo.get(binding.name)?.script_name === undefined ? {} : { script_name: existingDo.get(binding.name).script_name }) : { script_name: binding.script_name }),
    ...(binding.environment === undefined ? (existingDo.get(binding.name)?.environment === undefined ? {} : { environment: existingDo.get(binding.name).environment }) : { environment: binding.environment }),
  }));
  const assets = {
    ...base.assets,
    binding: normalized.bindings.find((binding) => binding.type === "assets")?.name,
    not_found_handling: normalized.runtime.assets.not_found_handling,
    run_worker_first: normalized.runtime.assets.raw_run_worker_first,
  };
  if (!assets.binding) fail("CONFIG_ASSETS_INVALID");
  const effective = {
    ...base,
    account_id: normalized.accountId,
    name: normalized.workerName,
    workers_dev: normalized.subdomain.enabled,
    preview_urls: normalized.subdomain.previews_enabled,
    compatibility_date: normalized.runtime.compatibility_date,
    compatibility_flags: normalized.runtime.compatibility_flags,
    limits: cloneJson(normalized.runtime.limits),
    cache: cloneJson(normalized.runtime.cache_options),
    observability: cloneJson(normalized.settings.observability),
    logpush: normalized.settings.logpush,
    tail_consumers: cloneJson(normalized.settings.tail_consumers),
    routes: routeConfig(normalized),
    triggers: { crons: [...normalized.crons] },
    vars: Object.fromEntries(normalized.bindings
      .filter((binding) => binding.type === "plain_text" && binding.name !== PRODUCTION_LIVE_CONFIG_SOURCE_BINDING)
      .map((binding) => [binding.name, binding.text])
      .concat([[PRODUCTION_LIVE_CONFIG_SOURCE_BINDING, sourceCommit]])),
    secrets: { required: normalized.bindings.filter((binding) => binding.type === "secret_text").map((binding) => binding.name).sort() },
    d1_databases,
    r2_buckets,
    ratelimits: normalized.bindings.filter((binding) => binding.type === "ratelimit").map(({ name, namespace_id, simple }) => ({ name, namespace_id, simple })),
    durable_objects: { ...base.durable_objects, bindings: durableBindings },
    assets,
    ...(Object.keys(normalized.settings.placement).length > 0
      ? { placement: cloneJson(normalized.settings.placement) }
      : {}),
  };
  // Wrangler inherits migrations from the root config when an environment does
  // not redeclare them. Keep that declaration in the generated environment so
  // the typed runner sees the live migration tag under --env production.
  if (effective.migrations === undefined && Array.isArray(trackedConfig.migrations)) {
    effective.migrations = cloneJson(trackedConfig.migrations, "CONFIG_MIGRATIONS_INVALID");
  }
  const rendered = object(trackedConfig.env)
    ? { ...cloneJson(trackedConfig), account_id: normalized.accountId, env: { ...cloneJson(trackedConfig.env), production: effective } }
    : effective;
  const verification = verifyProductionLiveConfig({ snapshot: normalized, candidateConfig: rendered, sourceCommit });
  if (!verification.ok) {
    const suffix = typeof verification.code === "string"
      && verification.code.startsWith("PRODUCTION_LIVE_CONFIG_")
      ? verification.code.slice("PRODUCTION_LIVE_CONFIG_".length)
      : "DRIFT";
    fail(`CONFIG_${suffix}`);
  }
  return rendered;
}

/**
 * Compare a rendered candidate config with a captured live baseline. The
 * result is intentionally limited to status, a stable code, and digests.
 */
export function verifyProductionLiveConfig({ snapshot, candidateConfig, sourceCommit }) {
  try {
    const normalized = snapshot?.schema === PRODUCTION_LIVE_CONFIG_SCHEMA
      ? snapshot
      : createProductionLiveConfigSnapshot(snapshot);
    const environment = configEnvironment(candidateConfig);
    checkUnsupportedResources(environment);
    const candidate = candidateComparable({ config: candidateConfig, snapshot: normalized });
    assertCandidateMatches({ candidate, snapshot: normalized, sourceCommit });
    const expectedFingerprint = normalized.fingerprint ?? digest(comparableSnapshot(normalized));
    const actualFingerprint = digest({
      accountId: candidate.accountId,
      bindings: candidate.bindings,
      crons: candidate.crons,
      domains: normalized.domains,
      namespaces: normalized.namespaces,
      routes: normalized.routes,
      runtime: comparableRuntime(candidate.runtime),
      settings: candidate.settings,
      subdomain: candidate.subdomain,
      workerName: candidate.workerName,
    });
    if (expectedFingerprint !== actualFingerprint) {
      return { ok: false, code: "PRODUCTION_LIVE_CONFIG_DRIFT", expectedFingerprint, actualFingerprint };
    }
    return { ok: true, code: null, expectedFingerprint, actualFingerprint };
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("PRODUCTION_LIVE_CONFIG_")) {
      return { ok: false, code: error.code };
    }
    return { ok: false, code: "PRODUCTION_LIVE_CONFIG_INVALID" };
  }
}

export function productionLiveConfigFingerprint(snapshot) {
  const normalized = snapshot?.schema === PRODUCTION_LIVE_CONFIG_SCHEMA
    ? snapshot
    : createProductionLiveConfigSnapshot(snapshot);
  return normalized.fingerprint ?? digest(comparableSnapshot(normalized));
}
