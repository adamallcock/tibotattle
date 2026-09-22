import { openOperation, identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { createProductionDeploymentLock } from './production-deployment-lock.mjs';
import { prepareStoragePlan, storageError, resolveStorageApproval, assertStorageMutationApproval,
  D1_STORAGE_CONFIRMATION, D1_STORAGE_OPERATING_CAP } from './d1-storage-plan.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function resource(value, target) {
  if (!value || typeof value.id !== 'string' || !UUID.test(value.id) || value.name !== target.name
      || !Number.isSafeInteger(value.bytes) || value.bytes < 0
      || (target.databaseId !== null && value.id !== target.databaseId)) throw storageError('RESOURCE_IDENTITY_OR_CAPACITY_MISMATCH');
  return { id: value.id, name: value.name, bytes: value.bytes };
}
function observedPrefix(observed, migrations) {
  if (!observed || !Array.isArray(observed.migrations) || observed.migrations.length > migrations.length) throw storageError('SCHEMA_RECEIPT_MISMATCH');
  for (let i = 0; i < observed.migrations.length; i++) {
    const actual = observed.migrations[i], expected = migrations[i];
    if (!actual || Object.keys(actual).sort().join() !== 'name,sha256' || actual.name !== expected.name || actual.sha256 !== expected.sha256) throw storageError('SCHEMA_RECEIPT_MISMATCH');
  }
  const count = observed.migrations.length;
  if (observed.schemaSha256 !== (count ? migrations[count - 1].afterSchemaSha256 : migrations[0].beforeSchemaSha256)) throw storageError('SCHEMA_RECEIPT_MISMATCH');
  return count;
}

/** All effects are injected. Even adapter/lock construction occurs only after
 * explicit execute and the exact reviewed plan digest have been checked. */
