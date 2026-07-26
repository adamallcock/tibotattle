import {
  AGGREGATE_MINIMUM_PARTICIPANTS,
  MAX_REQUEST_BYTES,
  MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT,
  MAX_TELEMETRY_CONTRIBUTIONS_PER_PARTICIPANT,
  TELEMETRY_CONSENT_VERSION,
} from "./constants";
import {
  decryptSyntheticEnvelope,
  publicEnvelopeKey,
} from "./crypto";
import {
  ApiError,
  errorResponse,
  jsonResponse,
} from "./errors";
import {
  authenticate,
  contributionCount,
  contributionForResponse,
  enroll,
  envelopeDigest,
  existingContribution,
  finishParticipantDeletion,
  insertContribution,
  listContributions,
  markParticipantDeleting,
  recoverAccess,
} from "./repository";
import {
  communityStats,
  deleteTelemetryContribution,
  existingTelemetryContribution,
  insertTelemetryContribution,
  listTelemetryContributions,
  personalStats,
  telemetryContributionById,
  telemetryContributionCount,
  telemetryContributionMetadata,
  telemetryEnvelopeDigest,
  telemetryPlaintextDigest,
  telemetryRecordsForContribution,
} from "./telemetry-repository";
import {
  validateTelemetryContribution,
  validateTelemetryEnvelope,
} from "./telemetry-validation";
import {
  validateEnvelope,
  validateSyntheticContribution,
} from "./validation";

async function readBoundedJson(request: Request): Promise<{ raw: string; value: unknown }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new ApiError(415, "CONTENT_TYPE_INVALID");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new ApiError(400, "BODY_INVALID");
    if (length > MAX_REQUEST_BYTES) throw new ApiError(413, "BODY_TOO_LARGE");
  }
  if (!request.body) throw new ApiError(400, "BODY_INVALID");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(combined);
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new ApiError(400, "BODY_INVALID");
  }
}

function methodNotAllowed(allowed: string[]): never {
  const error = new ApiError(405, "METHOD_NOT_ALLOWED");
  Object.defineProperty(error, "allowed", { value: allowed });
  throw error;
}

function allowedHeader(error: ApiError): HeadersInit | undefined {
  const value = Reflect.get(error, "allowed");
  return Array.isArray(value) ? { allow: value.join(", ") } : undefined;
}

function hasExactEnvelopeKeyOccurrences(raw: string): boolean {
  const keys = [...raw.matchAll(/"([^"\\]+)"\s*:/gu)].map((match) => match[1]);
  const expected = [
    "schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext",
  ].sort();
  return keys.length === expected.length
    && keys.sort().every((key, index) => key === expected[index]);
}

async function handleEnroll(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
    || body.value === null
    || Array.isArray(body.value)
    || Object.keys(body.value).length !== 2
    || !Object.hasOwn(body.value, "consentVersion")
    || !Object.hasOwn(body.value, "syntheticOnly")
    || !(
      (Reflect.get(body.value, "consentVersion") === "synthetic-preview-v0.1"
        && Reflect.get(body.value, "syntheticOnly") === true)
      || (Reflect.get(body.value, "consentVersion") === TELEMETRY_CONSENT_VERSION
        && Reflect.get(body.value, "syntheticOnly") === false)
    )) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const consentVersion = Reflect.get(body.value, "consentVersion") as string;
  return jsonResponse(
    await enroll(env.USAGE_MONITOR_DB, consentVersion),
    201,
  );
}

async function handleRecover(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
    || body.value === null
    || Array.isArray(body.value)
    || Object.keys(body.value).length !== 1
    || !Object.hasOwn(body.value, "recoveryCode")) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return jsonResponse(
    await recoverAccess(env.USAGE_MONITOR_DB, Reflect.get(body.value, "recoveryCode")),
  );
}

function handleEnvelopeKey(request: Request, env: Env): Response {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  return jsonResponse(publicEnvelopeKey(env.ENVELOPE_PUBLIC_JWK));
}

