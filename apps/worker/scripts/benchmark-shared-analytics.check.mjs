import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments, readBenchmarkSummary } from './benchmark-shared-analytics.mjs';

test('benchmark arguments select local workload explicitly and reject unknown or repeated flags', () => {
  assert.deepEqual(parseArguments([]), { full: false, modelBlock: false, dense: false, output: null, help: false });
  assert.equal(parseArguments(['--full']).full, true);
  assert.equal(parseArguments(['--model-block', '--full']).modelBlock, true);
  assert.equal(parseArguments(['--model-block', '--full', '--dense']).dense, true);
  for (const args of [['--remote'], ['--full', '--full'], ['--model-block', '--model-block'],
    ['--dense'], ['--model-block', '--dense'], ['--model-block', '--full', '--dense', '--dense'], ['--output'], ['--output', '--full']])
    assert.throws(() => parseArguments(args));
});

test('a saved report requires exactly one complete recognized summary', () => {
  const summary = { schemaVersion: 'shared-analytics-benchmark-v2', phases: { cold: {} } };
  const line = `shared-analytics-benchmark ${JSON.stringify(summary)}`;
  assert.deepEqual(readBenchmarkSummary(`Vitest output\n${line}\nDone`), summary);
  const durable = { schemaVersion: 'model-block-benchmark-v1', phases: { cold: {} } };
  assert.deepEqual(readBenchmarkSummary(`model-block-benchmark ${JSON.stringify(durable)}`, true), durable);
  assert.throws(() => readBenchmarkSummary(line, true));
  for (const output of ['', `${line}\n${line}`, 'shared-analytics-benchmark {',
    'shared-analytics-benchmark {"schemaVersion":"unrecognized","phases":{}}'])
    assert.throws(() => readBenchmarkSummary(output));
});
