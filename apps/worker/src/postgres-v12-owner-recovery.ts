/** Owner-only recovery for complete, unheaded v1.2 domains.
 *
 * Preview reports only structural eligibility. Execution issues the normal
 * v1.2 predecessor and submits the exact latest READY vector captured with
 * that predecessor through the ordinary activation proof. No refusal is
 * bypassed and an uncertain activation ends the page for a fresh review.
 */
import {
  MAX_TELEMETRY_V12_DOMAIN_DAYS,
  parseTelemetryV12DomainManifest,
  telemetryV12DomainManifestDigestInput,
} from "@app-usagemonitor/telemetry-contract";
import { encodeBase64Url, sha256, sha256Hex } from "./crypto";
import { TELEMETRY_CONSENT_VERSION } from "./constants";
import { ApiError } from "./errors";
import {
  beginPostgresAdminOperation,
  finishPostgresAdminOperation,
  finishPostgresAdminOperationBestEffort,
} from "./postgres-admin-audit";
import { assertPostgresCollectionControl } from "./postgres-collection-controls";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";
import {
  createPostgresTypedV12Domain,
  type TelemetryV12DomainDayReference,
} from "./postgres-typed-v12-domain";
import {
  parseV12DomainRecoveryRequest,
  parseV12DomainRecoveryResult,
  V12_DOMAIN_RECOVERY_METHOD,
  V12_DOMAIN_RECOVERY_REFUSAL_CODES,
  type V12DomainRecoveryOutcome,
  type V12DomainRecoveryRefusalCode,
  type V12DomainRecoveryResult,
} from "./v12-domain-recovery";
import type { PostgresTypedV12Principal } from "./postgres-typed-v12-admission";

const CURSOR_TTL_MS = 30 * 60_000;
const PAGE_BUDGET_MS = 15_000;
const PREFLIGHT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 1_000;
const CURSOR_PREFIX = "v12r1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_REFUSALS = new Set<string>(V12_DOMAIN_RECOVERY_REFUSAL_CODES);

interface CandidateRow {
  readonly participant_id: string;
  readonly device_id: string;
  readonly order_key: string;
}

interface AuthorityRow {
  readonly participant_state: string;
  readonly owner_kind: string;
  readonly participant_consent_version: string | null;
  readonly device_state: string;
  readonly authority_kind: string;
  readonly device_expires_at: string | Date;
  readonly active_authorization: boolean;
  readonly generation_id: string | null;
}

interface ReadyDayRow {
  readonly day: string;
  readonly manifestId: string;
  readonly manifestDigest: string;
}

interface Cursor {
  readonly after: string;
  readonly cutoff: string;
  readonly expires: number;
}

interface PlanResult {
  readonly outcome: V12DomainRecoveryOutcome;
  readonly code?: V12DomainRecoveryRefusalCode;
  readonly days?: readonly TelemetryV12DomainDayReference[];
}

type FailureStage = "selection" | "preflight" | "predecessor" | "activation" | "terminal_audit";

function safeError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function preserveSafeError(error: unknown): Error | null {
  return error instanceof ApiError ? error : null;
}

function refuse(code: V12DomainRecoveryRefusalCode): PlanResult {
  return { outcome: "refused", code };
}