async function handleSyntheticContribution(
  body: { raw: string; value: unknown },
  participant: Awaited<ReturnType<typeof authenticate>>,
  env: Env,
): Promise<Response> {
  if (participant.consentVersion !== "synthetic-preview-v0.1") {
    throw new ApiError(400, "SYNTHETIC_REQUIRED");
  }
  const envelope = validateEnvelope(body.value);
  const digest = await envelopeDigest(envelope);
  const existing = await existingContribution(env.USAGE_MONITOR_DB, participant.id, digest);
  if (existing) {
    return jsonResponse(
      { contributionId: existing.id, status: existing.status },
      202,
      { "idempotency-replayed": "true" },
    );
  }
  if (await contributionCount(env.USAGE_MONITOR_DB, participant.id)
      >= MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
    throw new ApiError(429, "CONTRIBUTION_LIMIT_REACHED");
  }

  const plaintext = await decryptSyntheticEnvelope(
    envelope,
    env.ENVELOPE_PUBLIC_JWK,
    env.ENVELOPE_PRIVATE_JWK,
  );
  const record = validateSyntheticContribution(plaintext);
  const contributionId = `contribution:${crypto.randomUUID()}`;
  const r2Key = `synthetic/${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  await env.QUARANTINE.put(r2Key, JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      contributionId,
      schemaVersion: envelope.schemaVersion,
      synthetic: "true",
    },
  });
  try {
    await insertContribution(
      env.USAGE_MONITOR_DB,
      participant.id,
      contributionId,
      r2Key,
      digest,
      envelope,
      record,
      createdAt,
    );
  } catch (error) {
    await env.QUARANTINE.delete(r2Key);
    const replay = await existingContribution(env.USAGE_MONITOR_DB, participant.id, digest);
    if (replay) {
      return jsonResponse(
        { contributionId: replay.id, status: replay.status },
        202,
        { "idempotency-replayed": "true" },
      );
    }
    if (await contributionCount(env.USAGE_MONITOR_DB, participant.id)
        >= MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
      throw new ApiError(429, "CONTRIBUTION_LIMIT_REACHED");
    }
    throw error;
  }
  return jsonResponse(
    { contributionId, status: "accepted_synthetic" },
    202,
  );
}

async function handleTelemetryContribution(
  body: { raw: string; value: unknown },
  participant: Awaited<ReturnType<typeof authenticate>>,
  env: Env,
): Promise<Response> {
  if (participant.consentVersion !== TELEMETRY_CONSENT_VERSION) {
    throw new ApiError(400, "TELEMETRY_REQUIRED");
  }
  const envelope = validateTelemetryEnvelope(body.value);
  const envelopeDigestValue = await telemetryEnvelopeDigest(envelope);
  const envelopeReplay = await existingTelemetryContribution(
    env.USAGE_MONITOR_DB,
    participant.id,
    envelopeDigestValue,
    "envelope",
  );
  if (envelopeReplay) {
    const metadata = telemetryContributionMetadata(envelopeReplay) as {
      recordCounts: unknown;
    };
    return jsonResponse(
      {
        contributionId: envelopeReplay.id,
        status: envelopeReplay.status,
        replayed: true,
        recordCounts: metadata.recordCounts,
        accountingVerification: "client_declared_unverified",
      },
      202,
      { "idempotency-replayed": "true" },
    );
  }
  if (await telemetryContributionCount(env.USAGE_MONITOR_DB, participant.id)
      >= MAX_TELEMETRY_CONTRIBUTIONS_PER_PARTICIPANT) {
    throw new ApiError(429, "CONTRIBUTION_LIMIT_REACHED");
  }

  const plaintext = await decryptSyntheticEnvelope(
    envelope,
    env.ENVELOPE_PUBLIC_JWK,
    env.ENVELOPE_PRIVATE_JWK,
  );
  const record = validateTelemetryContribution(plaintext);
  const plaintextDigest = await telemetryPlaintextDigest(record);
  const contentReplay = await existingTelemetryContribution(
    env.USAGE_MONITOR_DB,
    participant.id,
    plaintextDigest,
  );
  if (contentReplay) {
    const metadata = telemetryContributionMetadata(contentReplay) as {
      recordCounts: unknown;
    };
    return jsonResponse(
      {
        contributionId: contentReplay.id,
        status: contentReplay.status,
        replayed: true,
        recordCounts: metadata.recordCounts,
        accountingVerification: "client_declared_unverified",
      },
      202,
      { "idempotency-replayed": "true" },
    );
  }

  const contributionId = `contribution:${crypto.randomUUID()}`;
  const r2Key = `telemetry/${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  await env.QUARANTINE.put(r2Key, JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      contributionId,
      schemaVersion: envelope.schemaVersion,
      synthetic: "false",
    },
  });
  try {
    const result = await insertTelemetryContribution(
      env.USAGE_MONITOR_DB,
      participant.id,
      contributionId,
      r2Key,
      envelopeDigestValue,
      plaintextDigest,
      record,
      createdAt,
    );
    return jsonResponse({
      contributionId,
      status: "accepted",
      recordCounts: {
        usageEvents: record.usageEvents.length,
        quotaSnapshots: record.quotaSnapshots.length,
        activityMarkers: record.activityMarkers.length,
        accepted: result.acceptedRecords,
        deduplicated: result.deduplicatedRecords,
      },
      accountingVerification: "client_declared_unverified",
    }, 202);
  } catch (error) {
    await env.QUARANTINE.delete(r2Key);
    const replay = await existingTelemetryContribution(
      env.USAGE_MONITOR_DB,
      participant.id,
      plaintextDigest,
    );
    if (replay) {
      const metadata = telemetryContributionMetadata(replay) as {
        recordCounts: unknown;
      };
      return jsonResponse(
        {
          contributionId: replay.id,
          status: replay.status,
          replayed: true,
          recordCounts: metadata.recordCounts,
          accountingVerification: "client_declared_unverified",
        },
        202,
        { "idempotency-replayed": "true" },
      );
    }
    if (await telemetryContributionCount(env.USAGE_MONITOR_DB, participant.id)
        >= MAX_TELEMETRY_CONTRIBUTIONS_PER_PARTICIPANT) {
      throw new ApiError(429, "CONTRIBUTION_LIMIT_REACHED");
    }
    throw error;
  }
}

