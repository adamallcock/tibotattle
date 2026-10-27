import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Resolve from the pool so a second Zod installation cannot hide its regression.
const { z } = createRequire(import.meta.resolve("@cloudflare/vitest-pool-workers"))("zod");

test("Worker test configuration rejects oversized bounded collections before visiting elements", () => {
  let visits = 0;
  const element = z.string().refine(() => { visits += 1; return true; });
  for (const [schema, oversized, valid] of [
    [z.array(element).max(2), ["a", "b", "c"], ["a", "b"]],
    [z.set(element).max(2), new Set(["a", "b", "c"]), new Set(["a", "b"])],
    [z.map(element, element).max(2), new Map([["a", "x"], ["b", "y"], ["c", "z"]]), new Map([["a", "x"]])],
  ]) {
    visits = 0;
    const result = schema.safeParse(oversized);
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues.map(({ code }) => code), ["too_big"]);
    assert.equal(visits, 0);
    assert.equal(schema.safeParse(valid).success, true);
    assert.ok(visits > 0);
  }
});

test("Worker test configuration still reports invalid elements within collection bounds", () => {
  const result = z.array(z.string()).max(2).safeParse([1, 2]);
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues.map(({ code, path }) => ({ code, path })), [
    { code: "invalid_type", path: [0] },
    { code: "invalid_type", path: [1] },
  ]);
});
