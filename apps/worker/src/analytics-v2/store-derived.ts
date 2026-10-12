/**
 * analytics_v2 store, derived families (K-SPLIT): the owner-scoped rows one
 * run recomputes (owner_day, cache_bands, owner_fits, owner_model_dates).
 *
 * Inside the run's write transaction (store.ts writeRunOutputs) it replaces
 * the computed owners' rows inside the run's horizon: owner_day rows from
 * horizon.ownerDayFromDay and cache_bands rows from horizon.cacheBandsFromDay,
 * and every fits and model-date row of those owners. Rows of owners the run
 * did not compute, and rows older than the horizon, are retained, never
 * retired: a roster change stops future contributions only, and a display
 * window is not a retention policy. Moved out of store.ts unchanged in
 * behaviour.
 */

import type { PostgresClient } from "../postgres-client";
import {
  ANALYTICS_V2_CACHE_BAND_COUNTERS,
  ANALYTICS_V2_TABLES,
  type AnalyticsV2RunOutputs,
} from "./contract";
import type { AnalyticsV2RunStamp } from "./kernel";
import {
  fail,
  insertRecordset,
  mapped,
  relation,
  rowsOf,
  type AnalyticsV2RunHorizon,
} from "./store-run";

/**
 * Replace the computed owners' owner-scoped rows inside `horizon` and return
 * how many other owners still have stored owner-scoped rows (retained).
 */
export async function writeAnalyticsV2DerivedFamilies(client: PostgresClient, schema: string,
  outputs: AnalyticsV2RunOutputs, computedOwners: readonly string[], horizon: AnalyticsV2RunHorizon,
  runId: string, stamp: AnalyticsV2RunStamp): Promise<number> {
  const kernelId = stamp.kernel.kernelId;
  const manifestVersion = stamp.manifestVersion;
  const tables = ANALYTICS_V2_TABLES;
  const ownerTables = [tables.ownerDay, tables.cacheBands, tables.ownerFits, tables.ownerModelDates];
  const retained = rowsOf<{ retained: unknown }>(await client.query(
    `SELECT count(*)::integer AS retained FROM (
       ${ownerTables.map((name) => `SELECT owner_digest FROM ${relation(schema, name)}`).join("\nUNION\n")}
     ) present WHERE NOT (owner_digest = ANY($1::text[]))`,
    [computedOwners],
  ), "ANALYTICS_V2_WRITE_FAILED");
  const retainedOwners = retained[0]?.retained;
  if (typeof retainedOwners !== "number" || !Number.isSafeInteger(retainedOwners) || retainedOwners < 0) {
    fail("ANALYTICS_V2_WRITE_FAILED", "retainedOwners");
  }
  await client.query(
    `DELETE FROM ${relation(schema, tables.ownerDay)} WHERE owner_digest = ANY($1::text[]) AND day >= $2::date`,
    [computedOwners, horizon.ownerDayFromDay],
  );
  await client.query(
    `DELETE FROM ${relation(schema, tables.cacheBands)} WHERE owner_digest = ANY($1::text[]) AND day >= $2::date`,
    [computedOwners, horizon.cacheBandsFromDay],
  );
  for (const name of [tables.ownerFits, tables.ownerModelDates]) {
    await client.query(`DELETE FROM ${relation(schema, name)} WHERE owner_digest = ANY($1::text[])`, [computedOwners]);
  }

  await insertRecordset(client,
    `INSERT INTO ${relation(schema, tables.ownerDay)}
       (owner_digest, day, daily, refusal, run_id, kernel_id, manifest_version)
     SELECT owner_digest, day, daily, refusal, run_id, kernel_id, manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(owner_digest text, day date, daily jsonb, refusal text, run_id uuid, kernel_id smallint,
                manifest_version integer)`,
    mapped(outputs.ownerDays, (row) => ({
      owner_digest: row.ownerDigest,
      day: row.day,
      daily: row.daily ?? null,
      refusal: row.refusal ?? null,
      run_id: runId,
      kernel_id: kernelId,
      manifest_version: manifestVersion,
    })),
    "ownerDays");

  const counterColumns = ANALYTICS_V2_CACHE_BAND_COUNTERS.join(", ");
  await insertRecordset(client,
    `INSERT INTO ${relation(schema, tables.cacheBands)}
       (owner_digest, day, model, effort, band, ${counterColumns}, run_id, kernel_id, manifest_version)
     SELECT owner_digest, day, model, effort, band, ${counterColumns}, run_id, kernel_id, manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(owner_digest text, day date, model text, effort text, band text,
                ${ANALYTICS_V2_CACHE_BAND_COUNTERS.map((name) => `${name} bigint`).join(", ")},
                run_id uuid, kernel_id smallint, manifest_version integer)`,
    mapped(outputs.cacheBands, (row) => ({
      owner_digest: row.ownerDigest,
      day: row.day,
      model: row.model,
      effort: row.effort,
      band: row.band,
      ...Object.fromEntries(ANALYTICS_V2_CACHE_BAND_COUNTERS.map((name) => [name, row.counters[name]])),
      run_id: runId,
      kernel_id: kernelId,
      manifest_version: manifestVersion,
    })),
    "cacheBands");

  await insertRecordset(client,
    `INSERT INTO ${relation(schema, tables.ownerFits)} (owner_digest, as_of_day, fits, run_id, kernel_id, manifest_version)
     SELECT owner_digest, as_of_day, fits, run_id, kernel_id, manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(owner_digest text, as_of_day date, fits jsonb, run_id uuid, kernel_id smallint,
                manifest_version integer)`,
    mapped(outputs.ownerFits, (row) => ({
      owner_digest: row.ownerDigest,
      as_of_day: row.asOfDay,
      fits: row.fits,
      run_id: runId,
      kernel_id: kernelId,
      manifest_version: manifestVersion,
    })),
    "ownerFits");

  await insertRecordset(client,
    `INSERT INTO ${relation(schema, tables.ownerModelDates)}
       (owner_digest, day, result, run_id, kernel_id, manifest_version)
     SELECT owner_digest, day, result, run_id, kernel_id, manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(owner_digest text, day date, result jsonb, run_id uuid, kernel_id smallint,
                manifest_version integer)`,
    mapped(outputs.ownerModelDates, (row) => ({
      owner_digest: row.ownerDigest,
      day: row.day,
      result: row.result,
      run_id: runId,
      kernel_id: kernelId,
      manifest_version: manifestVersion,
    })),
    "ownerModelDates");
  return retainedOwners as number;
}
