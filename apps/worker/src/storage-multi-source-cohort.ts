import {
  assertStorageCatalogEpoch,
  captureActiveOwnerRouteSnapshot,
  type OwnerStorageRoute,
  type StorageShardBindings,
} from "./storage-routing";
import {
  captureStorageCommunityAuthority,
  readStorageCommunityOwnerPage,
} from "./storage-community-authority";
import type { StorageAnalyticsSource } from "./storage-multi-source-analytics";
import {
  publishMultiSourceAllowancePreview,
  publishMultiSourceCommunityDaily,
  type MultiSourcePublicationMember,
  type MultiSourcePublicationSet,
} from "./storage-multi-source-publication";

const MAX_COHORT = 5_000;
const ROUTE_PAGE = 500;
const OWNER_PAGE = 64;
const unavailable = () => new Error("STORAGE_MULTI_SOURCE_COHORT_UNAVAILABLE");

/** Conservative actual-statement ceiling for routing capture and both public
 * artifacts. The scheduler adds its separately declared analytics allowance. */
export function storageMultiSourceCohortPublicationQueryCeiling(
  ownerCount: number, sourceCount = 3,
): number {
  if (!Number.isSafeInteger(ownerCount) || ownerCount < 0 || ownerCount > MAX_COHORT) {
    throw unavailable();
  }
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 2 || sourceCount > 3) {
    throw unavailable();
  }
  const routePages = Math.max(1, Math.ceil(ownerCount / ROUTE_PAGE));
  // Splitting rows across sources can add one partially filled page per split.
  const sourcePages = ownerCount === 0 ? 0
    : Math.ceil(ownerCount / OWNER_PAGE) + sourceCount - 1;
  const cohort = routePages * 3 + 1 // route page batches + final epoch recheck
    + sourcePages // current shard fence pages
    + 2 * sourceCount // source authority captures
    + sourcePages * 2 + sourceCount // eligible pages, owner joins, and terminal reads
    + 2; // post-source epoch and publication-control reads
  const daily = 6 + 10 * sourceCount + sourcePages;
  const allowance = 5 + 10 * sourceCount + sourcePages;
  return cohort + daily + allowance;
}

export interface StorageMultiSourceCohortEnv {
  STORAGE_ROUTING_DB?: D1Database;
  STORAGE_INGESTION_A?: D1Database;
  STORAGE_INGESTION_B?: D1Database;
  STORAGE_INGESTION_C?: D1Database;
  STORAGE_ANALYTICS_A?: D1Database;
  STORAGE_ANALYTICS_B?: D1Database;
  STORAGE_ANALYTICS_C?: D1Database;
  STORAGE_PUBLICATION_DB?: D1Database;
  STORAGE_SOURCE_NAMESPACE_A?: string;
  STORAGE_SOURCE_NAMESPACE_B?: string;
  STORAGE_SOURCE_NAMESPACE_C?: string;
  TELEMETRY_STORAGE_NAMESPACE?: string;
}

export interface StorageMultiSourceCohort {
  readonly set: MultiSourcePublicationSet;
  readonly catalogEpoch: number;
  readonly activeRouteCount: number;
  readonly memberCount: number;
}

function database(value: unknown): value is D1Database {
  return !!value && typeof value === "object"
    && typeof Reflect.get(value, "prepare") === "function"
    && typeof Reflect.get(value, "batch") === "function";
}

function settings(env: StorageMultiSourceCohortEnv) {
  const required = [env.STORAGE_ROUTING_DB, env.STORAGE_INGESTION_A,
    env.STORAGE_INGESTION_B, env.STORAGE_INGESTION_C,
    env.STORAGE_ANALYTICS_A, env.STORAGE_ANALYTICS_B,
    env.STORAGE_PUBLICATION_DB];
  if (!required.every(database)) throw unavailable();
  const namespaceA = env.STORAGE_SOURCE_NAMESPACE_A ?? env.TELEMETRY_STORAGE_NAMESPACE;
  const namespaceB = env.STORAGE_SOURCE_NAMESPACE_B ?? env.TELEMETRY_STORAGE_NAMESPACE;
  if (typeof namespaceA !== "string" || !namespaceA
      || typeof namespaceB !== "string" || !namespaceB) throw unavailable();
  const hasAnalyticsC = database(env.STORAGE_ANALYTICS_C);
  const hasNamespaceC = typeof env.STORAGE_SOURCE_NAMESPACE_C === "string"
    && env.STORAGE_SOURCE_NAMESPACE_C.length > 0;
  if (hasAnalyticsC !== hasNamespaceC) throw unavailable();
  const values = hasAnalyticsC ? [...required, env.STORAGE_ANALYTICS_C] : required;
  if (new Set(values).size !== values.length) throw unavailable();
  const sources = [
    { bindingName: "STORAGE_INGESTION_A", source: env.STORAGE_INGESTION_A!,
      target: env.STORAGE_ANALYTICS_A!, targetId: "analytics-a", sourceNamespace: namespaceA },
    { bindingName: "STORAGE_INGESTION_B", source: env.STORAGE_INGESTION_B!,
      target: env.STORAGE_ANALYTICS_B!, targetId: "analytics-b", sourceNamespace: namespaceB },
  ];
  if (hasAnalyticsC) sources.push({
    bindingName: "STORAGE_INGESTION_C", source: env.STORAGE_INGESTION_C!,
    target: env.STORAGE_ANALYTICS_C!, targetId: "analytics-c",
    sourceNamespace: env.STORAGE_SOURCE_NAMESPACE_C!,
  });
  return {
    catalog: env.STORAGE_ROUTING_DB!,
    publicationTarget: env.STORAGE_PUBLICATION_DB!,
    routingBindings: {
      STORAGE_INGESTION_A: env.STORAGE_INGESTION_A!,
      STORAGE_INGESTION_B: env.STORAGE_INGESTION_B!,
      STORAGE_INGESTION_C: env.STORAGE_INGESTION_C!,
    } satisfies StorageShardBindings,
    sources,
  };
}

