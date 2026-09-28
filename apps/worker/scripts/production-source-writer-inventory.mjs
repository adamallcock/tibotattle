import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { operationError, identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { readMaintenanceFile } from './production-maintenance.mjs';

const SNAPSHOT_SCHEMA = 'cloudflare-source-writer-snapshot-v1';
const EXPECTED_SCHEMA = 'cloudflare-source-writer-expected-graph-v1';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME = /^[a-zA-Z0-9_-]{1,63}$/;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const QUEUE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const BINDING_ROLES = Object.freeze({
  d1: ['writer', 'reader', 'read-write'],
  r2_bucket: ['writer', 'reader', 'read-write'],
  durable_object_namespace: ['writer', 'reader', 'read-write'],
  kv_namespace: ['writer', 'reader', 'read-write'],
  analytics_engine: ['writer', 'reader', 'read-write'],
  vectorize: ['writer', 'reader', 'read-write'],
  service: ['invoke'],
  queue: ['produce'],
  hyperdrive: ['connect'],
  ai: ['invoke'],
  dispatch_namespace: ['invoke'],
  assets: ['read'],
  plain_text: ['config'],
  secret_text: ['secret'],
  secret_key: ['secret'],
});
const RESOURCE_BINDINGS = new Set([
  'd1', 'r2_bucket', 'durable_object_namespace', 'kv_namespace', 'analytics_engine',
  'vectorize', 'service', 'queue', 'hyperdrive', 'ai', 'dispatch_namespace',
]);
const fail = code => { throw operationError(`SOURCE_WRITER_INVENTORY_${code}`); };
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INPUT_INVALID');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INPUT_INVALID');
};
const list = (value, max) => {
  if (!Array.isArray(value) || value.length > max) fail('INPUT_INVALID');
  return value;
};
const unique = values => new Set(values).size === values.length;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sortedBy = (values, key) => [...values].sort((a, b) => compare(key(a), key(b)));
const digest = value => identityDigest(value);

function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('INPUT_INVALID');
  const allowed = BINDING_ROLES[binding.type];
  if (!allowed) fail('BINDING_TYPE_UNCLASSIFIED');
  exact(binding, binding.type === 'r2_bucket'
    ? ['type', 'name', 'target', 'role', 'transferDisposition']
    : ['type', 'name', 'target', 'role']);
  if (!NAME.test(binding.name ?? '') || !allowed.includes(binding.role)) fail('BINDING_UNCLASSIFIED');
  if (RESOURCE_BINDINGS.has(binding.type)) {
    if (typeof binding.target !== 'string' || !TOKEN.test(binding.target)) fail('BINDING_TARGET_INVALID');
  } else if (binding.target !== null) fail('BINDING_TARGET_INVALID');
  if (binding.type === 'd1' && !UUID.test(binding.target)) fail('BINDING_TARGET_INVALID');
  if (binding.type === 'r2_bucket'
      && !['transfer', 'exclude', 'separate-review'].includes(binding.transferDisposition)) {
    fail('R2_DISPOSITION_UNCLASSIFIED');
  }
  if (binding.type === 'queue' && binding.role !== 'produce') fail('BINDING_UNCLASSIFIED');
  if (binding.type === 'service' && !NAME.test(binding.target)) fail('BINDING_TARGET_INVALID');
  const normalized = { type: binding.type, name: binding.name, target: binding.target, role: binding.role };
  if (binding.type === 'r2_bucket') normalized.transferDisposition = binding.transferDisposition;
  return normalized;
}

