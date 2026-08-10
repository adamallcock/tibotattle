import { createHash } from "node:crypto";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../../../config/deployment-endpoints.js";
import {
  getReleaseChannel,
  STABLE_RELEASE_CHANNEL,
} from "../../../config/release-channels.js";
import {
  checkDeploymentEndpointConsumers,
} from "./check-deployment-endpoints.mjs";
import {
  fetchBoundedMacOSPreviewHTTPS,
  MACOS_PREVIEW_REMOTE_CODES,
  validateSparkleAppcastXML,
} from "../../../scripts/verify-macos-preview-remote.js";

export const RELEASE_READINESS_SCHEMA_VERSION =
  "tibotattle-release-readiness-v0.1";
export const OBSERVATION_CHANNEL = "production_containment_observer";
export const DEFAULT_RELEASE_CHANNEL = STABLE_RELEASE_CHANNEL;
export const REMOTE_CONTAINMENT_OBSERVED_STATUS =
  "remote_containment_observed";
export const EXPECTED_ENROLLMENT_MODE = "disabled";
export const DEFAULT_RELEASE_PROBE_TIMEOUT_MS = 5_000;
export const MAX_RELEASE_PROBE_TIMEOUT_MS = 30_000;

const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
});

const KNOWN_ENROLLMENT_MODES = new Set([
  "local_open",
  "open",
  "invite_only",
  "disabled",
]);
const KNOWN_COLLECTION_STATES = new Set([
  "operational",
  "degraded",
  "contained",
]);

function canonicalManifestSnapshot(endpoints) {
  return {
    public: {
      origin: endpoints.public.origin,
      routeHosts: [...endpoints.public.routeHosts],
    },
    schemaVersion: endpoints.schemaVersion,
    sparkle: {
      appcastURL: endpoints.sparkle.appcastURL,
      origin: endpoints.sparkle.origin,
      r2Bucket: endpoints.sparkle.r2Bucket,
    },
  };
}

const CANONICAL_MANIFEST_SNAPSHOT = canonicalManifestSnapshot(
  DEPLOYMENT_ENDPOINTS,
);
const CANONICAL_MANIFEST_SERIALIZED = JSON.stringify(
  CANONICAL_MANIFEST_SNAPSHOT,
);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameSerializedValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function knownEnrollmentMode(value) {
  return KNOWN_ENROLLMENT_MODES.has(value) ? value : "unknown";
}

function knownCollectionState(value) {
  return KNOWN_COLLECTION_STATES.has(value) ? value : "unknown";
}

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value)
      || value < 1
      || value > MAX_RELEASE_PROBE_TIMEOUT_MS) {
    throw new TypeError(
      `timeout must be an integer from 1 to ${MAX_RELEASE_PROBE_TIMEOUT_MS}`,
    );
  }
  return value;
}

function timestamp(clock) {
  const value = new Date(clock.now());
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("clock returned an invalid timestamp");
  }
  return value.toISOString();
}

function manifestReceipt(manifest) {
  if (!manifest.ok) {
    return {
      checked: true,
      status: "invalid",
      code: manifest.code ?? "ENDPOINT_MANIFEST_INVALID",
      schemaVersion: null,
      sha256: null,
      publicOrigin: null,
      appcastURL: null,
      routeHosts: [],
    };
  }
  return {
    checked: true,
    status: "matched",
    code: null,
    schemaVersion: manifest.schemaVersion,
    sha256: manifest.sha256,
    publicOrigin: manifest.publicOrigin,
    appcastURL: manifest.appcastURL,
    routeHosts: [...manifest.routeHosts],
  };
}

function channelPolicyReceipt(channel) {
  return {
    schemaVersion: channel.schemaVersion,
    name: channel.name,
    configured: channel.configured,
    buildManifestChannel: channel.buildManifestChannel,
    serviceOriginMode: channel.serviceOriginMode,
    serviceOrigin: channel.serviceOrigin,
    publicWebsiteOrigin: channel.publicWebsiteOrigin,
    sparkle: {
      origin: channel.sparkle.origin,
      appcastURL: channel.sparkle.appcastURL,
      appcastObjectKey: channel.sparkle.appcastObjectKey,
      r2Bucket: channel.sparkle.r2Bucket,
      objectPrefix: channel.sparkle.objectPrefix,
      publicEdKeySha256: channel.sparkle.publicEdKeySha256,
    },
  };
}