async function captureRoutes(catalog: D1Database,
  bindings: StorageShardBindings): Promise<{ epoch: number; routes: OwnerStorageRoute[] }> {
  const routes: OwnerStorageRoute[] = [];
  let afterOwnerId = "";
  let epoch: number | null = null;
  for (;;) {
    const page = await captureActiveOwnerRouteSnapshot({
      catalog, bindings, afterOwnerId, limit: ROUTE_PAGE,
    });
    if (epoch === null) epoch = page.catalogEpoch;
    if (page.catalogEpoch !== epoch) throw unavailable();
    routes.push(...page.routes);
    if (routes.length > MAX_COHORT || (routes.length === MAX_COHORT && page.bounded)) {
      throw unavailable();
    }
    if (!page.bounded) break;
    if (!page.nextAfterOwnerId || page.nextAfterOwnerId <= afterOwnerId) throw unavailable();
    afterOwnerId = page.nextAfterOwnerId;
  }
  if (epoch === null) throw unavailable();
  // Preparing owners may have no public source yet. Their reservation cannot
  // freeze an otherwise complete cohort. Moving/offline eligible owners are
  // absent here and are rejected when source eligibility is joined below.
  await assertStorageCatalogEpoch(catalog, epoch);
  return { epoch, routes };
}

async function verifyFences(routes: readonly OwnerStorageRoute[],
  sources: ReadonlyMap<string, { source: D1Database }>): Promise<void> {
  const routesByBinding = new Map<string, OwnerStorageRoute[]>();
  for (const route of routes) {
    const grouped = routesByBinding.get(route.bindingName) ?? [];
    grouped.push(route);
    routesByBinding.set(route.bindingName, grouped);
  }
  for (const [bindingName, grouped] of routesByBinding) {
    const configured = sources.get(bindingName);
    if (!configured) throw unavailable();
    for (let offset = 0; offset < grouped.length; offset += OWNER_PAGE) {
      const page = grouped.slice(offset, offset + OWNER_PAGE);
      const rows = (await configured.source.prepare(`WITH requested AS MATERIALIZED (
        SELECT json_extract(value,'$.ownerId') AS owner_id,
          json_extract(value,'$.shardId') AS shard_id,
          json_extract(value,'$.generation') AS route_generation
        FROM json_each(?)
      )
      SELECT requested.owner_id,fence.owner_id AS matched_owner
      FROM requested LEFT JOIN storage_owner_fences fence
        ON fence.owner_id=requested.owner_id
       AND fence.shard_id=requested.shard_id
       AND fence.route_generation=requested.route_generation
       AND fence.state='active'
      ORDER BY requested.owner_id`)
        .bind(JSON.stringify(page.map(({ ownerId, shardId, generation }) => ({
          ownerId, shardId, generation,
        })))).all<{owner_id: string; matched_owner: string | null}>()).results;
      if (rows.length !== page.length || rows.some((row) => row.matched_owner !== row.owner_id)) {
        throw unavailable();
      }
    }
  }
}

async function participantOwners(source: D1Database,
  participantIds: readonly string[]): Promise<Map<string, string>> {
  const rows = (await source.prepare(`WITH requested AS MATERIALIZED (
    SELECT value AS participant_id FROM json_each(?)
  )
  SELECT requested.participant_id,
    MIN(ledger.installation_principal_id) AS owner_id,
    count(ledger.installation_principal_id) AS matches
  FROM requested
  LEFT JOIN accountless_upload_owners owner
    ON owner.participant_id=requested.participant_id AND owner.state='active'
  LEFT JOIN accountless_enrollment_ledger ledger
    ON ledger.device_id=owner.enrollment_device_id AND ledger.state='active'
  GROUP BY requested.participant_id ORDER BY requested.participant_id`)
    .bind(JSON.stringify(participantIds)).all<{
      participant_id: string; owner_id: string | null; matches: number;
    }>()).results;
  if (rows.length !== participantIds.length
      || rows.some((row) => row.matches !== 1 || typeof row.owner_id !== "string")) {
    throw unavailable();
  }
  return new Map(rows.map((row) => [row.participant_id, row.owner_id!]));
}

