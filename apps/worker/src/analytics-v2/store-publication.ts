/**
 * analytics_v2 store, publication (K-SPLIT): the served community daily heads
 * and the admin allowance preview.
 *
 * Inside the run's write transaction (store.ts writeRunOutputs) it publishes
 * each daily candidate whose content digest differs from the stored head:
 * revision = nextPublishedRevision(previous, the day's revision floor,
 * revisionSeed), that is max(head, floor, seed) + 1, and releasedAt = nowMs.
 * An unchanged digest keeps the row untouched, and a blocked day is never
 * written, so it keeps its prior row (or stays absent). The preview row is
 * upserted.
 *
 * The revision floor (REV-SEED, owner decisions rounds 12 and 14) is
 * Cloudflare's last published revision per day, loaded once by the cutover
 * import before the first publication and immutable after it. A day
 * Cloudflare published at rN continues at rN+1; a day it never published
 * starts at r1. nextPublishedRevision is the ONE place a published revision
 * is computed: every publishing path (this full-mode write, and any later
 * incremental, reprice or purge republish) must call it. Static checks
 * (analytics-v2-test/publication-revision.spec.ts) hold that no other
 * analytics_v2 or refresh-Job module computes a revision, and that no
 * non-test Worker source but this one writes the published heads. A table
 * name assembled at run time escapes them; the database refuses a head at
 * or below its floor regardless (analytics_v2_published_daily_above_floor).
 */

import type { PostgresClient } from "../postgres-client";
import {
  ANALYTICS_V2_SINGLETON_ID,
  ANALYTICS_V2_TABLES,
  type AnalyticsV2Day,
} from "./contract";
import type { AnalyticsV2RunStamp } from "./kernel";
import {
  ANALYTICS_V2_MAX_DAILY_PAYLOAD_BYTES,
  ANALYTICS_V2_MAX_REVISION_SEED,
  ANALYTICS_V2_REVISION_FLOOR_TABLES,
  fail,
  forEachRecordsetChunk,
  insertRecordset,
  relation,
  rowsOf,
  stampAnalyticsV2DailyPayload,
  type PreparedOutputs,
  type StoredHeadRow,
} from "./store-run";

/**
 * The revision a changed day publishes at: one above the stored head, the
 * day's revision floor and the run's revision seed, whichever is largest.
 * `head` and `floor` are absent (undefined or null) when the day has none.
 * Pure: the same inputs always give the same revision.
 */
export function nextPublishedRevision(input: {
  readonly head?: number | null;
  readonly floor?: number | null;
  readonly seed: number;
}): number {
  const parts = [input.head ?? 0, input.floor ?? 0, input.seed];
  if (!parts.every((value) => Number.isSafeInteger(value) && value >= 0)) fail("ANALYTICS_V2_STATE_INVALID", "revision");
  return Math.max(...parts) + 1;
}

