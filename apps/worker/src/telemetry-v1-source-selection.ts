import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";

/** Device transport dedupe, not account identity or proof of complete history. */
export const V1_SOURCE_SELECTION_METHOD_VERSION = "legacy-day-or-complete-domain-3";
export const MAX_V1_SOURCE_CHUNKS = 30_000;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type V1SourceScope = { participantId: string; fromDay?: string } | { day: string };

export interface V1SourceChunk {
  readonly id: string;
  readonly participant_id: string;
  readonly device_id: string;
  readonly chunk_day: string;
  readonly stream: "usage" | "quota" | "session";
  readonly revision: number;
  readonly chunk_digest: string;
  readonly parser_version: string;
  readonly accepted_record_count: number;
  readonly created_at: string;
}

export interface V1WinningDevice {
  readonly participant_id: string;
  readonly observed_day: string;
  readonly device_id: string;
  readonly evidence: "analytical" | "session_only";
}

export interface V1SourcePin {
  readonly methodVersion: typeof V1_SOURCE_SELECTION_METHOD_VERSION;
  readonly scope: V1SourceScope;
  readonly mutationEpoch: number;
  readonly inputRevision: number | null;
  readonly fingerprint: string;
  readonly winners: readonly V1WinningDevice[];
  readonly winnersJson: string;
}

/**
 * Shared row-IN predicate for every usage, quota, totals, and model-cell read.
 * One JSON bind avoids the variable limit and a many-row VALUES nested loop.
 */
export const V1_WINNER_FILTER_SQL = `(r.participant_id, r.observed_day, r.device_id) IN (
  SELECT json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]'),
         json_extract(je.value, '$[2]') FROM json_each(?) je
)`;

/**
 * Analytical chunks elect the single day winner. Session-only evidence is an
 * explicit fallback when no device has analytical records on that day; a late
 * session dimension must not replace another device's complete usage/quota.
 * Same-time ties use the larger device ID, independent of input order.
 */
export function selectV1WinningDevices(chunks: readonly V1SourceChunk[]): V1WinningDevice[] {
  const days = new Map<string, Map<string, {
    participantId: string; day: string; deviceId: string;
    newestAnalytical: string | null; newestSession: string | null;
  }>>();
  for (const chunk of chunks) {
    if (chunk.accepted_record_count <= 0) continue;
    const dayKey = JSON.stringify([chunk.participant_id, chunk.chunk_day]);
    let devices = days.get(dayKey);
    if (!devices) { devices = new Map(); days.set(dayKey, devices); }
    let device = devices.get(chunk.device_id);
    if (!device) {
      device = {
        participantId: chunk.participant_id, day: chunk.chunk_day,
        deviceId: chunk.device_id, newestAnalytical: null, newestSession: null,
      };
      devices.set(chunk.device_id, device);
    }
    const field = chunk.stream === "session" ? "newestSession" : "newestAnalytical";
    if (device[field] === null || chunk.created_at > device[field]!) device[field] = chunk.created_at;
  }
  const winners: V1WinningDevice[] = [];
  for (const devices of days.values()) {
    const hasAnalytical = [...devices.values()].some((device) => device.newestAnalytical !== null);
    const field = hasAnalytical ? "newestAnalytical" : "newestSession";
    const candidates = [...devices.values()].filter((device) => device[field] !== null);
    candidates.sort((left, right) => compareText(right[field]!, left[field]!)
      || compareText(right.deviceId, left.deviceId));
    const winner = candidates[0];
    if (winner) winners.push({
      participant_id: winner.participantId, observed_day: winner.day,
      device_id: winner.deviceId, evidence: hasAnalytical ? "analytical" : "session_only",
    });
  }
  return winners.sort((left, right) => compareText(left.participant_id, right.participant_id)
    || compareText(left.observed_day, right.observed_day));
}

function sourceScope(scope: V1SourceScope): { sql: string; bindings: string[] } {
  if ("participantId" in scope) {
    if (!scope.participantId) throw new TypeError("v1 source participant scope required");
    return scope.fromDay === undefined
      ? { sql: "c.participant_id = ?", bindings: [scope.participantId] }
      : { sql: "c.participant_id = ? AND c.chunk_day >= ?", bindings: [scope.participantId, scope.fromDay] };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(scope.day)) throw new TypeError("v1 source day scope required");
  return { sql: "c.chunk_day = ?", bindings: [scope.day] };
}

