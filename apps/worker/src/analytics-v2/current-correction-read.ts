/** Private bounded source reads for explicit current-owner-day correction. */
import type { PostgresClient } from "../postgres-client";
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import { ANALYTICS_V2_TABLES as T } from "./contract";
import { quotedSchema } from "./owners";
import { analyticsV2KernelRegistry, type AnalyticsV2RunStamp } from "./kernel";
import { analyticsV2ExclusionsSha256, analyticsV2ExcludedOn, type AnalyticsV2ExclusionRow } from "./exclusions";
import { ANALYTICS_V2_REPRICE_TABLES as R, ANALYTICS_V2_REPRICE_LIMITS, repriceFail,
  validAnalyticsV2RepriceBounds, type AnalyticsV2RepriceBounds } from "./reprice";
import { analyticsV2RepriceTarget } from "./reprice-read";
import { validCurrentCorrectionSourceKernel, type CurrentCorrectionHead, type CurrentCorrectionMember } from "./current-correction";
type Row = Record<string, unknown>;
const integer = (value: unknown): number => {
  const n = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  return n as number;
};
const nullableInteger = (value: unknown): number | null => value === null ? null : integer(value);
export interface CurrentCorrectionOptions {
  readonly schema: string; readonly bounds: AnalyticsV2RepriceBounds; readonly stamp: AnalyticsV2RunStamp;
  readonly sourceKernelId: number;
}
export interface CurrentCorrectionMetadata {
  readonly headRows: readonly Row[]; readonly memberRows: readonly Row[];
  readonly planSha256: string;
  readonly counts: { heads: number; members: number; inputBytes: number };
  readonly caps: { heads: boolean; members: boolean; inputBytes: boolean };
}
export async function requireCurrentCorrectionSchema(client: PostgresClient, schema: string): Promise<void> {
  const r = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM information_schema.columns
    WHERE table_schema=$1 AND ((table_name=$2 AND column_name IN ('input_source','source_kernel_id'))
      OR (table_name=$3 AND column_name='correction_provenance'))`, [schema, R.runs, R.contributionPriceInputs]);
  if (r.rows.length !== 1 || r.rows[0]?.count !== 3) repriceFail("ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE");
}
/** Plans contain hashes/counts only. Neither compressed input bodies nor daily JSON leave SQL here. */
export async function readCurrentCorrectionMetadata(client: PostgresClient, options: CurrentCorrectionOptions): Promise<CurrentCorrectionMetadata> {
  const bounds = validAnalyticsV2RepriceBounds(options.bounds), sourceKernelId = validCurrentCorrectionSourceKernel(options.sourceKernelId);
  const s = quotedSchema(options.schema), target = analyticsV2RepriceTarget(options.stamp);
  const registered = analyticsV2KernelRegistry().find(kernel => kernel.kernelId === sourceKernelId);
  if (!registered || sourceKernelId > target.kernelId) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  await requireCurrentCorrectionSchema(client, options.schema);
  const sourceKernel = await client.query<Row>(`SELECT kernel_id,production_commit,vendor_manifest_sha256,
    compute_closure_sha256,price_registry_sha256,price_registry_version,method_version
    FROM ${s}.${T.kernels} WHERE kernel_id=$1`, [sourceKernelId]);
  if (sourceKernel.rows.length !== 1 || sourceKernel.rows[0]?.price_registry_sha256 !== target.registrySha256
    || sourceKernel.rows[0]?.price_registry_version !== options.stamp.kernel.priceRegistryVersion
    || sourceKernel.rows[0]?.method_version !== options.stamp.kernel.methodVersion
    || sourceKernel.rows[0]?.production_commit !== registered!.productionCommit
    || sourceKernel.rows[0]?.vendor_manifest_sha256 !== registered!.vendorManifestSha256
    || sourceKernel.rows[0]?.compute_closure_sha256 !== registered!.computeClosureSha256
    || sourceKernel.rows[0]?.price_registry_sha256 !== registered!.priceRegistrySha256
    || sourceKernel.rows[0]?.price_registry_version !== registered!.priceRegistryVersion
    || sourceKernel.rows[0]?.method_version !== registered!.methodVersion) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  const heads = await client.query<Row>(`SELECT day::text,revision,payload_sha256::text,run_id::text,kernel_id,manifest_version,
    EXISTS(SELECT 1 FROM ${s}.${T.ownerSetBootstrap} b WHERE b.day=h.day) AS recorded
    FROM ${s}.${T.publishedDaily} h WHERE day BETWEEN $1::date AND $2::date
      AND (payload #>> '{apiEquivalentSpend,registrySha256}' IS DISTINCT FROM $3
        OR payload #>> '{apiEquivalentSpend,pricingMethodVersion}' IS DISTINCT FROM $4)
    ORDER BY day LIMIT $5`, [bounds.fromDay,bounds.throughDay,target.registrySha256,target.pricingMethodVersion,bounds.maxDays+1]);
  const headRows = heads.rows.slice(0,bounds.maxDays), days = headRows.map(h => String(h.day));
  const rows = await client.query<Row>(`SELECT m.day::text,m.owner_digest,c.version,c.devices,c.values_sha256::text,
    c.run_id::text,c.price_kernel_id,c.manifest_version,octet_length(c.daily_values::text) AS values_bytes,l.participant_id,
    a.version IS NOT NULL AS archive_present,a.values_sha256::text AS archive_values_sha256,
    CASE WHEN a.version IS NOT NULL THEN a.run_id ELSE p.run_id END::text AS price_run_id,
    CASE WHEN a.version IS NOT NULL THEN a.kernel_id ELSE p.kernel_id END AS input_kernel_id,
    CASE WHEN a.version IS NOT NULL THEN a.inputs_sha256 ELSE p.inputs_sha256 END::text AS inputs_sha256,
    CASE WHEN a.version IS NOT NULL THEN a.projection_version ELSE p.projection_version END AS projection_version,
    CASE WHEN a.version IS NOT NULL THEN a.codec ELSE p.codec END AS codec,
    CASE WHEN a.version IS NOT NULL THEN a.input_events ELSE p.input_events END AS input_events,
    octet_length(CASE WHEN a.version IS NOT NULL THEN a.inputs ELSE p.inputs END) AS input_bytes,
    d.owner_digest IS NOT NULL AS current_present,d.run_id::text AS current_run_id,d.kernel_id AS current_kernel_id,
    d.manifest_version AS current_manifest_version,d.refusal AS current_refusal,
    encode(sha256(convert_to(d.daily::text,'UTF8')),'hex') AS current_values_sql_sha256,
    octet_length(d.daily::text) AS current_values_bytes,p.manifest_version AS price_manifest_version,p.usage_events,
    r.state AS run_state,r.mode AS run_mode,r.kernel_id AS run_kernel_id,r.manifest_version AS run_manifest_version,
    (extract(epoch FROM r.finished_at)*1000000)::bigint::text AS run_finished_us
    FROM ${s}.${T.dailyOwnerSets} m
    LEFT JOIN LATERAL (SELECT * FROM ${s}.${T.dailyContributions} c
      WHERE c.day=m.day AND c.owner_digest=m.owner_digest ORDER BY version DESC LIMIT 1)c ON true
    LEFT JOIN ${s}.storage_v11_owner_links l ON l.owner_digest=m.owner_digest
    LEFT JOIN ${s}.${R.contributionPriceInputs} a ON a.day=m.day AND a.owner_digest=m.owner_digest AND a.version=c.version
    LEFT JOIN ${s}.${T.ownerDay} d ON d.day=m.day AND d.owner_digest=m.owner_digest
    LEFT JOIN ${s}.${T.ownerDayPrice} p ON p.day=m.day AND p.owner_digest=m.owner_digest
    LEFT JOIN ${s}.${T.runs} r ON r.run_id=d.run_id
    WHERE m.day=ANY($1::date[]) ORDER BY m.day,m.owner_digest COLLATE "C" LIMIT $2`, [days,bounds.maxMembers+1]);
  const memberRows = rows.rows.slice(0,bounds.maxMembers).map(r => ({ ...r }));
  const exclusions = await client.query<Row>(`SELECT exclusion_id,participant_id,scope,state,
    (extract(epoch FROM effective_at)*1000000)::bigint::text AS effective_at_us,
    (extract(epoch FROM expires_at)*1000000)::bigint::text AS expires_at_us
    FROM ${s}.community_aggregate_exclusions ORDER BY exclusion_id COLLATE "C" LIMIT 10001`);
  if (exclusions.rows.length > 10000) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
  const exclusionRows: AnalyticsV2ExclusionRow[] = exclusions.rows.map(r => ({ exclusionId: String(r.exclusion_id),
    participantId: String(r.participant_id),scope: String(r.scope),state: String(r.state),
    effectiveAtUs: integer(r.effective_at_us),expiresAtUs: nullableInteger(r.expires_at_us) }));
  let inputBytes = 0, valuesBytes = 0, events = 0;
  for (const m of memberRows) {
    m.excluded = analyticsV2ExcludedOn(exclusionRows.filter(e => e.participantId === m.participant_id
      && e.scope === "community_weekly" && e.state === "active"), String(m.day));
    inputBytes += m.input_bytes === null ? 0 : integer(m.input_bytes);
    valuesBytes += m.values_bytes === null ? 0 : integer(m.values_bytes);
    if (!m.archive_present) valuesBytes += m.current_values_bytes === null ? 0 : integer(m.current_values_bytes);
    events += m.input_events === null ? 0 : integer(m.input_events);
  }
  const caps = { heads: heads.rows.length > bounds.maxDays, members: rows.rows.length > bounds.maxMembers,
    inputBytes: inputBytes > bounds.maxInputBytes || valuesBytes > bounds.maxInputBytes || events > ANALYTICS_V2_REPRICE_LIMITS.events };
  const counts = { heads: headRows.length,members: memberRows.length,inputBytes: Math.min(inputBytes,bounds.maxInputBytes) };
  const planSha256 = await sha256Hex(canonicalJson(["analytics-v2-current-correction-plan-v1","current-owner-day",
    sourceKernelId,sourceKernel.rows[0],bounds,target,options.stamp,await analyticsV2ExclusionsSha256(exclusionRows),
    headRows,memberRows,caps,counts]));
  return { headRows,memberRows,caps,counts,planSha256 };
}
export async function loadCurrentCorrectionHeads(client: PostgresClient, schema: string,
  metadata: CurrentCorrectionMetadata): Promise<CurrentCorrectionHead[]> {
  if (Object.values(metadata.caps).some(Boolean)) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
  const s = quotedSchema(schema), days = metadata.headRows.map(h => String(h.day));
  const payloads = await client.query<Row>(`SELECT day::text,payload FROM ${s}.${T.publishedDaily} WHERE day=ANY($1::date[]) ORDER BY day`, [days]);
  const docs = await client.query<Row>(`SELECT m.day::text,m.owner_digest,c.daily_values,
    CASE WHEN a.version IS NULL THEN d.daily ELSE NULL END AS current_values,
    CASE WHEN a.version IS NOT NULL THEN a.inputs ELSE p.inputs END AS inputs
    FROM ${s}.${T.dailyOwnerSets} m
    JOIN LATERAL (SELECT daily_values,version FROM ${s}.${T.dailyContributions} c
      WHERE c.day=m.day AND c.owner_digest=m.owner_digest ORDER BY version DESC LIMIT 1)c ON true
    LEFT JOIN ${s}.${R.contributionPriceInputs} a ON a.day=m.day AND a.owner_digest=m.owner_digest AND a.version=c.version
    LEFT JOIN ${s}.${T.ownerDay} d ON d.day=m.day AND d.owner_digest=m.owner_digest
    LEFT JOIN ${s}.${T.ownerDayPrice} p ON p.day=m.day AND p.owner_digest=m.owner_digest
    WHERE m.day=ANY($1::date[]) ORDER BY m.day,m.owner_digest COLLATE "C"`, [days]);
  if (docs.rows.length !== metadata.memberRows.length || payloads.rows.length !== days.length) repriceFail("ANALYTICS_V2_REPRICE_PLAN_CHANGED");
  return metadata.headRows.map(h => {
    const payload = payloads.rows.find(p => p.day === h.day)?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
    const members: CurrentCorrectionMember[] = metadata.memberRows.filter(m => m.day === h.day).map(m => {
      const doc = docs.rows.find(d => d.day === m.day && d.owner_digest === m.owner_digest), bytes = doc?.inputs;
      return { ownerDigest: String(m.owner_digest),version: integer(m.version),devices: integer(m.devices),
        values: doc?.daily_values,valuesSha256: String(m.values_sha256),runId: String(m.run_id),priceKernelId: integer(m.price_kernel_id),
        manifestVersion: integer(m.manifest_version),participantLinked: m.participant_id !== null,excluded: m.excluded === true,
        archivePresent: m.archive_present === true,archiveValuesSha256: m.archive_values_sha256 === null ? null : String(m.archive_values_sha256),
        priceRunId: m.price_run_id === null ? null : String(m.price_run_id),inputKernelId: nullableInteger(m.input_kernel_id),
        inputs: bytes instanceof Uint8Array ? { bytes,projectionVersion: String(m.projection_version),codec: String(m.codec),
          sha256: String(m.inputs_sha256),events: integer(m.input_events) } : null,
        current: m.current_present !== true ? null : { values: doc?.current_values,refusal: m.current_refusal,
          runId: String(m.current_run_id),kernelId: m.current_kernel_id === null ? 0 : integer(m.current_kernel_id),manifestVersion: integer(m.current_manifest_version),
          priceManifestVersion: m.price_manifest_version === null ? 0 : integer(m.price_manifest_version),
          usageEvents: m.usage_events === null ? 0 : integer(m.usage_events),runState: m.run_state as string | null,
          runMode: m.run_mode as string | null,runKernelId: nullableInteger(m.run_kernel_id),
          runManifestVersion: nullableInteger(m.run_manifest_version),runFinished: m.run_finished_us !== null },
      };
    });
    return { day: String(h.day),revision: integer(h.revision),payload: payload as Record<string,unknown>,
      payloadSha256: String(h.payload_sha256),recorded: h.recorded === true,members };
  });
}
