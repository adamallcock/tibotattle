import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  cp,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import { parse } from "jsonc-parser";
import {
  checkDeploymentEndpointConsumers,
  edgeModeForbiddenPathClass,
  validateEdgeModePublicSurface,
} from "./check-deployment-endpoints.mjs";
import { checkLocalWorkspacePackages } from "./check-local-workspace-packages.mjs";
import {
  stageProductionAssets,
  verifyPinnedPublicReleaseManifestSource,
} from "./stage-production-assets.mjs";
import { ADMIN_UI_SOURCES } from "./generate-admin-ui-assets.mjs";
import { runReleasePreflight } from "./release-preflight.mjs";
import {
  identityDigest,
  openOperation,
  operationError,
  readOperation,
} from "../../../scripts/lib/release-operation.mjs";
import { createProductionDeploymentLock } from "./production-deployment-lock.mjs";
import { readPrivateProductionInventory } from "./production-reconcile.mjs";
import { createProductionLiveProvider } from "./production-live-provider.mjs";
import {
  createProductionLiveConfigSnapshot,
  renderProductionLiveConfig,
  verifyProductionLiveConfig,
} from "./production-live-config.mjs";
import { buildTypedProductionExpectedSchemas } from "./production-typed-schema.mjs";
import {
  runTypedProductionPreflight,
  TYPED_PRODUCTION_ROLE_BINDINGS,
} from "./production-typed-preflight.mjs";

// Renamed from DEPLOY_CONTAINED_PRODUCTION on 2026-08-07: production deploys
// no longer assert a contained/paused intake posture, so the old token lied.
// See docs/governance/2026-08-07-production-deploy-migration-gate.md.
export const PRODUCTION_DEPLOY_CONFIRMATION =
  "DEPLOY_PRODUCTION";
const PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS = 10_000;
// Wrangler creates these runtime-state directories at the node_modules root
// while release preflight runs. They contain account/Miniflare cache data, not
// installed package code, and can legitimately appear after the dependency
// snapshot is taken. Skip only these root entries: identically named paths
// inside an installed package remain covered by the integrity digest.
const DEPENDENCY_RUNTIME_STATE_DIRECTORIES = new Set([".cache", ".mf"]);
export const PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS = Object.freeze([
  "/app.js",
  "/data-client.js",
  "/navigation.js",
  "/admin",
  ...ADMIN_UI_SOURCES.map(({ route }) => route),
  "/api/v1/admin/community/allowance-preview",
  "/api/v1/admin/reconstruction-progress",
  "/api/v1/admin/database-health",
]);
const PRODUCTION_PUBLIC_ROOT_FORBIDDEN_MARKERS = Object.freeze([
  'src="./app.js"',
  'id="share-panel"',
  'id="identity-google-signin"',
  'id="contribution-cta"',
  'id="blind-spot-list"',
]);
const PRODUCTION_PUBLIC_RELEASE_MANIFEST_PATH = "/release-site-manifest.json";
const PRODUCTION_PUBLIC_RELEASE_MANIFEST_MAX_BYTES = 512 * 1024;

function localFailure(code) {
  return { ok: false, code };
}

// Edge-mode support (production-edge-mode.mjs) loads only when an edge mode is
// requested or pinned, so a deploy without --edge-mode keeps its module graph.
let productionEdgeModeModule = null;
async function loadProductionEdgeMode() {
  productionEdgeModeModule ??= await import("./production-edge-mode.mjs");
  return productionEdgeModeModule;
}

// The web-release receipt verifier (scripts/web-release-lane.js) loads only for
// a candidate-site deploy from the CLI, for the same reason.
let webReleaseLaneModule = null;
async function loadWebReleaseLane() {
  webReleaseLaneModule ??= await import("../../../scripts/web-release-lane.js");
  return webReleaseLaneModule;
}

// Options only an --edge-mode deploy may carry.
const PRODUCTION_EDGE_OPTION_NAMES = Object.freeze([
  "edgePlan",
  "originCommit",
  "obtainOriginIdentityToken",
  "edgeHistory",
  "edgeTools",
]);

const PRODUCTION_SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const PRODUCTION_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const defaultTypedConfigTools = Object.freeze({
  createSnapshot: createProductionLiveConfigSnapshot,
  render: renderProductionLiveConfig,
  verify: verifyProductionLiveConfig,
});

function typedFailure(code, typedCode = null) {
  return {
    ok: false,
    code,
    ...(typeof typedCode === "string" ? { typedCode } : {}),
  };
}

function typedSnapshotMatches(left, right, { source = true, version = true } = {}) {
  return left?.fingerprint === right?.fingerprint
    && (!source || left?.sourceCommit === right?.sourceCommit)
    && (!version || left?.versionId === right?.versionId);
}

function typedConfigDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function typedConfigEnvironment(config) {
  return config?.env?.production && typeof config.env.production === "object"
    ? config.env.production
    : config;
}

function typedRoles() {
  return Object.entries(TYPED_PRODUCTION_ROLE_BINDINGS)
    .map(([role, binding]) => ({ role, binding }));
}

const TYPED_SCHEMA_IDENTITY_ROLES = Object.freeze(
  Object.keys(TYPED_PRODUCTION_ROLE_BINDINGS).sort(),
);

function typedSchemaIdentity(expected) {
  if (expected?.schema !== "production-typed-schema-v1"
      || !expected?.inputSha256
      || typeof expected.inputSha256 !== "object"
      || Array.isArray(expected.inputSha256)
      || !expected?.expectedSchemas
      || typeof expected.expectedSchemas !== "object"
      || Array.isArray(expected.expectedSchemas)
      || !PRODUCTION_SHA256_PATTERN.test(expected.operatorSchemaSourceSha256 ?? "")) {
    return null;
  }
  const roleKey = TYPED_SCHEMA_IDENTITY_ROLES.join(",");
  if (Object.keys(expected.inputSha256).sort().join(",") !== roleKey
      || Object.keys(expected.expectedSchemas).sort().join(",") !== roleKey) {
    return null;
  }
  const inputSha256 = {};
  const schemaSha256 = {};
  for (const role of TYPED_SCHEMA_IDENTITY_ROLES) {
    const input = expected.inputSha256[role];
    const schema = expected.expectedSchemas[role]?.schemaSha256;
    if (!PRODUCTION_SHA256_PATTERN.test(input ?? "")
        || !PRODUCTION_SHA256_PATTERN.test(schema ?? "")) {
      return null;
    }
    inputSha256[role] = input;
    schemaSha256[role] = schema;
  }
  return {
    schema: expected.schema,
    inputSha256,
    schemaSha256,
    operatorSchemaSourceSha256: expected.operatorSchemaSourceSha256,
  };
}

/**
 * Compute the immutable, content-free identity that is written into the
 * production operation journal before any provider mutation is attempted.
 * The live configuration fingerprint and schema/asset pins let a later
 * operator distinguish a typed operation from the legacy reconciliation path;
 * no binding IDs, names, or other private inventory values are persisted.
 */
export async function createTypedProductionOperationPin({
  inventory,
  workerDirectory,
  expectedPreviousSourceCommit,
  retainedPublicSourceCommit,
  expectedLiveManifestSha256,
  candidatePublicManifestSha256 = null,
  candidatePublicSourceCommit = null,
  buildSchemas = buildTypedProductionExpectedSchemas,
  configTools = defaultTypedConfigTools,
} = {}) {
  if (!PRODUCTION_SOURCE_COMMIT_PATTERN.test(expectedPreviousSourceCommit ?? "")
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(retainedPublicSourceCommit ?? "")
      || !PRODUCTION_SHA256_PATTERN.test(expectedLiveManifestSha256 ?? "")
      || (candidatePublicManifestSha256 !== null && !PRODUCTION_SHA256_PATTERN.test(candidatePublicManifestSha256))
      // A candidate site built from another commit (a rollback) names that
      // commit; it is meaningless without a candidate manifest.
      || (candidatePublicSourceCommit !== null
        && (candidatePublicManifestSha256 === null
          || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(candidatePublicSourceCommit)))
      || typeof buildSchemas !== "function"
      || typeof configTools?.createSnapshot !== "function") {
    return typedFailure("PRODUCTION_TYPED_INPUT_INVALID");
  }
  let baseline;
  let expected;
  try {
    baseline = configTools.createSnapshot(inventory);
    if (baseline.sourceCommit !== expectedPreviousSourceCommit) {
      return typedFailure("PRODUCTION_TYPED_PREDECESSOR_MISMATCH");
    }
    expected = await buildSchemas({ workerDirectory });
  } catch (error) {
    const code = typeof error?.code === "string"
      && (error.code.startsWith("PRODUCTION_LIVE_CONFIG_")
        || error.code.startsWith("PRODUCTION_LIVE_")
        || error.code.startsWith("PRODUCTION_TYPED_SCHEMA_")
        || error.code.startsWith("PRODUCTION_TYPED_"))
      ? error.code
      : "PRODUCTION_TYPED_SCHEMA_IDENTITY_FAILED";
    return typedFailure(code);
  }
  if (!PRODUCTION_SHA256_PATTERN.test(baseline?.fingerprint ?? "")) {
    return typedFailure("PRODUCTION_TYPED_LIVE_CONFIG_FINGERPRINT_INVALID");
  }
  const schemaIdentity = typedSchemaIdentity(expected);
  if (!schemaIdentity) return typedFailure("PRODUCTION_TYPED_SCHEMA_IDENTITY_INVALID");
  return {
    ok: true,
    pin: {
      schema: "production-typed-operation-v1",
      liveConfigurationFingerprint: baseline.fingerprint,
      predecessorSourceCommit: expectedPreviousSourceCommit,
      retainedPublicSourceCommit,
      expectedLiveManifestSha256,
      ...(candidatePublicManifestSha256 === null ? {} : { candidatePublicManifestSha256 }),
      ...(candidatePublicSourceCommit === null ? {} : { candidatePublicSourceCommit }),
      expectedSchemaIdentity: schemaIdentity,
    },
  };
}

async function installTypedProductionConfig({ configPath, configBytes }) {
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch {
    throw operationError("PRODUCTION_TYPED_CONFIG_PATH_INVALID");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw operationError("PRODUCTION_TYPED_CONFIG_PATH_INVALID");
  }
  try {
    await chmod(configPath, 0o600);
    await writeFile(configPath, configBytes, { flag: "w" });
    const written = await lstat(configPath);
    if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1
        || (written.mode & 0o077) !== 0) {
      throw operationError("PRODUCTION_TYPED_CONFIG_PATH_INVALID");
    }
  } catch (error) {
    if (error?.code === "PRODUCTION_TYPED_CONFIG_PATH_INVALID") throw error;
    throw operationError("PRODUCTION_TYPED_CONFIG_WRITE_FAILED");
  }
}

// The generated live config intentionally replaces the checked-in config in
// the disposable snapshot. It is the only expected tracked-file difference;
// every other source change remains visible to the public asset clean-tree
// gate. The checked-out source tree is still verified independently before and
// after the provider mutation.
function gitWithGeneratedConfigException({ snapshotGit, repositoryRoot, configPath }) {
  const relativeConfig = relative(repositoryRoot, configPath).split(sep).join("/");
  const marker = ` M ${relativeConfig}`;
  return (root, arguments_) => {
    const output = snapshotGit(root, arguments_);
    if (root !== repositoryRoot || arguments_?.[0] !== "status") return output;
    return output
      .split(/\r?\n/u)
      .filter((line) => line !== marker)
      .join("\n");
  };
}

/**
 * Prepare the typed production candidate against an owner-private inventory.
 * This performs only provider reads and local config/schema qualification; the
 * caller must still install the returned config into its disposable snapshot
 * and pass the immutable source/lock gates before Wrangler is invoked.
 */
export async function prepareTypedProductionDeployment({
  inventory,
  provider,
  workerDirectory,
  sourceCommit,
  expectedPreviousSourceCommit,
  buildSchemas = buildTypedProductionExpectedSchemas,
  inspectTyped = runTypedProductionPreflight,
  configTools = defaultTypedConfigTools,
} = {}) {
  if (!PRODUCTION_SOURCE_COMMIT_PATTERN.test(sourceCommit ?? "")
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(expectedPreviousSourceCommit ?? "")
      || !inventory || typeof inventory !== "object"
      || typeof provider?.capture !== "function"
      || typeof provider?.query !== "function"
      || typeof buildSchemas !== "function"
      || typeof inspectTyped !== "function"
      || typeof configTools?.createSnapshot !== "function"
      || typeof configTools?.render !== "function"
      || typeof configTools?.verify !== "function") {
    return typedFailure("PRODUCTION_TYPED_INPUT_INVALID");
  }

  let baseline;
  let currentInventory;
  let current;
  let trackedConfig;
  let candidateConfig;
  let expected;
  let typed;
  try {
    baseline = configTools.createSnapshot(inventory);
    if (baseline.sourceCommit !== expectedPreviousSourceCommit) {
      return typedFailure("PRODUCTION_TYPED_PREDECESSOR_MISMATCH");
    }
    currentInventory = await provider.capture();
    current = configTools.createSnapshot(currentInventory);
    if (!typedSnapshotMatches(baseline, current)
        || current.sourceCommit !== expectedPreviousSourceCommit) {
      return typedFailure("PRODUCTION_TYPED_LIVE_CHANGED");
    }

    const parseErrors = [];
    trackedConfig = parse(
      await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8"),
      parseErrors,
    );
    if (parseErrors.length || !trackedConfig || typeof trackedConfig !== "object") {
      return typedFailure("PRODUCTION_TYPED_CONFIG_INVALID");
    }
    candidateConfig = configTools.render({
      trackedConfig,
      snapshot: current,
      sourceCommit,
    });
    const preservation = configTools.verify({
      snapshot: current,
      candidateConfig,
      sourceCommit,
    });
    if (!preservation?.ok) {
      return typedFailure(
        "PRODUCTION_TYPED_CONFIG_UNVERIFIED",
        preservation?.code,
      );
    }

    expected = await buildSchemas({ workerDirectory });
    const production = typedConfigEnvironment(candidateConfig);
    const vars = production?.vars;
    typed = await inspectTyped({
      roles: typedRoles(),
      expectedSchemas: expected?.expectedSchemas,
      config: {
        mode: vars?.TELEMETRY_STORAGE_MODE,
        sourceNamespace: vars?.TELEMETRY_STORAGE_NAMESPACE,
      },
      runQuery: (binding, sql) => provider.query(currentInventory, binding, sql),
    });
  } catch (error) {
    const code = typeof error?.code === "string"
      && (error.code.startsWith("PRODUCTION_LIVE_CONFIG_")
        || error.code.startsWith("PRODUCTION_LIVE_")
        || error.code.startsWith("TYPED_PREFLIGHT_")
        || error.code.startsWith("PRODUCTION_TYPED_"))
      ? error.code
      : "PRODUCTION_TYPED_PREPARATION_FAILED";
    return typedFailure(code);
  }
  if (!typed?.ok) {
    return typedFailure("PRODUCTION_TYPED_PREFLIGHT_BLOCKED", typed?.code);
  }
  const configBytes = Buffer.from(
    `${JSON.stringify(candidateConfig, null, 2)}\n`,
    "utf8",
  );
  return {
    ok: true,
    baseline,
    current,
    currentInventory,
    candidateConfig,
    configBytes,
    configSha256: typedConfigDigest(configBytes),
    expectedSchemas: expected.expectedSchemas,
    expectedSchemaIdentity: typedSchemaIdentity(expected),
    provider,
    inspectTyped,
    configTools,
  };
}

/**
 * Re-read the pinned live configuration and all fixed typed SELECTs at a
 * deployment boundary. Before Wrangler the active version/source must still
 * be the pinned predecessor; after Wrangler only the source/version may move,
 * while the effective configuration and typed schema must remain identical.
 */
