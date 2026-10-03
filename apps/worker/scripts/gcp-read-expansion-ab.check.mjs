import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_BASE } from "./gcp-read-expansion-ab.mjs";

test("A/B harness pins an exact base, two module graphs, read-only snapshot and aggregate-only receipt", async () => {
  assert.match(DEFAULT_BASE, /^[0-9a-f]{40}$/u);
  const source = await readFile(new URL("./gcp-read-expansion-ab.mjs", import.meta.url), "utf8");
  assert.match(source, /pg_export_snapshot/u);
  assert.match(source, /SET TRANSACTION SNAPSHOT/u);
  assert.match(source, /REPEATABLE READ READ ONLY/u);
  assert.match(source, /fingerprint output\/refusal bytes differ/u);
  assert.match(source, /await readers.close/u);
  assert.doesNotMatch(source, /console\.log\([^\n]*(ownerDigest|rows|options)/u);
});
