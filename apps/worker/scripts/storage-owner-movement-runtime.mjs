const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const BINDING = /^STORAGE_INGESTION_[ABC]$/;
const ACTIONS = new Set(['prepare', 'copy', 'fence', 'resume', 'abort']);
const fail = code => { throw new Error(`D1_STORAGE_OWNER_MOVEMENT_${code}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();

export function validateStorageOwnerMovementRuntimePlan(value) {
  if (!exact(value, ['schema', 'operationDigest', 'moveId', 'ownerDigest', 'sourceRoute',
    'destinationShardId', 'sourceNamespace', 'catalogBinding', 'sourceBinding', 'destinationBinding',
    'pageSize', 'expiresAt'])
    || value.schema !== 'storage-owner-movement-runtime-v1' || !SHA.test(value.operationDigest)
    || !ID.test(value.moveId) || !SHA.test(value.ownerDigest)
    || !exact(value.sourceRoute, ['ownerId', 'shardId', 'bindingName', 'generation', 'mode'])
    || !ID.test(value.sourceRoute.ownerId) || !ID.test(value.sourceRoute.shardId)
    || !BINDING.test(value.sourceRoute.bindingName) || value.sourceRoute.mode !== 'catalog'
    || !Number.isSafeInteger(value.sourceRoute.generation) || value.sourceRoute.generation < 1
    || !ID.test(value.destinationShardId) || value.destinationShardId === value.sourceRoute.shardId
    || typeof value.sourceNamespace !== 'string' || value.sourceNamespace.length < 1
    || value.sourceNamespace.length > 256 || value.catalogBinding !== 'STORAGE_ROUTING_DB'
    || value.sourceBinding !== value.sourceRoute.bindingName || !BINDING.test(value.destinationBinding)
    || value.destinationBinding === value.sourceBinding
    || !Number.isSafeInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 100
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) fail('PLAN_INVALID');
  return structuredClone(value);
}

function binding(env, name) {
  const value = env[name];
  if (!value || typeof value.prepare !== 'function' || typeof value.batch !== 'function') fail('CONFIGURATION_INVALID');
  return value;
}

function configured(env, plan, clock) {
  if (env.STORAGE_OWNER_MOVEMENT_MODE !== 'enabled'
    || env.STORAGE_OWNER_MOVEMENT_OPERATION_DIGEST !== plan.operationDigest
    || !Number.isSafeInteger(clock()) || clock() >= plan.expiresAt) fail('CONFIGURATION_INVALID');
  const catalog = binding(env, plan.catalogBinding), source = binding(env, plan.sourceBinding);
  const destination = binding(env, plan.destinationBinding);
  if (catalog === source || catalog === destination || source === destination) fail('CONFIGURATION_INVALID');
  return { catalog, source, destination };
}

function singleRow(result) {
  if (result?.success !== true || result.results.length > 1) fail('READBACK_INVALID');
  return result.results[0] ?? null;
}

export async function readStorageOwnerMovementRuntimeStatus(env, rawPlan) {
  const plan = validateStorageOwnerMovementRuntimePlan(rawPlan);
  const catalog = binding(env, plan.catalogBinding), source = binding(env, plan.sourceBinding);
  const destination = binding(env, plan.destinationBinding);
  const [preparationResult, routeResult, moveResult, sourceFenceResult, destinationFenceResult, controlResult,
    stagedResult, authorityResult, historyResult] =
    await Promise.all([
      catalog.prepare(`SELECT move_id,owner_id,source_shard_id,destination_shard_id,source_generation,
       destination_generation,reservation_bytes,source_namespace,state,precopy_after_source_row_id,precopy_high_water,
       final_high_water,materialized_after_source_row_id,verify_after_source_row_id,verify_chain_digest,
       authority_digest,copy_digest
       FROM storage_owner_move_preparations WHERE move_id=? LIMIT 2`).bind(plan.moveId).all(),
      catalog.prepare(`SELECT route.shard_id,shard.binding_name,route.route_generation,route.state
       FROM storage_owner_routes route JOIN storage_shards shard ON shard.shard_id=route.shard_id
       WHERE route.owner_id=? LIMIT 2`).bind(plan.sourceRoute.ownerId).all(),
      catalog.prepare(`SELECT move_id,owner_id,source_shard_id,destination_shard_id,source_generation,
       destination_generation,reservation_bytes,state,copy_digest FROM storage_owner_moves WHERE move_id=? LIMIT 2`)
        .bind(plan.moveId).all(),
      source.prepare(`SELECT shard_id,route_generation,state,move_id,copy_digest FROM storage_owner_fences
       WHERE owner_id=? LIMIT 2`).bind(plan.sourceRoute.ownerId).all(),
      destination.prepare(`SELECT shard_id,route_generation,state,move_id,copy_digest FROM storage_owner_fences
       WHERE owner_id=? LIMIT 2`).bind(plan.sourceRoute.ownerId).all(),
      destination.prepare(`SELECT state FROM storage_owner_move_copy_controls WHERE move_id=? LIMIT 2`)
        .bind(plan.moveId).all(),
      destination.prepare(`SELECT count(*) AS n,
       COALESCE(sum(CASE WHEN owner_id<>? OR source_namespace<>? THEN 1 ELSE 0 END),0) AS invalid,
       COALESCE(max(source_row_id),0) AS maximum FROM storage_owner_move_staged_records WHERE move_id=?`)
        .bind(plan.sourceRoute.ownerId, plan.sourceNamespace, plan.moveId).all(),
      destination.prepare(`SELECT owner_id,authority_digest,state FROM storage_owner_move_authority_seeds
       WHERE move_id=? LIMIT 2`).bind(plan.moveId).all(),
      destination.prepare(`SELECT owner_id,source_namespace,state,completed_digest FROM storage_owner_move_history_imports
       WHERE move_id=? LIMIT 2`).bind(plan.moveId).all(),
    ]);
  const preparation = singleRow(preparationResult), route = singleRow(routeResult);
  const move = singleRow(moveResult), authority = singleRow(authorityResult), history = singleRow(historyResult);
  const sourceFence = singleRow(sourceFenceResult), destinationFence = singleRow(destinationFenceResult);
  const control = singleRow(controlResult), staged = singleRow(stagedResult);
  if (preparation && (preparation.move_id !== plan.moveId
    || preparation.owner_id !== plan.sourceRoute.ownerId
    || preparation.source_shard_id !== plan.sourceRoute.shardId
    || preparation.destination_shard_id !== plan.destinationShardId
    || preparation.source_generation !== plan.sourceRoute.generation
    || preparation.destination_generation !== plan.sourceRoute.generation + 1
    || preparation.source_namespace !== plan.sourceNamespace)) fail('IDENTITY_CHANGED');
  if (route && (!['active', 'moving'].includes(route.state)
    || (preparation?.state === 'committed'
      ? route.shard_id !== plan.destinationShardId || route.route_generation !== plan.sourceRoute.generation + 1
        || route.state !== 'active'
      : route.shard_id !== plan.sourceRoute.shardId || route.route_generation !== plan.sourceRoute.generation)))
    fail('IDENTITY_CHANGED');
  const stagedCount = Number(staged?.n ?? 0), stagedInvalidCount = Number(staged?.invalid ?? 0),
    stagedMaximum = Number(staged?.maximum ?? 0);
  if (![stagedCount, stagedInvalidCount, stagedMaximum].every(Number.isSafeInteger)
    || stagedCount < 0 || stagedInvalidCount < 0 || stagedMaximum < 0) fail('READBACK_INVALID');
  return Object.freeze({
    state: preparation?.state ?? 'absent',
    destinationGeneration: preparation?.destination_generation ?? null,
    reservationBytes: preparation?.reservation_bytes ?? null,
    sourceNamespace: preparation?.source_namespace ?? null,
    precopyCursor: Number(preparation?.precopy_after_source_row_id ?? 0),
    precopyHighWater: Number(preparation?.precopy_high_water ?? 0),
    finalHighWater: preparation?.final_high_water === null || preparation?.final_high_water === undefined
      ? null : Number(preparation.final_high_water),
    materializedCursor: Number(preparation?.materialized_after_source_row_id ?? 0),
    verifyCursor: Number(preparation?.verify_after_source_row_id ?? 0),
    verifyChainDigest: preparation?.verify_chain_digest ?? null,
    authorityDigest: preparation?.authority_digest ?? null,
    copyDigest: preparation?.copy_digest ?? null,
    route: route ? { shardId: route.shard_id, bindingName: route.binding_name,
      generation: route.route_generation } : null,
    sourceFence: sourceFence ? { shardId: sourceFence.shard_id, generation: sourceFence.route_generation,
      state: sourceFence.state, moveId: sourceFence.move_id, copyDigest: sourceFence.copy_digest } : null,
    destinationFence: destinationFence ? { shardId: destinationFence.shard_id,
      generation: destinationFence.route_generation, state: destinationFence.state,
      moveId: destinationFence.move_id, copyDigest: destinationFence.copy_digest } : null,
    move: move ? { moveId: move.move_id, ownerId: move.owner_id, sourceShardId: move.source_shard_id,
      destinationShardId: move.destination_shard_id, sourceGeneration: move.source_generation,
      destinationGeneration: move.destination_generation, reservationBytes: move.reservation_bytes,
      state: move.state, copyDigest: move.copy_digest } : null,
    authority: authority ? { ownerId: authority.owner_id, authorityDigest: authority.authority_digest,
      state: authority.state } : null,
    history: history ? { ownerId: history.owner_id, sourceNamespace: history.source_namespace,
      state: history.state, completedDigest: history.completed_digest } : null,
    copyControl: control?.state ?? null,
    stagedCount, stagedInvalidCount, stagedMaximum,
  });
}

export function createStorageOwnerMovementWorker({ createMovement, plan: rawPlan, clock = Date.now }) {
  const plan = validateStorageOwnerMovementRuntimePlan(rawPlan);
  if (typeof createMovement !== 'function') fail('API_INVALID');
  return {
    fetch() {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    },
    async queue(batch, env) {
      const databases = configured(env, plan, clock);
      if (!Array.isArray(batch?.messages) || batch.messages.length !== 1) fail('MESSAGE_INVALID');
      const message = batch.messages[0], body = message?.body;
      if (!exact(body, ['schema', 'operationDigest', 'action', 'sequence'])
        || body.schema !== 'storage-owner-movement-wakeup-v1'
        || body.operationDigest !== plan.operationDigest || !ACTIONS.has(body.action)
        || !Number.isSafeInteger(body.sequence) || body.sequence < 1
        || typeof message.ack !== 'function') fail('MESSAGE_INVALID');
      const mover = createMovement({ catalog: databases.catalog,
        bindings: { [plan.sourceBinding]: databases.source, [plan.destinationBinding]: databases.destination }, clock });
      if (body.action === 'prepare') await mover.prepare(plan.moveId, plan.sourceRoute,
        plan.destinationShardId, plan.sourceNamespace);
      else if (body.action === 'copy') await mover.copyPage(plan.moveId, plan.pageSize);
      else if (body.action === 'fence') await mover.fenceSource(plan.moveId);
      else if (body.action === 'resume') await mover.resumeFinalization(plan.moveId);
      else await mover.rollbackPage(plan.moveId, plan.pageSize);
      message.ack();
    },
  };
}