function unconfiguredManifestReceipt() {
  return {
    checked: true,
    status: "not_configured",
    code: "RELEASE_CHANNEL_NOT_CONFIGURED",
    schemaVersion: null,
    sha256: null,
    publicOrigin: null,
    appcastURL: null,
    routeHosts: [],
  };
}

function channelPolicyManifestReceipt(channel) {
  return {
    checked: true,
    status: "matched",
    code: null,
    schemaVersion: channel.schemaVersion,
    sha256: null,
    publicOrigin: channel.serviceOrigin,
    appcastURL: channel.sparkle.appcastURL,
    routeHosts: [],
  };
}

export function validateCanonicalEndpointManifest(
  endpoints = DEPLOYMENT_ENDPOINTS,
) {
  try {
    assertDeploymentEndpoints(endpoints);
    const snapshot = canonicalManifestSnapshot(endpoints);
    if (!sameSerializedValue(snapshot, CANONICAL_MANIFEST_SNAPSHOT)) {
      return Object.freeze({
        ok: false,
        code: "ENDPOINT_MANIFEST_DRIFT",
      });
    }
    return Object.freeze({
      ok: true,
      code: null,
      schemaVersion: snapshot.schemaVersion,
      sha256: sha256(CANONICAL_MANIFEST_SERIALIZED),
      publicOrigin: snapshot.public.origin,
      appcastURL: snapshot.sparkle.appcastURL,
      routeHosts: Object.freeze([...snapshot.public.routeHosts]),
    });
  } catch {
    return Object.freeze({
      ok: false,
      code: "ENDPOINT_MANIFEST_INVALID",
    });
  }
}

function deploymentDriftReceipt({ checked, status, code = null }) {
  return {
    checked,
    status,
    code,
  };
}

function notCheckedEndpoint() {
  return {
    checked: false,
    status: "not_checked",
    code: "PUBLIC_PROBE_NOT_REQUESTED",
    httpStatus: null,
  };
}

function requestFailure(error, prefix) {
  const remoteCode = error?.code;
  const code = remoteCode === MACOS_PREVIEW_REMOTE_CODES.TIMEOUT
    ? `${prefix}_TIMEOUT`
    : remoteCode === MACOS_PREVIEW_REMOTE_CODES.FETCH_REDIRECT
      ? `${prefix}_REDIRECT`
      : `${prefix}_UNAVAILABLE`;
  return {
    checked: true,
    status: "unavailable",
    code,
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
  };
}

function isContentType(contentType, expected) {
  return typeof contentType === "string"
    && contentType.split(";", 1)[0].trim().toLowerCase() === expected;
}

function parseHealthBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function containedHealthChecks(body) {
  const controls = body?.collectionControls;
  return {
    serviceOk: body?.status === "ok",
    enrollmentDisabled: body?.enrollmentMode === EXPECTED_ENROLLMENT_MODE
      && controls?.enrollment === false,
    collectionContained: controls?.state === "contained"
      && controls?.enrollment === false
      && controls?.uploadRegistration === false
      && controls?.processing === false
      && controls?.publication === false,
    externalParticipantsUnauthorized:
      body?.contracts?.accountScopedContribution
        ?.externalParticipantsAuthorized === false,
  };
}