async function handleContribution(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  const participant = await authenticate(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
  );
  const body = await readBoundedJson(request);
  if (!hasExactEnvelopeKeyOccurrences(body.raw)) {
    throw new ApiError(400, "ENVELOPE_INVALID");
  }
  if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
    throw new ApiError(400, "ENVELOPE_INVALID");
  }
  return Reflect.get(body.value, "schemaVersion") === "telemetry-envelope-v0.1"
    ? handleTelemetryContribution(body, participant, env)
    : handleSyntheticContribution(body, participant, env);
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const participant = await authenticate(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
  );
  const contributions = await listContributions(env.USAGE_MONITOR_DB, participant.id);
  const telemetryContributions = await listTelemetryContributions(
    env.USAGE_MONITOR_DB,
    participant.id,
  );
  return jsonResponse({
    participantId: participant.id,
    createdAt: participant.createdAt,
    syntheticOnly: participant.consentVersion === "synthetic-preview-v0.1",
    contributionCount: contributions.length + telemetryContributions.length,
    latestContribution: telemetryContributions.length > 0
      ? telemetryContributionMetadata(telemetryContributions[telemetryContributions.length - 1]!)
      : contributions.length > 0
        ? contributionForResponse(contributions[contributions.length - 1]!)
        : null,
    contributions: [
      ...contributions.map((row) => ({
        contributionId: row.id,
        status: row.status,
        fixtureId: row.fixture_id,
        synthetic: true,
        createdAt: row.created_at,
      })),
      ...telemetryContributions.map(telemetryContributionMetadata),
    ],
  });
}

async function handleExport(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const participant = await authenticate(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
  );
  const contributions = await listContributions(env.USAGE_MONITOR_DB, participant.id);
  const telemetryContributions = await listTelemetryContributions(
    env.USAGE_MONITOR_DB,
    participant.id,
  );
  const telemetry = [];
  for (const row of telemetryContributions) {
    const rows = await telemetryRecordsForContribution(
      env.USAGE_MONITOR_DB,
      participant.id,
      row.id,
    );
    telemetry.push({
      ...telemetryContributionMetadata(row),
      records: rows.map((record) => ({
        kind: record.record_kind,
        value: JSON.parse(record.record_json) as unknown,
      })),
    });
  }
  return jsonResponse({
    schemaVersion: "participant-export-v0.2",
    syntheticOnly: participant.consentVersion === "synthetic-preview-v0.1",
    participant: {
      participantId: participant.id,
      createdAt: participant.createdAt,
    },
    contributions: [
      ...contributions.map(contributionForResponse),
      ...telemetry,
    ],
    generatedAt: new Date().toISOString(),
  });
}

