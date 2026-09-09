import { env } from "cloudflare:workers";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../../src/device-auth";
import { sha256Hex } from "../../src/crypto";
import { priceChunkUsageRecord, MODEL_HISTORY_METHOD_VERSION } from "../../src/quota-analysis-v1";
import { modelHistoryWindow } from "../../src/model-history-window";
import { loadV1SourcePin } from "../../src/telemetry-v1-source-selection";
import type { CommunityAnalysisWorkIdentity } from "../../src/community-analysis-work";
import { createV11DeviceFixture } from "./telemetry-v11";

export const MODEL_HISTORY_TEST_PARTICIPANT = "synthetic-model-history-participant";
export const MODEL_HISTORY_TEST_DAY = "2026-09-05";
export const MODEL_HISTORY_TEST_CAPACITIES = { "gpt-5.6-sol": 2500, "gpt-5.6-terra": 900 };
const PROVIDER = "openai_codex", BASE = Date.parse("2026-09-01T00:00:00.000Z");
const HOUR = 3_600_000, DAY_MS = 24 * HOUR, RESET = "2026-09-08T00:00:00.000Z";
const database = () => env.USAGE_MONITOR_DB;
export const modelHistoryTestTime = (hours: number) => new Date(BASE + hours * HOUR).toISOString();

export interface SyntheticModelHistoryRecord {
  stream: "quota" | "usage";
  observedAt: string;
  usedPercent?: number;
  planType?: string;
  resetsAt?: string;
  modelId?: string;
  recordJson?: string;
}
type DeviceFixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;

/** Every field is synthetic and content-free. Use the reviewed upload grant
 * helper so local SQLite still exercises the real journal/FK contracts. */
