import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { parse } from "jsonc-parser";
import { operationError } from "../../../scripts/lib/release-operation.mjs";
import {
  EDGE_HEADERS,
  canonicalRunAppOrigin,
  isEdgeOriginAudience,
  isEdgeServiceAccountEmail,
  parseEdgeUpstreamMode,
} from "../src/edge-origin-contract.ts";
import {
  EDGE_MODE_GCP_VARS,
  EDGE_MODE_RELEASE_GUARD_BINDING,
  EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR,
  EDGE_MODE_TRANSITIONS,
  EDGE_MODE_VAR,
  applyEdgeModeOverlay,
  applyEdgeModeSnapshotDelta,
  assertEdgeModeTransition,
  edgeModeOverlaySha256,
  liveEdgeMode,
  normalizeEdgeModePlan,
  verifyEdgeModeLiveSnapshot,
} from "./edge-mode-configuration.mjs";
import { readMaintenanceFile } from "./production-maintenance.mjs";

/**
 * Edge-mode support for the typed production deploy and its reconcilers
 * (E10). production-deploy.mjs and production-reconcile.mjs load this module
 * only when an edge mode is requested or pinned, so a deploy without
 * --edge-mode keeps today's module graph and behaviour.
 *
 * What this adds on top of EP-9's overlay (edge-mode-configuration.mjs):
 * - the request: mode and plan validation, the content-free operation pin and
 *   the receipt fields (no token, key, email, address or plan value; the plan
 *   is pinned by its overlay sha256 only);
 * - the typed config tools: render = overlay(render), verify = verify against
 *   the expected post-deploy snapshot (applyEdgeModeSnapshotDelta), and a
 *   typed schema inspector that reads no storage in gcp mode, where no typed
 *   role is bound;
 * - the pre-upload gates: the transition matrix (with the deployment history
 *   since the EP-8 fence for fenced -> worker), source descent from the live
 *   DEPLOYMENT_SOURCE_COMMIT, the edge entry and contract blobs at the source,
 *   and for gcp the six edge-tier Rate Limiting bindings, the pre-gcp origin
 *   verifier and the contract-blob identity between the edge and the origin
 *   commit;
 * - the privacy-page topology marker rule.
 *
 * Every check here is local or uses an injected reader. Nothing logs, writes
 * a file or puts a value into an error: errors carry a stable code only.
 */

export const PRODUCTION_EDGE_MODE_PIN_SCHEMA = "production-edge-mode-pin-v1";

/**
 * The six Workers Rate Limiting bindings evaluated at the edge. This mirrors
 * EDGE_ADMISSION_BINDINGS in src/edge-admission-policy.ts (EP-1), which a
 * script cannot import; production-edge-mode.check.mjs ties the two.
 */
export const EDGE_MODE_ADMISSION_BINDINGS = Object.freeze([
  "ENROLLMENT_RATE_LIMIT",
  "RECOVERY_RATE_LIMIT",
  "CLIENT_ATTEMPT_RATE_LIMIT",
  "PUBLIC_READ_RATE_LIMIT",
  "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_INGRESS_CLIENT_RATE_LIMIT",
]);

/** The only D1 a gcp edge binds, and its migration directory (EP-9). */
export const EDGE_MODE_RELEASE_GUARD_DATABASE = Object.freeze({
  binding: EDGE_MODE_RELEASE_GUARD_BINDING,
  migrationsDir: EDGE_MODE_RELEASE_GUARD_MIGRATIONS_DIR,
});

/** Repository paths whose blobs bind an edge deploy (git `<commit>:<path>`). */
export const EDGE_ORIGIN_CONTRACT_PATH = "apps/worker/src/edge-origin-contract.ts";
export const EDGE_ENTRY_PATH = "apps/worker/src/edge-entry.ts";

/** The candidate site's privacy page and the gcp hosting-topology marker. */
export const EDGE_PRIVACY_PAGE = "privacy.html";
export const EDGE_PRIVACY_TOPOLOGY_MARKER = 'data-hosting-topology="cloudflare-edge-gcp-origin"';
const EDGE_PRIVACY_PAGE_MAX_BYTES = 1024 * 1024;

/** The pre-gcp verifier reads exactly these origin paths (EP-6's verifier set). */
export const EDGE_ORIGIN_VERIFIER_PATHS = Object.freeze(["/api/health", "/api/ready"]);
const EDGE_ORIGIN_MARKER_VALUE = "1";
const EDGE_ORIGIN_VERIFIER_MAX_BYTES = 64 * 1024;
const EDGE_ORIGIN_VERIFIER_TIMEOUT_MS = 10_000;

