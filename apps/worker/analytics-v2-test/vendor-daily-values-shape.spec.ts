import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskNonCode } from '../scripts/vendor-analytics-kernels.mjs';
import { v11UsageRecord } from './kernel-parity/helpers/telemetry-v11';
import type * as Daily from '../vendor/analytics-d43c8f92/apps/worker/src/v11-daily-projection-values';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendorRoot = join(root, 'vendor/analytics-d43c8f92');
const sourcePath = 'apps/worker/src/v11-daily-projection-values.ts';
const originalCommit = 'd43c8f92a059d9c577776f7eca8a331eb305b8a6';
const invalid = { name: 'Error', message: 'V11_DAILY_PROJECTION_VALUES_INVALID' };
const day = '2026-09-28';
type Kernel = Omit<typeof Daily, 'foldV11DailyProjectionValuesTrusted'> & {
  closedShape(value: unknown, keys: readonly string[]): void;
  decimalValue(value: unknown): bigint;
};
type Fixture = { value: unknown; trace: string[] };
const fixture = (value: unknown): Fixture => ({ value, trace: [] });
const own = (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, 0]));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const git = (args: string[]) => execFileSync('git', args, { cwd: resolve(root, '../..'), maxBuffer: 64 * 1024 * 1024 });
function closing(masked: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < masked.length; index++) {
    if (masked[index] === open) depth++;
    if (masked[index] === close && --depth === 0) return index;
  }
  throw Error('UNBALANCED_SOURCE');
}
function closedText(text: string): string {
  const masked = maskNonCode(text), matches = [...masked.matchAll(/\bfunction closed\(/g)];
  assert.equal(matches.length, 1);
  const start = matches[0]!.index, brace = masked.indexOf('{', start);
  return text.slice(start, closing(masked, brace, '{', '}') + 1);
}

// Resolve the actual call-site literals, including TOKEN_KEYS/COMPONENTS.
// A new dynamic key expression must be reviewed instead of escaping coverage.
function closedKeyLists(text: string): string[][] {
  const masked = maskNonCode(text), lists: string[][] = [];
  const keys = (expression: string, seen = new Set<string>()): string[] => {
    expression = expression.trim().replace(/\s+as const$/, '');
    if (/^[A-Za-z_]\w*$/.test(expression)) {
      assert.ok(!seen.has(expression));
      const matches = [...masked.matchAll(new RegExp(`\\bconst ${expression} = `, 'g'))];
      assert.equal(matches.length, 1);
      const start = matches[0]!.index + matches[0]![0].length;
      return keys(text.slice(start, masked.indexOf(';', start)), new Set([...seen, expression]));
    }
    assert.ok(expression.startsWith('[') && expression.endsWith(']'), 'closed() keys must remain a fixed literal list');
    const body = expression.slice(1, -1), token = /\.\.\.[A-Za-z_]\w*|'[A-Za-z]\w*'/g;
    assert.match(body.replace(token, ''), /^[,\s]*$/, 'closed() keys must remain strings or fixed spreads');
    return [...body.matchAll(token)].flatMap(([item]) => item.startsWith('...') ? keys(item.slice(3), seen) : [item.slice(1, -1)]);
  };
  for (const match of masked.matchAll(/\bclosed\(/g)) {
    if (masked.slice(0, match.index).endsWith('function ')) continue;
    const start = match.index + match[0].length, end = closing(masked, start - 1, '(', ')');
    const comma = masked.indexOf(',', start);
    assert.ok(comma < end); assert.match(masked.slice(start, comma), /^[\w.]+$/);
    lists.push(keys(text.slice(comma + 1, end)));
  }
  return lists;
}
function outcome(action: () => unknown) {
  try { action(); return null; }
  catch (error) { return { name: (error as Error).name, message: (error as Error).message }; }
}
let directory: string, candidate: Kernel, oracle: Kernel, keyLists: string[][];
let candidateSource: string, oracleSource: string, originalSource: string;
let candidateInputs: string[], oracleInputs: string[];
let manifest: { sourceCommit: string; files: { path: string; blob: string; sha256: string }[] };
function compare(make: () => Fixture, action: (kernel: Kernel, value: unknown) => void, expected: ReturnType<typeof outcome>) {
  const before = make(), after = make();
  expect(outcome(() => action(oracle, before.value))).toEqual(expected);
  expect(outcome(() => action(candidate, after.value))).toEqual(expected);
  expect(after.trace).toEqual(before.trace);
}

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'tibo-daily-values-shape-')));
  manifest = JSON.parse(await readFile(join(vendorRoot, 'MANIFEST.json'), 'utf8'));
  assert.match(manifest.sourceCommit, /^[0-9a-f]{40}$/);
  const immutableRoot = join(directory, 'immutable');
  await mkdir(immutableRoot);
  // The directory name is historical; the public oracle must use the actual
  // manifest commit, including its pricing and contract dependency graph.
  const archive = git(['archive', '--format=tar', manifest.sourceCommit, 'apps/worker/src',
    'packages/accounting', 'packages/quota-analysis', 'packages/telemetry-contract']);
  execFileSync('tar', ['-x', '-C', immutableRoot], { input: archive });
  const tsconfig = await readFile(join(vendorRoot, 'tsconfig.json'), 'utf8');
  await writeFile(join(immutableRoot, 'tsconfig.json'), tsconfig);
  candidateSource = await readFile(join(vendorRoot, sourcePath), 'utf8');
  oracleSource = await readFile(join(immutableRoot, sourcePath), 'utf8');
  originalSource = git(['show', `${originalCommit}:${sourcePath}`]).toString('utf8');
  keyLists = closedKeyLists(candidateSource);
  const compile = async (sourceRoot: string, source: string, name: string) => {
    const file = join(sourceRoot, sourcePath), outfile = join(directory, `${name}.mjs`);
    const result = await build({ stdin: { contents: `${source}\nexport { closed as closedShape, decimal as decimalValue };\n`,
      sourcefile: file, resolveDir: dirname(file), loader: 'ts' }, outfile, absWorkingDir: root,
      bundle: true, platform: 'node', format: 'esm', target: 'node22', mainFields: ['module', 'main'],
      tsconfig: join(sourceRoot, 'tsconfig.json'), nodePaths: [join(root, 'node_modules')],
      metafile: true, logLevel: 'silent' });
    const inputs = Object.keys(result.metafile.inputs).map(input => {
      const absolute = resolve(root, input);
      if (absolute.startsWith(`${sourceRoot}${sep}`)) return relative(sourceRoot, absolute);
      assert.ok(absolute.startsWith(`${root}node_modules${sep}`), `source escaped its isolated graph: ${input}`);
      return relative(root, absolute);
    }).sort();
    expect(inputs).toContain(sourcePath);
    expect(inputs).toContain('packages/telemetry-contract/index.js');
    expect(Object.values(result.metafile.outputs)[0]!.exports).toContain('closedShape');
    // Native, separate bundles prevent the runner from sharing either helper
    // or public validator between the candidate and immutable source graph.
    return { module: createRequire(import.meta.url)(outfile) as Kernel, inputs };
  };
  const current = await compile(vendorRoot, candidateSource, 'candidate');
  const historical = await compile(immutableRoot, oracleSource, 'oracle');
  candidate = current.module; candidateInputs = current.inputs;
  oracle = historical.module; oracleInputs = historical.inputs;
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('source patch daily-values-closed-shape', () => {
  it('binds separate bundles to the actual vendor blob and all eight fixed unique key lists', () => {
    const recorded = manifest.files.find(file => file.path === sourcePath)!;
    expect(hash(candidateSource)).toBe(recorded.sha256);
    expect(createHash('sha1').update(`blob ${Buffer.byteLength(oracleSource)}\0`).update(oracleSource).digest('hex')).toBe(recorded.blob);
    expect(closedText(oracleSource)).toBe(closedText(originalSource));
    expect(keyLists).toEqual(closedKeyLists(oracleSource));
    expect(keyLists).toEqual(closedKeyLists(originalSource));
    expect(keyLists).toHaveLength(8);
    for (const keys of keyLists) {
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.length).toBeGreaterThan(0); expect(keys.length).toBeLessThanOrEqual(9);
      expect(keys.every(key => !key.includes('\0'))).toBe(true);
    }
    expect(candidateInputs).toEqual(oracleInputs);
    expect(candidate.closedShape).not.toBe(oracle.closedShape);
    expect(candidate.validateV11DailyProjectionValues).not.toBe(oracle.validateV11DailyProjectionValues);
  });

  it('preserves every real shape, key order, type guard and enumerable-own-key boundary', () => {
    for (const list of keyLists) {
      const keys = Object.freeze([...list]), first = keys[0]!;
      const check = (make: () => unknown, valid: boolean) => compare(() => fixture(make()),
        (kernel, value) => kernel.closedShape(value, keys), valid ? null : invalid);
      const orders = [keys, [...keys].reverse(), ...keys.map((_, index) => [...keys.slice(index), ...keys.slice(0, index)])];
      for (const order of orders) check(() => own(order), true);
      check(() => Object.assign(Object.create(null), own(keys)), true);
      check(() => Object.freeze(own(keys)), true);
      for (const value of [null, undefined, false, 0, 'shape', 1n, Symbol('shape')]) check(() => value, false);
      check(() => Object.assign([], own(keys)), false);
      check(() => Object.assign(() => {}, own(keys)), false);
      for (const missing of keys) check(() => own(keys.filter(key => key !== missing)), false);
      check(() => ({ ...own(keys), extra: 0 }), false);
      check(() => ({ ...own(keys.slice(1)), extra: 0 }), false);
      check(() => Object.create(own(keys)), false);
      check(() => Object.assign(Object.create({ [first]: 0 }), own(keys.slice(1))), false);
      check(() => Object.defineProperty(own(keys), first, { enumerable: false }), false);
      check(() => Object.assign(Object.create({ extra: 0 }), own(keys)), true);
      check(() => Object.defineProperty(own(keys), 'extra', { get() { throw Error('UNEXPECTED_GET'); } }), true);
      check(() => Object.defineProperty(own(keys), Symbol('extra'), { enumerable: true, get() { throw Error('UNEXPECTED_GET'); } }), true);
      check(() => Object.defineProperty(own(keys), first, { enumerable: true, get() { throw Error('UNEXPECTED_GET'); } }), true);
      expect(keys).toEqual(list);
    }
  });

  it('retains historical NUL-delimiter collisions through the mismatch fallback', () => {
    for (const list of keyLists) {
      const keys = Object.freeze([...list]), sorted = [...keys].sort();
      for (const actual of [[sorted.join('\0')], [sorted.slice(0, 2).join('\0'), ...sorted.slice(2)]])
        compare(() => fixture(own(actual)), (kernel, value) => kernel.closedShape(value, keys), null);
      compare(() => fixture(own([`${sorted.join('\0')}\0extra`])), (kernel, value) => kernel.closedShape(value, keys), invalid);
    }
    // Same-length mismatch, as well as the fewer-key collisions above.
    compare(() => fixture(own(['a', 'b\0c'])), (kernel, value) => kernel.closedShape(value, ['a\0b', 'c']), null);
  });

  it('uses one Object.keys snapshot and preserves stateful proxy refusal and access order', () => {
    const keys = Object.freeze(['usage', 'quota', 'session']);
    for (const mode of ['valid', 'missing-first', 'throw-descriptor'] as const) {
      const make = (): Fixture => {
        const trace: string[] = [], reads = new Map<PropertyKey, number>(), target = own(keys);
        const value = new Proxy(target, {
          ownKeys(object) { trace.push('ownKeys'); if (trace.filter(item => item === 'ownKeys').length > 1) throw Error('REPEATED_KEYS'); return Reflect.ownKeys(object); },
          getOwnPropertyDescriptor(object, key) {
            trace.push(`descriptor:${String(key)}`); reads.set(key, (reads.get(key) ?? 0) + 1);
            if (key === keys[0] && mode === 'throw-descriptor') throw Error('DESCRIPTOR_REFUSAL');
            if (key === keys[0] && mode === 'missing-first' && reads.get(key) === 1) return undefined;
            if (reads.get(key)! > 1) throw Error('REPEATED_DESCRIPTOR');
            return Reflect.getOwnPropertyDescriptor(object, key);
          },
          get(_object, key) { trace.push(`get:${String(key)}`); throw Error('UNEXPECTED_GET'); },
          has(_object, key) { trace.push(`has:${String(key)}`); throw Error('UNEXPECTED_HAS'); },
        });
        return { value, trace };
      };
      const expected = mode === 'valid' ? null : mode === 'missing-first' ? invalid : { name: 'Error', message: 'DESCRIPTOR_REFUSAL' };
      compare(make, (kernel, value) => kernel.closedShape(value, keys), expected);
      const probe = make(); outcome(() => candidate.closedShape(probe.value, keys));
      expect(probe.trace).toEqual(['ownKeys', ...keys.slice(0, mode === 'throw-descriptor' ? 1 : keys.length).map(key => `descriptor:${key}`)]);
    }
  });

  it('preserves public validation, nested malformation and arithmetic rejection', () => {
    const validate = (kernel: Kernel, value: unknown) => kernel.validateV11DailyProjectionValues(value);
    const record = v11UsageRecord(day, 'a', { modelId: 'gpt-5.4' });
    const initial = oracle.foldV11DailyProjectionValues(oracle.createV11DailyProjectionValues(day), [record]);
    const corruptions: Array<(value: any) => void> = [
      value => { value.extra = 0; }, value => { delete value.day; }, value => { value.counts.extra = 0; },
      value => { value.counts = null; }, value => { value.tokens.inputUncachedTokens = []; },
      value => { delete value.tokens.inputUncachedTokens.knownSum; }, value => { value.tokens.extra = {}; },
      value => { value.pricing.extra = 0; }, value => { value.cells[0].extra = 0; },
      value => { value.omitted.extra = 0; }, value => { value.omitted.pricing.unpriced = 1; },
      value => { value.omitted.tokens.effectiveOutput.unavailable = 1; },
      value => { value.cells[0].pricing.knownNanousd = '00'; },
      value => { value.cells[0].tokens.effectiveOutput.unavailable = 2; },
      value => { value.counts.usage = 6_000_001; }, value => { value.counts.quota = -1; },
      value => { value.pricing.fullyPriced++; }, value => { value.tokens.effectiveOutput.knownSum = '9999999999999999999999999'; },
      value => { value.tokens.inputUncachedTokens.knownSum = '101'; },
      value => { value.cells[0].usageEvents = 0; }, value => { value.cells.push(structuredClone(value.cells[0])); },
    ];
    for (const corrupt of corruptions) compare(() => {
      const value = structuredClone(initial); corrupt(value); return fixture(value);
    }, validate, invalid);
    compare(() => {
      const value = oracle.createV11DailyProjectionValues(day), keys = ['usage', 'quota', 'session'];
      // The old helper accepts this delimiter collision. Nonenumerable real
      // fields keep later arithmetic valid; this optimization must too.
      value.counts = Object.defineProperties(own([[...keys].sort().join('\0')]),
        Object.fromEntries(keys.map(key => [key, { value: 0 }]))) as typeof value.counts;
      return fixture(value);
    }, validate, null);
    for (const throws of [false, true]) compare(() => {
      const value = structuredClone(initial), trace: string[] = [], counts = value.counts;
      Object.defineProperty(value, 'counts', { enumerable: true, get() {
        trace.push('get:counts'); if (throws) throw Error('COUNTS_GETTER_REFUSAL'); return counts;
      } });
      return { value: new Proxy(value, {
        ownKeys(target) { trace.push('ownKeys'); return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { trace.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
        get(target, key, receiver) { trace.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
      }), trace };
    }, validate, throws ? { name: 'Error', message: 'COUNTS_GETTER_REFUSAL' } : null);
  });

  it('preserves public own-key and getter behavior at every nested shape boundary', () => {
    const initial = oracle.foldV11DailyProjectionValues(oracle.createV11DailyProjectionValues(day), [v11UsageRecord(day)]);
    const paths = [[], ['counts'], ['tokens'], ['tokens', 'inputUncachedTokens'], ['pricing'], ['cells', 0], ['omitted']];
    const variants: Array<[boolean, (value: any, trace: string[]) => unknown]> = [
      [true, value => Object.fromEntries(Object.entries(value).reverse())],
      [true, value => Object.assign(Object.create({ extra: 0 }), value)],
      [true, value => Object.defineProperty(value, 'extra', { get() { throw Error('UNEXPECTED_GET'); } })],
      [true, value => Object.defineProperty(value, Symbol('extra'), { enumerable: true, get() { throw Error('UNEXPECTED_GET'); } })],
      [true, (value, trace) => {
        const first = Object.keys(value)[0]!, field = value[first];
        return Object.defineProperty(value, first, { enumerable: true, get() { trace.push(`get:${first}`); return field; } });
      }],
      [false, value => Object.defineProperty(value, Object.keys(value)[0]!, { enumerable: false })],
      [false, value => {
        const first = Object.keys(value)[0]!, field = value[first]; delete value[first];
        return Object.assign(Object.create({ [first]: field }), value);
      }],
    ];
    for (const path of paths) for (const [valid, modify] of variants) compare(() => {
      let value: any = structuredClone(initial); const trace: string[] = [];
      if (path.length === 0) value = modify(value, trace);
      else {
        const parent = path.slice(0, -1).reduce<any>((node, key) => node[key], value), key = path.at(-1)!;
        parent[key] = modify(parent[key], trace);
      }
      return { value, trace };
    }, (kernel, value) => kernel.validateV11DailyProjectionValues(value), valid ? null : invalid);
  });

  it('serializes zero, legacy normalization and nontrivial bounded folds identically', () => {
    let expected = oracle.createV11DailyProjectionValues(day), actual = candidate.createV11DailyProjectionValues(day);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    const legacy: any = { ...expected, schemaVersion: 'v11-daily-projection-values-v1' }; delete legacy.omitted;
    expect(JSON.stringify(candidate.normalizeV11DailyProjectionValues(legacy)))
      .toBe(JSON.stringify(oracle.normalizeV11DailyProjectionValues(legacy)));
    const records = Array.from({ length: 203 }, (_, index) => v11UsageRecord(day, 'a', {
      eventId: `event:shape:${index.toString().padStart(4, '0')}`,
      modelId: index < 200 ? `.shape-${index.toString().padStart(3, '0')}` : index === 202 ? 'unknown' : 'gpt-5.4',
      ...(index === 201 ? { components: { ...v11UsageRecord(day).components, inputCacheReadTokens: null } } : {}),
    }));
    const before = JSON.stringify(records);
    for (const page of [records.slice(0, 200), records.slice(200)]) {
      expected = oracle.foldV11DailyProjectionValues(expected, page);
      actual = candidate.foldV11DailyProjectionValues(actual, page);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
      candidate.validateV11DailyProjectionValues(actual); oracle.validateV11DailyProjectionValues(expected);
    }
    expect(actual.cells).toHaveLength(200); expect(actual.omitted.usageEvents).toBe(3);
    expect(actual.omitted.pricing).toMatchObject({ fullyPriced: 1, partiallyPriced: 1, unpriced: 1 });
    expect(JSON.stringify(candidate.finalizeV11DailyProjectionValues(actual)))
      .toBe(JSON.stringify(oracle.finalizeV11DailyProjectionValues(expected)));
    expect(JSON.stringify(records)).toBe(before);
  });
});

describe('source patch daily-values-decimal-zero', () => {
  function decimalResult(kernel: Kernel, value: unknown) {
    try {
      const result = kernel.decimalValue(value);
      return { kind: typeof result, value: result.toString() };
    } catch (error) {
      return { name: (error as Error).name, message: (error as Error).message };
    }
  }
  const vectors: unknown[] = [
    '0', '1', '9', '10', '9007199254740991', '9007199254740992', '9999999999999999',
    '10000000000000000', '9'.repeat(25), '9'.repeat(26), '0\n', '1\r\n', '1\u2028', '1\u2029',
    '', '00', '01', '-0', '-1', '+1', '1.0', '1e3', '0x10', ' 1', '1 ', '1\0', '1\n\n',
    null, undefined, 0, -0, 1, NaN, Infinity, false, true, 0n, 1n, Symbol('decimal'), {}, [],
    new String('0'), new String('1'),
  ];
  it('preserves exact decimal values and refusals across repeated primitive-zero fast paths', () => {
    for (let pass = 0; pass < 3; pass++) {
      for (const value of vectors) {
        expect(decimalResult(candidate, value)).toEqual(decimalResult(oracle, value));
      }
    }
    expect(candidate.decimalValue('0')).toBe(0n);
    expect(candidate.decimalValue('9'.repeat(25))).toBe(9999999999999999999999999n);
    expect(decimalResult(candidate,'0\n')).toEqual(decimalResult(oracle,'0\n'));
  });
  it('never coerces String objects or proxies, and preserves getter access order with repeated primitive-zero arithmetic', () => {
    for (const value of ['0', '1', '100', '900']) candidate.decimalValue(value);
    for (const boxed of [false, true]) {
      const make = () => {
        const trace: string[] = [], target = boxed ? new String('1') : {};
        const value = new Proxy(target, {
          get(_target, key) { trace.push('get:' + String(key)); throw Error('UNEXPECTED_GET'); },
          ownKeys() { trace.push('ownKeys'); throw Error('UNEXPECTED_OWN_KEYS'); },
          getOwnPropertyDescriptor() { trace.push('descriptor'); throw Error('UNEXPECTED_DESCRIPTOR'); },
        });
        return { value, trace };
      };
      const a = make(), b = make();
      expect(decimalResult(candidate, a.value)).toEqual(decimalResult(oracle, b.value));
      expect(a.trace).toEqual(b.trace);
      expect(a.trace).toEqual([]);
    }
    for (const sequence of [['0'], ['0', '1'], ['0', 'invalid'], ['0', new String('0')]]) {
      const make = () => {
        const trace: string[] = [], value = oracle.createV11DailyProjectionValues(day);
        let calls = 0;
        Object.defineProperty(value.tokens.inputUncachedTokens, 'knownSum', {
          enumerable: true,
          get() {
            trace.push('knownSum:' + calls);
            return sequence[Math.min(calls++, sequence.length - 1)];
          },
        });
        return { value, trace };
      };
      const a = make(), b = make();
      expect(outcome(() => candidate.validateV11DailyProjectionValues(a.value)))
        .toEqual(outcome(() => oracle.validateV11DailyProjectionValues(b.value)));
      expect(a.trace).toEqual(b.trace);
    }
  });
});
