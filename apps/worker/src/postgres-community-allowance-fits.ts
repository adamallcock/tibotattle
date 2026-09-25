/** Private PostgreSQL persistence boundary for caller-computed allowance-fit output.
 *
 * This adapter does not calculate quota fits or make them publicly readable.
 * Its caller must supply a complete result calculated by a reviewed source
 * reader. Until PostgreSQL fit computation and v1/v1.1 correction parity are
 * implemented, it accepts only typed-v1.2 owners with no legacy-source flags.
 * It binds each result to the current owner, global source/cursor, import,
 * runtime, policy, collection, and owner revisions before storing it in
 * `analytics_owner_results`. Stored rows are not a readiness signal; there is
 * deliberately no public route or daily-publication mutation here.
 */
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";
import { COMMUNITY_ALLOWANCE_FIT_METHOD } from "./community-allowance";
import {
  createPostgresSchemaConfig,
  createPostgresSourceIdentityConfig,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";
import type {
  PostgresCommunityGraphCohortOwner,
  PostgresCommunityGraphCohortSourcePin,
} from "./postgres-community-graph-cohort";

export const POSTGRES_ALLOWANCE_FIT_RESULT_SCHEMA = "postgres-community-allowance-fit-result-v1";
export const POSTGRES_ALLOWANCE_FIT_RESULT_METHOD = "postgres-persisted-fit-input-v1";
const MAX_FITS_PER_OWNER = 50_000;
const MAX_RESULT_BYTES = 1_048_576;
const SHA256 = /^[a-f0-9]{64}$/u;
const PLAN_TYPE = /^[a-z][a-z0-9_-]{0,31}$/u;
const PLAN_TYPES = new Set<string>(TELEMETRY_PLAN_TYPES);

export interface PostgresCommunityAllowanceFitValue {
  readonly planType: string;
  readonly capacityNanousd: number;
  readonly lastObservedAt: string;
}

export interface PersistPostgresCommunityAllowanceFitInput {
  readonly sourcePin: PostgresCommunityGraphCohortSourcePin;
  readonly owner: PostgresCommunityGraphCohortOwner;
  readonly observedDay: string;
  /** The version of the completed scalar fit the caller actually ran. */
  readonly fitMethodVersion: string;
  /** Selected fit values only. Participant IDs are supplied from the owner pin. */
  readonly fits: readonly PostgresCommunityAllowanceFitValue[];
  readonly schema?: PostgresSchemaOptions;
}

export type PersistPostgresCommunityAllowanceFitResult =
  | { readonly state: "stored"; readonly ownerDigest: string; readonly fitCount: number }
  | { readonly state: "deferred"; readonly reason: "source_changed" | "owner_changed" | "result_conflict";
      readonly ownerDigest: string; readonly fitCount: number };

export interface PostgresCommunityAllowanceFitResult {
  readonly schemaVersion: typeof POSTGRES_ALLOWANCE_FIT_RESULT_SCHEMA;
  readonly method: typeof POSTGRES_ALLOWANCE_FIT_RESULT_METHOD;
  readonly fitMethodVersion: typeof COMMUNITY_ALLOWANCE_FIT_METHOD;
  readonly sourceKind: "effective-v1.2";
  readonly observedDay: string;
  readonly ownerDigest: string;
  readonly fitCount: number;
  readonly fits: readonly (PostgresCommunityAllowanceFitValue & { readonly participantId: string })[];
  readonly payloadSha256: string;
}

interface GlobalFenceRow {
  readonly source_id: string;
  readonly source_authority_epoch: string | number;
  readonly cursor_sequence: string | number;
  readonly cursor_authority_epoch: string | number;
  readonly latest_sequence: string | number;
  readonly policy_state: string;
  readonly policy_revision: string | number;
  readonly control_state: string;
  readonly collection_revision: string | number;
  readonly publication_enabled: boolean;
  readonly v12_runtime_state: string;
  readonly v12_runtime_revision: string | number;
  readonly v12_typed_runtime_state: string;
  readonly v12_typed_runtime_policy_revision: string | number;
  readonly accountless_authorization_count: string | number;
  readonly next_accountless_authorization_expiry: string | Date | null;
  readonly v1_generation: string | number;
  readonly v1_digest: string;
  readonly v11_generation: string | number;
  readonly v11_digest: string;
}

interface OwnerFenceRow {
  readonly participant_id: string;
  readonly owner_digest: string;
  readonly participant_state: string;
  readonly owner_kind: string;
  readonly link_state: string;
  readonly owner_state: string;
  readonly owner_revision: string | number;
  readonly owner_authority_epoch: string | number;
  readonly analytical_input_revision: string | number;
  readonly publisher_input_revision: string | number;
  readonly v12_generation_id: string;
  readonly v12_device_id: string;
  readonly v12_retained_authorized: boolean;
  readonly erasure_receipt_exists: boolean;
}

interface StoredFitRow {
  readonly source_namespace: string;
  readonly input_revision: string | number;
  readonly owner_revision: string | number;
  readonly authority_epoch: string | number;
  readonly public_authority_epoch: string | number;
  readonly source_epoch: string | number;
  readonly sequence: string | number;
  readonly method: string;
  readonly status: string;
  readonly reason: string | null;
  readonly payload_json: string;
  readonly payload_sha256: string;
}

type NormalizedInput = {
  readonly sourcePin: PostgresCommunityGraphCohortSourcePin;
  readonly owner: PostgresCommunityGraphCohortOwner;
  readonly observedDay: string;
  readonly fits: readonly PostgresCommunityAllowanceFitValue[];
  readonly payloadJson: string;
};

function fail(code: "invalid" | "unavailable" | "conflict", operation: string): never {
  throw new PostgresStorageError(code, operation, { retryable: code === "conflict" });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function integer(value: unknown, minimum = 0): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) {
    return fail("unavailable", "community_fit.fence");
  }
  return parsed;
}

function validDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    return fail("invalid", "community_fit.day");
  }
  return value;
}

function isoTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const epoch = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(epoch) || epoch < 0) return fail("unavailable", "community_fit.fence");
  return new Date(epoch).toISOString();
}

function normalizeInput(input: PersistPostgresCommunityAllowanceFitInput): NormalizedInput {
  try {
    const identity = createPostgresSourceIdentityConfig({
      sourceId: input.sourcePin?.sourceId,
      sourceNamespace: input.sourcePin?.sourceNamespace,
    });
    const pin = input.sourcePin as unknown as Record<string, unknown>;
    const effective = object(pin.effectiveSourcePin);
    const ownerValue = input.owner as unknown as Record<string, unknown>;
    const ownerPin = object(ownerValue.ownerPin);
    const sourceKeys = ["sourceId", "sourceNamespace", "sourceAuthorityEpoch", "analyticsAuthorityEpoch", "sequence",
      "telemetryV12RuntimeState", "telemetryV12RuntimeRevision", "telemetryV12TypedRuntimeState",
      "telemetryV12TypedRuntimePolicyRevision", "accountlessAuthorizationCount",
      "nextAccountlessAuthorizationExpiry", "effectiveSourcePin", "policyRevision", "collectionRevision"];
    const effectiveKeys = ["sourceId", "sourceNamespace", "storageAuthorityEpoch", "sourceCursorSequence",
      "sourceCursorAuthorityEpoch", "v1ImportGeneration", "v1ImportDigest", "v11ImportGeneration", "v11ImportDigest"];
    const ownerKeys = ["participantId", "ownerDigest", "inputRevision", "ownerRevision", "authorityEpoch", "sourceKind",
      "hasV1", "hasV11", "hasLegacy", "hasV12", "v12GenerationId", "ownerPin"];
    const ownerPinKeys = [...effectiveKeys, "ownerDigest", "participantId", "inputRevision", "ownerRevision",
      "authorityEpoch", "v12State", "v12GenerationId"];
    if (!exactKeys(pin, sourceKeys) || !effective || !exactKeys(effective, effectiveKeys)
        || !exactKeys(ownerValue, ownerKeys) || !ownerPin || !exactKeys(ownerPin, ownerPinKeys)
        || pin.sourceId !== identity.sourceId || pin.sourceNamespace !== identity.sourceNamespace
        || effective.sourceId !== identity.sourceId || effective.sourceNamespace !== identity.sourceNamespace
        || effective.storageAuthorityEpoch !== pin.sourceAuthorityEpoch
        || effective.sourceCursorAuthorityEpoch !== pin.analyticsAuthorityEpoch
        || effective.sourceCursorSequence !== pin.sequence
        || ownerValue.sourceKind !== "effective" || ownerValue.hasV12 !== true
        || ownerValue.hasV1 !== false || ownerValue.hasV11 !== false || ownerValue.hasLegacy !== false
        || typeof ownerValue.participantId !== "string" || ownerValue.participantId.length < 1
        || typeof ownerValue.ownerDigest !== "string" || !SHA256.test(ownerValue.ownerDigest)
        || typeof ownerValue.v12GenerationId !== "string" || ownerValue.v12GenerationId.length < 1
        || ownerPin.ownerDigest !== ownerValue.ownerDigest || ownerPin.participantId !== ownerValue.participantId
        || ownerPin.v12GenerationId !== ownerValue.v12GenerationId || ownerPin.v12State !== "active:active"
        || ownerPin.sourceId !== identity.sourceId || ownerPin.sourceNamespace !== identity.sourceNamespace
        || ownerPin.storageAuthorityEpoch !== effective.storageAuthorityEpoch
        || ownerPin.sourceCursorSequence !== effective.sourceCursorSequence
        || ownerPin.sourceCursorAuthorityEpoch !== effective.sourceCursorAuthorityEpoch
        || ownerPin.v1ImportGeneration !== effective.v1ImportGeneration || ownerPin.v1ImportDigest !== effective.v1ImportDigest
        || ownerPin.v11ImportGeneration !== effective.v11ImportGeneration || ownerPin.v11ImportDigest !== effective.v11ImportDigest
        || input.fitMethodVersion !== COMMUNITY_ALLOWANCE_FIT_METHOD
        || !Array.isArray(input.fits) || input.fits.length > MAX_FITS_PER_OWNER) {
      return fail("invalid", "community_fit.input");
    }
    for (const name of ["sourceAuthorityEpoch", "analyticsAuthorityEpoch", "sequence", "telemetryV12RuntimeRevision",
      "telemetryV12TypedRuntimePolicyRevision", "accountlessAuthorizationCount", "policyRevision", "collectionRevision"]) {
      integer(pin[name], name === "policyRevision" || name === "collectionRevision"
        || name === "telemetryV12TypedRuntimePolicyRevision" ? 1 : 0);
    }
    for (const name of ["storageAuthorityEpoch", "sourceCursorSequence", "sourceCursorAuthorityEpoch",
      "v1ImportGeneration", "v11ImportGeneration"]) {
      integer(effective[name], name === "v1ImportGeneration" || name === "v11ImportGeneration" ? 1 : 0);
    }
    for (const name of ["inputRevision", "ownerRevision", "authorityEpoch"]) integer(ownerValue[name]);
    for (const name of ["inputRevision", "ownerRevision", "authorityEpoch"]) integer(ownerPin[name]);
    if (integer(ownerPin.ownerRevision) !== integer(ownerValue.ownerRevision)
        || integer(ownerPin.authorityEpoch) !== integer(ownerValue.authorityEpoch)) {
      return fail("invalid", "community_fit.input");
    }
    if (typeof effective.v1ImportDigest !== "string" || !SHA256.test(effective.v1ImportDigest)
        || typeof effective.v11ImportDigest !== "string" || !SHA256.test(effective.v11ImportDigest)
        || pin.telemetryV12RuntimeState !== "active" || pin.telemetryV12TypedRuntimeState !== "active"
        || typeof pin.nextAccountlessAuthorizationExpiry !== "string" && pin.nextAccountlessAuthorizationExpiry !== null) {
      return fail("invalid", "community_fit.input");
    }
    const capturedExpiry = isoTimestamp(pin.nextAccountlessAuthorizationExpiry);
    if (capturedExpiry !== pin.nextAccountlessAuthorizationExpiry) return fail("invalid", "community_fit.input");
    const fits = input.fits.map((raw): PostgresCommunityAllowanceFitValue => {
      const value = raw as unknown as Record<string, unknown>;
      if (!exactKeys(value, ["planType", "capacityNanousd", "lastObservedAt"])
          || typeof value.planType !== "string" || !PLAN_TYPE.test(value.planType) || !PLAN_TYPES.has(value.planType)
          || typeof value.capacityNanousd !== "number" || !Number.isFinite(value.capacityNanousd)
          || value.capacityNanousd <= 0
          || typeof value.lastObservedAt !== "string" || value.lastObservedAt.length > 128
          || !Number.isFinite(Date.parse(value.lastObservedAt))) {
        return fail("invalid", "community_fit.fit");
      }
      return Object.freeze({ planType: value.planType, capacityNanousd: value.capacityNanousd,
        lastObservedAt: value.lastObservedAt });
    });
    const observedDay = validDay(input.observedDay);
    const sourcePin = input.sourcePin;
    const owner = input.owner;
    const payloadJson = canonicalJson({
      schemaVersion: POSTGRES_ALLOWANCE_FIT_RESULT_SCHEMA,
      method: POSTGRES_ALLOWANCE_FIT_RESULT_METHOD,
      fitMethodVersion: COMMUNITY_ALLOWANCE_FIT_METHOD,
      sourceKind: "effective-v1.2",
      producer: "persisted-caller-fit-input",
      observedDay,
      ownerDigest: owner.ownerDigest,
      sourcePin,
      ownerFence: {
        inputRevision: owner.inputRevision,
        analyticalInputRevision: owner.ownerPin.inputRevision,
        ownerRevision: owner.ownerRevision,
        authorityEpoch: owner.authorityEpoch,
        v12GenerationId: owner.v12GenerationId,
      },
      fits: fits.map((fit) => ({ participantId: owner.participantId, ...fit })),
    });
    if (new TextEncoder().encode(payloadJson).byteLength > MAX_RESULT_BYTES) {
      return fail("invalid", "community_fit.result_size");
    }
    return Object.freeze({ sourcePin, owner, observedDay, fits: Object.freeze(fits), payloadJson });
  } catch (error) {
    if (error instanceof PostgresStorageError) throw error;
    return fail("invalid", "community_fit.input");
  }
}