/** Captures every public-eligible accountless owner at one routing epoch. */
export async function captureStorageMultiSourceCohort(
  env: StorageMultiSourceCohortEnv,
): Promise<StorageMultiSourceCohort> {
  const configured = settings(env);
  const { epoch, routes } = await captureRoutes(
    configured.catalog, configured.routingBindings);
  const routesByOwner = new Map(routes.map((route) => [route.ownerId, route]));
  if (routesByOwner.size !== routes.length) throw unavailable();
  const sourcesByBinding = new Map(configured.sources.map((source) => [
    source.bindingName, source,
  ]));
  await verifyFences(routes, sourcesByBinding);

  const sources: StorageAnalyticsSource[] = [];
  const members: MultiSourcePublicationMember[] = [];
  const includedOwners = new Set<string>();
  const eligibleOwners = new Set<string>();
  const ownerDigests = new Set<string>();
  let eligibleCount = 0;
  for (const configuredSource of configured.sources) {
    const authority = await captureStorageCommunityAuthority(
      configuredSource.source,
      { sourceNamespace: configuredSource.sourceNamespace },
    );
    const source: StorageAnalyticsSource = {
      source: configuredSource.source,
      target: configuredSource.target,
      sourceId: authority.sourceId,
      sourceNamespace: authority.sourceNamespace,
      targetId: configuredSource.targetId,
    };
    sources.push(source);
    let afterParticipantId = "";
    for (;;) {
      const page = await readStorageCommunityOwnerPage(configuredSource.source, {
        afterParticipantId, limit: OWNER_PAGE,
      });
      eligibleCount += page.length;
      if (eligibleCount > MAX_COHORT) throw unavailable();
      if (!page.length) break;
      const owners = await participantOwners(configuredSource.source,
        page.map((owner) => owner.participantId));
      for (const owner of page) {
        const ownerId = owners.get(owner.participantId);
        if (!ownerId) throw unavailable();
        eligibleOwners.add(ownerId);
        const route = routesByOwner.get(ownerId);
        if (!route) throw unavailable();
        if (route.bindingName !== configuredSource.bindingName) continue;
        if (!owner.ownerDigest || owner.inputRevision < 0 || owner.ownerRevision < 1
            || ownerDigests.has(owner.ownerDigest) || includedOwners.has(ownerId)) {
          throw unavailable();
        }
        ownerDigests.add(owner.ownerDigest);
        includedOwners.add(ownerId);
        members.push({ sourceId: source.sourceId, ownerDigest: owner.ownerDigest,
          inputRevision: owner.inputRevision, ownerRevision: owner.ownerRevision,
          routeGeneration: route.generation });
      }
      if (page.length < OWNER_PAGE) break;
      const next = page.at(-1)!.participantId;
      if (next <= afterParticipantId) throw unavailable();
      afterParticipantId = next;
    }
  }
  if ([...eligibleOwners].some((ownerId) => !includedOwners.has(ownerId))) {
    throw unavailable();
  }
  await assertStorageCatalogEpoch(configured.catalog, epoch);
  const control = await configured.publicationTarget.prepare(`SELECT routing_generation,erasure_generation
    FROM analytics_multi_source_control WHERE singleton=1`)
    .first<{routing_generation: number; erasure_generation: number}>();
  if (!control || !Number.isSafeInteger(control.routing_generation)
      || control.routing_generation > epoch
      || !Number.isSafeInteger(control.erasure_generation)
      || control.erasure_generation < 0) throw unavailable();
  members.sort((left, right) => left.ownerDigest.localeCompare(right.ownerDigest));
  const set: MultiSourcePublicationSet = {
    sources,
    publicationTarget: configured.publicationTarget,
    members,
    routingGeneration: epoch,
    erasureGeneration: control.erasure_generation,
    assertRoutingCurrent: () => assertStorageCatalogEpoch(configured.catalog, epoch),
  };
  return Object.freeze({ set, catalogEpoch: epoch,
    activeRouteCount: routes.length, memberCount: members.length });
}

export async function publishStorageMultiSourceCohort(
  env: StorageMultiSourceCohortEnv,
  nowMs = Date.now(),
) {
  const cohort = await captureStorageMultiSourceCohort(env);
  const day = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
  const daily = await publishMultiSourceCommunityDaily(cohort.set, { day, nowMs });
  const allowance = await publishMultiSourceAllowancePreview(cohort.set, { nowMs });
  return { catalogEpoch: cohort.catalogEpoch, memberCount: cohort.memberCount,
    day, daily, allowance };
}
