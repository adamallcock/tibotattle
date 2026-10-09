/** Bounded metadata planning and private saved-contribution reads for K-REPRICE. */
import type { PostgresClient } from "../postgres-client";
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import { createV11DailyProjectionValues } from "../../vendor/analytics-d43c8f92/entry";
import { quotedSchema } from "./owners";
import { analyticsV2ExclusionsSha256, analyticsV2ExcludedOn, type AnalyticsV2ExclusionRow } from "./exclusions";
import type { AnalyticsV2RunStamp } from "./kernel";
import { ANALYTICS_V2_TABLES as T } from "./contract";
import { ANALYTICS_V2_REPRICE_TABLES as R, ANALYTICS_V2_REPRICE_LIMITS,
  validAnalyticsV2RepriceBounds, repriceFail, type AnalyticsV2RepriceBounds,
  type AnalyticsV2RepriceHead, type AnalyticsV2RepriceMember } from "./reprice";

type Row = Record<string, unknown>;
const integer = (value: unknown): number => {
  const n = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  return n as number;
};
/** Stored completed receipts are closed, bounded and arithmetically consistent. */
export function validAnalyticsV2RepriceStoredReceipt(value: unknown, planSha256: unknown): boolean {
  if(!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string,unknown>;
  if(Object.keys(v).sort().join(",") !== "counts,planSha256,refusals,replayed,schema,status"
    || v.schema !== "analytics-v2-reprice-execution-v1" || v.status !== "complete" || v.replayed !== false
    || v.planSha256 !== planSha256 || typeof v.planSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(v.planSha256)
    || !v.counts || typeof v.counts !== "object" || Array.isArray(v.counts)
    || !v.refusals || typeof v.refusals !== "object" || Array.isArray(v.refusals)) return false;
  const counts = v.counts as Record<string,unknown>,refusals = v.refusals as Record<string,unknown>;
  if(Object.keys(counts).sort().join(",") !== "changed,contributionVersions,equivalent,planned,refused,unchanged"
    || Object.keys(refusals).sort().join(",") !== "contribution_invalid,member_link_unavailable,owner_set_unavailable,price_input_association_unproven,price_inputs_corrupt,price_inputs_unavailable,reprice_membership_or_evidence_drift") return false;
  const bounded = (n: unknown,max: number) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
  if(!Object.entries(counts).every(([key,n]) => bounded(n,key === "contributionVersions" ? 1000 : 32))
    || !Object.values(refusals).every((n) => bounded(n,32))) return false;
  return (counts.changed as number)+(counts.equivalent as number)+(counts.unchanged as number)+(counts.refused as number)
      === counts.planned && Object.values(refusals).reduce<number>((sum,n) => sum+(n as number),0) === counts.refused;
}
export function analyticsV2RepriceTarget(stamp: AnalyticsV2RunStamp) {
  const identity = createV11DailyProjectionValues("2026-01-01");
  if (stamp.kernel.priceRegistrySha256 !== identity.registrySha256) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
  return { kernelId: stamp.kernel.kernelId, manifestVersion: stamp.manifestVersion,
    registrySha256: identity.registrySha256, pricingMethodVersion: identity.pricingMethodVersion };
}
export interface AnalyticsV2RepriceMetadata {
  readonly headRows: readonly Row[]; readonly memberRows: readonly Row[];
  readonly exclusionsSha256: string; readonly sourceSha256: ReadonlyMap<string, string>;
  readonly counts: { readonly heads: number; readonly members: number; readonly inputBytes: number };
  readonly caps: { readonly heads: boolean; readonly members: boolean; readonly inputBytes: boolean };
  readonly planSha256: string;
}
async function schemaPresent(client: PostgresClient, s: string): Promise<void> {
  const result = await client.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL
    AND to_regclass($2) IS NOT NULL AS present`, [`${s}.${R.runs}`, `${s}.${R.equivalences}`]);
  if (result.rows.length !== 1 || result.rows[0]?.present !== true) repriceFail("ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE");
}
/** No compressed inputs or daily documents are fetched by metadata planning. */
export async function readAnalyticsV2RepriceMetadata(client: PostgresClient, options: {
  readonly schema: string; readonly bounds: AnalyticsV2RepriceBounds; readonly stamp: AnalyticsV2RunStamp;
  readonly headDays?: readonly string[];
}): Promise<AnalyticsV2RepriceMetadata> {
  const bounds = validAnalyticsV2RepriceBounds(options.bounds), s = quotedSchema(options.schema);
  const target = analyticsV2RepriceTarget(options.stamp);
  await schemaPresent(client, s);
  const heads = await client.query<Row>(`SELECT day::text,revision,payload_sha256::text,run_id::text,
    kernel_id::integer,manifest_version,
    EXISTS(SELECT 1 FROM ${s}.${T.ownerSetBootstrap} b WHERE b.day=p.day) AS recorded
    FROM ${s}.${T.publishedDaily} p WHERE day BETWEEN $1::date AND $2::date
      AND ($6::date[] IS NULL OR day=ANY($6::date[]))
      AND (payload #>> '{apiEquivalentSpend,registrySha256}' IS DISTINCT FROM $3
        OR payload #>> '{apiEquivalentSpend,pricingMethodVersion}' IS DISTINCT FROM $4)
    ORDER BY day LIMIT $5`, [bounds.fromDay, bounds.throughDay, target.registrySha256,
    target.pricingMethodVersion, bounds.maxDays + 1, options.headDays ?? null]);
  const headCap = heads.rows.length > bounds.maxDays;
  const headRows = heads.rows.slice(0, bounds.maxDays);
  const days = headRows.map((row) => String(row.day));
  const members = await client.query<Row>(`SELECT m.day::text,m.owner_digest,c.version,c.devices,
    c.values_sha256::text,c.run_id::text,c.price_kernel_id::integer,
    octet_length(c.daily_values::text) AS values_bytes,l.participant_id,
    coalesce(a.run_id,p.run_id)::text AS price_run_id,coalesce(a.kernel_id,p.kernel_id)::integer AS input_kernel_id,
    coalesce(a.inputs_sha256,p.inputs_sha256)::text AS inputs_sha256,
    coalesce(a.projection_version,p.projection_version) AS projection_version,coalesce(a.codec,p.codec) AS codec,
    coalesce(a.input_events,p.input_events) AS input_events,
    octet_length(coalesce(a.inputs,p.inputs)) AS input_bytes,
    a.values_sha256::text AS input_values_sha256
    FROM ${s}.${T.dailyOwnerSets} m
    LEFT JOIN LATERAL (SELECT * FROM ${s}.${T.dailyContributions} c
      WHERE c.day=m.day AND c.owner_digest=m.owner_digest ORDER BY version DESC LIMIT 1) c ON true
    LEFT JOIN ${s}.storage_v11_owner_links l ON l.owner_digest=m.owner_digest
    LEFT JOIN ${s}.${T.ownerDayPrice} p ON p.owner_digest=m.owner_digest AND p.day=m.day
    LEFT JOIN ${s}.${R.contributionPriceInputs} a ON a.day=m.day AND a.owner_digest=m.owner_digest AND a.version=c.version
    WHERE m.day=ANY($1::date[]) ORDER BY m.day,m.owner_digest COLLATE "C" LIMIT $2`, [days, bounds.maxMembers + 1]);
  const memberCap = members.rows.length > bounds.maxMembers;
  const memberRows = members.rows.slice(0, bounds.maxMembers).map((row) => ({ ...row }));
  // The same whole-table identity as full refresh and the public historical reader.
  const exclusions = await client.query<Row>(`SELECT exclusion_id,participant_id,scope,state,
    (extract(epoch FROM effective_at)*1000000)::bigint::text AS effective_at_us,
    (extract(epoch FROM expires_at)*1000000)::bigint::text AS expires_at_us
    FROM ${s}.community_aggregate_exclusions ORDER BY exclusion_id COLLATE "C" LIMIT 10001`);
  if (exclusions.rows.length > 10000) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
  const exclusionRows: AnalyticsV2ExclusionRow[] = exclusions.rows.map((row) => ({ exclusionId: String(row.exclusion_id),
    participantId: String(row.participant_id), scope: String(row.scope), state: String(row.state),
    effectiveAtUs: integer(row.effective_at_us), expiresAtUs: row.expires_at_us === null ? null : integer(row.expires_at_us) }));
  const exclusionsSha256 = await analyticsV2ExclusionsSha256(exclusionRows);
  let inputBytes = 0, valuesBytes = 0, events = 0;
  for (const row of memberRows) {
    if (row.input_values_sha256 !== null && row.input_values_sha256 !== row.values_sha256) {
      repriceFail("ANALYTICS_V2_REPRICE_INVALID");
    }
    row.excluded = analyticsV2ExcludedOn(exclusionRows.filter((x) => x.participantId === row.participant_id
      && x.scope === "community_weekly" && x.state === "active"), String(row.day));
    inputBytes += row.input_bytes === null ? 0 : integer(row.input_bytes);
    valuesBytes += row.values_bytes === null ? 0 : integer(row.values_bytes);
    events += row.input_events === null ? 0 : integer(row.input_events);
  }
  const byteCap = inputBytes > bounds.maxInputBytes || valuesBytes > bounds.maxInputBytes
    || events > ANALYTICS_V2_REPRICE_LIMITS.events;
  const sourceSha256 = new Map<string, string>();
  for (const head of headRows) {
    const source = memberRows.filter((m) => m.day === head.day).map((m) => [m.owner_digest,m.version,m.devices,
      m.values_sha256,m.run_id,m.price_kernel_id,m.participant_id,m.excluded,
      m.inputs_sha256,m.projection_version,m.codec,m.input_events]);
    // Once a body was proved at creation, identical codec document digest
    // survives harmless replacement run IDs. First association stays strict.
    sourceSha256.set(String(head.day), await sha256Hex(canonicalJson([head.recorded,source])));
  }
  const caps = { heads: headCap, members: memberCap, inputBytes: byteCap };
  const counts = { heads: headRows.length, members: memberRows.length, inputBytes: Math.min(inputBytes,bounds.maxInputBytes) };
  const planSha256 = await sha256Hex(canonicalJson(["analytics-v2-reprice-plan-v1",bounds,target,options.stamp,exclusionsSha256,
    headRows.map((h) => [h.day,h.revision,h.payload_sha256,h.run_id,h.kernel_id,h.manifest_version,
      sourceSha256.get(String(h.day))]),caps,counts]));
  return { headRows, memberRows, exclusionsSha256, sourceSha256, counts, caps, planSha256 };
}
/** Load only the documents whose combined metadata fits the agreed cap. */
export async function loadAnalyticsV2RepriceHeads(client: PostgresClient, schema: string,
  metadata: AnalyticsV2RepriceMetadata): Promise<AnalyticsV2RepriceHead[]> {
  if (Object.values(metadata.caps).some(Boolean)) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
  const s = quotedSchema(schema);
  const days = metadata.headRows.map((h) => String(h.day));
  const payloads = await client.query<Row>(`SELECT day::text,payload FROM ${s}.${T.publishedDaily}
    WHERE day=ANY($1::date[]) ORDER BY day`, [days]);
  const documents = await client.query<Row>(`SELECT m.day::text,m.owner_digest,c.daily_values,coalesce(a.inputs,p.inputs) AS inputs
    FROM ${s}.${T.dailyOwnerSets} m
    JOIN LATERAL(SELECT daily_values,version FROM ${s}.${T.dailyContributions} c
      WHERE c.day=m.day AND c.owner_digest=m.owner_digest ORDER BY version DESC LIMIT 1)c ON true
    LEFT JOIN ${s}.${T.ownerDayPrice} p ON p.day=m.day AND p.owner_digest=m.owner_digest
    LEFT JOIN ${s}.${R.contributionPriceInputs} a ON a.day=m.day AND a.owner_digest=m.owner_digest AND a.version=c.version
    WHERE m.day=ANY($1::date[]) ORDER BY m.day,m.owner_digest COLLATE "C"`, [days]);
  if (documents.rows.length !== metadata.memberRows.length || payloads.rows.length !== days.length) {
    repriceFail("ANALYTICS_V2_REPRICE_PLAN_CHANGED");
  }
  return metadata.headRows.map((head) => {
    const payload = payloads.rows.find((p) => p.day === head.day)?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) repriceFail("ANALYTICS_V2_REPRICE_INVALID");
    const members: AnalyticsV2RepriceMember[] = metadata.memberRows.filter((m) => m.day === head.day).map((m) => {
      const doc = documents.rows.find((d) => d.day === m.day && d.owner_digest === m.owner_digest);
      const bytes = doc?.inputs;
      return { ownerDigest: String(m.owner_digest), version: integer(m.version), devices: integer(m.devices),
        values: doc?.daily_values, valuesSha256: String(m.values_sha256), runId: String(m.run_id),
        priceKernelId: integer(m.price_kernel_id), participantLinked: m.participant_id !== null,
        excluded: m.excluded === true, priceRunId: m.price_run_id === null ? null : String(m.price_run_id),
        inputKernelId: m.input_kernel_id === null ? null : integer(m.input_kernel_id),
        inputs: bytes instanceof Uint8Array ? { bytes, projectionVersion: String(m.projection_version),
          codec: String(m.codec), sha256: String(m.inputs_sha256), events: integer(m.input_events) } : null };
    });
    return { day: String(head.day), revision: integer(head.revision), payload: payload as Record<string, unknown>,
      payloadSha256: String(head.payload_sha256), recorded: head.recorded === true, members };
  });
}
/** Optional route proof: inspect source metadata ONLY for actual equivalence candidates. */
export async function readAnalyticsV2RepriceEquivalences(client: PostgresClient, options: {
  readonly schema: string; readonly heads: readonly { day: string; revision: number; payloadSha256: string }[];
  readonly stamp: AnalyticsV2RunStamp;
}): Promise<Map<string, { registrySha256: string; pricingMethodVersion: string }>> {
  const output = new Map<string, { registrySha256: string; pricingMethodVersion: string }>();
  if (options.heads.length === 0) return output;
  if (options.heads.length > ANALYTICS_V2_REPRICE_LIMITS.days) repriceFail("ANALYTICS_V2_REPRICE_LIMIT");
  const s = quotedSchema(options.schema), target = analyticsV2RepriceTarget(options.stamp);
  await schemaPresent(client, s);
  const proof = await client.query<Row>(`SELECT e.day::text,e.revision,e.payload_sha256::text,e.source_sha256::text,
    e.exclusions_sha256::text,r.receipt,r.plan_sha256::text FROM ${s}.${R.equivalences} e JOIN ${s}.${R.runs} r ON r.run_id=e.run_id
    WHERE e.day=ANY($1::date[]) AND e.kernel_id=$2 AND e.manifest_version=$3
      AND e.registry_sha256=$4 AND e.pricing_method_version=$5
      AND r.kernel_id=e.kernel_id AND r.manifest_version=e.manifest_version
      AND r.registry_sha256=e.registry_sha256 AND r.pricing_method_version=e.pricing_method_version
      AND r.receipt ->> 'status'='complete' ORDER BY e.day,e.revision LIMIT 1001`, [options.heads.map((h) => h.day),target.kernelId,
      target.manifestVersion,target.registrySha256,target.pricingMethodVersion]);
  if (proof.rows.length > 1000) return output;
  const validProofs = proof.rows.filter((p) => validAnalyticsV2RepriceStoredReceipt(p.receipt,p.plan_sha256)
    && ((p.receipt as { counts: { equivalent: number } }).counts.equivalent > 0));
  const candidates = options.heads.filter((h) => validProofs.some((p) => p.day === h.day && integer(p.revision) === h.revision
    && p.payload_sha256 === h.payloadSha256));
  if (candidates.length === 0) return output;
  const days = candidates.map((h) => h.day).sort();
  const metadata = await readAnalyticsV2RepriceMetadata(client, { schema: options.schema,stamp: options.stamp,
    bounds: { fromDay: days[0]!, throughDay: days.at(-1)!, maxDays: ANALYTICS_V2_REPRICE_LIMITS.days,
      maxMembers: ANALYTICS_V2_REPRICE_LIMITS.members,maxInputBytes: ANALYTICS_V2_REPRICE_LIMITS.inputBytes }, headDays: days });
  if (Object.values(metadata.caps).some(Boolean)) return output;
  for (const head of candidates) {
    const stored = metadata.headRows.find((row) => row.day === head.day);
    if (stored && integer(stored.revision) === head.revision && stored.payload_sha256 === head.payloadSha256
      && validProofs.some((p) => p.day === head.day && integer(p.revision) === head.revision && p.payload_sha256 === head.payloadSha256
      && p.source_sha256 === metadata.sourceSha256.get(head.day) && p.exclusions_sha256 === metadata.exclusionsSha256)) {
      output.set(head.day,{ registrySha256: target.registrySha256,pricingMethodVersion: target.pricingMethodVersion });
    }
  }
  return output;
}