function sameNumber(actual: unknown, expected: number): boolean {
  try { return integer(actual) === expected; } catch { return false; }
}

function schemaName(options: PostgresSchemaOptions | undefined): string {
  return quotePostgresIdentifier(createPostgresSchemaConfig(options).primarySchema);
}

async function sourceFenceCurrent(
  client: PostgresClient,
  schema: string,
  pin: PostgresCommunityGraphCohortSourcePin,
  lock: boolean,
): Promise<boolean> {
  const rowResult = await client.query<GlobalFenceRow>(
    `SELECT source.source_id, source.authority_epoch AS source_authority_epoch,
            cursor.sequence AS cursor_sequence, cursor.authority_epoch AS cursor_authority_epoch,
            COALESCE((SELECT max(change.sequence) FROM ${schema}.storage_ingestion_changes change
                       WHERE change.source_id=source.source_id),0) AS latest_sequence,
            policy.publication_state AS policy_state, policy.policy_revision,
            controls.control_state, controls.revision AS collection_revision, controls.publication_enabled,
            v12.state AS v12_runtime_state, v12.revision AS v12_runtime_revision,
            typed.state AS v12_typed_runtime_state, typed.policy_revision AS v12_typed_runtime_policy_revision,
            (SELECT count(*) FROM ${schema}.accountless_v12_device_authorizations auth
              WHERE auth.state='active' AND auth.expires_at>statement_timestamp())
              AS accountless_authorization_count,
            (SELECT min(auth.expires_at) FROM ${schema}.accountless_v12_device_authorizations auth
              WHERE auth.state='active' AND auth.expires_at>statement_timestamp())
              AS next_accountless_authorization_expiry,
            v1.generation AS v1_generation, v1.source_digest AS v1_digest,
            v11.generation AS v11_generation, v11.source_digest AS v11_digest
       FROM ${schema}.storage_source_state source
       JOIN ${schema}.analytics_source_cursors cursor ON cursor.source_id=source.source_id
       JOIN ${schema}.publication_state policy ON policy.singleton=1
       JOIN ${schema}.collection_controls controls ON controls.singleton=1
       JOIN ${schema}.telemetry_v12_runtime v12 ON v12.id=1
       JOIN ${schema}.telemetry_v12_typed_runtime typed ON typed.id=1
       JOIN ${schema}.typed_telemetry_source_family_receipts v1
         ON v1.source_namespace=$2 AND v1.source_format=10
       JOIN ${schema}.typed_telemetry_source_family_receipts v11
         ON v11.source_namespace=$2 AND v11.source_format=11
       JOIN ${schema}.typed_telemetry_admission_transfer_receipts transfer
         ON transfer.v1_source_namespace=$2 AND transfer.v1_source_format=10
        AND transfer.v11_source_namespace=$2 AND transfer.v11_source_format=11
        AND transfer.v1_base_generation=v1.generation AND transfer.v11_base_generation=v11.generation
      WHERE source.singleton=1 AND source.source_id=$1
      ${lock ? "FOR SHARE OF source,cursor,policy,controls,v12,typed,v1,v11,transfer" : ""}`,
    [pin.sourceId, pin.sourceNamespace],
  );
  if (rowResult.rows.length !== 1) return false;
  const row = rowResult.rows[0]!;
  const expiry = isoTimestamp(row.next_accountless_authorization_expiry);
  return row.source_id === pin.sourceId && row.policy_state === "ready"
    && row.control_state === "operational" && row.publication_enabled === true
    && row.v12_runtime_state === pin.telemetryV12RuntimeState
    && row.v12_typed_runtime_state === pin.telemetryV12TypedRuntimeState
    && sameNumber(row.source_authority_epoch, pin.sourceAuthorityEpoch)
    && sameNumber(row.cursor_authority_epoch, pin.analyticsAuthorityEpoch)
    && sameNumber(row.cursor_sequence, pin.sequence) && sameNumber(row.latest_sequence, pin.sequence)
    && pin.sourceAuthorityEpoch === pin.analyticsAuthorityEpoch
    && sameNumber(row.policy_revision, pin.policyRevision)
    && sameNumber(row.collection_revision, pin.collectionRevision)
    && sameNumber(row.v12_runtime_revision, pin.telemetryV12RuntimeRevision)
    && sameNumber(row.v12_typed_runtime_policy_revision, pin.telemetryV12TypedRuntimePolicyRevision)
    && sameNumber(row.accountless_authorization_count, pin.accountlessAuthorizationCount)
    && expiry === pin.nextAccountlessAuthorizationExpiry
    && (expiry === null || Date.parse(expiry) > Date.now())
    && sameNumber(row.v1_generation, pin.effectiveSourcePin.v1ImportGeneration)
    && row.v1_digest === pin.effectiveSourcePin.v1ImportDigest
    && sameNumber(row.v11_generation, pin.effectiveSourcePin.v11ImportGeneration)
    && row.v11_digest === pin.effectiveSourcePin.v11ImportDigest;
}

