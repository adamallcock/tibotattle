/** Owner-only recovery of new READY days beyond an existing v1.1 head.
 * Preview is structural eligibility, not a claim that classification/closure
 * will pass. Execute always uses the ordinary activation and journal path.
 * Covered-day replacements and participants with any v1.2 activity are excluded.
 */
import { MAX_TELEMETRY_V11_DOMAIN_DAYS, TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  telemetryV11DomainManifestDigestInput } from "@app-usagemonitor/telemetry-contract";
import { encodeBase64Url, sha256, sha256Hex } from "./crypto";
import { ApiError } from "./errors";
import { beginPostgresAdminOperation, finishPostgresAdminOperation,
  finishPostgresAdminOperationBestEffort } from "./postgres-admin-audit";
import { assertPostgresCollectionControl } from "./postgres-collection-controls";
import { quotePostgresIdentifier, withPostgresRead, type PostgresClient, type PostgresPool,
  type PostgresSchemaConfig } from "./postgres-client";
import { createPostgresTelemetryV11Domain, type PostgresTelemetryV11Principal } from "./postgres-telemetry-v11-live-admission";
import { assertPostgresTelemetryTransportWriteAllowed } from "./postgres-transport-write-authority";
import { parseV11EvidenceAdoptionRequest, V11_EVIDENCE_ADOPTION_METHOD,
  type V11EvidenceAdoptionOutcome, type V11EvidenceAdoptionResult } from "./v11-evidence-adoption";

const DAY_MS = 86_400_000;
// Match the executor's 24-hour ownership fence for unused client predecessors.
const PREDECESSOR_OWNERSHIP_MS = 24 * 60 * 60 * 1_000;
const CURSOR_MS = 30 * 60_000;
const PAGE_BUDGET_MS = 15_000;
const encoder = new TextEncoder();
const safeError = (error: unknown) => error instanceof ApiError ? error : new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
const preserveSafeError = (error: unknown) => error instanceof ApiError ? error : null;
const nextDay = (day: string) => new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10);

interface Day { day: string; manifestId: string; manifestDigest: string }
interface Candidate { participant_id: string; device_id: string; order_key: string }
interface State { generation_id: string; input_revision: string; from_day: string; through_day: string; device_id: string }
interface Plan { state: State; days: Day[]; newDays: number }
interface DeviceResult { outcome: V11EvidenceAdoptionOutcome; code?: string; plan?: Plan }
interface Cursor { after: string; cutoff: string; expires: number }

/** The legacy field name is retained for the existing admin UI. Its value is
 * encrypted, authenticated, owner/schema/mode-bound, expires after 30 minutes,
 * and contains only a salted order hash plus timestamps, never an identifier. */
async function cursorCodec(secret: string, identityKey: string, schema: string, dryRun: boolean) {
  if (typeof secret !== "string" || secret.length < 32) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  const raw = await sha256(`app-usagemonitor/v11-adoption/cursor-key/v1\0${secret}`);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const additionalData = encoder.encode(JSON.stringify(["v11-adoption-cursor-1", schema, dryRun,
    await sha256Hex(`app-usagemonitor/v11-adoption/actor/v1\0${identityKey}`)]));
  return {
    orderSecret: await sha256Hex(`app-usagemonitor/v11-adoption/order/v1\0${secret}`),
    async encode(value: Cursor) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData },
        key, encoder.encode(JSON.stringify(value))));
      return `pg1.${encodeBase64Url(iv)}.${encodeBase64Url(encrypted)}`;
    },
    async decode(value: string, nowEpoch: number): Promise<Cursor> {
      try {
        if (!/^pg1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,235}$/u.test(value) || value.length > 256) throw 0;
        const parts = value.split(".");
        const bytes = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
        const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(parts[1]!), additionalData }, key, bytes(parts[2]!));
        const cursor: Cursor = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(clear));
        if (Object.keys(cursor).sort().join() !== "after,cutoff,expires" || !/^[0-9a-f]{64}$/u.test(cursor.after)
            || !Number.isSafeInteger(cursor.expires) || cursor.expires <= nowEpoch
            || cursor.expires > nowEpoch + CURSOR_MS
            || new Date(cursor.cutoff).toISOString() !== cursor.cutoff || Date.parse(cursor.cutoff) > nowEpoch) throw 0;
        return cursor;
      } catch { throw new ApiError(400, "BODY_INVALID"); }
    },
  };
}