export async function revalidateTypedProductionDeployment({
  typedDeployment,
  configPath,
  sourceCommit,
  expectedPreviousSourceCommit,
  phase,
} = {}) {
  if (!typedDeployment?.baseline
      || !typedDeployment?.currentInventory
      || typeof typedDeployment.provider?.capture !== "function"
      || typeof typedDeployment.provider?.query !== "function"
      || typeof typedDeployment.inspectTyped !== "function"
      || typeof typedDeployment.configTools?.createSnapshot !== "function"
      || typeof typedDeployment.configTools?.verify !== "function"
      || !["before", "after"].includes(phase)
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(sourceCommit ?? "")
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(expectedPreviousSourceCommit ?? "")) {
    return typedFailure("PRODUCTION_TYPED_INPUT_INVALID");
  }
  let inventory;
  let snapshot;
  let candidateConfig;
  try {
    inventory = await typedDeployment.provider.capture();
    snapshot = typedDeployment.configTools.createSnapshot(inventory);
    if (phase === "before") {
      if (!typedSnapshotMatches(typedDeployment.baseline, snapshot)
          || snapshot.sourceCommit !== expectedPreviousSourceCommit) {
        return typedFailure("PRODUCTION_TYPED_LIVE_CHANGED");
      }
    } else if (!typedSnapshotMatches(typedDeployment.edge?.expectedAfter ?? typedDeployment.baseline, snapshot, {
      source: false,
      version: false,
    }) || snapshot.sourceCommit !== sourceCommit) {
      return typedFailure("PRODUCTION_TYPED_POST_DEPLOY_LIVE_MISMATCH");
    }
    if (phase === "after" && typedDeployment.edge) {
      // An edge deploy's post-deploy identity: one version at 100% whose
      // DEPLOYMENT_SOURCE_COMMIT and EDGE_UPSTREAM_MODE are the deploy's.
      const live = typedDeployment.edge.verifyLive({ snapshot, sourceCommit });
      if (!live?.ok) {
        return typedFailure("PRODUCTION_TYPED_POST_DEPLOY_EDGE_MODE_UNVERIFIED", live?.code);
      }
    }

    const metadata = await lstat(configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || (metadata.mode & 0o077) !== 0) {
      return typedFailure("PRODUCTION_TYPED_CONFIG_PATH_INVALID");
    }
    const bytes = await readFile(configPath);
    if (typedConfigDigest(bytes) !== typedDeployment.configSha256) {
      return typedFailure("PRODUCTION_TYPED_CONFIG_CHANGED");
    }
    const parseErrors = [];
    candidateConfig = parse(bytes.toString("utf8"), parseErrors);
    if (parseErrors.length || !candidateConfig || typeof candidateConfig !== "object") {
      return typedFailure("PRODUCTION_TYPED_CONFIG_INVALID");
    }
    const preservation = typedDeployment.configTools.verify({
      snapshot,
      candidateConfig,
      sourceCommit,
    });
    if (!preservation?.ok) {
      return typedFailure(
        "PRODUCTION_TYPED_CONFIG_UNVERIFIED",
        preservation?.code,
      );
    }
    const production = typedConfigEnvironment(candidateConfig);
    const vars = production?.vars;
    const typed = await typedDeployment.inspectTyped({
      roles: typedRoles(),
      expectedSchemas: typedDeployment.expectedSchemas,
      config: {
        mode: vars?.TELEMETRY_STORAGE_MODE,
        sourceNamespace: vars?.TELEMETRY_STORAGE_NAMESPACE,
      },
      runQuery: (binding, sql) => typedDeployment.provider.query(inventory, binding, sql),
    });
    if (!typed?.ok) {
      return typedFailure("PRODUCTION_TYPED_PREFLIGHT_BLOCKED", typed?.code);
    }
    if (phase === "before") {
      // Schema qualification performs ten fixed provider queries. Re-capture
      // the compact live configuration once after those reads so a
      // predecessor/config change during the query window cannot reach the
      // final lock/source/dependency boundary. The after-deploy phase already
      // has its own post-mutation capture and does not repeat this read.
      const postSchemaInventory = await typedDeployment.provider.capture();
      const postSchemaSnapshot = typedDeployment.configTools.createSnapshot(
        postSchemaInventory,
      );
      if (!typedSnapshotMatches(typedDeployment.baseline, postSchemaSnapshot)
          || postSchemaSnapshot.sourceCommit !== expectedPreviousSourceCommit) {
        return typedFailure("PRODUCTION_TYPED_LIVE_CHANGED");
      }
    }
  } catch (error) {
    const code = typeof error?.code === "string"
      && (error.code.startsWith("PRODUCTION_LIVE_CONFIG_")
        || error.code.startsWith("PRODUCTION_LIVE_")
        || error.code.startsWith("TYPED_PREFLIGHT_")
        || error.code.startsWith("PRODUCTION_TYPED_"))
      ? error.code
      : `PRODUCTION_TYPED_${phase.toUpperCase()}_REVALIDATION_FAILED`;
    return typedFailure(code);
  }
  return { ok: true, code: null, phase };
}

function boundedExcerpt(text) {
  const value = typeof text === "string" ? text.trim() : "";
  return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
}

// A bare PRODUCTION_MIGRATION_STATE_UNKNOWN told the operator nothing about
// which of the gate's reads failed or why; every undeterminable outcome now
// names the database, the stage that failed, and what that stage produced.
function migrationStateUnknown(detail) {
  return { ok: false, code: "PRODUCTION_MIGRATION_STATE_UNKNOWN", detail };
}

// Production D1 migration gate
// (docs/governance/2026-08-07-production-deploy-migration-gate.md): the
// dangerous part of a routine deploy is a schema migration riding along
// unnoticed, not intake. A deploy that carries no unapplied migrations
// proceeds with no receipt; a deploy that does carry them must name every
// one explicitly through --confirm-migrations. An undeterminable pending
// set fails closed.
const PRODUCTION_D1_DATABASES = Object.freeze([
  Object.freeze({ binding: "USAGE_MONITOR_DB", migrationsDir: "migrations" }),
  Object.freeze({
    binding: "DELETION_LEDGER",
    migrationsDir: "deletion-ledger-migrations",
  }),
]);
const PRODUCTION_MIGRATION_FILENAME_PATTERN =
  /^\d{4}_[a-z0-9][a-z0-9_]*\.sql$/u;
export const PRODUCTION_MIGRATION_LEDGER_SQL =
  "SELECT id, name FROM d1_migrations ORDER BY id";

function parseD1ExecuteRows(stdout) {
  try {
    const value = JSON.parse(stdout);
    const entries = Array.isArray(value) ? value : [];
    const result = entries.findLast((entry) => Array.isArray(entry?.results));
    return result?.results ?? null;
  } catch {
    return null;
  }
}

async function listLocalMigrationNames(workerDirectory, migrationsDir) {
  const entries = await readdir(join(workerDirectory, migrationsDir), {
    withFileTypes: true,
  });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  return names.length > 0
      && names.every((name) => PRODUCTION_MIGRATION_FILENAME_PATTERN.test(name))
    ? names
    : null;
}

/**
 * Determine which checked-out D1 migrations are not yet recorded in the
 * remote production migration ledgers. The only remote operation is a
 * read-only SELECT against d1_migrations; nothing is applied or mutated.
 * Any unreadable directory, failed or unparseable query, non-sequential
 * ledger, or ledger entry unknown to the checkout fails closed.
 */
