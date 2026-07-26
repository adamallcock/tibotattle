import {
  inviteGrantHashMatches,
  type ParsedInviteGrant,
} from "./admission";
import { hashCapability, randomSecret, sha256Hex, timingSafeEqual } from "./crypto";
import { ApiError } from "./errors";
import type { SyntheticContribution, SyntheticEnvelope } from "./validation";

export interface Participant {
  id: string;
  createdAt: string;
  state: "active" | "deleting";
  consentVersion: string;
}

interface ParticipantAuthRow {
  id: string;
  access_token_hash: ArrayBuffer;
  created_at: string;
  state: "active" | "deleting";
  consent_version: string;
}

interface RecoveryAuthRow {
  id: string;
  recovery_token_hash: ArrayBuffer;
  state: "active" | "deleting";
}

interface InviteGrantRow {
  id: string;
  secret_hash: ArrayBuffer;
  state: "issued" | "redeemed";
  expires_at: string;
}

export interface ContributionRow {
  id: string;
  participant_id: string;
  envelope_digest: string;
  r2_key: string;
  status: "accepted_synthetic" | "deleting";
  fixture_id: string;
  range_start: string;
  range_end: string;
  quota_window_minutes: number;
  quota_used_percent_before: number;
  quota_used_percent_after: number;
  quota_display_precision: number;
  model_id: string;
  subscription_speed: "standard" | "fast";
  api_tier_assumption: "standard" | "priority" | "flex";
  input_uncached_tokens: number;
  input_cached_tokens: number;
  output_text_tokens: number;
  output_reasoning_tokens: number;
  web_search_calls: number;
  unknown_tool_units: number;
  estimated_api_cost_usd: string;
  priced_event_coverage_percent: number;
  unknown_billable_units: number;
  price_basis: "current-api-price-sensitivity";
  created_at: string;
}

export interface Enrollment {
  participantId: string;
  accessToken: string;
  recoveryCode: string;
}

function capability(prefix: "um_access" | "um_recovery"): {
  id: string;
  secret: string;
  encoded: string;
} {
  const id = crypto.randomUUID();
  const secret = randomSecret(32);
  return { id, secret, encoded: `${prefix}_${id}.${secret}` };
}

function parseAccessToken(header: string | null): { id: string; secret: string } {
  if (!header?.startsWith("Bearer ")) throw new ApiError(401, "AUTH_REQUIRED");
  const token = header.slice(7);
  const match = /^um_access_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match?.[1] || !match[2]) throw new ApiError(401, "AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

function parseRecoveryCode(recoveryCode: unknown): { id: string; secret: string } {
  if (typeof recoveryCode !== "string") throw new ApiError(401, "AUTH_INVALID");
  const match = /^um_recovery_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u.exec(recoveryCode);
  if (!match?.[1] || !match[2]) throw new ApiError(401, "AUTH_INVALID");
  return { id: match[1], secret: match[2] };
}

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value);
}

function canonicalFutureInstant(value: string, nowEpoch: number): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    && new Date(epoch).toISOString() === value
    && epoch > nowEpoch;
}