export async function insertModelHistoryRecords(fixture: DeviceFixture, label: string, records: SyntheticModelHistoryRecord[]) {
  const principal = await authenticateDevice(database(), fixture.authorization);
  const groups = new Map<string, SyntheticModelHistoryRecord[]>();
  for (const record of records) {
    const key = `${record.stream}:${record.observedAt.slice(0, 10)}`;
    const group = groups.get(key) ?? [];
    group.push(record); groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const stream = group[0]!.stream, day = group[0]!.observedAt.slice(0, 10);
    const previous = await database().prepare(`SELECT COALESCE(MAX(chunk_seq), -1) AS sequence
      FROM telemetry_v1_chunks WHERE participant_id=? AND device_id=? AND stream=? AND chunk_day=?`)
      .bind(fixture.participantId, fixture.deviceId, stream, day).first<{ sequence: number }>();
    for (let offset = 0; offset < group.length; offset += 200) {
      const page = group.slice(offset, offset + 200), id = `history-${fixture.participantId}-${label}-${key}-${offset}`;
      const digest = await sha256Hex(id);
      const upload = await createDeviceUploadAuthorization(database(), principal, digest, 200);
      const claimed = await claimDeviceUploadAuthorization(database(), `Upload ${upload.uploadAuthorization}`,
        { envelopeDigest: digest, bodyBytes: 200, contentType: "application/json" });
      await database().prepare(`INSERT INTO telemetry_v1_chunks
        (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,
         parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
        VALUES (?,?,?,?,?,?,1,?,?,'synthetic-model-history',?,?,?,?,?)`)
        .bind(id, fixture.participantId, fixture.deviceId, stream, day, previous!.sequence + 1 + offset / 200,
          digest, digest, page.length, page.length, `synthetic/model-history/${id}`, claimed.authorizationId,
          `${day}T23:59:59.999Z`).run();
      await database().batch(page.map((record, index) => database().prepare(`INSERT INTO telemetry_v1_records
        (chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,provider,
         model_id,plan_type,plan_variant,limit_id,slot,used_percent,window_duration_minutes,resets_at,record_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, fixture.participantId, fixture.deviceId, stream, `${id}-${index}`, record.observedAt, day, PROVIDER,
          record.modelId ?? null, stream === "quota" ? record.planType ?? "pro" : null,
          stream === "quota" ? "unknown" : null, stream === "quota" ? "codex" : null,
          stream === "quota" ? "seven_day" : null, record.usedPercent ?? null,
          stream === "quota" ? 10_080 : null, stream === "quota" ? record.resetsAt ?? RESET : null,
          record.recordJson ?? "{}")));
    }
  }
}

export function pricedModelHistoryUsage(modelId: string, costUsd: number, observedAt: string) {
  const json = (tokens: number) => JSON.stringify({ provider: PROVIDER, modelId,
    billingSurface: "chatgpt_subscription", apiServiceTier: "default", speedMode: "standard", totalInputContextTokens: 0,
    components: { inputUncachedTokens: 0, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
      outputTextTokens: tokens, outputReasoningTokens: 0, outputCombinedTokens: null } });
  const unit = priceChunkUsageRecord(json(1), observedAt);
  if (!unit || unit.pricingStatus !== "fully_priced" || unit.costNanousd <= 0) {
    throw new Error("synthetic model must have a fully priced unit");
  }
  const recordJson = json(Math.round(costUsd * 1e9 / unit.costNanousd));
  const priced = priceChunkUsageRecord(recordJson, observedAt)!;
  return { record: { stream: "usage" as const, observedAt, modelId, recordJson }, costUsd: priced.costNanousd / 1e9 };
}

export async function seedModelHistoryFixture(options: { participantId?: string; binCount?: number; startDay?: string } = {}) {
  const fixture = await createV11DeviceFixture(database(), { participantId: options.participantId ?? MODEL_HISTORY_TEST_PARTICIPANT });
  const base = options.startDay ? Date.parse(`${options.startDay}T00:00:00.000Z`) : BASE;
  const time = (hours: number) => new Date(base + hours * HOUR).toISOString();
  const resetsAt = new Date(base + 7 * DAY_MS).toISOString();
  const records: SyntheticModelHistoryRecord[] = [{ stream: "quota", observedAt: time(0), usedPercent: 0, resetsAt }];
  let usedPercent = 0;
  // Two independent cost columns, with the same known coefficients in both
  // interleaved halves. This must clear identification, not merely a fallback.
  for (let bin = 0; bin < (options.binCount ?? 60); bin++) {
    for (const [index, [model, capacity]] of Object.entries(MODEL_HISTORY_TEST_CAPACITIES).entries()) {
      const cost = (5 + ((bin * 7 + index * 11) % 17) / 4) * ((bin + index) % 3 === 0 ? 0.2 : 1);
      const usage = pricedModelHistoryUsage(model, cost, time(bin * 2 + 0.5));
      records.push(usage.record); usedPercent += usage.costUsd * 100 / capacity;
    }
    records.push({ stream: "quota", observedAt: time(bin * 2 + 1), usedPercent, resetsAt });
  }
  if (usedPercent >= 100) throw new Error("synthetic history fixture must stay below its quota reset");
  await insertModelHistoryRecords(fixture, "original", records);
  return fixture;
}

export async function modelHistorySourceInput(participantId: string, day = MODEL_HISTORY_TEST_DAY) {
  const window = modelHistoryWindow(day);
  const sourcePin = await loadV1SourcePin(database(),
    { participantId, fromDay: window.fromDay, throughDay: day });
  if (sourcePin.inputRevision === null) throw new Error("synthetic source revision missing");
  const identity: CommunityAnalysisWorkIdentity = {
    participantId, inputRevision: sourcePin.inputRevision, inputFingerprint: sourcePin.fingerprint,
    sourceKind: "v1", sourceMethodVersion: MODEL_HISTORY_METHOD_VERSION, fixedNow: window.fixedNow,
    observedAtCutoff: window.observedAtCutoff,
    resetsAtCutoff: new Date(Date.parse(window.observedAtCutoff) + 7 * DAY_MS).toISOString(),
    windowMinutes: 10_080, maxQuotaRows: 60_000,
  };
  return { identity, sourcePin };
}