async function checkHealth({
  publicOrigin,
  clock,
  fetchImpl,
  timeoutMs,
}) {
  let response;
  try {
    response = await fetchBoundedMacOSPreviewHTTPS(
      new URL("/api/health", publicOrigin).href,
      {
        accept: "application/json",
        clock,
        fetchImpl,
        maximumBytes: 64 * 1024,
        timeoutMs,
      },
    );
  } catch (error) {
    return requestFailure(error, "HEALTH");
  }
  if (response.status !== 200) {
    return {
      checked: true,
      status: "unavailable",
      code: "HEALTH_HTTP_STATUS",
      httpStatus: response.status,
    };
  }
  if (!isContentType(response.contentType, "application/json")) {
    return {
      checked: true,
      status: "unavailable",
      code: "HEALTH_CONTENT_TYPE_INVALID",
      httpStatus: response.status,
    };
  }
  const body = parseHealthBody(response.body);
  const checks = containedHealthChecks(body);
  const driftCodes = [];
  if (body?.enrollmentMode !== EXPECTED_ENROLLMENT_MODE) {
    driftCodes.push("DEPLOYED_ENROLLMENT_MODE_DRIFT");
  }
  if (!checks.collectionContained) {
    driftCodes.push("DEPLOYED_COLLECTION_CONTROLS_DRIFT");
  }
  if (!checks.externalParticipantsUnauthorized) {
    driftCodes.push("DEPLOYED_EXTERNAL_PARTICIPATION_DRIFT");
  }
  if (!body || !checks.serviceOk) {
    return {
      checked: true,
      status: "unavailable",
      code: "HEALTH_BODY_INVALID",
      httpStatus: response.status,
      enrollmentMode: knownEnrollmentMode(body?.enrollmentMode),
      collectionState: knownCollectionState(body?.collectionControls?.state),
      checks,
    };
  }
  if (driftCodes.length > 0) {
    return {
      checked: true,
      status: "drift",
      code: driftCodes[0],
      codes: Object.freeze(driftCodes),
      httpStatus: response.status,
      enrollmentMode: knownEnrollmentMode(body.enrollmentMode),
      collectionState: knownCollectionState(body.collectionControls?.state),
      checks,
    };
  }
  return {
    checked: true,
    status: "pass",
    code: null,
    codes: Object.freeze([]),
    httpStatus: response.status,
    enrollmentMode: EXPECTED_ENROLLMENT_MODE,
    collectionState: "contained",
    checks,
  };
}

function validReadyBody(body, status) {
  return [200, 503].includes(status)
    && body?.status === (status === 200 ? "ready" : "not_ready")
    && typeof body?.checks === "object"
    && body.checks !== null
    && typeof body.checks.lifecycleFresh === "boolean"
    && typeof body.checks.quarantineRetentionComplete === "boolean"
    && typeof body.checks.restoreReplayComplete === "boolean"
    && typeof body.checks.aggregateRebuildComplete === "boolean"
    && typeof body.checks.maintenanceCycleMatched === "boolean"
    && typeof body.checks.quarantineReconciliationComplete === "boolean"
    && body?.policy?.lifecycleStaleAfterMilliseconds
      === 2 * 60 * 60 * 1000;
}

async function checkReady({
  publicOrigin,
  clock,
  fetchImpl,
  timeoutMs,
}) {
  let response;
  try {
    response = await fetchBoundedMacOSPreviewHTTPS(
      new URL("/api/ready", publicOrigin).href,
      {
        accept: "application/json",
        clock,
        fetchImpl,
        maximumBytes: 64 * 1024,
        timeoutMs,
      },
    );
  } catch (error) {
    return requestFailure(error, "READY");
  }
  if (![200, 503].includes(response.status)) {
    return {
      checked: true,
      status: "unavailable",
      code: "READY_HTTP_STATUS",
      httpStatus: response.status,
    };
  }
  if (!isContentType(response.contentType, "application/json")) {
    return {
      checked: true,
      status: "unavailable",
      code: "READY_CONTENT_TYPE_INVALID",
      httpStatus: response.status,
    };
  }
  const body = parseHealthBody(response.body);
  if (!validReadyBody(body, response.status)) {
    return {
      checked: true,
      status: "unavailable",
      code: "READY_BODY_INVALID",
      httpStatus: response.status,
    };
  }
  if (response.status === 503) {
    return {
      checked: true,
      status: "not_ready",
      code: "READY_NOT_READY",
      httpStatus: response.status,
    };
  }
  return {
    checked: true,
    status: "pass",
    code: null,
    httpStatus: response.status,
  };
}