function mappedRefusalCode(error: ApiError): V12DomainRecoveryRefusalCode {
  if (SAFE_REFUSALS.has(error.code)) return error.code as V12DomainRecoveryRefusalCode;
  // Unknown ApiErrors are not evidence of a particular manifest refusal.
  // Stop the page with a closed storage error instead of misclassifying them.
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function authorityFailure(error: ApiError): boolean {
  return error.status === 401 || error.status === 403
    || error.code === "TELEMETRY_REQUIRED"
    || error.code === "TELEMETRY_TRANSPORT_BLOCKED"
    || error.code === "UPLOAD_REGISTRATION_DISABLED";
}

function asDayVector(rows: readonly ReadyDayRow[]):
  | { readonly days: readonly TelemetryV12DomainDayReference[] }
  | { readonly refusal: V12DomainRecoveryRefusalCode } {
  if (rows.length === 0) return { refusal: "TELEMETRY_MANIFEST_INCOMPLETE" };
  if (rows.length > MAX_TELEMETRY_V12_DOMAIN_DAYS) return { refusal: "SYNC_RANGE_TOO_LARGE" };
  const days: TelemetryV12DomainDayReference[] = [];
  let priorEpoch = Number.NaN;
  for (const row of rows) {
    const epoch = Date.parse(`${row.day}T00:00:00.000Z`);
    if (typeof row.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(row.day)
        || !Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== row.day
        || typeof row.manifestId !== "string" || !UUID.test(row.manifestId)
        || typeof row.manifestDigest !== "string" || !SHA256.test(row.manifestDigest)) {
      return { refusal: "TELEMETRY_MANIFEST_INVALID" };
    }
    if (Number.isFinite(priorEpoch) && epoch !== priorEpoch + 86_400_000) {
      return { refusal: "TELEMETRY_MANIFEST_INCOMPLETE" };
    }
    priorEpoch = epoch;
    days.push({ day: row.day, manifestId: row.manifestId, manifestDigest: row.manifestDigest });
  }
  // Reuse the public contract parser as the structural size and closed-shape
  // authority. The fake predecessor is never persisted or exposed.
  const probe = {
    schemaVersion: "telemetry-domain-manifest-v1.2",
    fromDay: days[0]!.day,
    throughDay: days.at(-1)!.day,
    predecessor: {
      token: "00000000-0000-4000-8000-000000000000",
      previousGenerationId: null,
      legacyFingerprint: "0".repeat(64),
    },
    days,
    manifestDigest: "0".repeat(64),
  };
  try {
    parseTelemetryV12DomainManifest(probe);
  } catch {
    return { refusal: "TELEMETRY_MANIFEST_INVALID" };
  }
  return { days };
}

function decodeBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function cursorCodec(secret: string, identityKey: string, schema: string, dryRun: boolean) {
  if (typeof secret !== "string" || secret.length < 32
      || typeof identityKey !== "string" || identityKey.length < 1 || identityKey.length > 512) {
    throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  }
  const rawKey = await sha256(`app-usagemonitor/v12-owner-domain-recovery/cursor-key/v1\0${secret}`);
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  const actorDigest = await sha256Hex(`app-usagemonitor/v12-owner-domain-recovery/actor/v1\0${identityKey}`);
  const additionalData = encoder.encode(JSON.stringify([CURSOR_PREFIX, schema, dryRun, actorDigest]));
  return {
    orderSecret: await sha256Hex(`app-usagemonitor/v12-owner-domain-recovery/order/v1\0${secret}`),
    async encode(value: Cursor): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData }, key, encoder.encode(JSON.stringify(value)),
      ));
      const result = `${CURSOR_PREFIX}.${encodeBase64Url(iv)}.${encodeBase64Url(encrypted)}`;
      if (result.length > 256) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      return result;
    },
    async decode(value: string, nowEpoch: number): Promise<Cursor> {
      try {
        if (typeof value !== "string" || value.length > 256
            || !/^v12r1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,235}$/u.test(value)) throw 0;
        const [prefix, ivText, cipherText] = value.split(".");
        if (prefix !== CURSOR_PREFIX || !ivText || !cipherText) throw 0;
        const iv = decodeBase64Url(ivText);
        const encrypted = decodeBase64Url(cipherText);
        if (iv.length !== 12 || encodeBase64Url(iv) !== ivText
            || encodeBase64Url(encrypted) !== cipherText || encrypted.length > 176) throw 0;
        const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, encrypted);
        if (clear.byteLength > 512) throw 0;
        const parsed: unknown = JSON.parse(decoder.decode(clear));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw 0;
        const cursor = parsed as Record<string, unknown>;
        if (Object.keys(cursor).sort().join(",") !== "after,cutoff,expires"
            || typeof cursor.after !== "string" || !SHA256.test(cursor.after)
            || typeof cursor.cutoff !== "string" || !Number.isSafeInteger(cursor.expires)) throw 0;
        const cutoff = Date.parse(cursor.cutoff);
        if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== cursor.cutoff
            || cutoff > nowEpoch || (cursor.expires as number) <= nowEpoch
            || (cursor.expires as number) > cutoff + CURSOR_TTL_MS) throw 0;
        return Object.freeze({ after: cursor.after, cutoff: cursor.cutoff, expires: cursor.expires as number });
      } catch {
        throw new ApiError(400, "BODY_INVALID");
      }
    },
  };
}

