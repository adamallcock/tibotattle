const WORKER = /^[A-Za-z0-9_-]{1,63}$/;
const QUEUE = /^[A-Za-z0-9_-]{1,63}$/;
const QID = /^[a-f0-9]{32}$/;
const CREATED = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();

/** Return the Worker name for ingress detection. The current API uses
 * `script`; the old alias is accepted only when it does not contradict it. */
export function queueConsumerWorkerName(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const current = typeof value.script === 'string' ? value.script : null;
  const legacy = typeof value.script_name === 'string' ? value.script_name : null;
  if (current !== null && legacy !== null && current !== legacy) return null;
  const name = current ?? legacy;
  if (name === null) return value.type === 'http_pull' ? '' : null;
  return WORKER.test(name) ? name : null;
}

/** Match the exact current Cloudflare worker-consumer representation for the
 * isolated bootstrap queue. Extra fields or relaxed delivery limits refuse. */
export function matchesExactBootstrapQueueConsumer(value, expected) {
  if (!exact(value, ['script', 'type', 'queue_name', 'queue_id', 'consumer_id', 'created_on', 'settings'])
    || !exact(value.settings, ['batch_size', 'max_retries', 'max_wait_time_ms', 'max_concurrency', 'retry_delay'])
    || !WORKER.test(expected?.workerName ?? '') || !QUEUE.test(expected?.queueName ?? '')
    || !QID.test(expected?.queueId ?? '') || queueConsumerWorkerName(value) !== expected.workerName
    || value.type !== 'worker' || value.queue_name !== expected.queueName || value.queue_id !== expected.queueId
    || !QID.test(value.consumer_id ?? '') || !CREATED.test(value.created_on ?? '')
    || value.settings.batch_size !== 1 || value.settings.max_retries !== 0
    || value.settings.max_wait_time_ms !== 1000 || value.settings.max_concurrency !== 1
    || value.settings.retry_delay !== 0) return false;
  return Number.isFinite(Date.parse(value.created_on));
}
