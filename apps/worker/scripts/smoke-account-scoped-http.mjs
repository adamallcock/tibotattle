import { createHash } from "node:crypto";
import {
  createTelemetryEnvelope,
  validateAccountScopedTelemetryContribution,
} from "../../web/public/lib.js";

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:"
      || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Account-scoped smoke accepts only a loopback HTTP origin.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

const origin = loopbackOrigin(
  optionValue("--origin", "http://127.0.0.1:8794"),
);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
let cookie = "";
let csrfToken = "";
let participantId = "";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function opaque(kind, value) {
  const version = kind === "event" || kind === "snapshot" ? "v2" : "v1";
  return `${kind}:${version}:${BigInt(value).toString(16).padStart(64, "0")}`;
}

function toolCounts() {
  return {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 0,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0,
  };
}

function contribution(resetIndex, accountTrackId) {
  const resetAt = Date.UTC(2026, 0, 8) + resetIndex * 7 * DAY_MS;
  const firstObserved = resetAt - 2 * DAY_MS;
  const quotaSnapshots = Array.from({ length: 10 }, (_, pointIndex) => {
    const observed = new Date(firstObserved + pointIndex * HOUR_MS).toISOString();
    return {
      schemaVersion: "quota-snapshot-v0.2",
      accountTrackId,
      observedTime: observed,
      receivedTime: observed,
      provider: "openai_codex",
      planType: "pro",
      planVariant: "pro-20x",
      limitId: "codex",
      slot: resetIndex % 2 === 0 ? "primary" : "secondary",
      usedPercent: pointIndex,
      displayPrecision: 0,
      windowDurationMinutes: 10_080,
      resetsAt: new Date(resetAt).toISOString(),
      snapshotSource: "rollout",
      providerSurface: "account_shared_unallocated",
      snapshotId: opaque("snapshot", 10_000 + resetIndex * 100 + pointIndex),
    };
  });
  const usageEvents = Array.from({ length: 9 }, (_, eventIndex) => ({
    schemaVersion: "usage-event-v0.2",
    accountTrackId,
    eventTime: new Date(
      firstObserved + eventIndex * HOUR_MS + HOUR_MS / 2,
    ).toISOString(),
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "standard",
    reasoningEffort: "xhigh",
    components: {
      inputUncachedTokens: 100_000,
      inputCacheReadTokens: 900_000,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 20_000,
      outputReasoningTokens: 10_000,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: 1_000_000,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: toolCounts(),
    outcome: "completed",
    eventId: opaque("event", 20_000 + resetIndex * 100 + eventIndex),
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      estimatedApiCostUsd: "999.000000",
      pricingCoveragePercent: 100,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  }));
  const value = {
    schemaVersion: "telemetry-contribution-v0.2",
    consentVersion: "privacy-safe-telemetry-v0.2",
    status: "implementation_disabled",
    synthetic: false,
    datasetId: opaque("dataset", 1_000 + resetIndex),
    partIndex: 1,
    partCount: 1,
    completeness: "complete",
    createdAt: new Date(firstObserved + 10 * HOUR_MS).toISOString(),
    coveredAt: {
      startAt: new Date(firstObserved).toISOString(),
      endAt: new Date(firstObserved + 9 * HOUR_MS).toISOString(),
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "unknown",
    usageEvents,
    quotaSnapshots,
    activityMarkers: [],
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      estimatedApiCostUsd: "8991.000000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
  validateAccountScopedTelemetryContribution(value);
  return value;
}

async function request(path, {
  method = "GET",
  body = null,
  csrf = false,
  authorization = "",
  includeCookie = true,
} = {}) {
  const headers = { Accept: "application/json" };
  if (includeCookie && cookie) headers.Cookie = cookie;
  if (body !== null) headers["Content-Type"] = "application/json";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.Origin = origin.origin;
  }
  if (csrf) {
    headers["X-Usage-Monitor-CSRF"] = csrfToken;
  }
  if (authorization) headers.Authorization = authorization;
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    body,
    redirect: "error",
  });
  const setCookie = response.headers.get("set-cookie");
  if (includeCookie && setCookie) cookie = setCookie.split(";", 1)[0] ?? "";
  const text = await response.text();
  let value = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON.`);
    }
  }
  return { response, value, text };
}

function expectStatus(result, status, label) {
  if (result.response.status !== status) {
    const code = result.value?.error?.code ?? "unknown_error";
    throw new Error(`${label} returned ${result.response.status} (${code}).`);
  }
  return result.value;
}

async function upload(payload, key) {
  const envelope = await createTelemetryEnvelope({
    payload,
    publicJwk: key.publicJwk,
    keyId: key.keyId,
  });
  const serialized = JSON.stringify(envelope);
  const registration = expectStatus(
    await request("/api/v1/me/upload-authorizations", {
      method: "POST",
      csrf: true,
      body: JSON.stringify({
        envelopeDigest: sha256(serialized),
        contentLengthBytes: Buffer.byteLength(serialized, "utf8"),
        contentType: "application/json",
      }),
    }),
    201,
    "Upload registration",
  );
  return request("/api/v1/contributions", {
    method: "POST",
    includeCookie: false,
    authorization: `Upload ${registration.uploadAuthorization}`,
    body: serialized,
  });
}

async function cleanup() {
  if (!cookie || !csrfToken) return;
  await request("/api/v1/me", {
    method: "DELETE",
    csrf: true,
  }).catch(() => {});
}

try {
  const health = expectStatus(await request("/api/health"), 200, "Health");
  if (health?.contracts?.accountScopedContribution?.status
      !== "local_preview_loopback_only"
      || health?.contracts?.accountScopedContribution
        ?.externalParticipantsAuthorized !== false) {
    throw new Error("The server did not advertise the bounded local-preview contract.");
  }

  const enrollment = expectStatus(
    await request("/api/v1/enroll", {
      method: "POST",
      body: JSON.stringify({
        consentVersion: "privacy-safe-telemetry-v0.2",
        syntheticOnly: false,
      }),
    }),
    201,
    "Account-scoped enrollment",
  );
  participantId = enrollment.participantId;
  csrfToken = enrollment.csrfToken;
  if (!/^participant:/u.test(participantId) || !cookie || !csrfToken) {
    throw new Error("Enrollment did not establish the anonymous session contract.");
  }
  const accountTrackId = `account-track:v1:${sha256(
    `usage-monitor/local-preview-smoke/v1\0${participantId}\0openai_codex`,
  )}`;
  const key = expectStatus(
    await request("/api/v1/envelope-key"),
    200,
    "Envelope key",
  );
  const contributionIds = [];
  for (let index = 0; index < 4; index += 1) {
    const receipt = expectStatus(
      await upload(contribution(index, accountTrackId), key),
      202,
      `Contribution ${index + 1}`,
    );
    if (receipt.status !== "accepted_account_scoped_local_preview"
        || receipt.accountingVerification !== "server_repriced") {
      throw new Error("The server did not return the account-scoped receipt.");
    }
    contributionIds.push(receipt.contributionId);
  }

  const statsResult = await request("/api/v1/me/insights");
  const stats = expectStatus(statsResult, 200, "Private insights");
  const track = stats?.accountScopedQuotaAnalysis?.tracks?.[0];
  if (stats?.totals?.usageEvents !== 36
      || stats?.totals?.quotaSnapshots !== 40
      || stats?.totals?.priceVerification !== "server_repriced"
      || stats?.totals?.apiPriceEquivalentUsd === "35964"
      || stats?.accountScopedQuotaAnalysis?.status !== "ready"
      || track?.calibration?.tracks?.[0]?.estimatedResetCount !== 4
      || track?.rolling?.status !== "conditional_comparison") {
    throw new Error("Private account-scoped calibration did not recompute correctly.");
  }

  const exportedResult = await request("/api/v1/me/export");
  const exported = expectStatus(exportedResult, 200, "Participant export");
  if (exported?.contributions?.length !== 4
      || !exportedResult.text.includes(accountTrackId)
      || /(?:um_session_|um_recovery_|um_upload_)/u.test(exportedResult.text)) {
    throw new Error("Participant export was incomplete or exposed an authority.");
  }

  const communityResult = await request("/api/v1/community/insights");
  expectStatus(communityResult, 200, "Community output");
  if (communityResult.text.includes("accountTrackId")
      || communityResult.text.includes(accountTrackId)
      || communityResult.text.includes(participantId)) {
    throw new Error("Community output exposed participant-scoped fields.");
  }

  const deletion = expectStatus(
    await request("/api/v1/me", {
      method: "DELETE",
      csrf: true,
    }),
    200,
    "Participant deletion",
  );
  cookie = "";
  csrfToken = "";
  if (deletion.contributionsDeleted !== 4) {
    throw new Error("Participant deletion did not cover every contribution.");
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "account-scoped-http-smoke-receipt-v0.1",
    status: "passed",
    contributions: 4,
    usageEvents: 36,
    quotaSnapshots: 40,
    qualifiedResetEstimates: 4,
    rollingComparisonStatus: "conditional_comparison",
    serverRepriced: true,
    participantExportVerified: true,
    communityFieldExclusionVerified: true,
    participantDeleted: true,
    externalParticipantsAuthorized: false,
  }, null, 2)}\n`);
} finally {
  await cleanup();
}
