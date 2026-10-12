import {
  prepareSharedAnalyticsDay, type SharedAnalyticsDay,
} from './analytics-shared-reducers';
import {
  assertEffectiveHistoryOwner, createEffectiveHistoryDayDependencyReader,
} from './storage-effective-history';
import {
  captureStorageCommunityAuthority, sameStorageCommunityAuthority,
  type StorageCommunityAuthority, type StorageCommunityOwner,
} from './storage-community-authority';
import {
  readEffectiveTelemetryOwnerDayPage, readEffectiveTelemetryOwnerDays,
  type EffectiveTelemetryOccurrence, type EffectiveTelemetryStream,
  type EffectiveUsageReaderCursor,
} from './telemetry-usage-effective-reader';
import { COMPOSITION_CACHE_KEY_SUFFIX } from './community-allowance';
import { COMMUNITY_DAILY_SPEND_PRICING_METHOD, COMMUNITY_DAILY_SPEND_REGISTRY_SHA256 } from './community-daily-spend';
import { CACHE_RETENTION_METHOD } from './cache-retention-values';
import { modelHistoryWindow } from './model-history-window';
import { sha256Hex } from './crypto';
import { canonicalJson } from './canonical-json';
import type { V11SourcePin } from './telemetry-v11-domain';

/** Local experiment only. No scheduled handler or public route imports this
 * module. Features and scalar input rows remain private process memory. */
export const SHARED_ANALYTICS_INPUT_METHOD = 'shared-analytics-input-experiment-v1';
const DAY_MS = 86_400_000;
const STREAMS = ['usage', 'quota', 'session'] as const;
const encoder = new TextEncoder();
type Owner = StorageCommunityOwner & { ownerDigest: string };

export interface SharedAnalyticsInputMetrics {
  preparedDays: number;
  reusedDays: number;
  dependencyDays: number;
  sourcePages: number;
  sourceRows: number;
  sourceRecordBytes: number;
  preparedBytes: number;
  retainedBytes: number;
  /** Serialized retained state, not a measurement of JavaScript heap. */
  peakRetainedBytes: number;
}

export interface SharedAnalyticsInputSnapshot {
  readonly days: readonly SharedAnalyticsDay[];
  readonly metrics: Readonly<SharedAnalyticsInputMetrics>;
  /** Recheck after computing and before accepting the local result. */
  assertCurrent(): Promise<void>;
  /** Kernel compatibility pin derived from this already fenced dependency
   * vector. It is private to the experiment, never a production cache key. */
  pinForDate(day: string): Promise<V11SourcePin>;
}

interface Entry {
  digest: string;
  stamp: string;
  value: SharedAnalyticsDay;
  bytes: number;
  rows: number;
}

export class SharedAnalyticsInputError extends Error {
  constructor(readonly code: 'SHARED_ANALYTICS_INVALID' | 'SHARED_ANALYTICS_LIMIT'
    | 'SHARED_ANALYTICS_CHANGED' | 'SHARED_ANALYTICS_BUSY' | 'SHARED_ANALYTICS_DEADLINE') {
    super(code);
    this.name = 'SharedAnalyticsInputError';
  }
}

function invalid(): never { throw new SharedAnalyticsInputError('SHARED_ANALYTICS_INVALID'); }
function size(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength; }
function daysBetween(fromDay: string, throughDay: string, limit: number): string[] {
  for (const day of [fromDay, throughDay]) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(Date.parse(day))
      || new Date(day).toISOString().slice(0, 10) !== day) invalid();
  }
  const count = (Date.parse(throughDay) - Date.parse(fromDay)) / DAY_MS + 1;
  if (!Number.isInteger(count) || count < 1) invalid();
  if (count > limit) throw new SharedAnalyticsInputError('SHARED_ANALYTICS_LIMIT');
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(fromDay) + i * DAY_MS).toISOString().slice(0, 10));
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A bounded batch cache over the real, correction-aware, version-neutral
 * reader. The owner is an authority/deduplication scope, not a worker/job key.
 * A cache instance may process another scope; doing so drops its prior state.
 *
 * Unchanged replay checks the full source authority plus owner CAS and reads
 * no raw history. After any source mutation it rechecks exact day dependencies,
 * including empty days and occurrence links outside a day. Changed days are
 * prepared in full and become reusable only after the final source fence.
 * There is no assumption that a correction remains on its original day.
 * This batch is NOT a single scheduled Worker invocation: a future production
 * adapter must supply durable bounded jobs and publication fencing separately.
 */