/**
 * Admission enforces record observed_day == chunk_day (telemetry-v1.ts), and
 * supersession atomically replaces the current records. The nonempty current
 * chunk journal therefore elects the same day devices in O(chunks), rather than
 * rescanning the million-row record partition for every consumer.
 *
 * The fingerprint covers the EXACT current input vector, not count/max/sum,
 * which can alias distinct revisions. This is an optimistic analysis pin; a
 * caller publishing durable output must additionally fence its final write
 * with the journal/publication generation inside that write's transaction.
 */
export async function loadV1SourcePin(
  db: D1Database,
  scope: V1SourceScope,
  options: { maxChunks?: number } = {},
): Promise<V1SourcePin> {
  const maxChunks = options.maxChunks ?? MAX_V1_SOURCE_CHUNKS;
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1) throw new TypeError("v1 source chunk cap invalid");
  const where = sourceScope(scope);
  const epochStatement = "participantId" in scope
    ? db.prepare(`SELECT mutation_epoch, (SELECT revision FROM community_analytical_input_versions
        WHERE participant_id = ?) AS input_revision
        FROM community_snapshot_mutation_control WHERE singleton_id = 1`).bind(scope.participantId)
    : db.prepare(`SELECT mutation_epoch, NULL AS input_revision
        FROM community_snapshot_mutation_control WHERE singleton_id = 1`);
  const results = await db.batch<V1SourceChunk | { mutation_epoch: number; input_revision: number | null }>([
    epochStatement,
    db.prepare(`SELECT c.id, c.participant_id, c.device_id, c.chunk_day,
      c.stream, c.revision, c.chunk_digest, c.parser_version,
      c.accepted_record_count, c.created_at
      FROM telemetry_analytical_chunks c
      JOIN participants p ON p.id = c.participant_id AND p.state = 'active'
      WHERE c.accepted_record_count > 0
        AND ${where.sql}
      ORDER BY c.participant_id, c.chunk_day, c.device_id, c.stream, c.id
      LIMIT ?`).bind(...where.bindings, maxChunks + 1),
  ]);
  const epochRow = results[0]?.results[0];
  const mutationEpoch = epochRow && "mutation_epoch" in epochRow ? epochRow.mutation_epoch : NaN;
  const inputRevision = epochRow && "input_revision" in epochRow ? epochRow.input_revision : null;
  if (!Number.isSafeInteger(mutationEpoch) || mutationEpoch < 0) {
    throw new Error("v1 source mutation control unavailable");
  }
  const chunks: V1SourceChunk[] = [];
  for (const row of results[1]?.results ?? []) {
    if (!("id" in row)) throw new Error("v1 source vector invalid");
    chunks.push(row);
  }
  if (chunks.length > maxChunks) throw new Error("v1 source chunk limit exceeded");
  if ("participantId" in scope && chunks.length > 0
      && (!Number.isSafeInteger(inputRevision) || inputRevision === null || inputRevision < 0)) {
    throw new Error("v1 source participant revision unavailable");
  }
  const winners = selectV1WinningDevices(chunks);
  const fingerprint = await sha256Hex(canonicalJson({
    // A different participant's upload must not invalidate this participant's
    // expensive fit. The global epoch is a publication fence, not cache input.
    methodVersion: V1_SOURCE_SELECTION_METHOD_VERSION, scope, inputRevision, chunks, winners,
  }));
  return Object.freeze({
    methodVersion: V1_SOURCE_SELECTION_METHOD_VERSION,
    scope: Object.freeze({ ...scope }), mutationEpoch, inputRevision, fingerprint,
    winners: Object.freeze(winners.map((winner) => Object.freeze(winner))),
    winnersJson: JSON.stringify(winners.map((winner) => [winner.participant_id, winner.observed_day, winner.device_id])),
  });
}

export async function assertV1SourcePinCurrent(db: D1Database, pin: V1SourcePin): Promise<void> {
  const current = await loadV1SourcePin(db, pin.scope);
  if (current.fingerprint !== pin.fingerprint) throw new Error("v1 source changed during analysis");
}