async function ownerFenceCurrent(
  client: PostgresClient,
  schema: string,
  pin: PostgresCommunityGraphCohortSourcePin,
  owner: PostgresCommunityGraphCohortOwner,
  lock: boolean,
): Promise<boolean> {
  const result = await client.query<OwnerFenceRow>(
    `SELECT link.participant_id, link.owner_digest, participant.state AS participant_state,
            participant.owner_kind, link.state AS link_state, owner.state AS owner_state,
            owner.revision AS owner_revision, owner.authority_epoch AS owner_authority_epoch,
            analytical.revision AS analytical_input_revision, publisher.revision AS publisher_input_revision,
            head.generation_id AS v12_generation_id, domain.device_id AS v12_device_id,
            EXISTS (SELECT 1 FROM ${schema}.telemetry_v12_typed_retained_authorizations retained
                     WHERE retained.participant_id=participant.id AND retained.device_id=domain.device_id)
              AS v12_retained_authorized,
            EXISTS (SELECT 1 FROM ${schema}.storage_owner_erasure_receipts erased
                     WHERE erased.owner_digest=link.owner_digest) AS erasure_receipt_exists
       FROM ${schema}.storage_v11_owner_links link
       JOIN ${schema}.participants participant ON participant.id=link.participant_id
       JOIN ${schema}.analytics_owner_state owner
         ON owner.source_id=$1 AND owner.owner_digest=link.owner_digest
       JOIN ${schema}.community_analytical_input_versions analytical
         ON analytical.participant_id=participant.id
       JOIN ${schema}.input_versions publisher ON publisher.participant_id=participant.id
       JOIN ${schema}.telemetry_v12_domain_heads head ON head.participant_id=participant.id
       JOIN ${schema}.telemetry_v12_domains domain
         ON domain.id=head.generation_id AND domain.participant_id=participant.id
      WHERE link.owner_digest=$2
      ${lock ? "FOR SHARE OF link,participant,owner,analytical,publisher,head,domain" : ""}`,
    [pin.sourceId, owner.ownerDigest],
  );
  if (result.rows.length !== 1) return false;
  const row = result.rows[0]!;
  return row.participant_id === owner.participantId && row.owner_digest === owner.ownerDigest
    && row.participant_state === "active" && ["social", "accountless"].includes(row.owner_kind)
    && row.link_state === "active" && row.owner_state === "active" && row.v12_retained_authorized === true
    && row.erasure_receipt_exists === false && row.v12_generation_id === owner.v12GenerationId
    && sameNumber(row.publisher_input_revision, owner.inputRevision)
    && sameNumber(row.analytical_input_revision, owner.ownerPin.inputRevision)
    && sameNumber(row.owner_revision, owner.ownerRevision)
    && sameNumber(row.owner_authority_epoch, owner.authorityEpoch)
    && owner.ownerPin.v12State === "active:active"
    && owner.ownerPin.storageAuthorityEpoch === pin.sourceAuthorityEpoch
    && owner.ownerPin.sourceCursorAuthorityEpoch === pin.analyticsAuthorityEpoch
    && owner.ownerPin.sourceCursorSequence === pin.sequence;
}