export async function runStorageOperation({ plan, workerRoot, repositoryRoot, directory, execute = false,
  confirmation, approvedPlanSha256, resume = false, now = Date.now(), adapterFactory,
  extension = null, approvedExtensionSha256 = null,
  lockFactory = () => createProductionDeploymentLock({ repositoryRoot }) }) {
  // An exact journal-bound expired plan may reconcile already-issued effects.
  // It does not grant a fresh mutation window: every write guard remains strict.
  const prepared = await prepareStoragePlan({ plan, workerRoot, now, allowExpired: execute && resume });
  if ((extension !== null || approvedExtensionSha256 !== null) && (!execute || !resume)) throw storageError('EXTENSION_REQUIRES_RESUME');
  if (!execute) return { status: 'planned', planSha256: prepared.planSha256, targetCount: plan.targets.length, publishingPerformed: false };
  if (confirmation !== D1_STORAGE_CONFIRMATION || approvedPlanSha256 !== prepared.planSha256 || typeof adapterFactory !== 'function') throw storageError('EXECUTE_NOT_APPROVED');
  const operation = await openOperation({ directory, kind: 'production', binding: prepared.plan, resume });
  let state = operation.record.state;
  const completedResult = () => ({ status: Object.values(state.targets ?? {}).some((target) => target.bytes >= D1_STORAGE_OPERATING_CAP)
    ? 'completed-over-budget' : 'completed', planSha256: prepared.planSha256, targetCount: plan.targets.length, publishingPerformed: true });
  try {
    const approval = resolveStorageApproval({ plan: prepared.plan, extensions: state.approvalExtensions,
      extension, approvedExtensionSha256, now });
    if (approval.extensions.length !== (state.approvalExtensions?.length ?? 0)) {
      if (!state.owner || state.status === 'completed' || state.status === 'release_intent') throw storageError('EXTENSION_NOT_NEEDED');
      state.approvalExtensions = approval.extensions;
      await operation.save(state);
    }
    if (state.status === 'completed') return completedResult();
    if (!state.owner) assertStorageMutationApproval(prepared.plan, state.approvalExtensions);
    const lock = lockFactory();
    if (state.status === 'release_intent' && await lock.status() === null) {
      // Every database was verified before this intent. A lost successful
      // release response is finishable without reissuing any remote mutation.
      state.status = 'completed'; await operation.save(state);
      return completedResult();
    }
    if (!state.owner) {
      const owner = await lock.createOwner({ id: operation.record.id, sourceCommit: plan.sourceCommit, previousSourceCommit: plan.previousSourceCommit });
      state = { status: 'lock_intent', owner, targets: {}, planSha256: prepared.planSha256 };
      await operation.save(state);
      await lock.acquire(owner);
      state.status = 'running'; await operation.save(state);
    } else {
      // A lost acquire response is reconciled by exact owner identity. Never
      // automatically reacquire a missing lock after an interrupted intent.
      await lock.assertOwned(state.owner);
    }
    const adapter = await adapterFactory({ plan: prepared.plan, qualifications: prepared.qualifications, directory,
      allowExpiredPlan: resume, approvalExtensions: state.approvalExtensions ?? [] });
    if (adapter.proof) {
      if (Object.keys(adapter.proof).sort().join() !== 'cliSha256,wranglerVersion'
          || adapter.proof.wranglerVersion !== '4.114.0' || !/^[a-f0-9]{64}$/.test(adapter.proof.cliSha256)
          || (state.transportProof && identityDigest(state.transportProof) !== identityDigest(adapter.proof))) throw storageError('TRANSPORT_PIN_CHANGED');
      state.transportProof = adapter.proof; await operation.save(state);
    }
    const guard = async () => {
      await lock.assertOwned(state.owner);
      // Re-read every source/qualification pin before every remote mutation.
      const current = await prepareStoragePlan({ plan: prepared.plan, workerRoot, now: Date.now(), allowExpired: true });
      if (current.planSha256 !== prepared.planSha256) throw storageError('PLAN_CHANGED');
      assertStorageMutationApproval(prepared.plan, state.approvalExtensions);
    };
    for (const target of plan.targets) {
      let receipt = state.targets[target.binding];
      const inventory = await adapter.inventory(target);
      if (!Array.isArray(inventory) || inventory.length > 1) throw storageError('RESOURCE_INVENTORY_AMBIGUOUS');
      if (plan.phase === 'create') {
        if (!receipt) {
          if (target.databaseId !== null) {
            if (inventory.length !== 1) throw storageError('RESOURCE_NOT_FOUND');
            receipt = { status: 'created', ...resource(inventory[0], target) };
            state.targets[target.binding] = receipt; await operation.save(state);
          } else {
            if (inventory.length !== 0) throw storageError('RESOURCE_NAME_ALREADY_EXISTS');
            await guard();
            receipt = { status: 'create_intent' };
            state.targets[target.binding] = receipt; await operation.save(state);
            await guard();
            try { await adapter.create(target); } catch { throw storageError('CREATE_RESULT_UNCERTAIN'); }
            const after = await adapter.inventory(target);
            if (!Array.isArray(after) || after.length !== 1) throw storageError('CREATE_RESULT_UNCERTAIN');
            receipt = { status: 'created', ...resource(after[0], target) };
            state.targets[target.binding] = receipt; await operation.save(state);
          }
        } else if (receipt.status === 'create_intent') {
          // Name contains the full operation UUID; an exclusive owner and a
          // durable pre-create empty inventory authorize adopting this exact
          // server-returned ID. An absent result never causes another POST.
          if (inventory.length !== 1) throw storageError('CREATE_RESULT_UNCERTAIN');
          receipt = { status: 'created', ...resource(inventory[0], target) };
          state.targets[target.binding] = receipt; await operation.save(state);
        } else {
          if (receipt.status !== 'created' || inventory.length !== 1 || inventory[0].id !== receipt.id) throw storageError('RESOURCE_IDENTITY_OR_CAPACITY_MISMATCH');
          receipt = { ...receipt, ...resource(inventory[0], { ...target, databaseId: receipt.id }) };
          state.targets[target.binding] = receipt; await operation.save(state);
        }
        continue;
      }
      if (inventory.length !== 1) throw storageError('RESOURCE_NOT_FOUND');
      let observedBytes = resource(inventory[0], target).bytes;
      const migrations = prepared.qualifications[target.binding].migrations;
      let observed = await adapter.inspect(target);
      let prefix = observedPrefix(observed, migrations);
      if (receipt?.status === 'migration_intent') {
        if (prefix !== receipt.index + 1) throw storageError('MIGRATION_RESULT_UNCERTAIN');
        receipt = { status: 'migrating', applied: prefix, schemaSha256: observed.schemaSha256, databaseId: target.databaseId, bytes: observedBytes };
        state.targets[target.binding] = receipt; await operation.save(state);
      } else if (receipt && prefix !== receipt.applied) throw storageError('MIGRATION_RECEIPT_DRIFT');
      // Existing prefix is accepted only with both exact schema and hash ledger.
      for (; prefix < migrations.length; prefix++) {
        await guard();
        const current = await adapter.inventory(target);
        if (!Array.isArray(current) || current.length !== 1) throw storageError('RESOURCE_NOT_FOUND');
        const info = resource(current[0], target);
        if (info.bytes + target.migrationGrowthBudgetBytes >= D1_STORAGE_OPERATING_CAP) throw storageError('OPERATING_CAP_EXCEEDED');
        observed = await adapter.inspect(target);
        if (observedPrefix(observed, migrations) !== prefix) throw storageError('MIGRATION_RECEIPT_DRIFT');
        state.targets[target.binding] = { status: 'migration_intent', index: prefix, name: migrations[prefix].name,
          migrationSha256: migrations[prefix].sha256, databaseId: target.databaseId };
        await operation.save(state);
        await guard();
        try { await adapter.migrate(target, migrations[prefix]); } catch { throw storageError('MIGRATION_RESULT_UNCERTAIN'); }
        observed = await adapter.inspect(target);
        if (observedPrefix(observed, migrations) !== prefix + 1) throw storageError('MIGRATION_RESULT_UNCERTAIN');
        const after = await adapter.inventory(target);
        if (!Array.isArray(after) || after.length !== 1) throw storageError('RESOURCE_NOT_FOUND');
        const finalResource = resource(after[0], target);
        observedBytes = finalResource.bytes;
        state.targets[target.binding] = { status: 'migrating', applied: prefix + 1,
          schemaSha256: observed.schemaSha256, databaseId: target.databaseId, bytes: finalResource.bytes };
        await operation.save(state);
      }
      state.targets[target.binding] = { ...state.targets[target.binding], status: 'migrated', applied: prefix,
        databaseId: target.databaseId, schemaSha256: observed.schemaSha256, bytes: observedBytes,
        qualificationSha256: target.qualificationSha256 };
      await operation.save(state);
    }
    await lock.assertOwned(state.owner);
    state.status = 'release_intent'; await operation.save(state);
    await lock.release(state.owner);
    state.status = 'completed'; await operation.save(state);
    return completedResult();
  } catch (error) {
    // Preserve the exact pending intent and owner. Reconciliation is a new
    // explicit invocation; a timestamp cannot fence an in-flight D1 request.
    state.lastFailure = /^D1_STORAGE_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'D1_STORAGE_OPERATION_UNCERTAIN';
    await operation.save(state);
    throw storageError(state.lastFailure.replace(/^D1_STORAGE_/, ''));
  } finally { operation.close(); }
}