/** Deployments the history reader walks back before it refuses. */
export const EDGE_MODE_HISTORY_MAX_DEPLOYMENTS = 25;

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}$/u;
const OPAQUE = /^[A-Za-z0-9-]{1,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEALTH_IDENTITY_MODES = Object.freeze([null, "worker"]);
const NON_GCP_HISTORY_MODES = Object.freeze([null, "worker", "fenced"]);

function fail(code) {
  throw operationError(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function edgeCode(error, fallback) {
  const code = error?.code;
  return typeof code === "string"
    && /^(?:EDGE|PRODUCTION_LIVE|PRODUCTION_TYPED|PRODUCTION_RECONCILE)_[A-Z0-9_]+$/u.test(code)
    ? code
    : fallback;
}

/**
 * Validate an --edge-mode request. gcp needs the EP-9 plan
 * (EDGE_MODE_PLAN_REQUIRED without one); worker and fenced take none.
 */
export function resolveEdgeModeRequest({ edgeMode, edgePlan } = {}) {
  const mode = parseEdgeUpstreamMode(edgeMode);
  if (mode === null) fail("EDGE_MODE_INVALID");
  if (mode === "gcp" && (edgePlan === undefined || edgePlan === null)) fail("EDGE_MODE_PLAN_REQUIRED");
  const plan = normalizeEdgeModePlan({ mode, plan: edgePlan });
  return Object.freeze({ mode, plan, overlaySha256: edgeModeOverlaySha256({ mode, plan }) });
}

/**
 * Today's health-based identity applies only while both the live and the
 * target mode run the storage Worker (null or worker). Every other pair takes
 * its identity from the Cloudflare DEPLOYMENT_SOURCE_COMMIT binding.
 */
export function edgeModeIdentity(liveMode, mode) {
  return HEALTH_IDENTITY_MODES.includes(liveMode) && HEALTH_IDENTITY_MODES.includes(mode)
    ? "health"
    : "binding";
}

/**
 * The typed config tools for an edge deploy. render overlays the typed live
 * render; verify compares a candidate with the expected post-deploy snapshot
 * of the snapshot it is given. The delta is idempotent on a snapshot already
 * in `mode`, so the same verify serves the pre-deploy baseline and the
 * post-deploy capture; the deploy's post-deploy fingerprint check against the
 * pinned expected snapshot keeps an unapplied overlay from passing.
 */
export function createEdgeModeConfigTools({ mode, plan, trackedConfig, base } = {}) {
  if (parseEdgeUpstreamMode(mode) === null || !object(trackedConfig)
      || typeof base?.createSnapshot !== "function" || typeof base?.render !== "function"
      || typeof base?.verify !== "function") {
    fail("EDGE_MODE_INPUT_INVALID");
  }
  const trackedText = JSON.stringify(trackedConfig);
  const expectedSnapshot = (snapshot) => applyEdgeModeSnapshotDelta({ snapshot, mode, plan, trackedConfig });
  return Object.freeze({
    createSnapshot: base.createSnapshot,
    render({ trackedConfig: rendered, snapshot, sourceCommit } = {}) {
      // The render's tracked config is the source snapshot's wrangler.jsonc;
      // the overlay's is the checked-out one. Both come from one commit.
      if (JSON.stringify(rendered) !== trackedText) fail("EDGE_MODE_INPUT_INVALID");
      return applyEdgeModeOverlay({
        renderedConfig: base.render({ trackedConfig: rendered, snapshot, sourceCommit }),
        mode,
        plan,
        trackedConfig,
      }).config;
    },
    verify({ snapshot, candidateConfig, sourceCommit } = {}) {
      let expected;
      try {
        expected = expectedSnapshot(snapshot);
      } catch (error) {
        return { ok: false, code: edgeCode(error, "EDGE_MODE_VERIFY_FAILED") };
      }
      return base.verify({ snapshot: expected, candidateConfig, sourceCommit });
    },
    expectedSnapshot,
  });
}

/**
 * gcp binds none of the typed roles (USAGE_MONITOR_DB, ANALYTICS_DB,
 * DELETION_LEDGER), so its typed schema inspection is restricted to the bound
 * roles: none, and no provider query is made. worker and fenced keep today's
 * full inspection.
 */
export function edgeModeTypedInspector({ mode, inspectTyped } = {}) {
  if (mode !== "gcp") return inspectTyped;
  return async () => ({ ok: true, code: "EDGE_MODE_GCP_TYPED_ROLES_UNBOUND", roles: [] });
}

/** gcp refuses a live baseline that lacks any of the six edge-tier bindings. */
export function assertEdgeAdmissionBindings(snapshot) {
  const bindings = Array.isArray(snapshot?.bindings) ? snapshot.bindings : null;
  if (bindings === null
      || EDGE_MODE_ADMISSION_BINDINGS.some((name) => !bindings.some((binding) =>
        binding?.name === name && binding.type === "ratelimit"))) {
    fail("EDGE_MODE_ADMISSION_BINDING_MISSING");
  }
}

/**
 * Whether a gcp-mode version ran since the EP-8 fence. `deployments` are the
 * production deployments newest first, each with the edge modes of its
 * versions; the walk stops at the fenced deployment the fence receipt names.
 * A history that does not reach it is refused, and a mode that is not provably
 * non-gcp (an unknown value) counts as gcp.
 */
export function gcpDeployedSinceFence({ deployments, fenceDeploymentId } = {}) {
  if (!Array.isArray(deployments) || typeof fenceDeploymentId !== "string" || !OPAQUE.test(fenceDeploymentId)) {
    fail("EDGE_MODE_FENCE_HISTORY_INCOMPLETE");
  }
  const index = deployments.findIndex((deployment) => deployment?.deploymentId === fenceDeploymentId);
  if (index < 0) fail("EDGE_MODE_FENCE_HISTORY_INCOMPLETE");
  return deployments.slice(0, index + 1).some((deployment) => !Array.isArray(deployment?.modes)
    || deployment.modes.length === 0
    || deployment.modes.some((mode) => !NON_GCP_HISTORY_MODES.includes(mode)));
}

/** The git blob of `path` at `commit`, or null; local git only. */
export function readGitBlob({ repositoryDirectory, commit, path, execFile = execFileSync } = {}) {
  if (typeof repositoryDirectory !== "string" || !SHA.test(commit ?? "")
      || typeof path !== "string" || !/^[A-Za-z0-9._/-]{1,256}$/u.test(path)) {
    return null;
  }
  try {
    const value = execFile(
      "/usr/bin/git",
      ["-C", repositoryDirectory, "rev-parse", "--verify", "--quiet", `${commit}:${path}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 },
    ).trim();
    return SHA.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** True only when `previous` is an ancestor of (or equal to) `candidate`; local git only. */
export function gitIsAncestor({ repositoryDirectory, previous, candidate, execFile = execFileSync } = {}) {
  if (typeof repositoryDirectory !== "string" || !SHA.test(previous ?? "") || !SHA.test(candidate ?? "")) {
    return false;
  }
  try {
    execFile(
      "/usr/bin/git",
      ["-C", repositoryDirectory, "merge-base", "--is-ancestor", previous, candidate],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * OD-E2: an --edge-mode deploy's source must descend from the live
 * DEPLOYMENT_SOURCE_COMMIT, so a worker-mode edge deploy can never replace
 * production's Worker with another line's.
 */
export function assertEdgeModeSourceDescends({ liveSourceCommit, sourceCommit, isAncestor } = {}) {
  if (!SHA.test(liveSourceCommit ?? "") || !SHA.test(sourceCommit ?? "")
      || typeof isAncestor !== "function" || isAncestor(liveSourceCommit, sourceCommit) !== true) {
    fail("EDGE_MODE_SOURCE_NOT_DESCENDANT");
  }
}

function secureJsonHeaders(response) {
  return response.headers?.get("content-type")?.split(";", 1)[0] === "application/json"
    && response.headers.get("cache-control") === "no-store"
    && response.headers.get("referrer-policy") === "no-referrer"
    && response.headers.get("x-content-type-options") === "nosniff";
}

async function boundedJson(response, maxBytes) {
  if (typeof response?.text !== "function") return null;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
    const value = JSON.parse(text);
    return object(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pre-gcp verifier: read the upstream origin's /api/health and /api/ready with
 * an identity token the operator obtained by impersonating a verifier account
 * (EP-6 admits it on exactly these paths). Both must answer 200, carry the
 * origin marker and the Worker's secure JSON headers; health must be status
 * "ok" with a deployment.sourceCommit, which is returned as originCommit, and
 * readiness status "ready". The token is held in memory for the two requests
 * and never returned, logged or put into a code.
 */
export async function verifyEdgeOriginBeforeGcp({
  upstreamOrigin,
  identityToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = EDGE_ORIGIN_VERIFIER_TIMEOUT_MS,
} = {}) {
  const failure = (code) => ({ ok: false, code, originCommit: null });
  if (canonicalRunAppOrigin(upstreamOrigin) !== upstreamOrigin
      || typeof identityToken !== "string" || !TOKEN.test(identityToken)
      || typeof fetchImpl !== "function") {
    return failure("EDGE_ORIGIN_VERIFIER_INPUT_INVALID");
  }
  let originCommit = null;
  for (const path of EDGE_ORIGIN_VERIFIER_PATHS) {
    const url = new URL(path, upstreamOrigin).href;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          [EDGE_HEADERS.invokerToken]: `Bearer ${identityToken}`,
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return failure("EDGE_ORIGIN_VERIFIER_UNREACHABLE");
    }
    if (response?.url !== url || response.status !== 200
        || response.headers?.get(EDGE_HEADERS.originMarker) !== EDGE_ORIGIN_MARKER_VALUE
        || !secureJsonHeaders(response)) {
      return failure("EDGE_ORIGIN_VERIFIER_INVALID");
    }
    const body = await boundedJson(response, EDGE_ORIGIN_VERIFIER_MAX_BYTES);
    if (body === null) return failure("EDGE_ORIGIN_VERIFIER_INVALID");
    if (path === "/api/health") {
      const sourceCommit = body.deployment?.sourceCommit;
      if (body.status !== "ok") return failure("EDGE_ORIGIN_VERIFIER_UNHEALTHY");
      if (typeof sourceCommit !== "string" || !SHA.test(sourceCommit)) {
        return failure("EDGE_ORIGIN_VERIFIER_SOURCE_MISSING");
      }
      originCommit = sourceCommit;
    } else if (body.status !== "ready") {
      return failure("EDGE_ORIGIN_VERIFIER_NOT_READY");
    }
  }
  return { ok: true, code: null, originCommit };
}

/** Names only a gcp deploy leaves on a version (EP-9 keeps them through gcp -> fenced). */
const GCP_ERA_BINDING_NAMES = Object.freeze([EDGE_MODE_RELEASE_GUARD_BINDING, ...Object.values(EDGE_MODE_GCP_VARS)]);

/**
 * Whether production has already served from the gcp origin: the live version
 * is gcp, or a fenced version that still carries the gcp-only bindings.
 */
export function edgeModeGcpEra({ snapshot, liveMode } = {}) {
  return liveMode === "gcp"
    || (Array.isArray(snapshot?.bindings)
      && snapshot.bindings.some((binding) => GCP_ERA_BINDING_NAMES.includes(binding?.name)));
}

/**
 * The privacy page rule. A gcp deploy's site must carry the gcp topology
 * marker in privacy.html, and the cutover (the first gcp deploy) must ship a
 * candidate site built from the source rather than the retained live site
 * (EDGE_PRIVACY_PAGE_NOT_CUTOVER). Before the cutover, worker and fenced
 * deploys refuse a site that carries the marker (EDGE_PRIVACY_PAGE_PREMATURE).
 * After it, a gcp -> fenced deploy keeps the accurate marked page.
 */
export async function assertEdgePrivacyPage({ mode, siteDirectory, candidateSite, gcpEra = false } = {}) {
  if (parseEdgeUpstreamMode(mode) === null || typeof siteDirectory !== "string"
      || typeof candidateSite !== "boolean" || typeof gcpEra !== "boolean") {
    return { ok: false, code: "EDGE_MODE_INPUT_INVALID" };
  }
  const path = join(siteDirectory, EDGE_PRIVACY_PAGE);
  let marked = false;
  let metadata = null;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code !== "ENOENT") return { ok: false, code: "EDGE_PRIVACY_PAGE_INVALID" };
  }
  if (metadata !== null) {
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > EDGE_PRIVACY_PAGE_MAX_BYTES) {
      return { ok: false, code: "EDGE_PRIVACY_PAGE_INVALID" };
    }
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return { ok: false, code: "EDGE_PRIVACY_PAGE_INVALID" };
    }
    marked = text.includes(EDGE_PRIVACY_TOPOLOGY_MARKER);
  }
  if (mode === "gcp") {
    return (candidateSite || gcpEra) && marked
      ? { ok: true, code: null }
      : { ok: false, code: "EDGE_PRIVACY_PAGE_NOT_CUTOVER" };
  }
  return marked && !gcpEra ? { ok: false, code: "EDGE_PRIVACY_PAGE_PREMATURE" } : { ok: true, code: null };
}

function createEdgeModePin({ mode, liveMode, overlaySha256, expected, contractBlobSha, originCommit }) {
  return Object.freeze({
    schema: PRODUCTION_EDGE_MODE_PIN_SCHEMA,
    mode,
    liveMode,
    overlaySha256,
    expectedLiveConfigurationFingerprint: expected.fingerprint,
    contractBlobSha,
    originCommit,
  });
}

const PIN_KEYS = Object.freeze([
  "contractBlobSha",
  "expectedLiveConfigurationFingerprint",
  "liveMode",
  "mode",
  "originCommit",
  "overlaySha256",
  "schema",
]);

/** The closed shape of the edge pin a typed operation journal carries. */
export function validateEdgeModePin(pin) {
  if (!object(pin) || Object.keys(pin).sort().join(",") !== PIN_KEYS.join(",")
      || pin.schema !== PRODUCTION_EDGE_MODE_PIN_SCHEMA
      || parseEdgeUpstreamMode(pin.mode) === null
      || !(pin.liveMode === null || parseEdgeUpstreamMode(pin.liveMode) !== null)
      || !SHA256.test(pin.overlaySha256 ?? "")
      || !SHA256.test(pin.expectedLiveConfigurationFingerprint ?? "")
      || !SHA.test(pin.contractBlobSha ?? "")
      || (pin.mode === "gcp" ? !SHA.test(pin.originCommit ?? "") : pin.originCommit !== null)
      || !EDGE_MODE_TRANSITIONS.some((entry) => entry.from === pin.liveMode && entry.to === pin.mode)) {
    fail("EDGE_MODE_PIN_INVALID");
  }
  return pin;
}

function singleVersionDeployment(snapshot) {
  // The typed provider's capture() refuses a split deployment
  // (PRODUCTION_LIVE_DEPLOYMENT_AMBIGUOUS) and reads the single active version
  // before and after the inventory, so a captured snapshot is that version.
  return { versions: [{ version_id: snapshot?.versionId, percentage: 100 }] };
}

/** Post-deploy edge identity of a captured snapshot (EP-9's live check). */
export function verifyEdgeModeDeployedSnapshot({ snapshot, mode, sourceCommit } = {}) {
  return verifyEdgeModeLiveSnapshot({
    snapshot,
    mode,
    deployment: singleVersionDeployment(snapshot),
    sourceCommit,
  });
}

async function readTrackedConfig(workerDirectory) {
  let text;
  try {
    text = await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8");
  } catch {
    return fail("EDGE_MODE_CONFIG_INVALID");
  }
  const errors = [];
  const config = parse(text, errors);
  if (errors.length > 0 || !object(config)) fail("EDGE_MODE_CONFIG_INVALID");
  return config;
}

function defaultBlobReader(workerDirectory) {
  return (commit, path) => readGitBlob({ repositoryDirectory: workerDirectory, commit, path });
}

function defaultAncestorCheck(workerDirectory) {
  return (previous, candidate) => gitIsAncestor({ repositoryDirectory: workerDirectory, previous, candidate });
}

/**
 * Every pre-upload edge gate of a typed deploy, run before the operation
 * journal is opened. `inventory` is the owner-private typed baseline; the
 * returned pin and receipt are content-free.
 */
export async function prepareEdgeModeDeployment({
  edgeMode,
  edgePlan,
  originCommit,
  inventory,
  baseConfigTools,
  inspectTyped,
  workerDirectory,
  sourceCommit,
  expectedPreviousSourceCommit,
  candidatePublicManifestSha256 = null,
  edgeHistory,
  obtainOriginIdentityToken,
  fetchImpl = globalThis.fetch,
  readBlob = defaultBlobReader(workerDirectory),
  isAncestor = defaultAncestorCheck(workerDirectory),
  verifyOrigin = verifyEdgeOriginBeforeGcp,
} = {}) {
  try {
    const { mode, plan, overlaySha256 } = resolveEdgeModeRequest({ edgeMode, edgePlan });
    if (mode !== "gcp" && (originCommit !== undefined || obtainOriginIdentityToken !== undefined)) {
      fail("EDGE_MODE_INPUT_INVALID");
    }
    if (typeof workerDirectory !== "string" || !SHA.test(sourceCommit ?? "")
        || typeof readBlob !== "function" || typeof isAncestor !== "function") {
      fail("EDGE_MODE_INPUT_INVALID");
    }
    const trackedConfig = await readTrackedConfig(workerDirectory);
    const baseline = baseConfigTools.createSnapshot(inventory);
    if (baseline?.sourceCommit !== expectedPreviousSourceCommit) fail("PRODUCTION_TYPED_PREDECESSOR_MISMATCH");
    const liveMode = liveEdgeMode(baseline);
    const gcpEra = edgeModeGcpEra({ snapshot: baseline, liveMode });

    const transition = EDGE_MODE_TRANSITIONS.find((entry) => entry.from === liveMode && entry.to === mode);
    let gcpEverDeployedSinceFence;
    if (transition?.requiresNoGcpSinceFence && typeof edgeHistory === "function") {
      const history = await edgeHistory();
      gcpEverDeployedSinceFence = gcpDeployedSinceFence({
        deployments: history?.deployments,
        fenceDeploymentId: history?.fenceDeploymentId,
      });
    }
    assertEdgeModeTransition({ liveMode, targetMode: mode, gcpEverDeployedSinceFence });
    assertEdgeModeSourceDescends({ liveSourceCommit: baseline.sourceCommit, sourceCommit, isAncestor });
    if (readBlob(sourceCommit, EDGE_ENTRY_PATH) === null) fail("EDGE_MODE_ENTRY_UNAVAILABLE");
    const contractBlobSha = readBlob(sourceCommit, EDGE_ORIGIN_CONTRACT_PATH);
    if (contractBlobSha === null) fail("EDGE_CONTRACT_UNAVAILABLE");

    // EP-9's delta repeats the history-free transition and, for gcp, refuses
    // an unknown live storage binding, a missing edge secret
    // (EDGE_MODE_SECRET_MISSING), a missing SPARKLE_RELEASES or a guard D1
    // that is another database.
    const expected = applyEdgeModeSnapshotDelta({ snapshot: baseline, mode, plan, trackedConfig });

    let verifiedOriginCommit = null;
    if (mode === "gcp") {
      if (candidatePublicManifestSha256 === null && !gcpEra) fail("EDGE_PRIVACY_PAGE_NOT_CUTOVER");
      assertEdgeAdmissionBindings(baseline);
      if (!SHA.test(originCommit ?? "")) fail("EDGE_ORIGIN_COMMIT_REQUIRED");
      if (typeof obtainOriginIdentityToken !== "function") fail("EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
      let identityToken;
      try {
        identityToken = await obtainOriginIdentityToken();
      } catch {
        fail("EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
      }
      const verification = await verifyOrigin({ upstreamOrigin: plan.upstreamOrigin, identityToken, fetchImpl });
      identityToken = null;
      if (verification?.ok !== true) fail(edgeCode(verification, "EDGE_ORIGIN_VERIFIER_FAILED"));
      if (verification.originCommit !== originCommit) fail("EDGE_ORIGIN_COMMIT_MISMATCH");
      if (readBlob(originCommit, EDGE_ORIGIN_CONTRACT_PATH) !== contractBlobSha) fail("EDGE_CONTRACT_DRIFT");
      verifiedOriginCommit = originCommit;
    }

    const configTools = createEdgeModeConfigTools({ mode, plan, trackedConfig, base: baseConfigTools });
    const pin = createEdgeModePin({
      mode, liveMode, overlaySha256, expected, contractBlobSha, originCommit: verifiedOriginCommit,
    });
    return {
      ok: true,
      code: null,
      mode,
      liveMode,
      gcpEra,
      identity: edgeModeIdentity(liveMode, mode),
      originCommit: verifiedOriginCommit,
      baseline,
      expected,
      pin,
      receipt: Object.freeze({
        edgeMode: mode,
        liveMode,
        edgeOverlaySha256: overlaySha256,
        contractBlobSha,
        originCommit: verifiedOriginCommit,
      }),
      configTools,
      inspectTyped: edgeModeTypedInspector({ mode, inspectTyped }),
    };
  } catch (error) {
    return { ok: false, code: edgeCode(error, "EDGE_MODE_PREPARATION_FAILED") };
  }
}

/**
 * Bind the edge pin to the typed preparation the deploy made from its source
 * snapshot: the expected post-deploy snapshot of the re-captured baseline must
 * be the pinned one, and the snapshot's candidate site must satisfy the
 * privacy-page rule. Returns the prepared typed deployment with an `edge`
 * member that revalidateTypedProductionDeployment uses after Wrangler.
 */
export async function bindEdgeModePreparation({ edge, prepared, siteDirectory, candidateSite } = {}) {
  let expectedAfter;
  try {
    expectedAfter = edge.configTools.expectedSnapshot(prepared.current);
  } catch (error) {
    return { ok: false, code: edgeCode(error, "EDGE_MODE_PIN_MISMATCH") };
  }
  if (expectedAfter.fingerprint !== edge.pin.expectedLiveConfigurationFingerprint) {
    return { ok: false, code: "EDGE_MODE_PIN_MISMATCH" };
  }
  const page = await assertEdgePrivacyPage({ mode: edge.mode, siteDirectory, candidateSite, gcpEra: edge.gcpEra });
  if (!page.ok) return page;
  const { mode } = edge;
  return {
    ok: true,
    prepared: {
      ...prepared,
      edge: Object.freeze({
        mode,
        expectedAfter,
        verifyLive: ({ snapshot, sourceCommit }) => verifyEdgeModeDeployedSnapshot({ snapshot, mode, sourceCommit }),
      }),
    },
  };
}

/**
 * The edge pin of a typed operation, re-bound for reconciliation. gcp needs
 * the same plan the deploy pinned (EDGE_MODE_PLAN_REQUIRED without one,
 * EDGE_MODE_PLAN_MISMATCH for another); a plan for an operation without an
 * edge pin is refused.
 */
export function resolvePinnedEdgeMode({ pin, edgePlan } = {}) {
  if (pin?.edge === undefined) {
    if (edgePlan !== undefined) fail("EDGE_MODE_INPUT_INVALID");
    return null;
  }
  const edge = validateEdgeModePin(pin.edge);
  if (edge.mode === "gcp" && (edgePlan === undefined || edgePlan === null)) fail("EDGE_MODE_PLAN_REQUIRED");
  const plan = normalizeEdgeModePlan({ mode: edge.mode, plan: edgePlan });
  if (edgeModeOverlaySha256({ mode: edge.mode, plan }) !== edge.overlaySha256) fail("EDGE_MODE_PLAN_MISMATCH");
  return Object.freeze({
    mode: edge.mode,
    liveMode: edge.liveMode,
    plan,
    identity: edgeModeIdentity(edge.liveMode, edge.mode),
    originCommit: edge.originCommit,
    contractBlobSha: edge.contractBlobSha,
    expectedLiveConfigurationFingerprint: edge.expectedLiveConfigurationFingerprint,
  });
}

/**
 * Reconciliation repeats the local contract rule: the blob pinned for the
 * edge source must still be the source's, and for gcp the pinned origin
 * commit's.
 */
export function assertPinnedEdgeContract({ edge, sourceCommit, readBlob } = {}) {
  if (typeof readBlob !== "function" || readBlob(sourceCommit, EDGE_ORIGIN_CONTRACT_PATH) !== edge.contractBlobSha) {
    fail("EDGE_CONTRACT_DRIFT");
  }
  if (edge.mode === "gcp" && readBlob(edge.originCommit, EDGE_ORIGIN_CONTRACT_PATH) !== edge.contractBlobSha) {
    fail("EDGE_CONTRACT_DRIFT");
  }
}

export function defaultEdgeModeBlobReader(workerDirectory) {
  return defaultBlobReader(workerDirectory);
}

/**
 * Read an owner-private edge plan file (0600, owner, single link, at most
 * 64 KiB). The plan names the origin, audience, invoker and guard D1; it is
 * pinned only by its overlay sha256 and never printed.
 */
export async function readEdgeModePlan(path) {
  let bytes;
  try {
    bytes = await readMaintenanceFile(path, 64 * 1024);
  } catch {
    return fail("EDGE_MODE_PLAN_UNREADABLE");
  }
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!object(value)) fail("EDGE_MODE_PLAN_INVALID");
    return value;
  } catch (error) {
    return fail(edgeCode(error, "EDGE_MODE_PLAN_INVALID"));
  }
}

/**
 * The CLI's verifier token source: `gcloud auth print-identity-token`
 * impersonating a verifier service account for the plan's audience. The
 * token stays in memory; gcloud's stderr is never read back.
 */
export function createGcloudIdentityTokenSource({ verifierAccount, audience, execFile = execFileSync } = {}) {
  if (!isEdgeServiceAccountEmail(verifierAccount) || !isEdgeOriginAudience(audience)) {
    fail("EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
  }
  return async () => {
    let token;
    try {
      token = String(execFile(
        "gcloud",
        [
          "auth",
          "print-identity-token",
          `--impersonate-service-account=${verifierAccount}`,
          `--audiences=${audience}`,
          "--include-email",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, maxBuffer: 64 * 1024 },
      )).trim();
    } catch {
      return fail("EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
    }
    if (!TOKEN.test(token)) fail("EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE");
    return token;
  };
}

/**
 * The CLI's history source for fenced -> worker: the EP-8 fence receipt (read
 * and verified by the fence tool's own reader, which refuses a released
 * fence) names the fenced deployment, and the read-only history reader walks
 * the live deployments back to it.
 */
export function createFenceHistorySource({
  receiptPath,
  receiptSha256,
  accountId,
  workerName,
  readFenceReceipt = null,
  createReader = createProductionDeploymentHistoryReader,
} = {}) {
  return async () => {
    let receipt;
    try {
      const read = readFenceReceipt
        ?? (await import("./cloudflare-writer-fence.mjs")).readCloudflareWriterFenceReceipt;
      receipt = await read(receiptPath, receiptSha256);
    } catch {
      return fail("EDGE_MODE_FENCE_RECEIPT_INVALID");
    }
    const fenceDeploymentId = receipt?.productionWorker?.deploymentId;
    const read = createReader({ accountId, workerName });
    return { fenceDeploymentId, deployments: await read(fenceDeploymentId) };
  };
}

function versionMode(version, versionId) {
  const bindings = version?.resources?.bindings;
  if (!object(version) || version.id !== versionId || !Array.isArray(bindings) || bindings.length > 512) {
    fail("EDGE_MODE_HISTORY_INVALID");
  }
  const binding = bindings.find((entry) => entry?.name === EDGE_MODE_VAR);
  if (binding === undefined) return null;
  if (binding.type !== "plain_text") return "invalid";
  return parseEdgeUpstreamMode(binding.text) ?? "invalid";
}

/**
 * Read-only production deployment history for the fenced -> worker gate:
 * deployments newest first, walked back to the fenced deployment, each with
 * the EDGE_UPSTREAM_MODE of its versions. Fixed account and Worker, GET only,
 * bounded reads; the token never enters a result or error.
 */
export function createProductionDeploymentHistoryReader({
  accountId,
  workerName,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  maxDeployments = EDGE_MODE_HISTORY_MAX_DEPLOYMENTS,
} = {}) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !/^[A-Za-z0-9_-]{1,63}$/u.test(workerName ?? "")) {
    fail("EDGE_MODE_HISTORY_INPUT_INVALID");
  }
  if (["CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL", "WRANGLER_API_ENVIRONMENT", "CLOUDFLARE_ENV"]
    .some((key) => Object.hasOwn(environment, key))) {
    fail("EDGE_MODE_HISTORY_ENVIRONMENT_OVERRIDE");
  }
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || token.length < 16) fail("EDGE_MODE_HISTORY_CREDENTIAL_REQUIRED");
  const script = `/accounts/${accountId}/workers/scripts/${workerName}`;
  const budget = 1 + 2 * maxDeployments;
  let requests = 0;
  const get = async (path) => {
    if (++requests > budget) fail("EDGE_MODE_HISTORY_READ_BUDGET");
    let body;
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 2_000_000) fail("EDGE_MODE_HISTORY_INVALID");
      body = JSON.parse(text);
      if (!response.ok || body?.success !== true) fail("EDGE_MODE_HISTORY_READ_REFUSED");
    } catch (error) {
      fail(edgeCode(error, "EDGE_MODE_HISTORY_READ_FAILED"));
    }
    return body.result;
  };
  return async (fenceDeploymentId) => {
    if (typeof fenceDeploymentId !== "string" || !OPAQUE.test(fenceDeploymentId)) {
      fail("EDGE_MODE_FENCE_HISTORY_INCOMPLETE");
    }
    const listed = await get(`${script}/deployments`);
    const rows = Array.isArray(listed) ? listed : listed?.deployments;
    if (!Array.isArray(rows) || rows.length > 100) fail("EDGE_MODE_HISTORY_INVALID");
    const index = rows.findIndex((row) => row?.id === fenceDeploymentId);
    if (index < 0 || index >= maxDeployments) fail("EDGE_MODE_FENCE_HISTORY_INCOMPLETE");
    const modes = new Map();
    const deployments = [];
    for (const row of rows.slice(0, index + 1)) {
      if (!object(row) || !OPAQUE.test(row.id ?? "") || !Array.isArray(row.versions)
          || row.versions.length < 1 || row.versions.length > 2) {
        fail("EDGE_MODE_HISTORY_INVALID");
      }
      const versionModes = [];
      for (const version of row.versions) {
        const versionId = version?.version_id;
        if (!UUID.test(versionId ?? "")) fail("EDGE_MODE_HISTORY_INVALID");
        if (!modes.has(versionId)) modes.set(versionId, versionMode(await get(`${script}/versions/${versionId}`), versionId));
        versionModes.push(modes.get(versionId));
      }
      deployments.push({ deploymentId: row.id, modes: versionModes });
    }
    return deployments;
  };
}