function validateGraph(value) {
  exact(value, ['workers', 'queues']);
  const workers = list(value.workers, 200).map(worker => {
    exact(worker, ['name', 'activeVersions', 'bindings', 'crons']);
    if (!NAME.test(worker.name ?? '')) fail('WORKER_IDENTITY_INVALID');
    const versions = list(worker.activeVersions, 16).map(version => {
      exact(version, ['id', 'percentage']);
      if (!UUID.test(version.id ?? '') || !Number.isInteger(version.percentage)
          || version.percentage < 1 || version.percentage > 100) fail('ACTIVE_VERSION_INVALID');
      return { id: version.id, percentage: version.percentage };
    });
    // This matches the existing maintenance inventory boundary: no split or
    // zero-traffic version may be treated as the single active source version.
    if (versions.length !== 1 || versions[0].percentage !== 100) fail('ACTIVE_VERSION_UNPROVEN');
    const bindings = list(worker.bindings, 200).map(validateBinding);
    const bindingKeys = bindings.map(binding => `${binding.type}:${binding.name}`);
    if (!unique(bindingKeys)) fail('BINDING_DUPLICATE');
    const crons = list(worker.crons, 32).map(cron => {
      if (typeof cron !== 'string' || cron.length > 100 || cron.trim() !== cron
          || cron.split(/\s+/).length !== 5 || !/^[a-zA-Z0-9*/?,#LW\-]+(?:\s+[a-zA-Z0-9*/?,#LW\-]+){4}$/.test(cron)) {
        fail('CRON_INVALID');
      }
      return cron;
    });
    if (!unique(crons)) fail('CRON_DUPLICATE');
    return {
      name: worker.name,
      activeVersions: versions,
      bindings: sortedBy(bindings, binding => `${binding.type}\0${binding.name}`),
      crons: [...crons].sort(),
    };
  });
  if (!unique(workers.map(worker => worker.name))) fail('WORKER_DUPLICATE');
  const workerNames = new Set(workers.map(worker => worker.name));
  const queues = list(value.queues, 200).map(queue => {
    exact(queue, ['id', 'name', 'settingsDigest', 'producers', 'consumers']);
    if (!QUEUE_ID.test(queue.id ?? '') || !NAME.test(queue.name ?? '') || !SHA.test(queue.settingsDigest ?? '')) {
      fail('QUEUE_METADATA_INVALID');
    }
    const producers = list(queue.producers, 200).map(producer => {
      exact(producer, ['worker', 'binding']);
      if (!NAME.test(producer.worker ?? '') || !NAME.test(producer.binding ?? '') || !workerNames.has(producer.worker)) {
        fail('QUEUE_REFERENCE_UNCLASSIFIED');
      }
      const owner = workers.find(worker => worker.name === producer.worker);
      if (!owner.bindings.some(binding => binding.type === 'queue' && binding.name === producer.binding && binding.target === queue.name)) {
        fail('QUEUE_REFERENCE_UNCLASSIFIED');
      }
      return { worker: producer.worker, binding: producer.binding };
    });
    if (!unique(producers.map(producer => `${producer.worker}:${producer.binding}`))) fail('QUEUE_PRODUCER_DUPLICATE');
    const consumers = list(queue.consumers, 200).map(consumer => {
      exact(consumer, ['worker', 'settingsDigest']);
      if (!NAME.test(consumer.worker ?? '') || !workerNames.has(consumer.worker) || !SHA.test(consumer.settingsDigest ?? '')) {
        fail('QUEUE_REFERENCE_UNCLASSIFIED');
      }
      return { worker: consumer.worker, settingsDigest: consumer.settingsDigest };
    });
    if (!unique(consumers.map(consumer => consumer.worker))) fail('QUEUE_CONSUMER_DUPLICATE');
    return { id: queue.id, name: queue.name, settingsDigest: queue.settingsDigest,
      producers: sortedBy(producers, producer => `${producer.worker}\0${producer.binding}`),
      consumers: sortedBy(consumers, consumer => consumer.worker) };
  });
  if (!unique(queues.map(queue => queue.id)) || !unique(queues.map(queue => queue.name))) fail('QUEUE_DUPLICATE');
  for (const worker of workers) {
    for (const binding of worker.bindings) {
      if (binding.type === 'service' && !workerNames.has(binding.target)) fail('SERVICE_REFERENCE_UNCLASSIFIED');
      if (binding.type === 'queue' && !queues.some(queue => queue.name === binding.target
          && queue.producers.some(producer => producer.worker === worker.name && producer.binding === binding.name))) {
        fail('QUEUE_REFERENCE_UNCLASSIFIED');
      }
    }
  }
  return {
    workers: sortedBy(workers, worker => worker.name),
    queues: sortedBy(queues, queue => `${queue.id}\0${queue.name}`),
  };
}

function validateSnapshot(snapshot) {
  exact(snapshot, ['schema', 'capturedAt', 'sourceProvenance', 'workers', 'queues']);
  if (snapshot.schema !== SNAPSHOT_SCHEMA || snapshot.sourceProvenance !== 'caller-supplied-unverified'
      || typeof snapshot.capturedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.capturedAt)
      || !Number.isFinite(Date.parse(snapshot.capturedAt))
      || new Date(snapshot.capturedAt).toISOString() !== snapshot.capturedAt) fail('INPUT_INVALID');
  return validateGraph({ workers: snapshot.workers, queues: snapshot.queues });
}