function buildNormalizedInput(input: PersistPostgresCommunityAllowanceFitInput): Promise<NormalizedInput> {
  return Promise.resolve(normalizeInput(input));
}

function readFitPayload(
  json: string,
  expected: NormalizedInput,
): PostgresCommunityAllowanceFitResult | null {
  if (new TextEncoder().encode(json).byteLength > MAX_RESULT_BYTES) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const payload = object(parsed);
  if (!payload || canonicalJson(payload) !== json
      || !exactKeys(payload, ["schemaVersion", "method", "fitMethodVersion", "sourceKind", "producer",
        "observedDay", "ownerDigest", "sourcePin", "ownerFence", "fits"])
      || payload.schemaVersion !== POSTGRES_ALLOWANCE_FIT_RESULT_SCHEMA
      || payload.method !== POSTGRES_ALLOWANCE_FIT_RESULT_METHOD
      || payload.fitMethodVersion !== COMMUNITY_ALLOWANCE_FIT_METHOD
      || payload.sourceKind !== "effective-v1.2" || payload.producer !== "persisted-caller-fit-input"
      || payload.observedDay !== expected.observedDay || payload.ownerDigest !== expected.owner.ownerDigest
      || canonicalJson(payload.sourcePin) !== canonicalJson(expected.sourcePin)
      || !Array.isArray(payload.fits) || payload.fits.length > MAX_FITS_PER_OWNER) return null;
  const ownerFence = object(payload.ownerFence);
  if (!ownerFence || !exactKeys(ownerFence, ["inputRevision", "analyticalInputRevision", "ownerRevision",
    "authorityEpoch", "v12GenerationId"])
      || !sameNumber(ownerFence.inputRevision, expected.owner.inputRevision)
      || !sameNumber(ownerFence.analyticalInputRevision, expected.owner.ownerPin.inputRevision)
      || !sameNumber(ownerFence.ownerRevision, expected.owner.ownerRevision)
      || !sameNumber(ownerFence.authorityEpoch, expected.owner.authorityEpoch)
      || ownerFence.v12GenerationId !== expected.owner.v12GenerationId) return null;
  const fits: (PostgresCommunityAllowanceFitValue & { participantId: string })[] = [];
  for (const raw of payload.fits) {
    const value = object(raw);
    if (!value || !exactKeys(value, ["participantId", "planType", "capacityNanousd", "lastObservedAt"])
        || value.participantId !== expected.owner.participantId
        || typeof value.planType !== "string" || !PLAN_TYPES.has(value.planType)
        || typeof value.capacityNanousd !== "number" || !Number.isFinite(value.capacityNanousd)
        || value.capacityNanousd <= 0 || typeof value.lastObservedAt !== "string"
        || value.lastObservedAt.length > 128 || !Number.isFinite(Date.parse(value.lastObservedAt))) return null;
    fits.push(Object.freeze({ participantId: expected.owner.participantId, planType: value.planType,
      capacityNanousd: value.capacityNanousd, lastObservedAt: value.lastObservedAt }));
  }
  if (canonicalJson(fits) !== canonicalJson(payload.fits)) return null;
  return Object.freeze({ schemaVersion: POSTGRES_ALLOWANCE_FIT_RESULT_SCHEMA,
    method: POSTGRES_ALLOWANCE_FIT_RESULT_METHOD, fitMethodVersion: COMMUNITY_ALLOWANCE_FIT_METHOD,
    sourceKind: "effective-v1.2", observedDay: expected.observedDay, ownerDigest: expected.owner.ownerDigest,
    fitCount: fits.length, fits: Object.freeze(fits), payloadSha256: "" });
}