export function createPostgresV11EvidenceAdoption(deps: {
  pool: PostgresPool; schema: PostgresSchemaConfig; cursorSecret: string;
  clock?: () => number;
  observeActivation?: (invoke: () => Promise<unknown>) => Promise<unknown>;
}) {
  const { pool, schema } = deps;
  const s = quotePostgresIdentifier(schema.primarySchema);
  const t = (name: string) => `${s}.${quotePostgresIdentifier(name)}`;
  const clock = deps.clock ?? Date.now;
  const domain = createPostgresTelemetryV11Domain(pool, { schema });
  const read = <T>(invoke: (client: PostgresClient) => Promise<T>) => withPostgresRead(pool, invoke, {
    operation: "telemetry.v11.adoption.preview", statementTimeoutMilliseconds: 60_000,
    lockTimeoutMilliseconds: 1_000, preserveSafeError,
  });

  async function planDevice(principal: PostgresTelemetryV11Principal): Promise<DeviceResult> {
    return read(async client => {
      const nowEpoch = clock();
      await assertPostgresCollectionControl(client, schema.primarySchema, "processing");
      const successor = await client.query(`SELECT 1 WHERE
        EXISTS (SELECT 1 FROM ${t("telemetry_v12_day_manifests")} WHERE participant_id = $1)
        OR EXISTS (SELECT 1 FROM ${t("telemetry_v12_domain_heads")} WHERE participant_id = $1)
        OR EXISTS (SELECT 1 FROM ${t("telemetry_v12_typed_active_authorizations")} WHERE participant_id = $1)`, [principal.participantId]);
      if (successor.rows.length) return { outcome: "successor_active" };
      try { await assertPostgresTelemetryTransportWriteAllowed(client, principal,
        TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION, { schema, nowEpoch, lock: false }); }
      catch (error) {
        if (error instanceof ApiError && [401, 403].includes(error.status)) return { outcome: "authority_unavailable" };
        throw error;
      }
      const busy = await client.query(`SELECT 1 FROM ${t("telemetry_v11_domain_predecessors")}
        WHERE participant_id = $1 AND consumed_at IS NULL AND created_at > $2::timestamptz LIMIT 1`,
        [principal.participantId, new Date(nowEpoch - PREDECESSOR_OWNERSHIP_MS).toISOString()]);
      if (busy.rows.length) return { outcome: "client_syncing" };
      const state = (await client.query<State>(`SELECT h.generation_id, v.revision::text AS input_revision,
        to_char(d.from_day, 'YYYY-MM-DD') AS from_day, to_char(d.through_day, 'YYYY-MM-DD') AS through_day, d.device_id
        FROM ${t("telemetry_v11_domain_heads")} h JOIN ${t("telemetry_v11_domains")} d ON d.id = h.generation_id
        JOIN ${t("community_analytical_input_versions")} v ON v.participant_id = h.participant_id
        WHERE h.participant_id = $1`, [principal.participantId])).rows[0];
      if (!state || state.device_id !== principal.deviceId) return { outcome: "unsupported_history" };
      const days = (await client.query<Day>(`SELECT to_char(day.observed_day, 'YYYY-MM-DD') AS day,
        m.id AS "manifestId", m.manifest_digest AS "manifestDigest"
        FROM ${t("telemetry_v11_domain_days")} day JOIN ${t("telemetry_v11_day_manifests")} m ON m.id = day.manifest_id
        WHERE day.generation_id = $1 ORDER BY day.observed_day LIMIT $2`,
        [state.generation_id, MAX_TELEMETRY_V11_DOMAIN_DAYS + 1])).rows;
      const ready = (await client.query<Day>(`SELECT to_char(m.chunk_day, 'YYYY-MM-DD') AS day,
        m.id AS "manifestId", m.manifest_digest AS "manifestDigest" FROM (
          SELECT DISTINCT ON (chunk_day) * FROM ${t("telemetry_v11_day_manifests")}
          WHERE participant_id = $1 AND device_id = $2 AND state = 'ready'
          ORDER BY chunk_day, created_at DESC, id COLLATE "C" DESC) m
        ORDER BY m.chunk_day LIMIT $3`,
        [principal.participantId, principal.deviceId, MAX_TELEMETRY_V11_DOMAIN_DAYS + 1])).rows;
      if (days.length > MAX_TELEMETRY_V11_DOMAIN_DAYS || ready.length > MAX_TELEMETRY_V11_DOMAIN_DAYS) {
        return { outcome: "refused", code: "SYNC_RANGE_TOO_LARGE" };
      }
      const latest = new Map(ready.map(day => [day.day, day]));
      if (days.some(day => latest.get(day.day)?.manifestId !== day.manifestId)) {
        return { outcome: "unsupported_history", code: "COVERED_DAY_REPLACEMENT_EXCLUDED" };
      }
      const span = (Date.parse(state.through_day) - Date.parse(state.from_day)) / DAY_MS + 1;
      if (days.length !== span || days.some((day, i) => day.day !==
          new Date(Date.parse(state.from_day) + i * DAY_MS).toISOString().slice(0, 10))) {
        return { outcome: "refused", code: "TELEMETRY_MANIFEST_INCOMPLETE" };
      }
      const chosen = [...days];
      for (let day = nextDay(state.through_day); latest.has(day); day = nextDay(day)) chosen.push(latest.get(day)!);
      if (chosen.length > MAX_TELEMETRY_V11_DOMAIN_DAYS) return { outcome: "refused", code: "SYNC_RANGE_TOO_LARGE" };
      const newDays = chosen.length - days.length;
      if (!newDays) return { outcome: "no_contiguous_days" };
      // READY alone is insufficient after transfer or corruption. Preview
      // checks chunk and typed-admission counts without taking write locks.
      const incomplete = await client.query(`SELECT 1 FROM ${t("telemetry_v11_day_manifests")} m
        WHERE m.id = ANY($1::text[]) AND (m.expected_chunk_count <>
          (SELECT count(*) FROM ${t("telemetry_v11_chunks")} c WHERE c.manifest_id = m.id)
          OR EXISTS (SELECT 1 FROM ${t("telemetry_v11_chunks")} c WHERE c.manifest_id = m.id AND c.record_count <>
            (SELECT count(*) FROM ${t("typed_v11_record_admissions")} a WHERE a.chunk_id = c.id))) LIMIT 1`,
        [chosen.map(day => day.manifestId)]);
      if (incomplete.rows.length) return { outcome: "refused", code: "TELEMETRY_MANIFEST_INCOMPLETE" };
      return { outcome: "adoptable", plan: { state, days: chosen, newDays } };
    });
  }

  return async ({ body, identityKey }: { body: unknown; identityKey: string }): Promise<V11EvidenceAdoptionResult> => {
    const request = parseV11EvidenceAdoptionRequest(body);
    const nowEpoch = clock();
    const codec = await cursorCodec(deps.cursorSecret, identityKey, schema.primarySchema, request.dryRun);
    const cursor = request.afterParticipantId === null
      ? { after: "", cutoff: new Date(nowEpoch).toISOString(), expires: nowEpoch + CURSOR_MS }
      : await codec.decode(request.afterParticipantId, nowEpoch);
    const details = { task: "v11_evidence_adoption", method: V11_EVIDENCE_ADOPTION_METHOD,
      dryRun: request.dryRun, maxDevices: request.maxDevices };
    let operationId: string | undefined;
    try {
      // No audit, token or pruning writes on preview, including failed previews.
      if (!request.dryRun) operationId = await beginPostgresAdminOperation(pool, schema.primarySchema,
        { action: "run_maintenance", identityKey, details });
      const page = await read(async client => {
        await assertPostgresCollectionControl(client, schema.primarySchema, "processing");
        return (await client.query<Candidate>(`WITH candidates AS (
          SELECT DISTINCT m.participant_id, m.device_id,
            encode(sha256(convert_to(jsonb_build_array($1::text, m.participant_id, m.device_id)::text, 'UTF8')), 'hex') AS order_key
          FROM ${t("telemetry_v11_day_manifests")} m
          JOIN ${t("participants")} p ON p.id = m.participant_id AND p.state = 'active' AND p.owner_kind = 'accountless'
          JOIN ${t("device_credentials")} d ON d.id = m.device_id AND d.participant_id = p.id
            AND d.state = 'active' AND d.authority_kind = 'accountless'
          JOIN ${t("telemetry_v11_domain_heads")} h ON h.participant_id = p.id
          JOIN ${t("telemetry_v11_domains")} generation ON generation.id = h.generation_id AND generation.device_id = m.device_id
          WHERE m.state = 'ready' AND m.created_at <= $2::timestamptz AND m.chunk_day > generation.through_day
            AND NOT EXISTS (SELECT 1 FROM ${t("telemetry_v11_domain_days")} accepted
              WHERE accepted.generation_id = h.generation_id AND accepted.manifest_id = m.id))
          SELECT * FROM candidates WHERE order_key > $3 ORDER BY order_key LIMIT $4`,
          [codec.orderSecret, cursor.cutoff, cursor.after, request.maxDevices + 1])).rows;
      });
      const selected = page.slice(0, request.maxDevices);
      const processed: Candidate[] = [];
      const pageStarted = clock();
      const outcomes: Record<V11EvidenceAdoptionOutcome, number> = { adopted: 0, adoptable: 0, unchanged: 0,
        authority_unavailable: 0, client_syncing: 0, successor_active: 0, unsupported_history: 0,
        no_contiguous_days: 0, refused: 0 };
      const refusals: Record<string, number> = {};
      let daysCovered = 0, newDays = 0, keptAcceptedDays = 0;
      for (const candidate of selected) {
        // One proof can exceed this budget; never start another after it.
        // The continuation resumes after the last device actually examined.
        if (processed.length > 0 && clock() - pageStarted >= PAGE_BUDGET_MS) break;
        const principal = { participantId: candidate.participant_id, deviceId: candidate.device_id };
        let result = await planDevice(principal);
        if (result.plan && !request.dryRun) {
          try {
            const plan = result.plan;
            const predecessor = await domain.createUploadedEvidencePredecessor(principal, {
              fromDay: plan.days[0]!.day, throughDay: plan.days.at(-1)!.day,
              previousGenerationId: plan.state.generation_id, inputRevision: Number(plan.state.input_revision),
            }, clock());
            const manifest = { schemaVersion: "telemetry-domain-manifest-v1.1" as const,
              fromDay: predecessor.fromDay, throughDay: predecessor.throughDay,
              predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
                legacyFingerprint: predecessor.legacyFingerprint }, days: plan.days, manifestDigest: "0".repeat(64) };
            manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
            const invoke = () => domain.activate(principal, manifest, clock(), true);
            await (deps.observeActivation ? deps.observeActivation(invoke) : invoke());
            result = { outcome: "adopted", plan };
          } catch (error) {
            const failure = safeError(error);
            // Unavailability includes uncertain commit acknowledgement: stop
            // the page, record failure, and require a fresh preview/recheck.
            if (failure.status >= 500) throw failure;
            result = { outcome: "refused", code: failure.code };
          }
        }
        outcomes[result.outcome] += 1;
        processed.push(candidate);
        if (result.code) refusals[result.code] = (refusals[result.code] ?? 0) + 1;
        if (result.plan) { daysCovered += result.plan.days.length; newDays += result.plan.newDays;
          keptAcceptedDays += result.plan.days.length - result.plan.newDays; }
      }
      const result: V11EvidenceAdoptionResult = { task: "v11_evidence_adoption", method: V11_EVIDENCE_ADOPTION_METHOD,
        dryRun: request.dryRun, examined: processed.length, outcomes, refusals, daysCovered, newDays, keptAcceptedDays,
        nextAfterParticipantId: page.length > processed.length
          ? await codec.encode({ ...cursor, after: processed.at(-1)!.order_key }) : null };
      if (operationId) await finishPostgresAdminOperation(pool, schema.primarySchema,
        { operationId, outcome: "success", details: { ...details, examined: result.examined, outcomes, refusals,
          daysCovered, newDays, keptAcceptedDays } });
      return result;
    } catch (error) {
      const failure = safeError(error);
      if (operationId) await finishPostgresAdminOperationBestEffort(pool, schema.primarySchema,
        { operationId, outcome: "failure", details: { ...details, code: failure.code } });
      throw failure;
    }
  };
}