function validateExpectedGraph(expected) {
  exact(expected, ['schema', 'graph', 'graphDigest']);
  if (expected.schema !== EXPECTED_SCHEMA || !SHA.test(expected.graphDigest ?? '')) fail('EXPECTED_GRAPH_INVALID');
  const graph = validateGraph(expected.graph);
  if (digest(graph) !== expected.graphDigest) fail('EXPECTED_GRAPH_DIGEST_MISMATCH');
  return { graph, graphDigest: expected.graphDigest };
}

/**
 * Compare caller-supplied metadata against a separately supplied expected graph.
 * The expected graph's self-digest detects accidental changes, not who approved
 * it. A match is review evidence only: provider provenance, completeness, a
 * write fence, request drain, and cutover readiness remain unproven.
 */
export function assessSourceWriterInventory({ snapshot, expectedGraph }) {
  const graph = validateSnapshot(snapshot);
  const expected = validateExpectedGraph(expectedGraph);
  const graphDigest = digest(graph);
  return {
    assessment: graphDigest === expected.graphDigest ? 'review_required_match' : 'review_required_mismatch',
    sourceProvenance: 'caller-supplied-unverified',
    snapshotCaptureDigest: digest(snapshot),
    snapshotGraphDigest: graphDigest,
    expectedGraphDigest: expected.graphDigest,
    expectedGraphSelfDigestValid: true,
    requestDrainProven: false,
    allWritersFenced: false,
    cutoverReady: false,
  };
}

export function parseSourceWriterInventoryArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const property = { '--snapshot': 'snapshotPath', '--expected-graph': 'expectedGraphPath' }[key];
    if (!property || result[property] || !args[index + 1] || args[index + 1].startsWith('--')) fail('ARGUMENTS_INVALID');
    result[property] = args[++index];
  }
  if (!result.snapshotPath || !result.expectedGraphPath) fail('ARGUMENTS_INVALID');
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseSourceWriterInventoryArguments(process.argv.slice(2));
    const snapshot = JSON.parse((await readMaintenanceFile(options.snapshotPath, 2_000_000)).toString());
    const expectedGraph = JSON.parse((await readMaintenanceFile(options.expectedGraphPath, 2_000_000)).toString());
    const result = assessSourceWriterInventory({ snapshot, expectedGraph });
    console.log(JSON.stringify(result));
    if (result.assessment !== 'review_required_match') process.exitCode = 2;
  } catch (error) {
    console.error(/^SOURCE_WRITER_INVENTORY_[A-Z_]+$/.test(error?.code ?? '')
      ? error.code : 'SOURCE_WRITER_INVENTORY_FAILED');
    process.exitCode = 1;
  }
}
