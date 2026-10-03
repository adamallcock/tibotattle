/**
 * analytics_v2 store, saved owner sets (E-OWNERSET; engine v2 design section
 * 6.1-6.3, staged migration analytics_v2_owner_sets).
 *
 * Inside the run's write transaction (store.ts writeRunOutputs), after the
 * heads are published, each PUBLISHED candidate records its owner set:
 *
 *  1. the day's stored set and each member's current contribution are read
 *     FOR UPDATE, with the day's bootstrap receipt. The fold must have used
 *     exactly that set: every stored member appears among the candidate's
 *     members (a set only grows), a retained or saved member names its
 *     current version, an excluded member is stored, and a bootstrap is the
 *     day's first recording. Anything else refuses the whole run with
 *     ANALYTICS_V2_OWNER_SET_CHANGED (nothing is written);
 *  2. a computed member not yet in the set is added (first_revision = the
 *     publication's revision; provenance 1, or the bootstrap's 2 or 3) with
 *     its contribution version 1;
 *  3. a computed member already in the set appends version n + 1 when its
 *     values or devices differ from version n, and nothing otherwise;
 *  4. a frozen-window first recording writes its bootstrap receipt.
 * An unchanged or blocked day records nothing: the stored contributions are
 * always the ones its head was folded from.
 *
 * first_revision is the revision writeAnalyticsV2PublishedDaily assigned
 * through nextPublishedRevision, the single publication helper.
 *
 * Errors carry closed codes and a field path at most; never a value.
 */

import type { PostgresClient } from "../postgres-client";
import {
  ANALYTICS_V2_OWNER_SET_PROVENANCE,
  ANALYTICS_V2_TABLES,
  type AnalyticsV2Day,
  type AnalyticsV2OwnerSetSummary,
  type AnalyticsV2OwnerSetWriteSummary,
} from "./contract";
import type { AnalyticsV2RunStamp } from "./kernel";
import { analyticsV2ContributionDigests } from "./owner-sets";
import {
  fail,
  insertRecordset,
  relation,
  rowsOf,
  sortedDays,
  type PreparedDailyCandidate,
} from "./store-run";

interface StoredMemberRow {
  readonly day: unknown;
  readonly owner_digest: unknown;
  readonly version: unknown;
  readonly devices: unknown;
  readonly values_sha256: unknown;
}

interface StoredMember {
  readonly version: number;
  readonly devices: number;
  readonly valuesSha256: string;
}

function changed(field: string): never {
  return fail("ANALYTICS_V2_OWNER_SET_CHANGED", field);
}

/**
 * Record the owner sets and contributions of the published candidates (see
 * the module comment); returns the run's owner-set write summary.
 */