/** Store a finished caller-computed fit result for one v1.2-eligible owner.
 * This does not analyze telemetry, publish a daily aggregate, or mark a cohort
 * ready. A stale source, owner, cursor, or policy pin returns `deferred`. */
export async function persistPostgresCommunityAllowanceFitResult(
  pool: PostgresPool,
  input: PersistPostgresCommunityAllowanceFitInput,
): Promise<PersistPostgresCommunityAllowanceFitResult> {
  const normalized = await buildNormalizedInput(input);
  const payloadSha256 = await sha256Hex(normalized.payloadJson);
  const schema = schemaName(input.schema);
  return withPostgresMutation(pool, async (client) => {
    if (!await sourceFenceCurrent(client, schema, normalized.sourcePin, true)) {
      return { state: "deferred" as const, reason: "source_changed" as const,
        ownerDigest: normalized.owner.ownerDigest, fitCount: normalized.fits.length };
    }
    if (!await ownerFenceCurrent(client, schema, normalized.sourcePin, normalized.owner, true)) {
      return { state: "deferred" as const, reason: "owner_changed" as const,
        ownerDigest: normalized.owner.ownerDigest, fitCount: normalized.fits.length };
    }
    const result = await client.query<{ payload_sha256: string }>(
      `INSERT INTO ${schema}.analytics_owner_results
         (source_id,source_namespace,observed_day,metric,owner_digest,input_revision,owner_revision,
          authority_epoch,public_authority_epoch,source_epoch,sequence,method,status,reason,payload_json,
          payload_sha256,computed_at_ms)
       VALUES ($1,$2,$3::date,'fits',$4,$5,$6,$7,$8,$9,$10,$11,'ready',NULL,$12,$13,$14)
       ON CONFLICT (source_id,observed_day,metric,owner_digest) DO UPDATE SET
         input_revision=EXCLUDED.input_revision, owner_revision=EXCLUDED.owner_revision,
         authority_epoch=EXCLUDED.authority_epoch, public_authority_epoch=EXCLUDED.public_authority_epoch,
         source_epoch=EXCLUDED.source_epoch, sequence=EXCLUDED.sequence, method=EXCLUDED.method,
         status=EXCLUDED.status, reason=EXCLUDED.reason, payload_json=EXCLUDED.payload_json,
         payload_sha256=EXCLUDED.payload_sha256, computed_at_ms=EXCLUDED.computed_at_ms
       WHERE analytics_owner_results.input_revision < EXCLUDED.input_revision
          OR (analytics_owner_results.input_revision=EXCLUDED.input_revision
         AND analytics_owner_results.owner_revision=EXCLUDED.owner_revision
            AND analytics_owner_results.authority_epoch=EXCLUDED.authority_epoch
            AND analytics_owner_results.public_authority_epoch=EXCLUDED.public_authority_epoch
            AND analytics_owner_results.source_epoch=EXCLUDED.source_epoch
            AND analytics_owner_results.sequence=EXCLUDED.sequence
            AND analytics_owner_results.source_namespace=EXCLUDED.source_namespace
            AND analytics_owner_results.method=EXCLUDED.method
            AND analytics_owner_results.status=EXCLUDED.status
            AND analytics_owner_results.reason IS NULL
            AND analytics_owner_results.payload_sha256=EXCLUDED.payload_sha256)
       RETURNING payload_sha256`,
      [normalized.sourcePin.sourceId, normalized.sourcePin.sourceNamespace, normalized.observedDay,
        normalized.owner.ownerDigest, normalized.owner.inputRevision, normalized.owner.ownerRevision,
        normalized.owner.authorityEpoch, normalized.sourcePin.sourceAuthorityEpoch,
        normalized.sourcePin.analyticsAuthorityEpoch, normalized.sourcePin.sequence,
        POSTGRES_ALLOWANCE_FIT_RESULT_METHOD, normalized.payloadJson, payloadSha256, Date.now()],
    );
    if (result.rows.length !== 1 || result.rows[0]!.payload_sha256 !== payloadSha256) {
      return { state: "deferred" as const, reason: "result_conflict" as const,
        ownerDigest: normalized.owner.ownerDigest, fitCount: normalized.fits.length };
    }
    return { state: "stored", ownerDigest: normalized.owner.ownerDigest, fitCount: normalized.fits.length };
  }, { operation: "community_fit.persist", statementTimeoutMilliseconds: 15_000, lockTimeoutMilliseconds: 5_000 });
}