async function handleDelete(request: Request, env: Env): Promise<Response> {
  if (request.method !== "DELETE") methodNotAllowed(["DELETE"]);
  const participant = await authenticate(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
    true,
  );
  if (participant.state === "active") {
    await markParticipantDeleting(env.USAGE_MONITOR_DB, participant.id);
  }
  const contributions = await listContributions(env.USAGE_MONITOR_DB, participant.id);
  const telemetryContributions = await listTelemetryContributions(
    env.USAGE_MONITOR_DB,
    participant.id,
  );
  if (contributions.length > MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT
      || telemetryContributions.length > MAX_TELEMETRY_CONTRIBUTIONS_PER_PARTICIPANT) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const r2Keys = [
    ...contributions.map((row) => row.r2_key),
    ...telemetryContributions.map((row) => row.r2_key),
  ];
  if (r2Keys.length > 0) {
    await env.QUARANTINE.delete(r2Keys);
  }
  await finishParticipantDeletion(env.USAGE_MONITOR_DB, participant.id);
  return jsonResponse({
    deleted: true,
    participantId: participant.id,
    contributionsDeleted: contributions.length + telemetryContributions.length,
  });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const participant = await authenticate(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
  );
  return jsonResponse(await personalStats(env.USAGE_MONITOR_DB, participant.id));
}

async function handleCommunityStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  return jsonResponse(await communityStats(
    env.USAGE_MONITOR_DB,
    AGGREGATE_MINIMUM_PARTICIPANTS,
  ));
}

async function handleContributionResource(
  request: Request,
  env: Env,
  contributionId: string,
): Promise<Response> {
  const participant = await authenticate(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
  );
  const row = await telemetryContributionById(
    env.USAGE_MONITOR_DB,
    participant.id,
    contributionId,
  );
  if (!row) throw new ApiError(404, "NOT_FOUND");
  if (request.method === "GET") {
    const records = await telemetryRecordsForContribution(
      env.USAGE_MONITOR_DB,
      participant.id,
      contributionId,
    );
    return jsonResponse({
      ...telemetryContributionMetadata(row),
      records: records.map((record) => ({
        kind: record.record_kind,
        value: JSON.parse(record.record_json) as unknown,
      })),
    });
  }
  if (request.method === "DELETE") {
    await env.QUARANTINE.delete(row.r2_key);
    await deleteTelemetryContribution(env.USAGE_MONITOR_DB, participant.id, contributionId);
    return jsonResponse({ deleted: true, contributionId });
  }
  methodNotAllowed(["GET", "DELETE"]);
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/v1/enroll") return handleEnroll(request, env);
  if (pathname === "/api/v1/recover") return handleRecover(request, env);
  if (pathname === "/api/v1/envelope-key") return handleEnvelopeKey(request, env);
  if (pathname === "/api/v1/contributions") return handleContribution(request, env);
  const contributionMatch = /^\/api\/v1\/contributions\/(contribution:[0-9a-f-]{36})$/u
    .exec(pathname);
  if (contributionMatch?.[1]) {
    return handleContributionResource(request, env, contributionMatch[1]);
  }
  if (pathname === "/api/v1/me/export") return handleExport(request, env);
  if (pathname === "/api/v1/me/stats" || pathname === "/api/v1/me/insights") {
    return handleStats(request, env);
  }
  if (pathname === "/api/v1/stats/aggregate"
      || pathname === "/api/v1/community/insights") {
    return handleCommunityStats(request, env);
  }
  if (pathname === "/api/v1/me") {
    if (request.method === "DELETE") return handleDelete(request, env);
    return handleMe(request, env);
  }
  throw new ApiError(404, "NOT_FOUND");
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") methodNotAllowed(["GET"]);
      await env.USAGE_MONITOR_DB.prepare("SELECT 1").first();
      return jsonResponse({ status: "ok", mode: "synthetic-and-private-telemetry" });
    }
    if (url.pathname.startsWith("/api/")) return await routeApi(request, env);
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set(
      "content-security-policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  } catch (error) {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(500, "INTERNAL_ERROR");
    const log = {
      level: apiError.status >= 500 ? "error" : "warn",
      event: "request_failed",
      requestId,
      method: request.method,
      path: url.pathname,
      code: apiError.code,
      status: apiError.status,
    };
    if (apiError.status >= 500) console.error(JSON.stringify(log));
    else console.warn(JSON.stringify(log));
    const response = errorResponse(apiError, requestId);
    const allow = allowedHeader(apiError);
    if (!allow) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of new Headers(allow)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  }
}

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