export async function writeAnalyticsV2OwnerSets(client: PostgresClient, schema: string,
  candidates: readonly PreparedDailyCandidate[], revisions: ReadonlyMap<AnalyticsV2Day, number>,
  fold: AnalyticsV2OwnerSetSummary, runId: string, stamp: AnalyticsV2RunStamp): Promise<AnalyticsV2OwnerSetWriteSummary> {
  const tables = ANALYTICS_V2_TABLES;
  const published = candidates.filter((candidate) => revisions.has(candidate.day));
  const days = published.map((candidate) => candidate.day);
  const stored = new Map<AnalyticsV2Day, Map<string, StoredMember>>(days.map((day) => [day, new Map()]));
  const bootstrapped = new Set<AnalyticsV2Day>();
  if (days.length > 0) {
    for (const row of rowsOf<StoredMemberRow>(await client.query(
      `SELECT to_char(member.day, 'YYYY-MM-DD') AS day, member.owner_digest,
              current.version, current.devices, current.values_sha256::text AS values_sha256
         FROM ${relation(schema, tables.dailyOwnerSets)} member
         LEFT JOIN LATERAL (
           SELECT contribution.version, contribution.devices, contribution.values_sha256
             FROM ${relation(schema, tables.dailyContributions)} contribution
            WHERE contribution.day = member.day AND contribution.owner_digest = member.owner_digest
            ORDER BY contribution.version DESC LIMIT 1) current ON true
        WHERE member.day = ANY($1::date[])
        ORDER BY member.day, member.owner_digest
        FOR UPDATE OF member`,
      [days],
    ), "ANALYTICS_V2_WRITE_FAILED")) {
      const members = typeof row.day === "string" ? stored.get(row.day) : undefined;
      if (members === undefined || typeof row.owner_digest !== "string" || members.has(row.owner_digest)
          || typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1
          || typeof row.devices !== "number" || !Number.isSafeInteger(row.devices) || row.devices < 1
          || typeof row.values_sha256 !== "string") {
        fail("ANALYTICS_V2_STATE_INVALID", "dailyOwnerSets");
      }
      members.set(row.owner_digest, { version: row.version, devices: row.devices, valuesSha256: row.values_sha256 });
    }
    for (const row of rowsOf<{ day: unknown }>(await client.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM ${relation(schema, tables.ownerSetBootstrap)}
        WHERE day = ANY($1::date[]) ORDER BY day FOR UPDATE`,
      [days],
    ), "ANALYTICS_V2_WRITE_FAILED")) {
      if (typeof row.day !== "string" || !stored.has(row.day)) fail("ANALYTICS_V2_STATE_INVALID", "ownerSetBootstrap");
      bootstrapped.add(row.day);
    }
  }

  const kernelId = stamp.kernel.kernelId;
  const manifestVersion = stamp.manifestVersion;
  const setRows: unknown[] = [];
  const contributionRows: unknown[] = [];
  const bootstrapRows: unknown[] = [];
  const verifiedDays: AnalyticsV2Day[] = [];
  const disclosedDays: AnalyticsV2Day[] = [];
  for (const candidate of published) {
    const day = candidate.day;
    const revision = revisions.get(day)!;
    const members = stored.get(day)!;
    const named = new Set(candidate.members.map((member) => member.ownerDigest));
    // A set only grows: the fold must have read every stored member.
    for (const ownerDigest of members.keys()) if (!named.has(ownerDigest)) changed("dailyCandidates.members");
    if (candidate.bootstrap !== null && (members.size > 0 || bootstrapped.has(day))) changed("dailyCandidates.bootstrap");
    const provenance = candidate.bootstrap?.provenance ?? ANALYTICS_V2_OWNER_SET_PROVENANCE.published;
    for (const member of candidate.members) {
      const current = members.get(member.ownerDigest);
      if (member.origin !== "computed") {
        if (current === undefined) changed("dailyCandidates.members");
        if (member.origin !== "excluded" && member.savedVersion !== current!.version) {
          changed("dailyCandidates.members.savedVersion");
        }
        continue;
      }
      const digests = await analyticsV2ContributionDigests(member.values);
      if (current !== undefined && current.valuesSha256 === digests.valuesSha256 && current.devices === member.devices) {
        continue;
      }
      if (current === undefined) {
        setRows.push({ day, owner_digest: member.ownerDigest, first_revision: revision, provenance, run_id: runId,
          kernel_id: kernelId, manifest_version: manifestVersion });
      }
      const values = member.values as Record<string, unknown>;
      contributionRows.push({
        day,
        owner_digest: member.ownerDigest,
        version: (current?.version ?? 0) + 1,
        evidence_fp: null,
        daily_values: values,
        values_schema: values.schemaVersion,
        values_sha256: digests.valuesSha256,
        stable_values_sha256: digests.stableValuesSha256,
        devices: member.devices,
        price_basis_id: null,
        price_kernel_id: kernelId,
        first_revision: revision,
        run_id: runId,
        kernel_id: kernelId,
        manifest_version: manifestVersion,
      });
    }
    if (candidate.bootstrap !== null) {
      bootstrapRows.push({ day, provenance: candidate.bootstrap.provenance, set_size: candidate.members.length,
        frozen_participants: candidate.bootstrap.frozenParticipants,
        frozen_export_sha256: candidate.bootstrap.frozenExportSha256, first_revision: revision, run_id: runId,
        kernel_id: kernelId, manifest_version: manifestVersion });
      (candidate.bootstrap.provenance === ANALYTICS_V2_OWNER_SET_PROVENANCE.cutoverVerified
        ? verifiedDays : disclosedDays).push(day);
    }
  }

  await insertRecordset(client,
    `INSERT INTO ${relation(schema, tables.dailyOwnerSets)}
       (day, owner_digest, first_revision, provenance, run_id, kernel_id, manifest_version)
     SELECT day, owner_digest, first_revision, provenance, run_id, kernel_id, manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(day date, owner_digest text, first_revision integer, provenance smallint, run_id uuid,
                kernel_id smallint, manifest_version integer)`,
    setRows, "dailyOwnerSets");
  await insertRecordset(client,
    `INSERT INTO ${relation(schema, tables.dailyContributions)}
       (day, owner_digest, version, evidence_fp, daily_values, values_schema, values_sha256, stable_values_sha256,
        devices, price_basis_id, price_kernel_id, first_revision, run_id, kernel_id, manifest_version)
     SELECT day, owner_digest, version, evidence_fp, daily_values, values_schema, values_sha256, stable_values_sha256,
            devices, price_basis_id, price_kernel_id, first_revision, run_id, kernel_id, manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(day date, owner_digest text, version integer, evidence_fp text, daily_values jsonb,
                values_schema text, values_sha256 text, stable_values_sha256 text, devices integer,
                price_basis_id integer, price_kernel_id smallint, first_revision integer, run_id uuid,
                kernel_id smallint, manifest_version integer)`,
    contributionRows, "dailyContributions");
  await insertRecordset(client,
    `INSERT INTO ${relation(schema, tables.ownerSetBootstrap)}
       (day, provenance, set_size, frozen_participants, frozen_export_sha256, first_revision, run_id, kernel_id,
        manifest_version)
     SELECT day, provenance, set_size, frozen_participants, frozen_export_sha256, first_revision, run_id, kernel_id,
            manifest_version
       FROM jsonb_to_recordset($1::jsonb)
         AS row(day date, provenance smallint, set_size integer, frozen_participants integer,
                frozen_export_sha256 text, first_revision integer, run_id uuid, kernel_id smallint,
                manifest_version integer)`,
    bootstrapRows, "ownerSetBootstrap");
  return Object.freeze({
    ...fold,
    membersAdded: setRows.length,
    contributionVersions: contributionRows.length,
    bootstrapVerifiedDays: Object.freeze(sortedDays(verifiedDays)),
    bootstrapDisclosedDays: Object.freeze(sortedDays(disclosedDays)),
  });
}