async function checkAppcast({
  appcastURL,
  clock,
  fetchImpl,
  timeoutMs,
}) {
  let response;
  try {
    response = await fetchBoundedMacOSPreviewHTTPS(appcastURL, {
      accept: "application/rss+xml, application/xml, text/xml;q=0.9",
      clock,
      fetchImpl,
      maximumBytes: 1024 * 1024,
      timeoutMs,
    });
  } catch (error) {
    return requestFailure(error, "APPCAST");
  }
  if (response.status === 404 || response.status === 410) {
    return {
      checked: true,
      status: "not_published",
      code: "APPCAST_NOT_PUBLISHED",
      httpStatus: response.status,
    };
  }
  if (response.status !== 200) {
    return {
      checked: true,
      status: "unavailable",
      code: "APPCAST_HTTP_STATUS",
      httpStatus: response.status,
    };
  }
  if (!isContentType(response.contentType, "application/rss+xml")
      && !isContentType(response.contentType, "application/xml")
      && !isContentType(response.contentType, "text/xml")) {
    return {
      checked: true,
      status: "invalid",
      code: "APPCAST_CONTENT_TYPE_INVALID",
      httpStatus: response.status,
    };
  }
  const structure = validateSparkleAppcastXML(response.body);
  if (!structure.valid) {
    return {
      checked: true,
      status: "invalid",
      code: "APPCAST_BODY_INVALID",
      httpStatus: response.status,
    };
  }
  return {
    checked: true,
    status: "pass",
    code: null,
    httpStatus: response.status,
    bytes: Buffer.byteLength(response.body, "utf8"),
    sha256: sha256(response.body),
    structure: {
      channelCount: structure.channelCount,
      enclosureCount: structure.enclosureCount,
      itemCount: structure.itemCount,
    },
  };
}

function publicReceipt(publicChecks, requested) {
  return {
    requested,
    health: publicChecks.health,
    ready: publicChecks.ready,
    appcast: publicChecks.appcast,
  };
}

function endpointCodes(endpoint) {
  return Array.isArray(endpoint?.codes) && endpoint.codes.length > 0
    ? endpoint.codes
    : endpoint?.code ? [endpoint.code] : [];
}

function unique(values) {
  return [...new Set(values)];
}

function observationEvidence({ status, configured, probePublic }) {
  const remoteContainment = !configured
    ? "not_configured"
    : !probePublic
      ? "not_checked"
      : status === REMOTE_CONTAINMENT_OBSERVED_STATUS
        ? "observed"
        : "not_observed";
  return {
    scope: "remote_containment",
    remoteContainment,
    signedUpdate: "not_proven",
    nativeClientRehearsal: "not_run",
  };
}

