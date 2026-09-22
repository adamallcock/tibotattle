import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductionTriggerRepairRehearsal } from './production-trigger-repair-rehearsal.mjs';

test('rehearses the out-of-order trigger loss and idempotent forward repair', async () => {
  const result = await runProductionTriggerRepairRehearsal();
  assert.deepEqual(result.repairTriggerNames, [
    'ingestion_analytics_payload_refusal_01',
    'ingestion_analytics_payload_refusal_15',
  ]);
  assert.match(result.repairSqlSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.outOfOrder.guardsPresentBefore0062, [true, true]);
  assert.deepEqual(result.outOfOrder.guardsPresentAfter0062, [false, false]);
  assert.equal(result.outOfOrder.dataPreserved, true);
  assert.equal(result.outOfOrder.foreignKeysClean, true);
  assert.equal(result.outOfOrder.repairAppliedTwice, true);
  assert.deepEqual(result.canonical.canonicalGuards, [true, true]);
  assert.equal(result.productionWritesPerformed, false);
});