/** Read one private owner result for a pinned fit worker. The current authority
 * fence is rechecked in the same repeatable-read snapshot. This function is
 * intentionally not wired to public routes or readiness state. */
export async function readPostgresCommunityAllowanceFitResult(
  pool: PostgresPool,
  input: Pick<PersistPostgresCommunityAllowanceFitInput, "sourcePin" | "owner" | "observedDay" | "fitMethodVersion" | "schema">,
): Promise<PostgresCommunityAllowanceFitResult | null> {
  const normalized = await buildNormalizedInput({ ...input, fits: [] });
  const schema = schemaName(input.schema);
  return withPostgresRead(pool, async (client) => {
    if (!await sourceFenceCurrent(client, schema, normalized.sourcePin, false)
        || !await ownerFenceCurrent(client, schema, normalized.sourcePin, normalized.owner, false)) return null;
    const result = await client.query<StoredFitRow>(
      `SELECT source_namespace,input_revision,owner_revision,authority_epoch,public_authority_epoch,
              source_epoch,sequence,method,status,reason,payload_json,payload_sha256
         FROM ${schema}.analytics_owner_results
        WHERE source_id=$1 AND source_namespace=$2 AND observed_day=$3::date
          AND metric='fits' AND owner_digest=$4`,
      [normalized.sourcePin.sourceId, normalized.sourcePin.sourceNamespace,
        normalized.observedDay, normalized.owner.ownerDigest],
    );
    if (result.rows.length !== 1) return null;
    const row = result.rows[0]!;
    if (row.method !== POSTGRES_ALLOWANCE_FIT_RESULT_METHOD || row.status !== "ready" || row.reason !== null
        || !sameNumber(row.input_revision, normalized.owner.inputRevision)
        || !sameNumber(row.owner_revision, normalized.owner.ownerRevision)
        || !sameNumber(row.authority_epoch, normalized.owner.authorityEpoch)
        || !sameNumber(row.public_authority_epoch, normalized.sourcePin.sourceAuthorityEpoch)
        || !sameNumber(row.source_epoch, normalized.sourcePin.analyticsAuthorityEpoch)
        || !sameNumber(row.sequence, normalized.sourcePin.sequence)
        || !SHA256.test(row.payload_sha256) || await sha256Hex(row.payload_json) !== row.payload_sha256) return null;
    const payload = readFitPayload(row.payload_json, normalized);
    if (!payload) return null;
    return Object.freeze({ ...payload, payloadSha256: row.payload_sha256 });
  }, { operation: "community_fit.read", statementTimeoutMilliseconds: 15_000, lockTimeoutMilliseconds: 5_000 });
}