export async function verifyReleaseReadiness({
  channel = DEFAULT_RELEASE_CHANNEL,
  endpoints = DEPLOYMENT_ENDPOINTS,
  probePublic = false,
  endpointConsumerCheck = checkDeploymentEndpointConsumers,
  fetchImpl = globalThis.fetch,
  clock = DEFAULT_CLOCK,
  timeoutMs = DEFAULT_RELEASE_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof probePublic !== "boolean") {
    throw new TypeError("probePublic must be a boolean");
  }
  const boundedTimeout = normalizeTimeout(timeoutMs);
  const selectedChannel = getReleaseChannel(channel);
  const blockers = [];
  const deployment = deploymentDriftReceipt({
    checked: false,
    status: "not_checked",
    code: "DEPLOYMENT_DRIFT_NOT_CHECKED",
  });
  let publicChecks = {
    health: notCheckedEndpoint(),
    ready: notCheckedEndpoint(),
    appcast: notCheckedEndpoint(),
  };
  let endpointManifest;
  let manifestIsUsable = false;
  let publicOrigin = null;
  let appcastURL = null;

  if (!selectedChannel.configured) {
    endpointManifest = unconfiguredManifestReceipt();
    deployment.code = "RELEASE_CHANNEL_NOT_CONFIGURED";
    blockers.push("RELEASE_CHANNEL_NOT_CONFIGURED");
  } else if (selectedChannel.name === STABLE_RELEASE_CHANNEL) {
    // The stable observer is bound to the reviewed production manifest. An
    // injected object is accepted only as a drift-test input and is never
    // used for consumer checks or network requests.
    const suppliedManifest = validateCanonicalEndpointManifest(endpoints);
    endpointManifest = manifestReceipt(suppliedManifest);
    manifestIsUsable = suppliedManifest.ok;
    publicOrigin = DEPLOYMENT_ENDPOINTS.public.origin;
    appcastURL = DEPLOYMENT_ENDPOINTS.sparkle.appcastURL;
    if (!suppliedManifest.ok) blockers.push(suppliedManifest.code);
  } else {
    endpointManifest = channelPolicyManifestReceipt(selectedChannel);
    manifestIsUsable = true;
    publicOrigin = selectedChannel.serviceOrigin;
    appcastURL = selectedChannel.sparkle.appcastURL;
    if (endpoints !== DEPLOYMENT_ENDPOINTS) {
      blockers.push("RELEASE_CHANNEL_ENDPOINT_OVERRIDE_REJECTED");
    }
    deployment.status = "not_applicable";
    deployment.code = "CHANNEL_LOCAL_DEPLOYMENT_MANIFEST_NOT_CHECKED";
  }

  if (manifestIsUsable && selectedChannel.name === STABLE_RELEASE_CHANNEL) {
    try {
      if (typeof endpointConsumerCheck !== "function") {
        throw new TypeError("endpoint consumer checker unavailable");
      }
      await endpointConsumerCheck({ endpoints: DEPLOYMENT_ENDPOINTS });
      deployment.checked = true;
      deployment.status = "no_drift";
      deployment.code = null;
    } catch {
      deployment.checked = true;
      deployment.status = "drift";
      deployment.code = "DEPLOYMENT_ENDPOINT_DRIFT";
      blockers.push(deployment.code);
    }
  }

  if (!probePublic) {
    blockers.push("PUBLIC_PROBE_NOT_REQUESTED");
  } else if (manifestIsUsable && blockers.length === 0) {
    const requestOptions = {
      clock,
      fetchImpl,
      timeoutMs: boundedTimeout,
    };
    publicChecks = {
      health: await checkHealth({
        publicOrigin,
        ...requestOptions,
      }),
      ready: await checkReady({
        publicOrigin,
        ...requestOptions,
      }),
      appcast: await checkAppcast({
        appcastURL,
        ...requestOptions,
      }),
    };
    for (const endpoint of Object.values(publicChecks)) {
      if (endpoint.status !== "pass") {
        blockers.push(...endpointCodes(endpoint));
      }
    }
  }

  const uniqueBlockers = unique(blockers.filter(Boolean));
  const status = !selectedChannel.configured
    || !manifestIsUsable
    || deployment.status === "drift"
    ? "blocked"
    : !probePublic
      ? "public_unchecked"
      : uniqueBlockers.length === 0
        ? REMOTE_CONTAINMENT_OBSERVED_STATUS
        : "not_ready";
  return Object.freeze({
    schemaVersion: RELEASE_READINESS_SCHEMA_VERSION,
    operation: "production_containment_observation",
    channel: selectedChannel.name,
    observationChannel: OBSERVATION_CHANNEL,
    channelPolicy: channelPolicyReceipt(selectedChannel),
    generatedAt: timestamp(clock),
    endpointManifest,
    deploymentDrift: deployment,
    expected: {
      enrollmentMode: EXPECTED_ENROLLMENT_MODE,
      collectionControls: "contained",
      externalParticipantsAuthorized: false,
    },
    public: publicReceipt(publicChecks, probePublic),
    status,
    // This observer never proves a release is ready. The nested public.ready
    // receipt is only the remote endpoint's own readiness response.
    ready: false,
    releaseReady: false,
    evidence: observationEvidence({
      status,
      configured: selectedChannel.configured,
      probePublic,
    }),
    collectionAuthorized: false,
    blockers: Object.freeze(uniqueBlockers),
  });
}