export interface PostgresV12OwnerRecoveryOptions {
  readonly pool: PostgresPool;
  readonly schema: PostgresSchemaConfig;
  readonly cursorSecret: string;
  readonly clock?: () => number;
  readonly observeActivation?: (invoke: () => Promise<unknown>) => Promise<unknown>;
}

export function createPostgresV12OwnerRecovery(deps: PostgresV12OwnerRecoveryOptions):
  (input: { readonly body: unknown; readonly identityKey: string }) => Promise<V12DomainRecoveryResult> {
  const { pool, schema } = deps;
  const quotedSchema = quotePostgresIdentifier(schema.primarySchema);
  const table = (name: string) => `${quotedSchema}.${quotePostgresIdentifier(name)}`;
  const clock = deps.clock ?? Date.now;
  const domain = createPostgresTypedV12Domain(pool, { schema });
  const read = <T>(operation: (client: PostgresClient) => Promise<T>) => withPostgresRead(pool, operation, {
    operation: "telemetry.v12.owner_recovery.preview",
    statementTimeoutMilliseconds: PREFLIGHT_TIMEOUT_MS,
    lockTimeoutMilliseconds: LOCK_TIMEOUT_MS,
    preserveSafeError,
  });

  async function planDevice(principal: PostgresTypedV12Principal, nowEpoch: number): Promise<PlanResult> {
    return read(async (client) => {
      await assertPostgresCollectionControl(client, schema.primarySchema, "processing");
      const authority = await client.query<AuthorityRow>(
        `SELECT p.state AS participant_state, p.owner_kind,
                p.consent_version AS participant_consent_version,
                d.state AS device_state, d.authority_kind, d.expires_at AS device_expires_at,
                EXISTS (SELECT 1 FROM ${table("telemetry_v12_typed_active_authorizations")} active_auth
                  WHERE active_auth.participant_id = p.id AND active_auth.device_id = d.id) AS active_authorization,
                h.generation_id
           FROM ${table("participants")} p
           JOIN ${table("device_credentials")} d ON d.participant_id = p.id
           LEFT JOIN ${table("telemetry_v12_domain_heads")} h ON h.participant_id = p.id
          WHERE p.id = $1 AND d.id = $2`,
        [principal.participantId, principal.deviceId],
      );
      const row = authority.rows[0];
      if (row?.generation_id !== null && row?.generation_id !== undefined) {
        return { outcome: "already_active" };
      }
      const ownerConsent = row?.owner_kind === "social"
        ? row.participant_consent_version === TELEMETRY_CONSENT_VERSION
        : row?.owner_kind === "accountless" && row.participant_consent_version === null;
      if (!row || row.participant_state !== "active" || row.device_state !== "active"
          || row.owner_kind !== row.authority_kind || !ownerConsent
          || new Date(row.device_expires_at).getTime() <= nowEpoch || !row.active_authorization) {
        return { outcome: "authority_unavailable" };
      }
      const latest = await client.query<ReadyDayRow>(
        `SELECT DISTINCT ON (chunk_day)
                to_char(chunk_day, 'YYYY-MM-DD') AS day,
                id AS "manifestId", manifest_digest AS "manifestDigest"
           FROM ${table("telemetry_v12_day_manifests")}
          WHERE participant_id = $1 AND device_id = $2 AND state = 'ready'
          ORDER BY chunk_day, created_at DESC, id COLLATE "C" DESC
          LIMIT $3`,
        [principal.participantId, principal.deviceId, MAX_TELEMETRY_V12_DOMAIN_DAYS + 1],
      );
      const vector = asDayVector(latest.rows);
      if ("refusal" in vector) return refuse(vector.refusal);
      return { outcome: "eligible", days: vector.days };
    });
  }

  return async ({ body, identityKey }): Promise<V12DomainRecoveryResult> => {
    const request = parseV12DomainRecoveryRequest(body);
    const startedAt = clock();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
    }
    const codec = await cursorCodec(deps.cursorSecret, identityKey, schema.primarySchema, request.dryRun);
    const cursor: Cursor = request.afterParticipantId === null
      ? { after: "0".repeat(64), cutoff: new Date(startedAt).toISOString(), expires: startedAt + CURSOR_TTL_MS }
      : await codec.decode(request.afterParticipantId, startedAt);
    const details = {
      task: "v12_domain_recovery",
      method: V12_DOMAIN_RECOVERY_METHOD,
      dryRun: request.dryRun,
      maxDevices: request.maxDevices,
    };
    let operationId: string | undefined;
    const completedOutcomes: Record<V12DomainRecoveryOutcome, number> = {
      activated: 0, eligible: 0, already_active: 0, authority_unavailable: 0, refused: 0,
    };
    const completedRefusals: Partial<Record<V12DomainRecoveryRefusalCode, number>> = {};
    let completedExamined = 0;
    let completedDaysCovered = 0;
    let failureStage: FailureStage = "selection";
    let currentAttemptMayHaveCommitted = false;
    let predecessorIssued = false;
    try {
      if (!request.dryRun) {
        operationId = await beginPostgresAdminOperation(pool, schema.primarySchema,
          { action: "run_maintenance", identityKey, details });
      }
      failureStage = "selection";
      const page = await read(async (client) => {
        await assertPostgresCollectionControl(client, schema.primarySchema, "processing");
        return (await client.query<CandidateRow>(
          `WITH eligible_devices AS (
             SELECT p.id AS participant_id, d.id AS device_id,
                    latest_ready.ready_at AS latest_ready_at,
                    row_number() OVER (
                      PARTITION BY p.id
                      ORDER BY latest_ready.ready_at DESC,
                               latest_ready.created_at DESC,
                               latest_ready.id COLLATE "C" DESC,
                               d.id COLLATE "C"
                    ) AS device_rank
               FROM ${table("participants")} p
               JOIN ${table("device_credentials")} d ON d.participant_id = p.id
               JOIN LATERAL (
                 SELECT ready.id, ready.ready_at, ready.created_at
                   FROM ${table("telemetry_v12_day_manifests")} ready
                  WHERE ready.participant_id = p.id AND ready.device_id = d.id
                    AND ready.state = 'ready'
                    AND ready.created_at <= $2::timestamptz
                    AND ready.ready_at <= $2::timestamptz
                  ORDER BY ready.ready_at DESC, ready.created_at DESC,
                           ready.id COLLATE "C" DESC
                  LIMIT 1
               ) latest_ready ON true
              WHERE p.state = 'active'
                AND ((p.owner_kind = 'social' AND p.consent_version = $5)
                  OR (p.owner_kind = 'accountless' AND p.consent_version IS NULL))
                AND d.state = 'active' AND d.expires_at > $2::timestamptz
                AND d.authority_kind = p.owner_kind
                AND EXISTS (SELECT 1 FROM ${table("telemetry_v12_typed_active_authorizations")} active_auth
                  WHERE active_auth.participant_id = p.id AND active_auth.device_id = d.id)
                AND NOT EXISTS (SELECT 1 FROM ${table("telemetry_v12_domain_heads")} h
                  WHERE h.participant_id = p.id)
           ), candidates AS (
             SELECT participant_id, device_id,
                    encode(sha256(convert_to(jsonb_build_array($1::text, participant_id)::text, 'UTF8')), 'hex') AS order_key
               FROM eligible_devices WHERE device_rank = 1
           )
           SELECT participant_id, device_id, order_key
             FROM candidates
            WHERE order_key > $3
            ORDER BY order_key
            LIMIT $4`,
          [codec.orderSecret, cursor.cutoff, cursor.after, request.maxDevices + 1, TELEMETRY_CONSENT_VERSION],
        )).rows;
      });
      const selected = page.slice(0, request.maxDevices);
      const processed: CandidateRow[] = [];
      const pageStarted = clock();
      for (const candidate of selected) {
        if (processed.length > 0 && clock() - pageStarted >= PAGE_BUDGET_MS) break;
        const principal = { participantId: candidate.participant_id, deviceId: candidate.device_id };
        predecessorIssued = false;
        currentAttemptMayHaveCommitted = false;
        failureStage = "preflight";
        let result = await planDevice(principal, clock());
        let candidateDaysCovered = result.days?.length ?? 0;
        if (result.outcome === "eligible" && !request.dryRun) {
          let candidateWriteStage: "predecessor" | "activation" = "predecessor";
          try {
            failureStage = "predecessor";
            currentAttemptMayHaveCommitted = true;
            const captured = await domain.createOwnerRecoveryPredecessor(principal, clock());
            currentAttemptMayHaveCommitted = false;
            predecessorIssued = true;
            candidateDaysCovered = captured.candidateDays.length;
            candidateWriteStage = "activation";
            failureStage = "activation";
            const manifest = {
              schemaVersion: "telemetry-domain-manifest-v1.2" as const,
              fromDay: captured.candidateDays[0]!.day,
              throughDay: captured.candidateDays.at(-1)!.day,
              predecessor: {
                token: captured.predecessor.token,
                previousGenerationId: captured.predecessor.previousGenerationId,
                legacyFingerprint: captured.predecessor.legacyFingerprint,
              },
              days: captured.candidateDays.map(({ day, manifestId, manifestDigest }) => ({
                day, manifestId, manifestDigest,
              })),
              manifestDigest: "0".repeat(64),
            };
            manifest.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
            const invoke = () => {
              currentAttemptMayHaveCommitted = true;
              return domain.activateOwnerRecovery(principal, manifest, clock());
            };
            const activation = deps.observeActivation
              ? await deps.observeActivation(invoke)
              : await invoke();
            currentAttemptMayHaveCommitted = false;
            if (activation !== null && typeof activation === "object"
                && Reflect.get(activation, "replay") === true) {
              result = { outcome: "already_active" };
            } else {
              result = { outcome: "activated" };
            }
          } catch (error) {
            const failure = safeError(error);
            if (failure.status >= 500) throw failure;
            currentAttemptMayHaveCommitted = false;
            failureStage = candidateWriteStage;
            if (failure.status === 409 && failure.code === "TELEMETRY_MANIFEST_CONFLICT") {
              const nowActive = await read(async (client) => {
                const head = await client.query<{ active: boolean }>(
                  `SELECT EXISTS (SELECT 1 FROM ${table("telemetry_v12_domain_heads")}
                    WHERE participant_id = $1) AS active`, [principal.participantId],
                );
                return head.rows[0]?.active === true;
              });
              result = nowActive ? { outcome: "already_active" } : { outcome: "refused", code: mappedRefusalCode(failure) };
            } else if (authorityFailure(failure)) {
              result = { outcome: "authority_unavailable" };
            } else {
              result = { outcome: "refused", code: mappedRefusalCode(failure) };
            }
          }
        }
        completedOutcomes[result.outcome] += 1;
        if (result.outcome === "refused" && result.code) {
          completedRefusals[result.code] = (completedRefusals[result.code] ?? 0) + 1;
        }
        completedDaysCovered += candidateDaysCovered;
        completedExamined += 1;
        processed.push(candidate);
        predecessorIssued = false;
        currentAttemptMayHaveCommitted = false;
      }
      failureStage = "terminal_audit";
      const result: V12DomainRecoveryResult = {
        task: "v12_domain_recovery",
        method: V12_DOMAIN_RECOVERY_METHOD,
        dryRun: request.dryRun,
        examined: completedExamined,
        outcomes: completedOutcomes,
        refusals: completedRefusals,
        daysCovered: completedDaysCovered,
        nextAfterParticipantId: page.length > processed.length
          ? await codec.encode({ ...cursor, after: processed.at(-1)!.order_key })
          : null,
      };
      const validated = parseV12DomainRecoveryResult(result);
      if (operationId) {
        await finishPostgresAdminOperation(pool, schema.primarySchema, {
          operationId,
          outcome: "success",
          details: {
            ...details,
            examined: validated.examined,
            outcomes: completedOutcomes,
            refusals: completedRefusals,
            daysCovered: completedDaysCovered,
          },
        });
      }
      return validated;
    } catch (error) {
      const failure = safeError(error);
      if (operationId) {
        await finishPostgresAdminOperationBestEffort(pool, schema.primarySchema, {
          operationId,
          outcome: "failure",
          details: {
            ...details,
            failureStage,
            predecessorIssued,
            currentAttemptMayHaveCommitted,
            completed: {
              examined: completedExamined,
              outcomes: completedOutcomes,
              refusals: completedRefusals,
              daysCovered: completedDaysCovered,
            },
          },
        });
      }
      throw failure;
    }
  };
}