export async function enroll(
  db: D1Database,
  consentVersion: string,
  inviteGrant: ParsedInviteGrant | null = null,
): Promise<Enrollment> {
  const participantId = `participant:${crypto.randomUUID()}`;
  const access = capability("um_access");
  const recovery = capability("um_recovery");
  const [accessHash, recoveryHash] = await Promise.all([
    hashCapability("access", access.id, access.secret),
    hashCapability("recovery", recovery.id, recovery.secret),
  ]);
  const participantInsert = db.prepare(
    `INSERT INTO participants (
      id, access_token_id, access_token_hash, recovery_token_id,
      recovery_token_hash, state, consent_version, consented_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).bind(
    participantId,
    access.id,
    accessHash,
    recovery.id,
    recoveryHash,
    consentVersion,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  if (!inviteGrant) {
    await participantInsert.run();
  } else {
    const grant = await db.prepare(
      `SELECT id, secret_hash, state, expires_at
         FROM enrollment_grants WHERE id = ?`,
    ).bind(inviteGrant.id).first<InviteGrantRow>();
    const nowEpoch = Date.now();
    const now = new Date(nowEpoch).toISOString();
    if (!inviteGrantHashMatches(inviteGrant.secretHash, grant?.secret_hash ?? null)
        || !grant
        || grant.state !== "issued"
        || !canonicalFutureInstant(grant.expires_at, nowEpoch)) {
      throw new ApiError(400, "INVITE_GRANT_INVALID");
    }
    const eligibilityId = `eligibility:${crypto.randomUUID()}`;
    try {
      const result = await db.batch([
        participantInsert,
        db.prepare(
          `UPDATE enrollment_grants
              SET state = 'redeemed', redeemed_at = ?, redeemed_participant_id = ?
            WHERE id = ? AND state = 'issued' AND expires_at > ?`,
        ).bind(now, participantId, inviteGrant.id, now),
        db.prepare(
          `INSERT INTO participant_community_eligibility (
            id, participant_id, grant_id, created_at
          ) VALUES (?, ?, ?, ?)`,
        ).bind(eligibilityId, participantId, inviteGrant.id, now),
      ]);
      if (result.some((entry) => entry.meta.changes !== 1)) {
        throw new ApiError(400, "INVITE_GRANT_INVALID");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const current = await db.prepare(
        "SELECT state, expires_at FROM enrollment_grants WHERE id = ?",
      ).bind(inviteGrant.id).first<{ state: string; expires_at: string }>();
      if (!current || current.state !== "issued"
          || !canonicalFutureInstant(current.expires_at, Date.now())) {
        throw new ApiError(400, "INVITE_GRANT_INVALID");
      }
      throw error;
    }
  }
  return {
    participantId,
    accessToken: access.encoded,
    recoveryCode: recovery.encoded,
  };
}

export async function recoverAccess(
  db: D1Database,
  recoveryCode: unknown,
): Promise<{ participantId: string; accessToken: string }> {
  const parsed = parseRecoveryCode(recoveryCode);
  const row = await db.prepare(
    `SELECT id, recovery_token_hash, state
       FROM participants
      WHERE recovery_token_id = ?`,
  ).bind(parsed.id).first<RecoveryAuthRow>();
  const presentedHash = await hashCapability("recovery", parsed.id, parsed.secret);
  const expectedHash = row ? bytes(row.recovery_token_hash) : new Uint8Array(32);
  if (!timingSafeEqual(presentedHash, expectedHash) || !row) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  if (row.state !== "active") throw new ApiError(401, "AUTH_INVALID");
  const replacement = capability("um_access");
  const replacementHash = await hashCapability(
    "access",
    replacement.id,
    replacement.secret,
  );
  const result = await db.prepare(
    `UPDATE participants
        SET access_token_id = ?, access_token_hash = ?
      WHERE id = ? AND state = 'active'`,
  ).bind(replacement.id, replacementHash, row.id).run();
  if (result.meta.changes !== 1) throw new ApiError(401, "AUTH_INVALID");
  return { participantId: row.id, accessToken: replacement.encoded };
}

export async function authenticate(
  db: D1Database,
  authorization: string | null,
  allowDeleting = false,
): Promise<Participant> {
  const parsed = parseAccessToken(authorization);
  const row = await db.prepare(
    `SELECT id, access_token_hash, created_at, state, consent_version
       FROM participants
      WHERE access_token_id = ?`,
  ).bind(parsed.id).first<ParticipantAuthRow>();
  const presentedHash = await hashCapability("access", parsed.id, parsed.secret);
  const expectedHash = row ? bytes(row.access_token_hash) : new Uint8Array(32);
  if (!timingSafeEqual(presentedHash, expectedHash) || !row) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  if (row.state === "deleting" && !allowDeleting) {
    throw new ApiError(409, "PARTICIPANT_DELETING");
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    state: row.state,
    consentVersion: row.consent_version,
  };
}

export async function envelopeDigest(envelope: SyntheticEnvelope): Promise<string> {
  return sha256Hex([
    envelope.schemaVersion,
    envelope.keyId,
    envelope.wrappedKey,
    envelope.iv,
    envelope.ciphertext,
  ].join("\0"));
}

export async function existingContribution(
  db: D1Database,
  participantId: string,
  digest: string,
): Promise<ContributionRow | null> {
  return db.prepare(
    `SELECT *
       FROM contributions
      WHERE participant_id = ? AND envelope_digest = ?`,
  ).bind(participantId, digest).first<ContributionRow>();
}

export async function contributionCount(
  db: D1Database,
  participantId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS total FROM contributions WHERE participant_id = ?",
  ).bind(participantId).first<{ total: number }>();
  return row?.total ?? 0;
}

export async function insertContribution(
  db: D1Database,
  participantId: string,
  contributionId: string,
  r2Key: string,
  digest: string,
  envelope: SyntheticEnvelope,
  record: SyntheticContribution,
  createdAt: string,
): Promise<void> {
  const result = await db.prepare(
    `INSERT INTO contributions (
      id, participant_id, envelope_digest, r2_key, envelope_schema_version,
      key_id, status, fixture_id, range_start, range_end, quota_window_minutes,
      quota_used_percent_before, quota_used_percent_after, quota_display_precision,
      model_id, subscription_speed, api_tier_assumption, input_uncached_tokens,
      input_cached_tokens, output_text_tokens, output_reasoning_tokens,
      web_search_calls, unknown_tool_units, estimated_api_cost_usd,
      priced_event_coverage_percent, unknown_billable_units, price_basis, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 'accepted_synthetic',
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?
    )`,
  ).bind(
    contributionId,
    participantId,
    digest,
    r2Key,
    envelope.schemaVersion,
    envelope.keyId,
    record.fixtureId,
    record.timeRange.start,
    record.timeRange.end,
    record.quota.windowMinutes,
    record.quota.usedPercentBefore,
    record.quota.usedPercentAfter,
    record.quota.displayPrecision,
    record.usage.modelId,
    record.usage.subscriptionSpeed,
    record.usage.apiTierAssumption,
    record.usage.inputUncachedTokens,
    record.usage.inputCachedTokens,
    record.usage.outputTextTokens,
    record.usage.outputReasoningTokens,
    record.usage.providerToolUnits.webSearchCalls,
    record.usage.providerToolUnits.unknownUnits,
    record.accounting.estimatedApiCostUsd,
    record.accounting.pricedEventCoveragePercent,
    record.accounting.unknownBillableUnits,
    record.accounting.priceBasis,
    createdAt,
  ).run();
  if (result.meta.changes !== 1) throw new ApiError(409, "PARTICIPANT_DELETING");
}

export async function listContributions(
  db: D1Database,
  participantId: string,
): Promise<ContributionRow[]> {
  const result = await db.prepare(
    `SELECT *
       FROM contributions
      WHERE participant_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1001`,
  ).bind(participantId).all<ContributionRow>();
  return result.results;
}

export async function markParticipantDeleting(
  db: D1Database,
  participantId: string,
): Promise<void> {
  await db.prepare(
    "UPDATE participants SET state = 'deleting' WHERE id = ?",
  ).bind(participantId).run();
}

export async function finishParticipantDeletion(
  db: D1Database,
  participantId: string,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM contributions WHERE participant_id = ?").bind(participantId),
    db.prepare("DELETE FROM participants WHERE id = ?").bind(participantId),
  ]);
}

export function contributionForResponse(row: ContributionRow): object {
  return {
    contributionId: row.id,
    status: row.status,
    synthetic: true,
    fixtureId: row.fixture_id,
    timeRange: { start: row.range_start, end: row.range_end },
    quota: {
      windowMinutes: row.quota_window_minutes,
      usedPercentBefore: row.quota_used_percent_before,
      usedPercentAfter: row.quota_used_percent_after,
      displayPrecision: row.quota_display_precision,
    },
    usage: {
      modelId: row.model_id,
      subscriptionSpeed: row.subscription_speed,
      apiTierAssumption: row.api_tier_assumption,
      inputUncachedTokens: row.input_uncached_tokens,
      inputCachedTokens: row.input_cached_tokens,
      outputTextTokens: row.output_text_tokens,
      outputReasoningTokens: row.output_reasoning_tokens,
      providerToolUnits: {
        webSearchCalls: row.web_search_calls,
        unknownUnits: row.unknown_tool_units,
      },
    },
    accounting: {
      estimatedApiCostUsd: row.estimated_api_cost_usd,
      pricedEventCoveragePercent: row.priced_event_coverage_percent,
      unknownBillableUnits: row.unknown_billable_units,
      priceBasis: row.price_basis,
      limitation: "API-price sensitivity only; no provider allowance formula is claimed.",
    },
    createdAt: row.created_at,
  };
}