/** Publish the changed daily candidates; returns the published and unchanged days, in candidate order. */
export async function writeAnalyticsV2PublishedDaily(client: PostgresClient, schema: string,
  prepared: PreparedOutputs, runId: string, releasedAt: string, stamp: AnalyticsV2RunStamp): Promise<{
    readonly published: AnalyticsV2Day[]; readonly unchanged: AnalyticsV2Day[];
  }> {
  const tables = ANALYTICS_V2_TABLES;
  // Published heads: write only days whose content digest changed. Blocked
  // days are never named here, so their prior rows stay untouched.
  const candidateDays = prepared.dailyCandidates.map((candidate) => candidate.day);
  const heads = new Map<string, StoredHeadRow>();
  if (candidateDays.length > 0) {
    for (const row of rowsOf<StoredHeadRow>(await client.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, revision, payload_sha256
         FROM ${relation(schema, tables.publishedDaily)}
        WHERE day = ANY($1::date[]) ORDER BY day FOR UPDATE`,
      [candidateDays],
    ), "ANALYTICS_V2_WRITE_FAILED")) {
      if (typeof row.day !== "string" || typeof row.revision !== "number"
          || !Number.isSafeInteger(row.revision) || row.revision < 1
          || typeof row.payload_sha256 !== "string") {
        fail("ANALYTICS_V2_STATE_INVALID", "publishedDaily");
      }
      heads.set(row.day, row);
    }
  }
  // The revision floor of the candidate days (REV-SEED). Immutable once any
  // day is published, so reading it here, in the write transaction, is exact.
  const floors = new Map<string, number>();
  if (candidateDays.length > 0) {
    for (const row of rowsOf<{ day: unknown; revision: unknown }>(await client.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, revision
         FROM ${relation(schema, ANALYTICS_V2_REVISION_FLOOR_TABLES.revisionFloor)}
        WHERE day = ANY($1::date[]) ORDER BY day`,
      [candidateDays],
    ), "ANALYTICS_V2_WRITE_FAILED")) {
      if (typeof row.day !== "string" || typeof row.revision !== "number"
          || !Number.isSafeInteger(row.revision) || row.revision < 1
          || row.revision > ANALYTICS_V2_MAX_REVISION_SEED) {
        fail("ANALYTICS_V2_STATE_INVALID", "revisionFloor");
      }
      floors.set(row.day, row.revision);
    }
  }
  const published: AnalyticsV2Day[] = [];
  const unchanged: AnalyticsV2Day[] = [];
  const publishRows: unknown[] = [];
  for (const candidate of prepared.dailyCandidates) {
    const head = heads.get(candidate.day);
    if (head !== undefined && head.payload_sha256 === candidate.payloadSha256) {
      unchanged.push(candidate.day);
      continue;
    }
    const revision = nextPublishedRevision({ head: head?.revision, floor: floors.get(candidate.day),
      seed: prepared.revisionSeed });
    const payload = stampAnalyticsV2DailyPayload(candidate.payload, {
      day: candidate.day,
      revision,
      releasedAt,
    });
    published.push(candidate.day);
    publishRows.push({
      day: candidate.day,
      revision,
      released_at: releasedAt,
      payload,
      payload_sha256: candidate.payloadSha256,
      run_id: runId,
      kernel_id: stamp.kernel.kernelId,
      manifest_version: stamp.manifestVersion,
    });
  }
  // Size each payload exactly as 0059's CHECK does (its jsonb text form), so
  // an oversized day is refused with its own code rather than as 23514.
  await forEachRecordsetChunk(publishRows, async (chunk) => {
    const sizes = rowsOf<{ oversized: unknown }>(await client.query(
      `SELECT count(*)::integer AS oversized FROM jsonb_array_elements($1::jsonb) AS item
        WHERE octet_length((item -> 'payload')::text) > $2`,
      [chunk, ANALYTICS_V2_MAX_DAILY_PAYLOAD_BYTES],
    ), "ANALYTICS_V2_WRITE_FAILED");
    if (sizes[0]?.oversized !== 0) fail("ANALYTICS_V2_DAILY_PAYLOAD_TOO_LARGE", "dailyCandidates.payload");
  });
  // The heads are row-locked above. The upsert is still guarded (a new digest
  // and a strictly higher revision); any shortfall refuses the whole run.
  await insertRecordset(client,
    `INSERT INTO ${relation(schema, tables.publishedDaily)} AS head
       (day, revision, released_at, payload, payload_sha256, run_id, kernel_id, manifest_version)
     SELECT day, revision, released_at, payload, payload_sha256, run_id, kernel_id, manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(day date, revision integer, released_at timestamptz, payload jsonb,
                payload_sha256 text, run_id uuid, kernel_id smallint, manifest_version integer)
     ON CONFLICT (day) DO UPDATE SET
       revision = EXCLUDED.revision,
       released_at = EXCLUDED.released_at,
       payload = EXCLUDED.payload,
       payload_sha256 = EXCLUDED.payload_sha256,
       run_id = EXCLUDED.run_id,
       kernel_id = EXCLUDED.kernel_id,
       manifest_version = EXCLUDED.manifest_version
     WHERE head.payload_sha256 <> EXCLUDED.payload_sha256
       AND head.revision < EXCLUDED.revision`,
    publishRows,
    "dailyCandidates",
    "ANALYTICS_V2_PUBLICATION_CONFLICT");
  return { published, unchanged };
}

/** Upsert the preview singleton (null when the run withheld it). */
export async function writeAnalyticsV2Preview(client: PostgresClient, schema: string, preview: unknown,
  computedAt: string, runId: string, stamp: AnalyticsV2RunStamp): Promise<void> {
  await client.query(
    `INSERT INTO ${relation(schema, ANALYTICS_V2_TABLES.preview)}
       (id, preview, computed_at, run_id, kernel_id, manifest_version)
     VALUES ($1, $2::jsonb, $3::timestamptz, $4::uuid, $5::smallint, $6::integer)
     ON CONFLICT (id) DO UPDATE SET
       preview = EXCLUDED.preview, computed_at = EXCLUDED.computed_at, run_id = EXCLUDED.run_id,
       kernel_id = EXCLUDED.kernel_id, manifest_version = EXCLUDED.manifest_version`,
    [
      ANALYTICS_V2_SINGLETON_ID,
      preview === null ? null : JSON.stringify(preview),
      computedAt,
      runId,
      stamp.kernel.kernelId,
      stamp.manifestVersion,
    ],
  );
}