export async function determinePendingProductionMigrations({
  wrangler,
  workerDirectory,
  spawn = spawnSync,
}) {
  const pending = [];
  for (const database of PRODUCTION_D1_DATABASES) {
    let local;
    try {
      local = await listLocalMigrationNames(
        workerDirectory,
        database.migrationsDir,
      );
    } catch {
      local = null;
    }
    if (!Array.isArray(local)) {
      return migrationStateUnknown({
        stage: "local-migration-inventory",
        binding: database.binding,
        migrationsDir: database.migrationsDir,
      });
    }
    let query;
    try {
      query = spawn(
        wrangler,
        [
          "d1",
          "execute",
          database.binding,
          "--remote",
          "--env",
          "production",
          "--command",
          PRODUCTION_MIGRATION_LEDGER_SQL,
          "--json",
        ],
        {
          cwd: workerDirectory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (error) {
      return migrationStateUnknown({
        stage: "wrangler-spawn",
        binding: database.binding,
        error: boundedExcerpt(error?.message ?? String(error)),
      });
    }
    if (query?.error || query?.status !== 0) {
      return migrationStateUnknown({
        stage: "wrangler-exit",
        binding: database.binding,
        status: query?.status ?? null,
        stderr: boundedExcerpt(query?.stderr),
        ...(query?.error
          ? { error: boundedExcerpt(query.error?.message ?? String(query.error)) }
          : {}),
      });
    }
    const stdout = typeof query?.stdout === "string" ? query.stdout : "";
    const rows = parseD1ExecuteRows(stdout);
    if (!Array.isArray(rows)) {
      return migrationStateUnknown({
        stage: "ledger-parse",
        binding: database.binding,
        stdout: boundedExcerpt(stdout),
        stderr: boundedExcerpt(query?.stderr),
      });
    }
    if (!rows.every((row, index) => Number(row?.id) === index + 1
      && typeof row?.name === "string")) {
      return migrationStateUnknown({
        stage: "ledger-sequence",
        binding: database.binding,
        rowCount: rows.length,
      });
    }
    const applied = rows.map((row) => row.name);
    if (applied.length > local.length
        || !applied.every((name, index) => name === local[index])) {
      const index = applied.findIndex((name, at) => name !== local[at]);
      return {
        ok: false,
        code: "PRODUCTION_MIGRATION_LEDGER_DRIFT",
        detail: {
          binding: database.binding,
          appliedCount: applied.length,
          localCount: local.length,
          firstMismatch: {
            index,
            applied: applied[index],
            local: local[index] ?? null,
          },
        },
      };
    }
    for (const name of local.slice(applied.length)) {
      pending.push(`${database.binding}:${name}`);
    }
  }
  return { ok: true, code: null, pending };
}

const D1_BINDING_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/u;
const D1_MIGRATIONS_DIRECTORY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/**
 * The same read-only pending-migration listing for an explicit set of D1
 * bindings under an explicit Wrangler config and environment: the edge gcp
 * gate reads RELEASE_GUARD_DB through the installed overlay config. Remote
 * reads are the fixed d1_migrations SELECT only, and the result shapes and
 * failure codes are determinePendingProductionMigrations's.
 */
export async function determinePendingD1Migrations({
  wrangler,
  workerDirectory,
  databases,
  configPath = null,
  environment = "production",
  spawn = spawnSync,
} = {}) {
  if (!Array.isArray(databases) || databases.length < 1 || databases.length > 4
      || databases.some((database) => !D1_BINDING_PATTERN.test(database?.binding ?? "")
        || !D1_MIGRATIONS_DIRECTORY_PATTERN.test(database?.migrationsDir ?? ""))
      || new Set(databases.map((database) => database.binding)).size !== databases.length
      || (configPath !== null && (typeof configPath !== "string" || !isAbsolute(configPath)))
      || typeof environment !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(environment)) {
    return migrationStateUnknown({ stage: "gate-input" });
  }
  const pending = [];
  for (const database of databases) {
    let local;
    try {
      local = await listLocalMigrationNames(workerDirectory, database.migrationsDir);
    } catch {
      local = null;
    }
    if (!Array.isArray(local)) {
      return migrationStateUnknown({
        stage: "local-migration-inventory",
        binding: database.binding,
        migrationsDir: database.migrationsDir,
      });
    }
    let query;
    try {
      query = spawn(
        wrangler,
        [
          "d1",
          "execute",
          database.binding,
          "--remote",
          ...(configPath === null ? [] : ["--config", configPath]),
          "--env",
          environment,
          "--command",
          PRODUCTION_MIGRATION_LEDGER_SQL,
          "--json",
        ],
        {
          cwd: workerDirectory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (error) {
      return migrationStateUnknown({
        stage: "wrangler-spawn",
        binding: database.binding,
        error: boundedExcerpt(error?.message ?? String(error)),
      });
    }
    if (query?.error || query?.status !== 0) {
      return migrationStateUnknown({
        stage: "wrangler-exit",
        binding: database.binding,
        status: query?.status ?? null,
        stderr: boundedExcerpt(query?.stderr),
        ...(query?.error
          ? { error: boundedExcerpt(query.error?.message ?? String(query.error)) }
          : {}),
      });
    }
    const stdout = typeof query?.stdout === "string" ? query.stdout : "";
    const rows = parseD1ExecuteRows(stdout);
    if (!Array.isArray(rows)) {
      return migrationStateUnknown({
        stage: "ledger-parse",
        binding: database.binding,
        stdout: boundedExcerpt(stdout),
        stderr: boundedExcerpt(query?.stderr),
      });
    }
    if (!rows.every((row, index) => Number(row?.id) === index + 1
      && typeof row?.name === "string")) {
      return migrationStateUnknown({
        stage: "ledger-sequence",
        binding: database.binding,
        rowCount: rows.length,
      });
    }
    const applied = rows.map((row) => row.name);
    if (applied.length > local.length
        || !applied.every((name, index) => name === local[index])) {
      const index = applied.findIndex((name, at) => name !== local[at]);
      return {
        ok: false,
        code: "PRODUCTION_MIGRATION_LEDGER_DRIFT",
        detail: {
          binding: database.binding,
          appliedCount: applied.length,
          localCount: local.length,
          firstMismatch: {
            index,
            applied: applied[index],
            local: local[index] ?? null,
          },
        },
      };
    }
    for (const name of local.slice(applied.length)) {
      pending.push(`${database.binding}:${name}`);
    }
  }
  return { ok: true, code: null, pending };
}

function confirmedMigrationTokens(confirmedMigrations) {
  if (confirmedMigrations === null || confirmedMigrations === undefined) {
    return null;
  }
  return String(confirmedMigrations)
    .split(",")
    .map((token) => token.trim());
}

function assessMigrationGate({ pending, confirmedMigrations }) {
  const confirmed = confirmedMigrationTokens(confirmedMigrations);
  if (pending.length === 0) {
    // A migration confirmation with nothing pending means the operator's
    // model of production state is wrong; fail closed rather than ignore it.
    return confirmed === null
      ? { ok: true, code: null, pendingMigrations: [] }
      : {
        ok: false,
        code: "PRODUCTION_MIGRATIONS_CONFIRMATION_UNEXPECTED",
        pendingMigrations: [],
      };
  }
  if (confirmed === null) {
    return {
      ok: false,
      code: "PRODUCTION_MIGRATIONS_UNCONFIRMED",
      pendingMigrations: pending,
    };
  }
  if (confirmed.length !== pending.length
      || !confirmed.every((token, index) => token === pending[index])) {
    return {
      ok: false,
      code: "PRODUCTION_MIGRATIONS_CONFIRMATION_MISMATCH",
      pendingMigrations: pending,
    };
  }
  return { ok: true, code: null, pendingMigrations: pending };
}

function checkedOutSourceCommit(workerDirectory) {
  try {
    const value = execFileSync(
      "/usr/bin/git",
      ["-C", workerDirectory, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    return /^[a-f0-9]{7,64}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

function checkedOutSourceTreeClean(workerDirectory) {
  try {
    const value = execFileSync(
      "/usr/bin/git",
      [
        "-C",
        workerDirectory,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      { encoding: "utf8" },
    );
    return value.trim() === "";
  } catch {
    return null;
  }
}

function verifySourceSnapshot({
  workerDirectory,
  expectedSourceCommit = null,
  sourceCommitCheck,
  sourceTreeCleanCheck,
}) {
  const sourceCommit = sourceCommitCheck(workerDirectory);
  if (!sourceCommit || !/^[a-f0-9]{7,64}$/u.test(sourceCommit)) {
    return localFailure("PRODUCTION_SOURCE_REVISION_UNAVAILABLE");
  }
  if (expectedSourceCommit !== null
      && sourceCommit !== expectedSourceCommit) {
    return localFailure("PRODUCTION_SOURCE_REVISION_CHANGED");
  }
  let clean;
  try {
    clean = sourceTreeCleanCheck(workerDirectory);
  } catch {
    clean = null;
  }
  if (clean !== true) {
    return localFailure("PRODUCTION_SOURCE_TREE_CHANGED");
  }
  return { ok: true, sourceCommit };
}

function pathWithin(parent, child) {
  const path = relative(parent, child);
  return path === ""
    || (path !== ".."
      && !path.startsWith(`..${sep}`)
      && !isAbsolute(path));
}

function sourceRepositoryRoot(workerDirectory) {
  try {
    const canonicalWorkerDirectory = realpathSync(workerDirectory);
    const reportedRoot = execFileSync(
      "/usr/bin/git",
      ["-C", canonicalWorkerDirectory, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
    if (!reportedRoot) throw new Error("Git did not report a repository root.");
    const canonicalRoot = realpathSync(
      isAbsolute(reportedRoot)
        ? reportedRoot
        : resolve(canonicalWorkerDirectory, reportedRoot),
    );
    const verifiedRoot = execFileSync(
      "/usr/bin/git",
      ["-C", canonicalRoot, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
    const canonicalVerifiedRoot = realpathSync(
      isAbsolute(verifiedRoot)
        ? verifiedRoot
        : resolve(canonicalRoot, verifiedRoot),
    );
    if (canonicalVerifiedRoot !== canonicalRoot
        || !pathWithin(canonicalRoot, canonicalWorkerDirectory)) {
      throw new Error("Git repository root does not contain the Worker directory.");
    }
    return canonicalRoot;
  } catch {
    const error = new Error("Unable to resolve the checked-out Git repository root.");
    error.code = "PRODUCTION_SOURCE_REPOSITORY_UNAVAILABLE";
    throw error;
  }
}

async function requireSafeDirectory(path, label) {
  const metadata = await lstat(path).catch((error) => {
    throw new Error(`${label} is missing or cannot be inspected.`, {
      cause: error,
    });
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function requireAbsent(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must not already exist.`);
}

/**
 * A deterministic content-and-structure digest of a dependency tree. The root
 * is realpath-resolved, so a symlinked node_modules digests the bytes of its
 * target. Entries are visited in a fixed sorted order and file content, symlink
 * targets, sizes, and directory structure all contribute, so any post-snapshot
 * mutation of installed dependency content produces a different digest. Known
 * Wrangler runtime-state directories at the root are excluded because preflight
 * legitimately creates them after the snapshot. Symlinks are recorded by target
 * string rather than followed, so internal `.bin` links and cycles neither
 * escape the tree nor double-count content.
 *
 * This is the mitigation for the ignored-node_modules gap: the snapshot records
 * this digest, and the deploy path reverifies it immediately before and after
 * Wrangler runs, binding the exact dependency bytes across the race window that
 * the source revalidation alone does not cover.
 */
export async function dependencyTreeDigest(rootPath) {
  const resolvedRoot = realpathSync(rootPath);
  const hash = createHash("sha256");
  async function walk(absolute, relativePath) {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    for (const entry of entries) {
      if (relativePath === ""
          && DEPENDENCY_RUNTIME_STATE_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const childAbsolute = join(absolute, entry.name);
      const childRelative = relativePath === ""
        ? entry.name
        : `${relativePath}/${entry.name}`;
      const info = await lstat(childAbsolute);
      if (info.isSymbolicLink()) {
        hash.update(`L\0${childRelative}\0${await readlink(childAbsolute)}\0`);
      } else if (info.isDirectory()) {
        hash.update(`D\0${childRelative}\0`);
        await walk(childAbsolute, childRelative);
      } else if (info.isFile()) {
        const fileHash = createHash("sha256")
          .update(await readFile(childAbsolute))
          .digest("hex");
        hash.update(`F\0${childRelative}\0${info.size}\0${fileHash}\0`);
      } else {
        // A device, socket, or fifo has no reviewable content; its presence in a
        // dependency tree is itself part of the structure being pinned.
        hash.update(`O\0${childRelative}\0`);
      }
    }
  }
  await walk(resolvedRoot, "");
  return hash.digest("hex");
}

async function verifySnapshotDependencyLink({
  dependencyPath,
  expectedTarget,
}) {
  const metadata = await lstat(dependencyPath);
  if (!metadata.isSymbolicLink()) {
    throw new Error("Snapshot dependency link changed unexpectedly.");
  }
  const target = await readlink(dependencyPath);
  const resolvedTarget = resolve(dirname(dependencyPath), target);
  if (resolvedTarget !== resolve(expectedTarget)) {
    throw new Error("Snapshot dependency link changed unexpectedly.");
  }
}

function runSnapshotGit(excludeFile, repositoryRoot, arguments_) {
  return execFileSync(
    "/usr/bin/git",
    ["-c", `core.excludesFile=${excludeFile}`, "-C", repositoryRoot, ...arguments_],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
}

export async function createImmutableSourceSnapshot({
  workerDirectory,
  sourceCommit,
}) {
  const repositoryRoot = sourceRepositoryRoot(workerDirectory);
  const snapshotParent = realpathSync(await mkdtemp(
    join(tmpdir(), "usage-monitor-production-source-"),
  ));
  const snapshotRoot = join(snapshotParent, "repository");
  let worktreeAdded = false;
  try {
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        repositoryRoot,
        "worktree",
        "add",
        "--detach",
        "--quiet",
        snapshotRoot,
        sourceCommit,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    worktreeAdded = true;
    const snapshotGitExclude = join(snapshotParent, "git-exclude");
    await writeFile(
      snapshotGitExclude,
      "apps/worker/node_modules\n",
      { mode: 0o600 },
    );

    const generatedSource = join(
      repositoryRoot,
      ".release-build",
      "public-release-site",
    );
    const snapshotGeneratedSource = join(
      snapshotRoot,
      ".release-build",
      "public-release-site",
    );
    const generatedMetadata = await lstat(generatedSource);
    if (!generatedMetadata.isDirectory()
        || generatedMetadata.isSymbolicLink()) {
      throw new Error("Generated public release output must be a real directory.");
    }
    const snapshotReleaseBuild = dirname(snapshotGeneratedSource);
    try {
      await requireSafeDirectory(snapshotReleaseBuild, "Snapshot release-build directory");
    } catch (error) {
      if (error?.cause?.code !== "ENOENT") throw error;
      await mkdir(snapshotReleaseBuild, { mode: 0o755 });
    }
    await requireAbsent(snapshotGeneratedSource, "Snapshot generated asset directory");
    await cp(generatedSource, snapshotGeneratedSource, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    await requireSafeDirectory(
      snapshotGeneratedSource,
      "Snapshot generated asset directory",
    );

    // Wrangler is launched from the snapshot, but its installed dependency
    // tree is not source input and remains the locally checked dependency set.
    const snapshotApps = join(snapshotRoot, "apps");
    const snapshotWorker = join(snapshotApps, "worker");
    await requireSafeDirectory(snapshotApps, "Snapshot apps directory");
    await requireSafeDirectory(snapshotWorker, "Snapshot Worker directory");
    const dependencySource = resolve(workerDirectory, "node_modules");
    await requireSafeDirectory(dependencySource, "Checked-out Worker dependencies");
    const dependencyDestination = join(snapshotWorker, "node_modules");
    await requireAbsent(dependencyDestination, "Snapshot Worker dependencies");
    await symlink(
      dependencySource,
      dependencyDestination,
      "dir",
    );
    // Record an immutable digest of the linked dependency tree. The deploy path
    // reverifies this before and after Wrangler runs, so a compromise of the
    // mutable node_modules after this point is detected and fails the deploy
    // closed rather than crossing into release execution or the bundle.
    const dependencyDigest = await dependencyTreeDigest(dependencyDestination);

    return {
      repositoryRoot: snapshotRoot,
      workerDirectory: snapshotWorker,
      dependencyDigest,
      dependencyPath: dependencyDestination,
      git: (root, arguments_) => runSnapshotGit(
        snapshotGitExclude,
        root,
        arguments_,
      ),
      async cleanup() {
        try {
          await verifySnapshotDependencyLink({
            dependencyPath: dependencyDestination,
            expectedTarget: dependencySource,
          });
          execFileSync(
            "/usr/bin/git",
            [
              "-C",
              repositoryRoot,
              "worktree",
              "remove",
              "--force",
              snapshotRoot,
            ],
            { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
          );
          await rm(snapshotParent, { recursive: true, force: false });
        } catch (error) {
          const cleanupError = new Error(
            "Production source snapshot cleanup failed.",
            { cause: error },
          );
          cleanupError.code = "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED";
          throw cleanupError;
        }
      },
    };
  } catch (error) {
    try {
      if (worktreeAdded) {
        execFileSync(
          "/usr/bin/git",
          [
            "-C",
            repositoryRoot,
            "worktree",
            "remove",
            "--force",
            snapshotRoot,
          ],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        );
      }
      await rm(snapshotParent, { recursive: true, force: false });
    } catch (cleanupError) {
      cleanupError.code = "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED";
      throw cleanupError;
    }
    throw error;
  }
}

async function productionReleasePreflight({ workerDirectory, wrangler, spawn }) {
  const configPath = join(workerDirectory, "wrangler.jsonc");
  const config = parse(await readFile(configPath, "utf8"));
  return runReleasePreflight({
    config,
    configPath,
    workerDirectory,
    wrangler,
    spawn,
  });
}

function secureJsonHeaders(response) {
  return response.headers?.get("content-type")?.split(";", 1)[0]
      === "application/json"
    && response.headers.get("cache-control") === "no-store"
    && response.headers.get("referrer-policy") === "no-referrer"
    && response.headers.get("x-content-type-options") === "nosniff";
}

function healthyProductionHealth(value) {
  // The pre-2026-08-07 gate additionally asserted enrollmentMode: "disabled"
  // and fully contained collection controls here. Production deploys now
  // happen against a live, enrollment-open service, so the recheck asserts
  // reachability, canonical origin, transport, security headers, and reported
  // health only (docs/governance/2026-08-07-production-deploy-migration-gate.md).
  return value?.status === "ok";
}

export async function recheckProductionHealth({
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const healthURL = new URL(
    "/api/health",
    DEPLOYMENT_ENDPOINTS.public.origin,
  ).href;
  let response;
  try {
    response = await fetchImpl(healthURL, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_UNREACHABLE");
  }
  if (response?.url !== healthURL
      || response.status !== 200
      || !secureJsonHeaders(response)
      || typeof response.text !== "function") {
    return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }
  let body;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
    }
    body = JSON.parse(text);
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }
  if (!healthyProductionHealth(body)) {
    return localFailure("PRODUCTION_HEALTH_RECHECK_UNHEALTHY");
  }
  const sourceCommit = body.deployment?.sourceCommit;
  return { ok: true, code: null, sourceCommit: /^[0-9a-f]{40}$/.test(sourceCommit ?? "") ? sourceCommit : null };
}

export async function recheckProductionPublicSurface({
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const publicOrigin = DEPLOYMENT_ENDPOINTS.public.origin;
  const rootURL = new URL("/", publicOrigin).href;
  let rootResponse;
  try {
    rootResponse = await fetchImpl(rootURL, {
      method: "GET",
      headers: { accept: "text/html" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  }
  if (rootResponse?.url !== rootURL
      || rootResponse.status !== 200
      || rootResponse.headers?.get("content-type")?.split(";", 1)[0]
        !== "text/html"
      || typeof rootResponse.text !== "function") {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_INVALID");
  }
  let rootBody;
  try {
    rootBody = await rootResponse.text();
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_INVALID");
  }
  if (Buffer.byteLength(rootBody, "utf8") > 1024 * 1024) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_INVALID");
  }
  if (PRODUCTION_PUBLIC_ROOT_FORBIDDEN_MARKERS.some((marker) =>
    rootBody.includes(marker))) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_PRIVATE_ROOT_EXPOSED");
  }

  const expectedCanonicalLink =
    `<link rel="canonical" href="${rootURL}">`;
  const expectedOpenGraphUrl =
    `<meta property="og:url" content="${rootURL}">`;
  if (!rootBody.includes(expectedCanonicalLink)
      || !rootBody.includes(expectedOpenGraphUrl)) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_CANONICAL_ROOT_INVALID");
  }

  const robotsURL = new URL("/robots.txt", publicOrigin).href;
  let robotsResponse;
  try {
    robotsResponse = await fetchImpl(robotsURL, {
      method: "GET",
      headers: { accept: "text/plain" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  }
  if (robotsResponse?.url !== robotsURL
      || robotsResponse.status !== 200
      || robotsResponse.headers?.get("content-type")?.split(";", 1)[0]
        !== "text/plain"
      || typeof robotsResponse.text !== "function") {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_ROBOTS_INVALID");
  }
  let robotsBody;
  try {
    robotsBody = await robotsResponse.text();
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_ROBOTS_INVALID");
  }
  if (Buffer.byteLength(robotsBody, "utf8") > 64 * 1024) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_ROBOTS_INVALID");
  }

  const sitemapURL = new URL("/sitemap.xml", publicOrigin).href;
  if (!robotsBody.includes(`Sitemap: ${sitemapURL}`)) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_ROBOTS_INVALID");
  }
  let sitemapResponse;
  try {
    sitemapResponse = await fetchImpl(sitemapURL, {
      method: "GET",
      headers: { accept: "application/xml, text/xml;q=0.9" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  }
  const sitemapContentType = sitemapResponse?.headers?.get("content-type")
    ?.split(";", 1)[0];
  if (sitemapResponse?.url !== sitemapURL
      || sitemapResponse.status !== 200
      || !["application/xml", "text/xml"].includes(sitemapContentType)
      || typeof sitemapResponse.text !== "function") {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_SITEMAP_INVALID");
  }
  let sitemapBody;
  try {
    sitemapBody = await sitemapResponse.text();
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_SITEMAP_INVALID");
  }
  if (Buffer.byteLength(sitemapBody, "utf8") > 1024 * 1024
      || !sitemapBody.includes(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      )
      || !sitemapBody.includes(`<loc>${rootURL}</loc>`)) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_SITEMAP_INVALID");
  }

  const wwwURL = new URL(publicOrigin);
  wwwURL.hostname = `www.${wwwURL.hostname}`;
  const wwwRootURL = new URL("/", wwwURL).href;
  let wwwResponse;
  try {
    wwwResponse = await fetchImpl(wwwRootURL, {
      method: "GET",
      headers: { accept: "text/html" },
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  }
  if (wwwResponse?.url !== wwwRootURL
      || wwwResponse.status !== 308
      || wwwResponse.headers?.get("location") !== rootURL) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_WWW_REDIRECT_INVALID");
  }

  for (const path of PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS) {
    const url = new URL(path, publicOrigin).href;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
    }
    if (response?.url !== url || response.status !== 404) {
      return localFailure("PRODUCTION_PUBLIC_SURFACE_PRIVATE_ASSET_EXPOSED");
    }
  }
  return { ok: true, code: null };
}

/**
 * Verify the retained public release manifest independently of the Worker
 * deployment. The manifest is public, but its exact bytes are a release input:
 * a backend deploy must not silently replace the live public site with a
 * different release tree. With includeBytes the verified bytes are returned
 * too, so a changed-site deploy can prove which commit produced them.
 */
export async function recheckProductionPublicReleaseManifest({
  fetchImpl = globalThis.fetch,
  expectedSha256,
  timeoutMs = 10_000,
  includeBytes = false,
} = {}) {
  if (!PRODUCTION_SHA256_PATTERN.test(expectedSha256 ?? "")) {
    return localFailure("PRODUCTION_PUBLIC_RELEASE_MANIFEST_EXPECTATION_INVALID");
  }
  const manifestURL = new URL(
    PRODUCTION_PUBLIC_RELEASE_MANIFEST_PATH,
    DEPLOYMENT_ENDPOINTS.public.origin,
  ).href;
  let response;
  try {
    response = await fetchImpl(manifestURL, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_RELEASE_MANIFEST_UNREACHABLE");
  }
  if (response?.url !== manifestURL
      || response.status !== 200
      || response.headers?.get("content-type")?.split(";", 1)[0]
        !== "application/json"
      || typeof response.arrayBuffer !== "function") {
    return localFailure("PRODUCTION_PUBLIC_RELEASE_MANIFEST_INVALID");
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    return localFailure("PRODUCTION_PUBLIC_RELEASE_MANIFEST_INVALID");
  }
  if (bytes.length < 1 || bytes.length > PRODUCTION_PUBLIC_RELEASE_MANIFEST_MAX_BYTES
      || typedConfigDigest(bytes) !== expectedSha256) {
    return localFailure("PRODUCTION_PUBLIC_RELEASE_MANIFEST_MISMATCH");
  }
  return { ok: true, code: null, sha256: expectedSha256, ...(includeBytes === true ? { bytes } : {}) };
}

const PRODUCTION_EDGE_BARRIER_HEALTH_MODE = "migration-mutation-barrier";

/**
 * Public health under an edge identity rule (E10). Every mode needs the
 * canonical URL, the secure JSON headers and status "ok". fenced must be the
 * mutation barrier's own health for the expected source commit; worker and
 * gcp must not be barrier health and must report the expected source commit:
 * the edge's for worker, the origin commit the pre-gcp verifier read for
 * gcp. The fast-path test origin's health (no deployment.sourceCommit) fails.
 */
export async function recheckProductionEdgeHealth({
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  mode,
  expectedSourceCommit,
} = {}) {
  if (!["worker", "fenced", "gcp"].includes(mode)
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(expectedSourceCommit ?? "")) {
    return localFailure("PRODUCTION_EDGE_HEALTH_INPUT_INVALID");
  }
  const healthURL = new URL("/api/health", DEPLOYMENT_ENDPOINTS.public.origin).href;
  let response;
  try {
    response = await fetchImpl(healthURL, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_EDGE_HEALTH_UNREACHABLE");
  }
  if (response?.url !== healthURL || response.status !== 200
      || !secureJsonHeaders(response) || typeof response.text !== "function") {
    return localFailure("PRODUCTION_EDGE_HEALTH_INVALID");
  }
  let body;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      return localFailure("PRODUCTION_EDGE_HEALTH_INVALID");
    }
    body = JSON.parse(text);
  } catch {
    return localFailure("PRODUCTION_EDGE_HEALTH_INVALID");
  }
  if (!healthyProductionHealth(body)) return localFailure("PRODUCTION_EDGE_HEALTH_UNHEALTHY");
  const barrier = body.mode === PRODUCTION_EDGE_BARRIER_HEALTH_MODE
    && body.maintenance?.state === "fenced"
    && body.maintenance?.storageQualified === false;
  if (mode === "fenced" ? !barrier : body.mode === PRODUCTION_EDGE_BARRIER_HEALTH_MODE) {
    return localFailure("PRODUCTION_EDGE_HEALTH_MODE_MISMATCH");
  }
  if (body.deployment?.sourceCommit !== expectedSourceCommit) {
    return localFailure("PRODUCTION_EDGE_HEALTH_SOURCE_MISMATCH");
  }
  return { ok: true, code: null, sourceCommit: expectedSourceCommit };
}

async function fetchEdgeSurface(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { credentials: "omit", ...init });
  } catch {
    return null;
  }
}

/**
 * The public surface of a fenced edge: the mode-independent expectations from
 * check-deployment-endpoints.mjs (www 308 to the apex root, the retained
 * release manifest 200), the public root without dashboard markers, and every
 * PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS entry as the fenced table says:
 * 503 MUTATION_BARRIER_ACTIVE with no-store and retry-after 300 for the admin
 * surface and API paths (a 404 there fails), 404 for the dashboard assets.
 */
export async function recheckFencedPublicSurface({
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  let expectations;
  try {
    expectations = validateEdgeModePublicSurface();
  } catch {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_EXPECTATIONS_INVALID");
  }
  const signal = () => AbortSignal.timeout(timeoutMs);
  const [www, manifest] = expectations.modeIndependent;
  const wwwResponse = await fetchEdgeSurface(fetchImpl, www.url, {
    method: "GET",
    headers: { accept: "text/html" },
    redirect: "manual",
    signal: signal(),
  });
  if (wwwResponse === null) return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  if (wwwResponse.url !== www.url || wwwResponse.status !== www.status
      || wwwResponse.headers?.get("location") !== www.location) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_WWW_REDIRECT_INVALID");
  }
  const manifestResponse = await fetchEdgeSurface(fetchImpl, manifest.url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: signal(),
  });
  if (manifestResponse === null) return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  if (manifestResponse.url !== manifest.url || manifestResponse.status !== manifest.status
      || manifestResponse.headers?.get("content-type")?.split(";", 1)[0] !== manifest.contentType) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RELEASE_MANIFEST_INVALID");
  }
  const rootURL = new URL("/", DEPLOYMENT_ENDPOINTS.public.origin).href;
  const rootResponse = await fetchEdgeSurface(fetchImpl, rootURL, {
    method: "GET",
    headers: { accept: "text/html" },
    redirect: "error",
    signal: signal(),
  });
  if (rootResponse === null) return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
  let rootBody = null;
  if (rootResponse.url === rootURL && rootResponse.status === 200
      && rootResponse.headers?.get("content-type")?.split(";", 1)[0] === "text/html"
      && typeof rootResponse.text === "function") {
    try {
      rootBody = await rootResponse.text();
    } catch {
      rootBody = null;
    }
  }
  if (typeof rootBody !== "string" || Buffer.byteLength(rootBody, "utf8") > 1024 * 1024) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_INVALID");
  }
  if (PRODUCTION_PUBLIC_ROOT_FORBIDDEN_MARKERS.some((marker) => rootBody.includes(marker))) {
    return localFailure("PRODUCTION_PUBLIC_SURFACE_PRIVATE_ROOT_EXPOSED");
  }
  for (const path of PRODUCTION_PUBLIC_SURFACE_FORBIDDEN_PATHS) {
    const expected = expectations.forbiddenPaths[edgeModeForbiddenPathClass(path)].fenced;
    const url = new URL(path, DEPLOYMENT_ENDPOINTS.public.origin).href;
    const response = await fetchEdgeSurface(fetchImpl, url, {
      method: "GET",
      redirect: "error",
      signal: signal(),
    });
    if (response === null) return localFailure("PRODUCTION_PUBLIC_SURFACE_RECHECK_UNREACHABLE");
    if (expected.status === 404) {
      if (response.url !== url || response.status !== 404) {
        return localFailure("PRODUCTION_PUBLIC_SURFACE_PRIVATE_ASSET_EXPOSED");
      }
      continue;
    }
    let code = null;
    if (response.url === url && response.status === expected.status
        && response.headers?.get("content-type")?.split(";", 1)[0] === expected.contentType
        && response.headers.get("cache-control") === expected.cacheControl
        && response.headers.get("retry-after") === expected.retryAfter
        && typeof response.text === "function") {
      try {
        const text = await response.text();
        code = Buffer.byteLength(text, "utf8") <= 64 * 1024 ? JSON.parse(text)?.error?.code : null;
      } catch {
        code = null;
      }
    }
    if (code !== expected.errorCode) return localFailure("PRODUCTION_PUBLIC_SURFACE_FENCE_INVALID");
  }
  return { ok: true, code: null };
}

async function runProductionDeploymentFromSnapshot({
  confirmedMigrations = null,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  checkWorkspacePackages = checkLocalWorkspacePackages,
  checkEndpoints = checkDeploymentEndpointConsumers,
  stageAssets = stageProductionAssets,
  migrationGateCheck = null,
  determinePendingMigrations = determinePendingProductionMigrations,
  log = (line) => process.stderr.write(line),
  sourceCommit,
  snapshotRepositoryRoot,
  snapshotGit,
  snapshotDependencyDigest,
  snapshotDependencyPath,
  dependencyDigestCheck = dependencyTreeDigest,
  sourceCheckDirectory,
  sourceCommitCheck = checkedOutSourceCommit,
  sourceTreeCleanCheck = checkedOutSourceTreeClean,
  releasePreflight = productionReleasePreflight,
  fetchImpl = globalThis.fetch,
  healthRecheck = recheckProductionHealth,
  publicSurfaceRecheck = recheckProductionPublicSurface,
  publicReleaseManifestRecheck = null,
  typedDeployment = null,
  typedConfigPath = null,
  retainedPublicSourceCommit = null,
  expectedLiveManifestSha256 = null,
  candidatePublicManifestSha256 = null,
  candidatePublicSourceCommit = null,
  replacedPublicSourceCheck = verifyPinnedPublicReleaseManifestSource,
  beforeMutation = async () => { throw operationError("PRODUCTION_COORDINATION_REQUIRED"); },
  finalMutationRecheck = null,
  mutationIntent = async () => { throw operationError("PRODUCTION_COORDINATION_REQUIRED"); },
  edgeDeployment = null,
}) {
  // The dependency tree the deploy executes from is not under Git provenance, so
  // it is bound by digest instead: reverify it against the snapshot digest
  // immediately before and after Wrangler, so a mutation of the mutable tree
  // between snapshot and execution fails closed rather than crossing into the
  // release. Any read failure is also fail-closed.
  const verifyDependencyDigest = async () => {
    let current;
    try {
      current = await dependencyDigestCheck(snapshotDependencyPath);
    } catch {
      return localFailure("PRODUCTION_DEPENDENCY_TREE_VERIFICATION_FAILED");
    }
    if (current !== snapshotDependencyDigest) {
      return localFailure("PRODUCTION_DEPENDENCY_TREE_DIGEST_MISMATCH");
    }
    return null;
  };
  if (typedDeployment) {
    if (typeof typedConfigPath !== "string"
        || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(typedDeployment.baseline?.sourceCommit ?? "")
        || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(retainedPublicSourceCommit ?? "")
        || !PRODUCTION_SHA256_PATTERN.test(expectedLiveManifestSha256 ?? "")
        || typeof publicReleaseManifestRecheck !== "function"
        || typeof finalMutationRecheck !== "function") {
      return typedFailure("PRODUCTION_TYPED_INPUT_INVALID");
    }
    try {
      await installTypedProductionConfig({
        configPath: typedConfigPath,
        configBytes: typedDeployment.configBytes,
      });
    } catch (error) {
      return typedFailure(error?.code ?? "PRODUCTION_TYPED_CONFIG_WRITE_FAILED");
    }
  }
  // Migration gate: the deploy source is the snapshot, so pending migrations
  // are computed from the snapshot's migration directories against the remote
  // production ledgers before any other gate runs.
  if (typedDeployment && confirmedMigrations !== null) {
    return typedFailure("PRODUCTION_TYPED_MIGRATIONS_UNSUPPORTED");
  }
  // Typed roles have already passed independent exact-schema qualification.
  // Their restore lineage does not use the legacy JSON migration ledger.
  const pendingCheck = migrationGateCheck ?? (typedDeployment
    ? { ok: true, code: null, pending: [] }
    : await determinePendingMigrations({
    wrangler,
    workerDirectory,
    spawn,
  }));
  if (!pendingCheck?.ok) {
    return pendingCheck?.code
      ? pendingCheck
      : migrationStateUnknown({ stage: "gate-result" });
  }
  if (!Array.isArray(pendingCheck.pending)) {
    return migrationStateUnknown({ stage: "gate-pending-list" });
  }
  const migrationGate = assessMigrationGate({
    pending: pendingCheck.pending,
    confirmedMigrations,
  });
  if (!migrationGate.ok) return migrationGate;
  const pendingMigrations = migrationGate.pendingMigrations;
  if (typedDeployment && pendingMigrations.length > 0) {
    return typedFailure("PRODUCTION_TYPED_MIGRATIONS_UNSUPPORTED");
  }
  if (pendingMigrations.length > 0) {
    log(
      "Production deploy carries unapplied D1 migrations "
        + "(explicitly confirmed):\n"
        + pendingMigrations.map((id) => `  ${id}\n`).join("")
        + "This deploy does NOT apply them; run the reviewed migration "
        + "procedure for the exact set above.\n",
    );
  }
  // A gcp edge binds only the release guard D1. Its nonce schema must already
  // be applied: the edge deploy never applies a migration.
  let releaseGuardPendingMigrations = null;
  if (edgeDeployment?.mode === "gcp") {
    const guard = await edgeDeployment.determinePendingD1Migrations({
      wrangler,
      workerDirectory,
      configPath: typedConfigPath,
      environment: "production",
      databases: [edgeDeployment.releaseGuardDatabase],
      spawn,
    });
    if (!guard?.ok) {
      return guard?.code ? guard : migrationStateUnknown({ stage: "release-guard-gate-result" });
    }
    if (!Array.isArray(guard.pending)) {
      return migrationStateUnknown({ stage: "release-guard-gate-pending-list" });
    }
    if (guard.pending.length > 0) {
      return {
        ok: false,
        code: "EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING",
        releaseGuardPendingMigrations: guard.pending,
      };
    }
    releaseGuardPendingMigrations = [];
  }

  let preflight;
  try {
    preflight = await releasePreflight({ workerDirectory, wrangler, spawn });
  } catch {
    return localFailure("RELEASE_PREFLIGHT_BLOCKED");
  }
  if (preflight?.state !== "ready") {
    return {
      ok: false,
      code: "RELEASE_PREFLIGHT_BLOCKED",
      blockers: Array.isArray(preflight?.blockers)
        ? preflight.blockers
        : ["LOCAL_RELEASE_PREFLIGHT_FAILED"],
    };
  }

  try {
    await checkWorkspacePackages();
  } catch (error) {
    const code = [
      "ACCOUNTING_PACKAGE_STALE",
      "TELEMETRY_CONTRACT_PACKAGE_STALE",
      "QUOTA_ANALYSIS_PACKAGE_STALE",
    ].includes(error?.code)
      ? error.code
      : "WORKSPACE_PACKAGES_CHECK_FAILED";
    return localFailure(code);
  }
  try {
    await checkEndpoints();
  } catch {
    return localFailure("DEPLOYMENT_ENDPOINTS_INVALID");
  }
  try {
    await stageAssets({
      repositoryRoot: snapshotRepositoryRoot,
      sourceDirectory: join(
        snapshotRepositoryRoot,
        ".release-build",
        "public-release-site",
      ),
      destinationDirectory: join(
        snapshotRepositoryRoot,
        ".release-build",
        "worker-assets",
      ),
      expectedSourceCommit: sourceCommit,
      // A candidate site is pinned to the commit it was built from: the deploy
      // source for a forward release, the released commit for a rollback.
      ...(retainedPublicSourceCommit === null
        ? {}
        : {
          retainedPublicSourceCommit: candidatePublicManifestSha256 === null
            ? retainedPublicSourceCommit
            : candidatePublicSourceCommit ?? sourceCommit,
        }),
      ...(expectedLiveManifestSha256 === null
        ? {}
        : { expectedLiveManifestSha256: candidatePublicManifestSha256 ?? expectedLiveManifestSha256 }),
      git: typedDeployment
        ? gitWithGeneratedConfigException({
          snapshotGit,
          repositoryRoot: snapshotRepositoryRoot,
          configPath: typedConfigPath,
        })
        : snapshotGit,
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_ASSETS_INVALID");
  }
  if (typedDeployment) {
    let manifest;
    try {
      manifest = await publicReleaseManifestRecheck({
        fetchImpl,
        expectedSha256: expectedLiveManifestSha256,
        timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
        includeBytes: candidatePublicManifestSha256 !== null,
      });
    } catch {
      return typedFailure("PRODUCTION_TYPED_PUBLIC_RELEASE_MANIFEST_UNREACHABLE");
    }
    if (!manifest?.ok) {
      return typedFailure(
        "PRODUCTION_TYPED_PUBLIC_RELEASE_MANIFEST_INVALID",
        manifest?.code,
      );
    }
    // A changed site replaces the live one. Its pinned source commit is
    // recorded as the replaced site's source, so prove it: the live manifest
    // bytes just matched their sha256, and their source provenance must match
    // that commit's public source files.
    if (candidatePublicManifestSha256 !== null) {
      try {
        await replacedPublicSourceCheck({
          repositoryRoot: snapshotRepositoryRoot,
          sourceCommit: retainedPublicSourceCommit,
          manifestBytes: manifest.bytes,
        });
      } catch {
        return typedFailure("PRODUCTION_REPLACED_PUBLIC_SOURCE_UNPROVEN");
      }
    }
  }
  let health;
  try {
    health = await healthRecheck({
      fetchImpl,
      timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
    });
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_UNREACHABLE");
  }
  if (!health?.ok) {
    return health?.code
      ? health
      : localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }

  // This is deliberately immediately before Wrangler: health probing can
  // yield to another checkout, so the earlier post-staging check is not the
  // deployment boundary.
  const deploySource = verifySourceSnapshot({
    workerDirectory: sourceCheckDirectory,
    expectedSourceCommit: sourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!deploySource.ok) return deploySource;

  // Same deployment boundary as the source recheck: bind the dependency bytes
  // immediately before Wrangler executes them.
  const preDeployDependency = await verifyDependencyDigest();
  if (preDeployDependency) return preDeployDependency;

  await beforeMutation();
  const lockedSource = verifySourceSnapshot({ workerDirectory: sourceCheckDirectory,
    expectedSourceCommit: sourceCommit, sourceCommitCheck, sourceTreeCleanCheck });
  if (!lockedSource.ok) return lockedSource;
  const lockedDependencies = await verifyDependencyDigest();
  if (lockedDependencies) return lockedDependencies;
  if (typedDeployment) {
    const typedBefore = await revalidateTypedProductionDeployment({
      typedDeployment,
      configPath: typedConfigPath,
      sourceCommit,
      expectedPreviousSourceCommit: typedDeployment.baseline.sourceCommit,
      phase: "before",
    });
    if (!typedBefore.ok) return typedBefore;
    // The typed preflight performs multiple provider reads. Re-establish the
    // coordination lock and predecessor health after those reads, then bind
    // the source and dependency bytes directly to the mutation boundary.
    await finalMutationRecheck();
    const finalSource = verifySourceSnapshot({
      workerDirectory: sourceCheckDirectory,
      expectedSourceCommit: sourceCommit,
      sourceCommitCheck,
      sourceTreeCleanCheck,
    });
    if (!finalSource.ok) return finalSource;
    const finalDependencies = await verifyDependencyDigest();
    if (finalDependencies) return finalDependencies;
  }
  await mutationIntent();

  let deployment;
  try {
    deployment = spawn(
      wrangler,
      [
        "deploy",
        "--env",
        "production",
        "--strict",
        // This is deliberately non-secret provenance. It lets the canonical
        // health endpoint identify the exact immutable snapshot that is live,
        // which is required to form the base for the next web-only release.
        "--var",
        `DEPLOYMENT_SOURCE_COMMIT:${sourceCommit}`,
      ],
      {
        cwd: workerDirectory,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch {
    return localFailure("PRODUCTION_DEPLOY_FAILED");
  }
  const postDeploySource = verifySourceSnapshot({
    workerDirectory: sourceCheckDirectory,
    expectedSourceCommit: sourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!postDeploySource.ok) return postDeploySource;
  // Reverify the dependency tree after bundling, so a mutation concurrent with
  // the Wrangler run is caught before the deploy is reported successful.
  const postDeployDependency = await verifyDependencyDigest();
  if (postDeployDependency) return postDeployDependency;
  if (deployment?.error || deployment?.status !== 0) {
    return localFailure("PRODUCTION_DEPLOY_FAILED");
  }
  if (typedDeployment) {
    const typedAfter = await revalidateTypedProductionDeployment({
      typedDeployment,
      configPath: typedConfigPath,
      sourceCommit,
      expectedPreviousSourceCommit: typedDeployment.baseline.sourceCommit,
      phase: "after",
    });
    if (!typedAfter.ok) return typedAfter;
    let manifest;
    try {
      manifest = await publicReleaseManifestRecheck({
        fetchImpl,
        expectedSha256: candidatePublicManifestSha256 ?? expectedLiveManifestSha256,
        timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
      });
    } catch {
      return typedFailure("PRODUCTION_TYPED_PUBLIC_RELEASE_MANIFEST_UNREACHABLE");
    }
    if (!manifest?.ok) {
      return typedFailure(
        "PRODUCTION_TYPED_PUBLIC_RELEASE_MANIFEST_INVALID",
        manifest?.code,
      );
    }
  }
  if (edgeDeployment?.identity === "binding") {
    // Edge identity (E10): the active version's binding was verified above;
    // public health must be the barrier's for this source (fenced), the
    // Worker's for this source (worker), or the verified origin commit's (gcp).
    let edgeHealth;
    try {
      edgeHealth = await edgeDeployment.healthRecheck({
        fetchImpl,
        timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
        mode: edgeDeployment.mode,
        expectedSourceCommit: edgeDeployment.mode === "gcp" ? edgeDeployment.originCommit : sourceCommit,
      });
    } catch {
      return localFailure("PRODUCTION_POST_DEPLOY_EDGE_HEALTH_UNREACHABLE");
    }
    if (edgeHealth?.ok !== true) {
      const reason = typeof edgeHealth?.code === "string"
        && edgeHealth.code.startsWith("PRODUCTION_EDGE_HEALTH_")
        ? edgeHealth.code.slice("PRODUCTION_EDGE_HEALTH_".length)
        : "AMBIGUOUS";
      return localFailure(`PRODUCTION_POST_DEPLOY_EDGE_HEALTH_${reason}`);
    }
  } else {
    let postDeployHealth;
    try {
      postDeployHealth = await healthRecheck({
        fetchImpl,
        timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
      });
    } catch {
      return localFailure("PRODUCTION_POST_DEPLOY_HEALTH_RECHECK_UNREACHABLE");
    }
    if (postDeployHealth?.ok !== true) {
      const reason = typeof postDeployHealth?.code === "string"
        && postDeployHealth.code.startsWith("PRODUCTION_HEALTH_RECHECK_")
        ? postDeployHealth.code.slice("PRODUCTION_HEALTH_RECHECK_".length)
        : "AMBIGUOUS";
      return localFailure(`PRODUCTION_POST_DEPLOY_HEALTH_RECHECK_${reason}`);
    }
    if (postDeployHealth.sourceCommit !== sourceCommit) return localFailure("PRODUCTION_POST_DEPLOY_SOURCE_MISMATCH");
  }
  let postDeployPublicSurface;
  try {
    postDeployPublicSurface = await publicSurfaceRecheck({
      fetchImpl,
      timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
    });
  } catch {
    return localFailure(
      "PRODUCTION_POST_DEPLOY_PUBLIC_SURFACE_RECHECK_UNREACHABLE",
    );
  }
  if (postDeployPublicSurface?.ok !== true) {
    const reason = typeof postDeployPublicSurface?.code === "string"
      && postDeployPublicSurface.code.startsWith(
        "PRODUCTION_PUBLIC_SURFACE_",
      )
      ? postDeployPublicSurface.code.slice(
        "PRODUCTION_PUBLIC_SURFACE_".length,
      )
      : "AMBIGUOUS";
    return localFailure(
      `PRODUCTION_POST_DEPLOY_PUBLIC_SURFACE_${reason}`,
    );
  }
  return {
    ok: true,
    code: "PRODUCTION_DEPLOYED",
    channel: "stable",
    collectionAuthorized: false,
    migrationGate: pendingMigrations.length === 0
      ? "no_unapplied_migrations"
      : "unapplied_migrations_explicitly_confirmed",
    pendingMigrations,
    immediateHealthRecheck: "healthy",
    postDeployHealthRecheck: "healthy",
    postDeployPublicSurfaceRecheck: "public-only",
    ...(edgeDeployment
      ? { edge: { ...edgeDeployment.receipt, releaseGuardPendingMigrations } }
      : {}),
  };
}

async function runUncoordinatedProductionDeployment({
  confirmation,
  confirmedMigrations = null,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  checkWorkspacePackages = checkLocalWorkspacePackages,
  checkEndpoints = checkDeploymentEndpointConsumers,
  stageAssets = stageProductionAssets,
  migrationGateCheck = null,
  determinePendingMigrations = determinePendingProductionMigrations,
  log = (line) => process.stderr.write(line),
  expectedSourceCommit = null,
  expectedPreviousSourceCommit = null,
  sourceCommitCheck = checkedOutSourceCommit,
  sourceTreeCleanCheck = checkedOutSourceTreeClean,
  createSourceSnapshot = createImmutableSourceSnapshot,
  dependencyDigestCheck = dependencyTreeDigest,
  releasePreflight = productionReleasePreflight,
  fetchImpl = globalThis.fetch,
  healthRecheck = recheckProductionHealth,
  publicSurfaceRecheck = recheckProductionPublicSurface,
  publicReleaseManifestRecheck = recheckProductionPublicReleaseManifest,
  typedProduction = null,
  typedOperationPin = null,
  retainedPublicSourceCommit = null,
  expectedLiveManifestSha256 = null,
  candidatePublicManifestSha256 = null,
  candidatePublicSourceCommit = null,
  replacedPublicSourceCheck = verifyPinnedPublicReleaseManifestSource,
  beforeMutation,
  finalMutationRecheck,
  mutationIntent,
  edgeDeployment = null,
}) {
  if (confirmation !== PRODUCTION_DEPLOY_CONFIRMATION) {
    return localFailure("CONFIRMATION_REQUIRED");
  }
  const initialSource = verifySourceSnapshot({
    workerDirectory,
    expectedSourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!initialSource.ok) return initialSource;
  const sourceCommit = initialSource.sourceCommit;
  if (typedProduction
      && (retainedPublicSourceCommit === null
        || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(retainedPublicSourceCommit)
        || !PRODUCTION_SHA256_PATTERN.test(expectedLiveManifestSha256 ?? "")
        || typeof publicReleaseManifestRecheck !== "function")) {
    return typedFailure("PRODUCTION_TYPED_INPUT_INVALID");
  }

  let snapshot;
  try {
    snapshot = await createSourceSnapshot({ workerDirectory, sourceCommit });
  } catch (error) {
    return localFailure(
      [
        "PRODUCTION_SOURCE_REPOSITORY_UNAVAILABLE",
        "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED",
      ].includes(error?.code)
        ? error.code
        : "PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE",
    );
  }
  if (!snapshot
      || typeof snapshot.repositoryRoot !== "string"
      || typeof snapshot.workerDirectory !== "string"
      || typeof snapshot.dependencyDigest !== "string"
      || typeof snapshot.dependencyPath !== "string"
      || typeof snapshot.cleanup !== "function") {
    if (typeof snapshot?.cleanup === "function") {
      try {
        await snapshot.cleanup();
      } catch {
        return localFailure("PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED");
      }
    }
    return localFailure("PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE");
  }

  let preparedTypedDeployment = null;
  if (typedProduction) {
    let prepared;
    try {
      prepared = await prepareTypedProductionDeployment({
        ...typedProduction,
        workerDirectory: snapshot.workerDirectory,
        sourceCommit,
        // The operation-level predecessor is authoritative. The public
        // execution API rejects a contradictory nested value below, and this
        // keeps preparation bound to the same pin even when an adapter passes
        // an equal nested value.
        expectedPreviousSourceCommit,
      });
    } catch (error) {
      prepared = typedFailure(
        typeof error?.code === "string"
          && error.code.startsWith("PRODUCTION_")
          ? error.code
          : "PRODUCTION_TYPED_PREPARATION_FAILED",
      );
    }
    if (!prepared.ok) {
      try {
        await snapshot.cleanup();
      } catch {
        return { ...prepared, cleanup: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED" };
      }
      return prepared;
    }
    if (!typedOperationPin
        || (typedOperationPin.candidatePublicManifestSha256 ?? null) !== candidatePublicManifestSha256
        || (typedOperationPin.candidatePublicSourceCommit ?? null) !== candidatePublicSourceCommit
        || prepared.baseline?.fingerprint !== typedOperationPin.liveConfigurationFingerprint
        || JSON.stringify(prepared.expectedSchemaIdentity)
          !== JSON.stringify(typedOperationPin.expectedSchemaIdentity)) {
      try {
        await snapshot.cleanup();
      } catch {
        return {
          ok: false,
          code: "PRODUCTION_TYPED_OPERATION_PIN_MISMATCH",
          cleanup: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED",
        };
      }
      return typedFailure("PRODUCTION_TYPED_OPERATION_PIN_MISMATCH");
    }
    preparedTypedDeployment = prepared;
    if (edgeDeployment) {
      const bound = await (await loadProductionEdgeMode()).bindEdgeModePreparation({
        edge: edgeDeployment,
        prepared,
        siteDirectory: join(snapshot.repositoryRoot, ".release-build", "public-release-site"),
        candidateSite: candidatePublicManifestSha256 !== null,
      });
      if (!bound.ok) {
        try {
          await snapshot.cleanup();
        } catch {
          return { ok: false, code: bound.code, cleanup: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED" };
        }
        return { ok: false, code: bound.code };
      }
      preparedTypedDeployment = bound.prepared;
    }
  }

  let result;
  try {
    result = await runProductionDeploymentFromSnapshot({
      confirmedMigrations,
      wrangler,
      workerDirectory: snapshot.workerDirectory,
      snapshotRepositoryRoot: snapshot.repositoryRoot,
      snapshotGit: snapshot.git,
      snapshotDependencyDigest: snapshot.dependencyDigest,
      snapshotDependencyPath: snapshot.dependencyPath,
      dependencyDigestCheck,
      sourceCheckDirectory: workerDirectory,
      sourceCommit,
      spawn,
      checkWorkspacePackages,
      checkEndpoints,
      stageAssets,
      migrationGateCheck,
      determinePendingMigrations,
      log,
      sourceCommitCheck,
      sourceTreeCleanCheck,
      releasePreflight,
      fetchImpl,
      healthRecheck,
      publicSurfaceRecheck,
      publicReleaseManifestRecheck,
      typedDeployment: preparedTypedDeployment,
      typedConfigPath: typedProduction
        ? join(snapshot.workerDirectory, "wrangler.jsonc")
        : null,
      retainedPublicSourceCommit,
      expectedLiveManifestSha256,
      candidatePublicManifestSha256,
      candidatePublicSourceCommit,
      replacedPublicSourceCheck,
      beforeMutation,
      finalMutationRecheck,
      mutationIntent,
      edgeDeployment,
    });
  } catch (error) {
    result = localFailure(/^PRODUCTION_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "PRODUCTION_DEPLOYMENT_FAILED");
  }

  try {
    await snapshot.cleanup();
  } catch {
    return { ...result, cleanup: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED" };
  }
  return result;
}

const EXACT_COMMIT = /^[a-f0-9]{40}$/;

const PRODUCTION_EDGE_TOOL_NAMES = Object.freeze([
  "determinePendingD1Migrations",
  "fencedSurfaceRecheck",
  "healthRecheck",
  "isAncestor",
  "readBlob",
  "verifyOrigin",
]);

/**
 * Resolve an --edge-mode deploy before its journal opens: production-edge-
 * mode.mjs runs the pre-upload gates, and this binds the typed path to the
 * edge config tools and the edge rechecks. `edgeTools` only replaces local
 * readers and rechecks (tests); it never relaxes a gate.
 */
async function prepareProductionEdgeDeployment({
  options,
  workerDirectory,
  sourceCommit,
  expectedPreviousSourceCommit,
  fetchImpl,
}) {
  const tools = options.edgeTools ?? {};
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)
      || Object.keys(tools).some((name) => !PRODUCTION_EDGE_TOOL_NAMES.includes(name)
        || typeof tools[name] !== "function")) {
    return localFailure("EDGE_MODE_INPUT_INVALID");
  }
  const edgeMode = await loadProductionEdgeMode();
  const typedProduction = options.typedProduction;
  const prepared = await edgeMode.prepareEdgeModeDeployment({
    edgeMode: options.edgeMode,
    edgePlan: options.edgePlan,
    originCommit: options.originCommit,
    inventory: typedProduction.inventory,
    baseConfigTools: typedProduction.configTools ?? defaultTypedConfigTools,
    inspectTyped: typedProduction.inspectTyped ?? runTypedProductionPreflight,
    workerDirectory,
    sourceCommit,
    expectedPreviousSourceCommit,
    candidatePublicManifestSha256: options.candidatePublicManifestSha256 ?? null,
    edgeHistory: options.edgeHistory,
    obtainOriginIdentityToken: options.obtainOriginIdentityToken,
    fetchImpl,
    ...Object.fromEntries(["readBlob", "isAncestor", "verifyOrigin"]
      .filter((name) => tools[name] !== undefined)
      .map((name) => [name, tools[name]])),
  });
  if (!prepared.ok) return prepared;
  return {
    ...prepared,
    typedProduction: {
      ...typedProduction,
      configTools: prepared.configTools,
      inspectTyped: prepared.inspectTyped,
    },
    healthRecheck: tools.healthRecheck ?? recheckProductionEdgeHealth,
    fencedSurfaceRecheck: tools.fencedSurfaceRecheck ?? recheckFencedPublicSurface,
    determinePendingD1Migrations: tools.determinePendingD1Migrations ?? determinePendingD1Migrations,
    releaseGuardDatabase: edgeMode.EDGE_MODE_RELEASE_GUARD_DATABASE,
  };
}

/**
 * The edge binding identity's final predecessor check: re-capture the live
 * version and require the pinned baseline (DEPLOYMENT_SOURCE_COMMIT, version
 * and configuration fingerprint) after the typed provider reads.
 */
async function assertEdgePredecessorBinding({ edgeDeployment, expectedPreviousSourceCommit }) {
  const { provider, configTools } = edgeDeployment.typedProduction;
  const snapshot = configTools.createSnapshot(await provider.capture());
  if (!typedSnapshotMatches(edgeDeployment.baseline, snapshot)
      || snapshot.sourceCommit !== expectedPreviousSourceCommit) {
    throw operationError("PRODUCTION_PREVIOUS_SOURCE_MISMATCH");
  }
}

// Without typedProduction this renders the checked-in env.production. That
// untyped form stays as the library path the checks exercise; neither
// operator entry point reaches it: production:deploy refuses it at parse and
// product:web-release:deploy before the receipt
// (PRODUCTION_UNTYPED_DEPLOY_REFUSED).
export async function runProductionDeployment(options) {
  const { confirmation, workerDirectory, expectedPreviousSourceCommit,
    sourceCommitCheck = checkedOutSourceCommit, sourceTreeCleanCheck = checkedOutSourceTreeClean,
    coordinationFactory = createProductionDeploymentLock, operationDirectory = null,
    healthRecheck = recheckProductionHealth, fetchImpl = globalThis.fetch } = options;
  if (confirmation !== PRODUCTION_DEPLOY_CONFIRMATION) return localFailure("CONFIRMATION_REQUIRED");
  if (!EXACT_COMMIT.test(expectedPreviousSourceCommit ?? "")) return localFailure("PRODUCTION_PREVIOUS_SOURCE_REQUIRED");
  const source = verifySourceSnapshot({ workerDirectory, expectedSourceCommit: options.expectedSourceCommit,
    sourceCommitCheck, sourceTreeCleanCheck });
  if (!source.ok) return source;
  if (!EXACT_COMMIT.test(source.sourceCommit)) return localFailure("PRODUCTION_SOURCE_COMMIT_INVALID");
  const hasRetainedPublicSourceCommit = options.retainedPublicSourceCommit !== undefined
    && options.retainedPublicSourceCommit !== null;
  const hasExpectedLiveManifestSha256 = options.expectedLiveManifestSha256 !== undefined
    && options.expectedLiveManifestSha256 !== null;
  if (!options.typedProduction
      && (hasRetainedPublicSourceCommit || hasExpectedLiveManifestSha256
        || options.candidatePublicManifestSha256 != null || options.candidatePublicSourceCommit != null)) {
    return typedFailure("PRODUCTION_TYPED_INPUT_INVALID");
  }
  if (options.typedProduction?.expectedPreviousSourceCommit !== undefined
      && options.typedProduction.expectedPreviousSourceCommit !== expectedPreviousSourceCommit) {
    return typedFailure("PRODUCTION_TYPED_PREDECESSOR_MISMATCH");
  }
  let typedOperationPin = null;
  if (options.typedProduction) {
    // Establish the content-free typed identity before opening the operation
    // journal. The binding is immutable, so a later reconciliation attempt can
    // never silently reinterpret a typed operation as a legacy deploy.
    let pinResult;
    try {
      pinResult = await createTypedProductionOperationPin({
        ...options.typedProduction,
        workerDirectory,
        expectedPreviousSourceCommit,
        retainedPublicSourceCommit: options.retainedPublicSourceCommit,
        expectedLiveManifestSha256: options.expectedLiveManifestSha256,
        candidatePublicManifestSha256: options.candidatePublicManifestSha256 ?? null,
        candidatePublicSourceCommit: options.candidatePublicSourceCommit ?? null,
      });
    } catch (error) {
      pinResult = typedFailure(
        typeof error?.code === "string"
          && (error.code.startsWith("PRODUCTION_") || error.code.startsWith("TYPED_"))
          ? error.code
          : "PRODUCTION_TYPED_OPERATION_PIN_FAILED",
      );
    }
    if (!pinResult?.ok) return pinResult ?? typedFailure("PRODUCTION_TYPED_OPERATION_PIN_FAILED");
    typedOperationPin = pinResult.pin;
    // Without --edge-mode the typed render installs the checked-in entry. Over
    // a live edge (any version carrying EDGE_UPSTREAM_MODE) that would replace
    // the edge entry and skip every edge gate, the privacy-page rule included,
    // so the deploy must name the live mode instead.
    if (options.edgeMode === undefined) {
      let liveEdge;
      try {
        const live = (options.typedProduction.configTools ?? defaultTypedConfigTools)
          .createSnapshot(options.typedProduction.inventory);
        liveEdge = Array.isArray(live?.bindings)
          && live.bindings.some((binding) => binding?.name === "EDGE_UPSTREAM_MODE");
      } catch {
        liveEdge = true;
      }
      if (liveEdge) return localFailure("EDGE_MODE_REQUIRED_FOR_EDGE_LIVE");
    }
    if (options.publicReleaseManifestRecheck === null
        || (options.publicReleaseManifestRecheck !== undefined
          && typeof options.publicReleaseManifestRecheck !== "function")) {
      return typedFailure("PRODUCTION_TYPED_INPUT_INVALID");
    }
  }
  let edgeDeployment = null;
  if (options.edgeMode !== undefined
      || PRODUCTION_EDGE_OPTION_NAMES.some((name) => options[name] !== undefined)) {
    if (options.edgeMode === undefined) return localFailure("EDGE_MODE_INPUT_INVALID");
    if (!options.typedProduction) return localFailure("EDGE_MODE_REQUIRES_TYPED");
    // Every edge gate that needs no source snapshot runs here, before the
    // operation journal or the coordination lock exists.
    edgeDeployment = await prepareProductionEdgeDeployment({
      options,
      workerDirectory,
      sourceCommit: source.sourceCommit,
      expectedPreviousSourceCommit,
      fetchImpl,
    });
    if (!edgeDeployment.ok) return localFailure(edgeDeployment.code);
    typedOperationPin = { ...typedOperationPin, edge: edgeDeployment.pin };
  }
  const repositoryRoot = resolve(workerDirectory, "../..");
  const directory = operationDirectory ?? join(repositoryRoot, ".release-build", "production-operations", source.sourceCommit);
  let operation;
  let lock;
  let state;
  let acquired = false;
  let attempted = false;
  let result;
  try {
    lock = coordinationFactory({ repositoryRoot });
    if (!lock.isAncestor(expectedPreviousSourceCommit, source.sourceCommit)) return localFailure("PRODUCTION_PREVIOUS_SOURCE_NOT_ANCESTOR");
    // A rollback site must come from a commit the deploy source contains.
    if (typedOperationPin?.candidatePublicSourceCommit !== undefined
        && !lock.isAncestor(typedOperationPin.candidatePublicSourceCommit, source.sourceCommit)) {
      return localFailure("PRODUCTION_CANDIDATE_PUBLIC_SOURCE_NOT_ANCESTOR");
    }
    // The site a changed-site deploy replaces was built on the live line:
    // its source commit is the live commit or one of its ancestors. The
    // pre-upload manifest recheck then proves that commit produced the live
    // manifest.
    if (typedOperationPin?.candidatePublicManifestSha256 !== undefined
        && !lock.isAncestor(typedOperationPin.retainedPublicSourceCommit, expectedPreviousSourceCommit)) {
      return localFailure("PRODUCTION_REPLACED_PUBLIC_SOURCE_NOT_ON_LIVE_LINE");
    }
    const binding = {
      sourceCommit: source.sourceCommit, previousSourceCommit: expectedPreviousSourceCommit,
      confirmedMigrations: options.confirmedMigrations ?? null,
      ...(typedOperationPin ? { typed: typedOperationPin } : {}),
    };
    operation = await openOperation({ directory, kind: "production", binding });
    const owner = lock.createOwner({ id: operation.record.id, sourceCommit: source.sourceCommit, previousSourceCommit: expectedPreviousSourceCommit });
    state = { owner, sourceCommit: source.sourceCommit, previousSourceCommit: expectedPreviousSourceCommit,
      confirmedMigrations: options.confirmedMigrations ?? null,
      ...(typedOperationPin ? { typed: typedOperationPin } : {}),
      stage: "preflight", outcome: "not_started", code: null, lock: "not_acquired" };
    await operation.save(state);
    result = await runUncoordinatedProductionDeployment({ ...options,
      typedOperationPin,
      ...(edgeDeployment
        ? {
          typedProduction: edgeDeployment.typedProduction,
          edgeDeployment,
          ...(edgeDeployment.mode === "fenced"
            ? { publicSurfaceRecheck: edgeDeployment.fencedSurfaceRecheck }
            : {}),
        }
        : {}),
      beforeMutation: async () => {
        state.stage = "acquiring_lock"; state.lock = "uncertain"; await operation.save(state);
        lock.acquire(owner); acquired = true;
        state.lock = "held"; state.stage = "predecessor_check"; await operation.save(state);
        // Under an edge binding identity the typed pre-deploy revalidation,
        // which runs next under this lock, is the predecessor check: it
        // re-captures the live version and requires the pinned
        // DEPLOYMENT_SOURCE_COMMIT and configuration.
        if (edgeDeployment?.identity !== "binding") {
          const health = await healthRecheck({ fetchImpl, timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS });
          if (!health?.ok || health.sourceCommit !== expectedPreviousSourceCommit) throw operationError("PRODUCTION_PREVIOUS_SOURCE_MISMATCH");
        }
        lock.assertOwned(owner);
      },
      finalMutationRecheck: async () => {
        lock.assertOwned(owner);
        if (edgeDeployment?.identity === "binding") {
          await assertEdgePredecessorBinding({ edgeDeployment, expectedPreviousSourceCommit });
        } else {
          const health = await healthRecheck({ fetchImpl, timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS });
          if (!health?.ok || health.sourceCommit !== expectedPreviousSourceCommit) {
            throw operationError("PRODUCTION_PREVIOUS_SOURCE_MISMATCH");
          }
        }
        lock.assertOwned(owner);
      },
      mutationIntent: async () => {
        lock.assertOwned(owner);
        state.stage = "deploy"; state.outcome = "outcome_unknown";
        await operation.save(state); // durable intent precedes Wrangler
        attempted = true;
      },
    });
    // Verify ownership after the provider call too. The lock is cooperative;
    // raw Wrangler/old checkouts remain unsupported bypasses, not fenced writers.
    if (attempted) lock.assertOwned(owner);
    state.outcome = attempted ? (result.ok ? "verified" : "deployed_unverified") : "not_started";
    state.stage = result.ok ? "verified" : "failed";
    state.code = result.code;
    if (result.cleanup) state.cleanup = result.cleanup;
    await operation.save(state);
  } catch (error) {
    const code = /^(?:PRODUCTION|RELEASE_OPERATION)_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "PRODUCTION_DEPLOYMENT_FAILED";
    result = localFailure(code);
    if (state) {
      state.code = code; state.stage = "failed";
      state.outcome = attempted ? "outcome_unknown" : "not_started";
      try { await operation.save(state); } catch { result.journal = "write_failed"; }
    }
  } finally {
    if (operation && acquired && (!attempted || state?.outcome === "verified")) {
      try { lock.release(state.owner); state.lock = "released"; await operation.save(state); }
      catch { result = { ...result, coordination: "release_unverified" }; }
    }
    operation?.close();
  }
  return { ...result, outcome: state?.outcome ?? "not_started", stage: state?.stage ?? "preflight",
    coordination: result?.coordination ?? state?.lock ?? "not_acquired" };
}

// Reconciliation never invokes Wrangler. Owner must first establish that the
// interrupted executor cannot still run; a lost HTTP response is not that proof.
export async function reconcileProductionDeployment({ operationDirectory, workerDirectory,
  confirmation, executorStopped = false, coordinationFactory = createProductionDeploymentLock,
  healthRecheck = recheckProductionHealth, publicSurfaceRecheck = recheckProductionPublicSurface,
  fetchImpl = globalThis.fetch }) {
  if (confirmation !== "RECONCILE_PRODUCTION_DEPLOYMENT" || executorStopped !== true) return localFailure("RECONCILIATION_CONFIRMATION_REQUIRED");
  let operation;
  try {
    const prior = await readOperation(operationDirectory);
    if (prior.kind !== "production") throw operationError("PRODUCTION_RECONCILIATION_INVALID");
    // Binding is independently checked by reading the closed deployment fields.
    const { state } = prior;
    if (!EXACT_COMMIT.test(state.sourceCommit ?? "") || !EXACT_COMMIT.test(state.previousSourceCommit ?? "") || !EXACT_COMMIT.test(state.owner ?? "")) throw operationError("PRODUCTION_RECONCILIATION_INVALID");
    // Typed operations carry provider/schema/public-release pins that this
    // legacy reconciler cannot revalidate. Refuse the operation before
    // opening or releasing its mutex; a dedicated typed reconciliation path
    // must establish the same reads as the deploy wrapper.
    if (state.typed !== undefined) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_UNSUPPORTED");
    }
    operation = await openOperation({ directory: operationDirectory, kind: "production", binding: { sourceCommit: state.sourceCommit,
      previousSourceCommit: state.previousSourceCommit, confirmedMigrations: state.confirmedMigrations ?? null }, resume: true });
    const lock = coordinationFactory({ repositoryRoot: resolve(workerDirectory, "../..") });
    lock.assertOwned(state.owner);
    const health = await healthRecheck({ fetchImpl });
    if (!health?.ok || health.sourceCommit !== state.sourceCommit || !(await publicSurfaceRecheck({ fetchImpl }))?.ok) throw operationError("PRODUCTION_RECONCILIATION_UNVERIFIED");
    state.outcome = "verified"; state.stage = "verified"; state.code = "PRODUCTION_DEPLOYED";
    await operation.save(state);
    lock.release(state.owner); state.lock = "released"; await operation.save(state);
    return { ok: true, code: "PRODUCTION_RECONCILED", outcome: "verified", coordination: "released" };
  } catch (error) { return localFailure(/^(?:PRODUCTION|RELEASE_OPERATION)_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "PRODUCTION_RECONCILIATION_FAILED"); }
  finally { operation?.close(); }
}

/**
 * Resolve a typed deploy whose provider mutation completed but whose final
 * verification was interrupted or observed a stale public health response.
 * This never deploys: it rebinds the journal and its exact remote owner, then
 * repeats the pinned configuration, three-role schema, manifest, and public
 * checks before releasing the lock.
 */
export async function reconcileTypedProductionDeployment({
  operationDirectory,
  workerDirectory,
  confirmation,
  executorStopped = false,
  typedProduction,
  coordinationFactory = createProductionDeploymentLock,
  buildSchemas = buildTypedProductionExpectedSchemas,
  inspectTyped = runTypedProductionPreflight,
  configTools = defaultTypedConfigTools,
  healthRecheck = recheckProductionHealth,
  publicSurfaceRecheck = recheckProductionPublicSurface,
  publicReleaseManifestRecheck = recheckProductionPublicReleaseManifest,
  fetchImpl = globalThis.fetch,
  edgePlan = undefined,
  edgeTools = {},
} = {}) {
  if (confirmation !== "RECONCILE_TYPED_PRODUCTION_DEPLOYMENT"
      || executorStopped !== true) {
    return localFailure("RECONCILIATION_CONFIRMATION_REQUIRED");
  }
  if (!typedProduction?.inventory
      || typeof typedProduction.provider?.capture !== "function"
      || typeof typedProduction.provider?.query !== "function"
      || typeof buildSchemas !== "function"
      || typeof inspectTyped !== "function"
      || typeof configTools?.createSnapshot !== "function"
      || typeof configTools?.render !== "function"
      || typeof configTools?.verify !== "function") {
    return typedFailure("PRODUCTION_TYPED_INPUT_INVALID");
  }
  let operation;
  try {
    const prior = await readOperation(operationDirectory);
    const { state } = prior;
    const pin = state.typed;
    if (prior.kind !== "production"
        || !EXACT_COMMIT.test(state.owner ?? "")
        || !EXACT_COMMIT.test(state.sourceCommit ?? "")
        || !EXACT_COMMIT.test(state.previousSourceCommit ?? "")
        || state.confirmedMigrations !== null
        || state.lock !== "held"
        || !["deployed_unverified", "outcome_unknown", "verified"].includes(state.outcome)
        || pin?.schema !== "production-typed-operation-v1"
        || !PRODUCTION_SHA256_PATTERN.test(pin.liveConfigurationFingerprint ?? "")
        || pin.predecessorSourceCommit !== state.previousSourceCommit
        || !EXACT_COMMIT.test(pin.retainedPublicSourceCommit ?? "")
        || !PRODUCTION_SHA256_PATTERN.test(pin.expectedLiveManifestSha256 ?? "")
        || (pin.candidatePublicManifestSha256 !== undefined
          && !PRODUCTION_SHA256_PATTERN.test(pin.candidatePublicManifestSha256))
        || (pin.candidatePublicSourceCommit !== undefined
          && (pin.candidatePublicManifestSha256 === undefined
            || !EXACT_COMMIT.test(pin.candidatePublicSourceCommit)))) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_INVALID");
    }
    // An edge-mode operation re-binds its pinned mode and plan, and repeats
    // the local contract rule, before the journal or the lock is touched.
    let edgeMode = null;
    let edge = null;
    if (pin.edge !== undefined || edgePlan !== undefined) {
      if (edgeTools === null || typeof edgeTools !== "object" || Array.isArray(edgeTools)
          || Object.keys(edgeTools).some((name) => !["fencedSurfaceRecheck", "healthRecheck", "readBlob"].includes(name)
            || typeof edgeTools[name] !== "function")) {
        throw operationError("EDGE_MODE_INPUT_INVALID");
      }
      edgeMode = await loadProductionEdgeMode();
      edge = edgeMode.resolvePinnedEdgeMode({ pin, edgePlan });
      edgeMode.assertPinnedEdgeContract({
        edge,
        sourceCommit: state.sourceCommit,
        readBlob: edgeTools.readBlob ?? edgeMode.defaultEdgeModeBlobReader(workerDirectory),
      });
    }
    operation = await openOperation({
      directory: operationDirectory,
      kind: "production",
      binding: {
        sourceCommit: state.sourceCommit,
        previousSourceCommit: state.previousSourceCommit,
        confirmedMigrations: null,
        typed: pin,
      },
      resume: true,
    });
    if (operation.record.updatedAt !== prior.updatedAt) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_INVALID");
    }
    const lock = coordinationFactory({ repositoryRoot: resolve(workerDirectory, "../..") });
    lock.assertOwned(state.owner);
    const starting = configTools.createSnapshot(typedProduction.inventory);
    const currentInventory = await typedProduction.provider.capture();
    const current = configTools.createSnapshot(currentInventory);
    if (!typedSnapshotMatches(starting, current)
        || current.sourceCommit !== state.sourceCommit
        || current.fingerprint !== (edge?.expectedLiveConfigurationFingerprint ?? pin.liveConfigurationFingerprint)) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_LIVE_MISMATCH");
    }
    const expected = await buildSchemas({ workerDirectory });
    const expectedIdentity = typedSchemaIdentity(expected);
    if (!expectedIdentity
        || JSON.stringify(expectedIdentity) !== JSON.stringify(pin.expectedSchemaIdentity)) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_SCHEMA_MISMATCH");
    }
    const parseErrors = [];
    const trackedConfig = parse(
      await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8"),
      parseErrors,
    );
    if (parseErrors.length || !trackedConfig || typeof trackedConfig !== "object") {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_CONFIG_MISMATCH");
    }
    const renderTools = edge
      ? edgeMode.createEdgeModeConfigTools({ mode: edge.mode, plan: edge.plan, trackedConfig, base: configTools })
      : configTools;
    const candidateConfig = renderTools.render({
      trackedConfig,
      snapshot: current,
      sourceCommit: state.sourceCommit,
    });
    if (!renderTools.verify({
      snapshot: current,
      candidateConfig,
      sourceCommit: state.sourceCommit,
    })?.ok) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_CONFIG_MISMATCH");
    }
    const vars = typedConfigEnvironment(candidateConfig)?.vars;
    const inspect = edge
      ? edgeMode.edgeModeTypedInspector({ mode: edge.mode, inspectTyped })
      : inspectTyped;
    const typed = await inspect({
      roles: typedRoles(),
      expectedSchemas: expected.expectedSchemas,
      config: {
        mode: vars?.TELEMETRY_STORAGE_MODE,
        sourceNamespace: vars?.TELEMETRY_STORAGE_NAMESPACE,
      },
      runQuery: (binding, sql) => typedProduction.provider.query(currentInventory, binding, sql),
    });
    if (!typed?.ok) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_PREFLIGHT_BLOCKED");
    }
    const afterSchema = configTools.createSnapshot(await typedProduction.provider.capture());
    if (!typedSnapshotMatches(current, afterSchema)) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_LIVE_MISMATCH");
    }
    if (edge && !edgeMode.verifyEdgeModeDeployedSnapshot({
      snapshot: current,
      mode: edge.mode,
      sourceCommit: state.sourceCommit,
    })?.ok) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_EDGE_MODE_UNVERIFIED");
    }
    const manifest = await publicReleaseManifestRecheck({
      fetchImpl,
      expectedSha256: pin.candidatePublicManifestSha256 ?? pin.expectedLiveManifestSha256,
      timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
    });
    if (!manifest?.ok) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_PUBLIC_MISMATCH");
    }
    let healthVerified;
    if (edge?.identity === "binding") {
      // The deploy's edge identity: barrier health for the source (fenced),
      // Worker health for the source (worker), or the pinned origin commit (gcp).
      const edgeHealth = await (edgeTools.healthRecheck ?? recheckProductionEdgeHealth)({
        fetchImpl,
        timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
        mode: edge.mode,
        expectedSourceCommit: edge.mode === "gcp" ? edge.originCommit : state.sourceCommit,
      });
      healthVerified = edgeHealth?.ok === true;
    } else {
      const health = await healthRecheck({
        fetchImpl,
        timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
      });
      healthVerified = health?.ok === true && health.sourceCommit === state.sourceCommit;
    }
    const surfaceRecheck = edge?.mode === "fenced"
      ? edgeTools.fencedSurfaceRecheck ?? recheckFencedPublicSurface
      : publicSurfaceRecheck;
    const surface = await surfaceRecheck({
      fetchImpl,
      timeoutMs: PRODUCTION_HEALTH_RECHECK_TIMEOUT_MS,
    });
    const finalSnapshot = configTools.createSnapshot(await typedProduction.provider.capture());
    if (!healthVerified || !surface?.ok || !typedSnapshotMatches(current, finalSnapshot)) {
      throw operationError("PRODUCTION_TYPED_RECONCILIATION_UNVERIFIED");
    }
    lock.assertOwned(state.owner);
    state.outcome = "verified";
    state.stage = "verified";
    state.code = "PRODUCTION_DEPLOYED";
    await operation.save(state);
    lock.release(state.owner);
    state.lock = "released";
    await operation.save(state);
    return {
      ok: true,
      code: "PRODUCTION_TYPED_RECONCILED",
      outcome: "verified",
      coordination: "released",
    };
  } catch (error) {
    const code = /^(?:PRODUCTION|RELEASE_OPERATION|EDGE)_[A-Z_]+$/.test(error?.code ?? "")
      ? error.code
      : "PRODUCTION_TYPED_RECONCILIATION_FAILED";
    return localFailure(code);
  } finally {
    operation?.close();
  }
}

// --edge-mode arguments (E10). Each also accepts the --name=value form.
const PRODUCTION_EDGE_ARGUMENTS = new Map([
  ["--edge-mode", "edgeMode"],
  ["--edge-plan", "edgePlanPath"],
  ["--origin-commit", "originCommit"],
  ["--origin-verifier-account", "originVerifierAccount"],
  ["--fence-receipt", "fenceReceiptPath"],
  ["--fence-receipt-sha256", "fenceReceiptSha256"],
]);

function splitProductionEdgeArgument(argument) {
  const separator = typeof argument === "string" ? argument.indexOf("=") : -1;
  return separator > 0 && PRODUCTION_EDGE_ARGUMENTS.has(argument.slice(0, separator))
    ? [argument.slice(0, separator), argument.slice(separator + 1)]
    : [argument];
}

/**
 * The edge arguments are closed per confirmation: a typed reconcile takes only
 * --edge-plan (its mode is pinned), the legacy reconcile none, and a deploy
 * --edge-mode with exactly its mode's inputs: gcp the plan, the origin commit
 * and the verifier account; worker optionally the EP-8 fence receipt that
 * anchors the history check for fenced -> worker; fenced nothing else.
 */
function assertProductionEdgeArguments(result) {
  const present = [...PRODUCTION_EDGE_ARGUMENTS.values()].filter((name) => name in result);
  if (present.length === 0) return;
  const invalid = () => { throw operationError("PRODUCTION_ARGUMENTS_INVALID"); };
  if (result.confirmation === "RECONCILE_TYPED_PRODUCTION_DEPLOYMENT") {
    if (present.some((name) => name !== "edgePlanPath")) invalid();
    return;
  }
  if (result.confirmation !== PRODUCTION_DEPLOY_CONFIRMATION
      || !["worker", "fenced", "gcp"].includes(result.edgeMode)) invalid();
  const allowed = {
    worker: ["edgeMode", "fenceReceiptPath", "fenceReceiptSha256"],
    fenced: ["edgeMode"],
    gcp: ["edgeMode", "edgePlanPath", "originCommit", "originVerifierAccount"],
  }[result.edgeMode];
  if (present.some((name) => !allowed.includes(name))
      || Boolean(result.fenceReceiptPath) !== Boolean(result.fenceReceiptSha256)
      || (result.fenceReceiptSha256 !== undefined && !PRODUCTION_SHA256_PATTERN.test(result.fenceReceiptSha256))
      || (result.edgeMode === "gcp" && (!result.edgePlanPath || !result.originVerifierAccount
        || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(result.originCommit ?? "")))) {
    invalid();
  }
}

// Candidate-site arguments: a typed edge deploy that ships a public site other
// than the live one. The candidate manifest comes with exactly one web-release
// receipt (a forward release, or a rollback to a previously released site,
// which also names the verified production operation that released it) and
// the replaced pair: the live public source and live manifest the deploy
// replaces. The replaced pair is proven before the upload (the live manifest
// bytes, and the commit that produced them), like the retained pair, but
// unlike it the site changes, so the two pairs never mix.
const PRODUCTION_CANDIDATE_SITE_ARGUMENTS = new Map([
  ["--candidate-public-manifest-sha256", "candidatePublicManifestSha256"],
  ["--web-release-receipt", "webReleaseReceiptPath"],
  ["--rollback-web-release-receipt", "rollbackWebReleaseReceiptPath"],
  ["--rollback-release-operation", "rollbackReleaseOperationDirectory"],
  ["--replaced-public-source", "replacedPublicSourceCommit"],
  ["--replaced-live-manifest-sha256", "replacedLiveManifestSha256"],
]);

/**
 * Close the candidate-site arguments before any other deploy rule, so their
 * refusals carry their own codes:
 * - PRODUCTION_CANDIDATE_SITE_EDGE_MODE_REQUIRED: no --edge-mode, so the
 *   privacy-page rule (EDGE_PRIVACY_PAGE_PREMATURE / _NOT_CUTOVER) would not
 *   run;
 * - PRODUCTION_CANDIDATE_SITE_FENCED: a site change while fenced (releases
 *   pause while the fence is up; the brake keeps the live site);
 * - PRODUCTION_CANDIDATE_SITE_RETAINED_PIN_CONFLICT: the retained pair
 *   (--retained-public-source, --expected-live-manifest-sha256) says the site
 *   stays, the candidate says it changes;
 * - PRODUCTION_CANDIDATE_SITE_UNCHANGED: the candidate equals the replaced live
 *   manifest; a deploy that keeps the site uses the retained pair;
 * - PRODUCTION_ARGUMENTS_INVALID: anything else incomplete or malformed,
 *   including a rollback receipt without its absolute
 *   --rollback-release-operation, or that flag on a forward release.
 */
function assertProductionCandidateSiteArguments(result) {
  const present = [...PRODUCTION_CANDIDATE_SITE_ARGUMENTS.values()].filter((name) => name in result);
  if (present.length === 0) return;
  const refuse = (code = "PRODUCTION_ARGUMENTS_INVALID") => { throw operationError(code); };
  if (result.confirmation !== PRODUCTION_DEPLOY_CONFIRMATION
      || result.candidatePublicManifestSha256 === undefined) refuse();
  if (result.edgeMode === undefined) refuse("PRODUCTION_CANDIDATE_SITE_EDGE_MODE_REQUIRED");
  if (result.edgeMode === "fenced") refuse("PRODUCTION_CANDIDATE_SITE_FENCED");
  if (result.retainedPublicSourceCommit !== undefined || result.expectedLiveManifestSha256 !== undefined) {
    refuse("PRODUCTION_CANDIDATE_SITE_RETAINED_PIN_CONFLICT");
  }
  if ((result.webReleaseReceiptPath === undefined) === (result.rollbackWebReleaseReceiptPath === undefined)
      || !isAbsolute(result.webReleaseReceiptPath ?? result.rollbackWebReleaseReceiptPath)
      || (result.rollbackWebReleaseReceiptPath === undefined) !== (result.rollbackReleaseOperationDirectory === undefined)
      || (result.rollbackReleaseOperationDirectory !== undefined && !isAbsolute(result.rollbackReleaseOperationDirectory))
      || result.inventoryPath === undefined
      || result.confirmedMigrations !== undefined
      || !PRODUCTION_SHA256_PATTERN.test(result.candidatePublicManifestSha256)
      || !PRODUCTION_SHA256_PATTERN.test(result.replacedLiveManifestSha256 ?? "")
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(result.replacedPublicSourceCommit ?? "")) {
    refuse();
  }
  if (result.candidatePublicManifestSha256 === result.replacedLiveManifestSha256) {
    refuse("PRODUCTION_CANDIDATE_SITE_UNCHANGED");
  }
}

export function parseProductionDeploymentArgs(argv) {
  argv = argv.flatMap(splitProductionEdgeArgument);
  const names = new Map([["--confirm", "confirmation"], ["--confirm-migrations", "confirmedMigrations"],
    ["--expected-previous-source", "expectedPreviousSourceCommit"], ["--operation", "operationDirectory"],
    ["--inventory", "inventoryPath"], ["--inventory-sha256", "inventorySha256"],
    ["--retained-public-source", "retainedPublicSourceCommit"],
    ["--retained-public-source-commit", "retainedPublicSourceCommit"],
    ["--expected-live-manifest-sha256", "expectedLiveManifestSha256"],
    ...PRODUCTION_CANDIDATE_SITE_ARGUMENTS,
    ...PRODUCTION_EDGE_ARGUMENTS]);
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--executor-stopped" && !result.executorStopped) { result.executorStopped = true; continue; }
    const name = names.get(argv[i]); const value = argv[++i];
    if (!name || name in result || !value || value.startsWith("--") || value.includes("\0")) throw operationError("PRODUCTION_ARGUMENTS_INVALID");
    result[name] = value;
  }
  assertProductionCandidateSiteArguments(result);
  const candidateSite = result.candidatePublicManifestSha256 !== undefined;
  if (result.confirmation === "RECONCILE_TYPED_PRODUCTION_DEPLOYMENT") {
    if (!result.operationDirectory || !result.executorStopped
        || !result.inventoryPath || !result.inventorySha256
        || !PRODUCTION_SHA256_PATTERN.test(result.inventorySha256)
        || result.confirmedMigrations || result.expectedPreviousSourceCommit
        || result.retainedPublicSourceCommit || result.expectedLiveManifestSha256) {
      throw operationError("PRODUCTION_ARGUMENTS_INVALID");
    }
  } else if (result.confirmation === "RECONCILE_PRODUCTION_DEPLOYMENT") {
    if (!result.operationDirectory || !result.executorStopped || result.confirmedMigrations || result.expectedPreviousSourceCommit
        || result.inventoryPath || result.inventorySha256 || result.retainedPublicSourceCommit || result.expectedLiveManifestSha256) {
      throw operationError("PRODUCTION_ARGUMENTS_INVALID");
    }
  } else if (result.confirmation !== PRODUCTION_DEPLOY_CONFIRMATION
      || !EXACT_COMMIT.test(result.expectedPreviousSourceCommit ?? "")
      || result.executorStopped
      || (Boolean(result.inventoryPath) !== Boolean(result.inventorySha256))
      || (Boolean(result.retainedPublicSourceCommit) !== Boolean(result.expectedLiveManifestSha256))
      || Boolean(result.inventoryPath) !== (Boolean(result.retainedPublicSourceCommit) || candidateSite)
      || (result.inventorySha256 !== undefined && !PRODUCTION_SHA256_PATTERN.test(result.inventorySha256))
      || (result.expectedLiveManifestSha256 !== undefined && !PRODUCTION_SHA256_PATTERN.test(result.expectedLiveManifestSha256))
      || (result.retainedPublicSourceCommit !== undefined && !PRODUCTION_SOURCE_COMMIT_PATTERN.test(result.retainedPublicSourceCommit))) {
    throw operationError("PRODUCTION_ARGUMENTS_INVALID");
  } else if (!result.inventoryPath) {
    // The untyped deploy renders the checked-in env.production: on this line
    // that is the JSON storage layout without the edge entry. It would replace
    // a typed production Worker, drop a live edge and skip every edge gate,
    // the privacy-page rule included, and nothing without an inventory can
    // see which is live. Every production deploy is typed.
    throw operationError("PRODUCTION_UNTYPED_DEPLOY_REFUSED");
  }
  assertProductionEdgeArguments(result);
  return result;
}

/**
 * The site a verified typed production deploy left live, read from its
 * operation journal: the candidate it shipped (built from its deploy source,
 * or from the rollback source it named), or the retained site it kept. Both
 * were proven at staging against their source commit. null unless the journal
 * is a verified typed production operation whose state still matches the
 * binding digest it was opened with.
 */
function releasedSiteOfOperation(record) {
  const state = record?.state;
  const pin = state?.typed;
  if (record?.kind !== "production"
      || state?.outcome !== "verified"
      || state.stage !== "verified"
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(state.sourceCommit ?? "")
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(state.previousSourceCommit ?? "")
      || state.confirmedMigrations !== null
      || pin?.schema !== "production-typed-operation-v1"
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(pin.retainedPublicSourceCommit ?? "")
      || !PRODUCTION_SHA256_PATTERN.test(pin.expectedLiveManifestSha256 ?? "")
      || (pin.candidatePublicManifestSha256 !== undefined
        && !PRODUCTION_SHA256_PATTERN.test(pin.candidatePublicManifestSha256))
      || (pin.candidatePublicSourceCommit !== undefined
        && (pin.candidatePublicManifestSha256 === undefined
          || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(pin.candidatePublicSourceCommit)))
      || record.binding !== identityDigest({
        sourceCommit: state.sourceCommit,
        previousSourceCommit: state.previousSourceCommit,
        confirmedMigrations: null,
        typed: pin,
      })) {
    return null;
  }
  return pin.candidatePublicManifestSha256 === undefined
    ? {
      manifestSha256: pin.expectedLiveManifestSha256,
      sourceCommit: pin.retainedPublicSourceCommit,
      deploySourceCommit: state.sourceCommit,
    }
    : {
      manifestSha256: pin.candidatePublicManifestSha256,
      sourceCommit: pin.candidatePublicSourceCommit ?? state.sourceCommit,
      deploySourceCommit: state.sourceCommit,
    };
}

/**
 * Turn the CLI's candidate-site arguments into runProductionDeployment inputs,
 * after proving them against a web-release receipt (scripts/web-release-lane.js
 * re-runs the receipt's scope, catalogue proofs and generated-site match):
 *
 * - Forward (--web-release-receipt): the receipt must be fresh. Its source is
 *   the checked-out HEAD, which becomes the deploy's exact source, and its base
 *   is --expected-previous-source, the live commit the shared lock rechecks.
 *   Otherwise PRODUCTION_CANDIDATE_RECEIPT_STALE.
 * - Rollback (--rollback-web-release-receipt): a previously released site.
 *   Its source must be on the live line (an ancestor of, or equal to,
 *   --expected-previous-source); otherwise PRODUCTION_ROLLBACK_RECEIPT_NOT_ON_LIVE_LINE.
 *   --rollback-release-operation names the journal of the verified typed
 *   production deploy that left this site live; it must be readable and
 *   intact (PRODUCTION_ROLLBACK_OPERATION_INVALID), and its site must be the
 *   candidate manifest from the receipt's source commit, deployed on the live
 *   line (PRODUCTION_ROLLBACK_SITE_NOT_RELEASED). The deploy source stays
 *   HEAD, and the staged site is pinned to the receipt's source commit.
 *
 * Either way the receipt's manifest must be the candidate
 * (PRODUCTION_CANDIDATE_RECEIPT_MISMATCH), and the replaced pair becomes the
 * live preimage the deploy proves before the upload. Staging then proves the
 * snapshot's site is exactly the candidate manifest, built from the pinned
 * commit. Options without a candidate pass through unchanged.
 */
export async function resolveProductionCandidateSite({
  options,
  workerDirectory,
  headCommit = checkedOutSourceCommit,
  isAncestor = null,
  verifyReceipt = null,
  readReleaseOperation = readOperation,
} = {}) {
  const {
    candidatePublicManifestSha256,
    webReleaseReceiptPath,
    rollbackWebReleaseReceiptPath,
    rollbackReleaseOperationDirectory,
    replacedPublicSourceCommit,
    replacedLiveManifestSha256,
    ...rest
  } = options ?? {};
  if (candidatePublicManifestSha256 === undefined) {
    return Object.keys(rest).length === Object.keys(options ?? {}).length
      ? { ok: true, code: null, options }
      : localFailure("PRODUCTION_ARGUMENTS_INVALID");
  }
  const rollback = rollbackWebReleaseReceiptPath !== undefined;
  const receiptPath = rollback ? rollbackWebReleaseReceiptPath : webReleaseReceiptPath;
  if (typeof workerDirectory !== "string"
      || rest.edgeMode === undefined
      || rest.edgeMode === "fenced"
      || rest.retainedPublicSourceCommit !== undefined
      || rest.expectedLiveManifestSha256 !== undefined
      || (webReleaseReceiptPath === undefined) === (rollbackWebReleaseReceiptPath === undefined)
      || typeof receiptPath !== "string" || !isAbsolute(receiptPath)
      || rollback !== (rollbackReleaseOperationDirectory !== undefined)
      || (rollback && (typeof rollbackReleaseOperationDirectory !== "string"
        || !isAbsolute(rollbackReleaseOperationDirectory)))
      || !PRODUCTION_SHA256_PATTERN.test(candidatePublicManifestSha256 ?? "")
      || !PRODUCTION_SHA256_PATTERN.test(replacedLiveManifestSha256 ?? "")
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(replacedPublicSourceCommit ?? "")
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(rest.expectedPreviousSourceCommit ?? "")
      || candidatePublicManifestSha256 === replacedLiveManifestSha256) {
    return localFailure("PRODUCTION_ARGUMENTS_INVALID");
  }
  const repositoryRoot = resolve(workerDirectory, "../..");
  let receipt;
  try {
    const verify = verifyReceipt ?? (await loadWebReleaseLane()).verifyWebReleaseReceipt;
    receipt = (await verify({ repositoryRoot, receiptPath }))?.receipt;
  } catch {
    return localFailure("PRODUCTION_CANDIDATE_RECEIPT_INVALID");
  }
  if (!PRODUCTION_SOURCE_COMMIT_PATTERN.test(receipt?.sourceCommit ?? "")
      || !PRODUCTION_SOURCE_COMMIT_PATTERN.test(receipt?.baseCommit ?? "")
      || !PRODUCTION_SHA256_PATTERN.test(receipt?.site?.manifestSha256 ?? "")) {
    return localFailure("PRODUCTION_CANDIDATE_RECEIPT_INVALID");
  }
  if (receipt.site.manifestSha256 !== candidatePublicManifestSha256) {
    return localFailure("PRODUCTION_CANDIDATE_RECEIPT_MISMATCH");
  }
  const head = headCommit(workerDirectory);
  if (!PRODUCTION_SOURCE_COMMIT_PATTERN.test(head ?? "")) {
    return localFailure("PRODUCTION_SOURCE_REVISION_UNAVAILABLE");
  }
  const sitePins = {
    retainedPublicSourceCommit: replacedPublicSourceCommit,
    expectedLiveManifestSha256: replacedLiveManifestSha256,
    candidatePublicManifestSha256,
  };
  if (!rollback) {
    if (receipt.sourceCommit !== head || receipt.baseCommit !== rest.expectedPreviousSourceCommit) {
      return localFailure("PRODUCTION_CANDIDATE_RECEIPT_STALE");
    }
    return { ok: true, code: null, options: { ...rest, expectedSourceCommit: head, ...sitePins } };
  }
  const ancestor = isAncestor ?? (async (previous, candidate) => (await loadProductionEdgeMode())
    .gitIsAncestor({ repositoryDirectory: workerDirectory, previous, candidate }));
  let onLiveLine;
  try {
    onLiveLine = await ancestor(receipt.sourceCommit, rest.expectedPreviousSourceCommit);
  } catch {
    onLiveLine = false;
  }
  if (onLiveLine !== true) return localFailure("PRODUCTION_ROLLBACK_RECEIPT_NOT_ON_LIVE_LINE");
  // The receipt proves the site's bytes and scope, not that it was ever live:
  // the named journal must show a verified production deploy that left this
  // exact site, from this exact commit, live on this line.
  let released;
  try {
    released = releasedSiteOfOperation(await readReleaseOperation(rollbackReleaseOperationDirectory));
  } catch {
    released = null;
  }
  if (released === null) return localFailure("PRODUCTION_ROLLBACK_OPERATION_INVALID");
  let releasedOnLiveLine = false;
  if (released.manifestSha256 === candidatePublicManifestSha256
      && released.sourceCommit === receipt.sourceCommit) {
    try {
      releasedOnLiveLine = await ancestor(released.deploySourceCommit, rest.expectedPreviousSourceCommit);
    } catch {
      releasedOnLiveLine = false;
    }
  }
  if (releasedOnLiveLine !== true) return localFailure("PRODUCTION_ROLLBACK_SITE_NOT_RELEASED");
  return {
    ok: true,
    code: null,
    options: { ...rest, expectedSourceCommit: head, ...sitePins, candidatePublicSourceCommit: receipt.sourceCommit },
  };
}

/**
 * Turn the CLI's edge arguments into runProductionDeployment and
 * reconcileTypedProductionDeployment inputs: the owner-private plan, the
 * in-memory gcloud verifier token source and the fence-anchored deployment
 * history reader. File paths and the verifier account never reach the run.
 */
async function productionEdgeRunOptions(runOptions) {
  const {
    edgePlanPath,
    originVerifierAccount,
    fenceReceiptPath,
    fenceReceiptSha256,
    ...rest
  } = runOptions;
  if (edgePlanPath === undefined && rest.edgeMode === undefined) return runOptions;
  const edgeMode = await loadProductionEdgeMode();
  if (edgePlanPath !== undefined) rest.edgePlan = await edgeMode.readEdgeModePlan(edgePlanPath);
  if (originVerifierAccount !== undefined) {
    const { plan } = edgeMode.resolveEdgeModeRequest({ edgeMode: rest.edgeMode, edgePlan: rest.edgePlan });
    rest.obtainOriginIdentityToken = edgeMode.createGcloudIdentityTokenSource({
      verifierAccount: originVerifierAccount,
      audience: plan.originAudience,
    });
  }
  if (fenceReceiptPath !== undefined) {
    rest.edgeHistory = edgeMode.createFenceHistorySource({
      receiptPath: fenceReceiptPath,
      receiptSha256: fenceReceiptSha256,
      accountId: rest.typedProduction?.inventory?.accountId,
      workerName: rest.typedProduction?.inventory?.workerName,
    });
  }
  return rest;
}

async function main() {
  let options;
  try { options = parseProductionDeploymentArgs(process.argv.slice(2)); } catch (error) {
    const code = /^PRODUCTION_[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "PRODUCTION_ARGUMENTS_INVALID";
    process.stderr.write(
      `${code}\n`
        + "Usage (typed only; an untyped deploy is refused PRODUCTION_UNTYPED_DEPLOY_REFUSED): production-deploy.mjs "
        + `--confirm ${PRODUCTION_DEPLOY_CONFIRMATION} `
        + "--expected-previous-source FULL_SHA [--operation PRIVATE_DIRECTORY] "
        + "--inventory PRIVATE_JSON --inventory-sha256 SHA256 "
        + "--retained-public-source FULL_SHA --expected-live-manifest-sha256 SHA256\n"
        + "Reconcile only: --confirm RECONCILE_PRODUCTION_DEPLOYMENT --operation PRIVATE_DIRECTORY --executor-stopped\n"
        + "Typed recovery: --confirm RECONCILE_TYPED_PRODUCTION_DEPLOYMENT --operation PRIVATE_DIRECTORY --executor-stopped --inventory PRIVATE_JSON --inventory-sha256 SHA256\n"
        + "Edge modes (typed only): --edge-mode worker [--fence-receipt PRIVATE_JSON --fence-receipt-sha256 SHA256] | --edge-mode fenced "
        + "| --edge-mode gcp --edge-plan PRIVATE_JSON --origin-commit FULL_SHA --origin-verifier-account EMAIL; "
        + "typed recovery of a gcp operation adds --edge-plan PRIVATE_JSON\n"
        + "Changed site (typed, --edge-mode worker or gcp; replaces the retained pair): "
        + "--candidate-public-manifest-sha256 SHA256 "
        + "(--web-release-receipt ABSOLUTE_RECEIPT | --rollback-web-release-receipt ABSOLUTE_RECEIPT "
        + "--rollback-release-operation ABSOLUTE_RELEASE_OPERATION_DIRECTORY) "
        + "--replaced-public-source FULL_SHA --replaced-live-manifest-sha256 SHA256\n",
    );
    process.exit(2);
  }
  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  let result;
  try {
    const wrangler = join(
      workerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    );
    const run = options.confirmation === "RECONCILE_PRODUCTION_DEPLOYMENT"
      ? reconcileProductionDeployment
      : options.confirmation === "RECONCILE_TYPED_PRODUCTION_DEPLOYMENT"
        ? reconcileTypedProductionDeployment
        : runProductionDeployment;
    // A candidate site is proven against its web-release receipt before the
    // inventory is read or anything remote runs.
    const candidate = await resolveProductionCandidateSite({ options, workerDirectory });
    if (!candidate.ok) {
      result = { ok: false, code: candidate.code };
    } else {
      const runOptions = {
        ...candidate.options,
        wrangler,
        workerDirectory,
      };
      if (runOptions.inventoryPath) {
        const inventory = await readPrivateProductionInventory(
          runOptions.inventoryPath,
          runOptions.inventorySha256,
        );
        runOptions.typedProduction = {
          inventory,
          provider: createProductionLiveProvider({
            accountId: inventory.accountId,
            workerName: inventory.workerName,
          }),
        };
      }
      result = await run(await productionEdgeRunOptions(runOptions));
    }
  } catch (error) {
    const code = typeof error?.code === "string"
      && (error.code.startsWith("PRODUCTION_RECONCILE_")
        || error.code.startsWith("PRODUCTION_LIVE_")
        || error.code.startsWith("EDGE_"))
      ? error.code
      : "PRODUCTION_DEPLOYMENT_FAILED";
    result = { ok: false, code };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