export function createSharedAnalyticsInputCache(options: {
  source: D1Database;
  sourceNamespace: string;
  /** Paired local benchmark control. Both modes must produce identical input. */
  dependencyMode?: 'per-day' | 'batched';
  maxBytes?: number;
  maxRows?: number;
  maxDays?: number;
}) {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const maxRows = options.maxRows ?? 200_000;
  const maxDays = options.maxDays ?? 466;
  const dependencyMode = options.dependencyMode ?? 'batched';
  if (!options.sourceNamespace || options.sourceNamespace.length > 256
    || dependencyMode !== 'per-day' && dependencyMode !== 'batched'
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000_000
    || !Number.isSafeInteger(maxDays) || maxDays < 1 || maxDays > 466) invalid();
  let entries = new Map<string, Entry>();
  let scope = '';
  let busy = false;
  let retainedBytes = 0;

  return {
    get retainedBytes() { return retainedBytes; },
    get retainedDays() { return entries.size; },
    clear() {
      if (busy) throw new SharedAnalyticsInputError('SHARED_ANALYTICS_BUSY');
      entries.clear(); scope = ''; retainedBytes = 0;
    },
    async load(input: {
      owner: Owner; fromDay: string; throughDay: string;
      signal?: AbortSignal; deadlineMs?: number;
    }): Promise<SharedAnalyticsInputSnapshot> {
      if (busy) throw new SharedAnalyticsInputError('SHARED_ANALYTICS_BUSY');
      const days = daysBetween(input.fromDay, input.throughDay, maxDays);
      if (!input.owner || !/^[a-f0-9]{64}$/u.test(input.owner.ownerDigest)
        || !input.owner.participantId || ![input.owner.ownerRevision, input.owner.authorityEpoch,
          input.owner.inputRevision].every(value => Number.isSafeInteger(value) && value >= 0)
        || input.deadlineMs !== undefined && !Number.isFinite(input.deadlineMs)) invalid();
      const owner = { ...input.owner };
      const check = () => {
        input.signal?.throwIfAborted();
        if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs)
          throw new SharedAnalyticsInputError('SHARED_ANALYTICS_DEADLINE');
      };
      check();
      busy = true;
      try {
        const nextScope = JSON.stringify([options.sourceNamespace, owner.participantId, owner.ownerDigest]);
        if (scope !== nextScope) { entries.clear(); retainedBytes = 0; scope = nextScope; }
        await assertEffectiveHistoryOwner(options.source, owner);
        const authority = await captureStorageCommunityAuthority(options.source, { sourceNamespace: options.sourceNamespace });
        const methods = [SHARED_ANALYTICS_INPUT_METHOD, COMPOSITION_CACHE_KEY_SUFFIX,
          COMMUNITY_DAILY_SPEND_PRICING_METHOD, COMMUNITY_DAILY_SPEND_REGISTRY_SHA256, CACHE_RETENTION_METHOD.version];
        const stamp = JSON.stringify([methods,
          authority, owner.ownerRevision, owner.authorityEpoch, owner.inputRevision]);
        const assertCurrent = async () => {
          check();
          await assertEffectiveHistoryOwner(options.source, owner);
          const live: StorageCommunityAuthority = await captureStorageCommunityAuthority(options.source,
            { sourceNamespace: options.sourceNamespace });
          if (!sameStorageCommunityAuthority(authority, live, true))
            throw new SharedAnalyticsInputError('SHARED_ANALYTICS_CHANGED');
        };
        const metrics: SharedAnalyticsInputMetrics = { preparedDays: 0, reusedDays: 0, dependencyDays: 0,
          sourcePages: 0, sourceRows: 0, sourceRecordBytes: 0, preparedBytes: 0,
          retainedBytes: 0, peakRetainedBytes: retainedBytes };
        const staged = new Map<string, Entry>();
        const digests = new Map<string, string>();
        const needsRead: string[] = [];
        // The dependency reader supports a maximum 101-calendar-day span.
        for (let offset = 0; offset < days.length; offset += 101) {
          check();
          const changed = days.slice(offset, offset + 101).filter(day => entries.get(day)?.stamp !== stamp);
          if (!changed.length) continue;
          const reader = await createEffectiveHistoryDayDependencyReader(options.source, owner,
            options.sourceNamespace, changed, { includeSessions: true, occurrenceLinks: dependencyMode,
              canContinue: () => { check(); return true; } });
          if (!reader) throw new SharedAnalyticsInputError('SHARED_ANALYTICS_DEADLINE');
          for (const day of changed) {
            check();
            const digest = await reader.readDigest(day);
            if (!digest) throw new SharedAnalyticsInputError('SHARED_ANALYTICS_CHANGED');
            metrics.dependencyDays++;
            digests.set(day, digest);
            if (entries.get(day)?.digest !== digest) needsRead.push(day);
          }
        }
        // Complete inventories let empty ranges remain explicit dependencies
        // without doing three empty occurrence queries on every calendar day.
        const nonempty = new Map<EffectiveTelemetryStream, Set<string>>(STREAMS.map(stream => [stream, new Set<string>()]));
        for (let offset = 0; offset < days.length; offset += 101) {
          const block = days.slice(offset, offset + 101);
          if (!block.some(day => needsRead.includes(day))) continue;
          for (const stream of STREAMS) {
            check();
            const found = await readEffectiveTelemetryOwnerDays(options.source, {
              sourceNamespace: options.sourceNamespace, ownerDigest: owner.ownerDigest,
              ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch,
              stream, fromDay: block[0]!, throughDay: block.at(-1)!,
            });
            for (const day of found) nonempty.get(stream)!.add(day);
          }
        }
        let newBytes = 0, rows = 0;
        for (const day of days) {
          check();
          const old = entries.get(day), digest = digests.get(day) ?? old?.digest;
          if (digest === undefined) throw new SharedAnalyticsInputError('SHARED_ANALYTICS_CHANGED');
          if (old && old.digest === digest) {
            staged.set(day, { ...old, stamp }); metrics.reusedDays++; rows += old.rows;
            if (rows > maxRows) throw new SharedAnalyticsInputError('SHARED_ANALYTICS_LIMIT');
            continue;
          }
          const streams: Record<EffectiveTelemetryStream, EffectiveTelemetryOccurrence[]> = { usage: [], quota: [], session: [] };
          let dayBytes = 0, dayRows = 0;
          for (const stream of STREAMS) {
            if (!nonempty.get(stream)!.has(day)) continue;
            let after: EffectiveUsageReaderCursor | undefined;
            for (;;) {
              check();
              const page = await readEffectiveTelemetryOwnerDayPage(options.source, {
                sourceNamespace: options.sourceNamespace, ownerDigest: owner.ownerDigest,
                ownerRevision: owner.ownerRevision, authorityEpoch: owner.authorityEpoch,
                stream, day, limit: 200, ...(after ? { after } : {}),
              });
              metrics.sourcePages++; metrics.sourceRows += page.rows.length;
              const bytes = size(page.rows);
              metrics.sourceRecordBytes += bytes; dayBytes += bytes; dayRows += page.rows.length;
              if (rows + dayRows > maxRows || retainedBytes + newBytes + dayBytes > maxBytes)
                throw new SharedAnalyticsInputError('SHARED_ANALYTICS_LIMIT');
              metrics.peakRetainedBytes = Math.max(metrics.peakRetainedBytes, retainedBytes + newBytes + dayBytes);
              streams[stream].push(...page.rows);
              if (!page.next) break;
              if (after && (page.next.observedAtMs < after.observedAtMs
                || page.next.observedAtMs === after.observedAtMs && page.next.occurrenceId <= after.occurrenceId)) invalid();
              after = page.next;
            }
          }
          check();
          const value = await prepareSharedAnalyticsDay({ day, ownerDigest: owner.ownerDigest, ...streams });
          const bytes = size(value);
          // Both old features and this day input coexist until preparation
          // finishes. This serialized bound is conservative, not heap telemetry.
          if (retainedBytes + newBytes + dayBytes + bytes > maxBytes)
            throw new SharedAnalyticsInputError('SHARED_ANALYTICS_LIMIT');
          metrics.peakRetainedBytes = Math.max(metrics.peakRetainedBytes, retainedBytes + newBytes + dayBytes + bytes);
          metrics.preparedDays++; metrics.preparedBytes += bytes; newBytes += bytes; rows += dayRows;
          staged.set(day, { digest, stamp, value: deepFreeze(value), bytes, rows: dayRows });
        }
        await assertCurrent();
        const pinForDate = async (day: string): Promise<V11SourcePin> => {
          daysBetween(day, day, 1);
          const fromDay = modelHistoryWindow(day).fromDay;
          const selected = daysBetween(fromDay, day, 101).map(label => {
            const entry = staged.get(label);
            if (!entry) throw new SharedAnalyticsInputError('SHARED_ANALYTICS_INVALID');
            return [label, entry.digest];
          });
          return { source: 'v1.1', participantId: owner.participantId,
            generationId: `effective:${owner.ownerDigest}`, fromDay, throughDay: day,
            inputRevision: owner.inputRevision, mutationEpoch: owner.authorityEpoch,
            fingerprint: await sha256Hex(canonicalJson([methods, owner.ownerDigest, selected])) };
        };
        entries = staged;
        retainedBytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        metrics.retainedBytes = retainedBytes;
        return Object.freeze({ days: Object.freeze(days.map(day => entries.get(day)!.value)),
          metrics: Object.freeze(metrics), assertCurrent, pinForDate });
      } catch (error) {
        // Failed authority, cancellation or resource refusal cannot leave an
        // accessible partly prepared successor or an unchecked old snapshot.
        entries.clear(); retainedBytes = 0;
        throw error;
      } finally { busy = false; }
    },
  };
}
