import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { buildPublicGoogleRequestUrl, sanitizeHeaders } from "./request-boundary.mjs";

// Loads the runtime-neutral edge/origin contract the way host.check.mjs loads
// Worker source, runs the checks the Workers spec runs, and compares the
// callback-query rule with the Cloud Run request boundary on a shared table.

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = resolve(ROOT, "..");
const CONTRACT_PATH = resolve(WORKER_ROOT, "src/edge-origin-contract.ts");
const REQUEST_BOUNDARY_PATH = resolve(ROOT, "request-boundary.mjs");
const PRIVATE_ORIGIN = "https://edge-origin-abc123-uc.a.run.app";
const PRIVATE_HOST = new URL(PRIVATE_ORIGIN).host;
const PUBLIC_ORIGIN = "https://public.synthetic.example";
// Written with String.raw so the comparison is against the exact source text.
const CALLBACK_QUERY_PATTERN_SOURCE = String.raw`/[\u0000-\u0020\u007f#\\]/u`;

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true, ws: false },
  appType: "custom",
});
let contract;
let vectors;
try {
  [contract, vectors] = await Promise.all([
    vite.ssrLoadModule("/src/edge-origin-contract.ts"),
    vite.ssrLoadModule("/test/edge-origin-contract-vectors.ts"),
  ]);
} finally {
  await vite.close();
}

const nodeAssert = Object.freeze({
  equal: (actual, expected, message) => assert.equal(actual, expected, message),
  deepEqual: (actual, expected, message) => assert.deepEqual(actual, expected, message),
  ok: (value, message) => assert.ok(value, message),
});

test("registers the shared contract checks", () => {
  assert.ok(vectors.EDGE_ORIGIN_CONTRACT_CHECKS.length >= 13);
  const names = vectors.EDGE_ORIGIN_CONTRACT_CHECKS.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length);
});

for (const check of vectors.EDGE_ORIGIN_CONTRACT_CHECKS) {
  test(`node: ${check.name}`, () => {
    check.run(contract, nodeAssert);
  });
}

function requestBoundaryAcceptsCallbackQuery(query) {
  let url;
  try {
    url = buildPublicGoogleRequestUrl(
      contract.GOOGLE_CALLBACK_PATH,
      PRIVATE_HOST,
      PRIVATE_ORIGIN,
      PUBLIC_ORIGIN,
      query,
    );
  } catch (error) {
    assert.equal(error?.message, "OAUTH_CALLBACK_QUERY_INVALID");
    assert.equal(error?.status, 400);
    return false;
  }
  assert.ok(url instanceof URL);
  assert.equal(url.origin, PUBLIC_ORIGIN);
  assert.equal(url.pathname, contract.GOOGLE_CALLBACK_PATH);
  return true;
}

test("validGoogleCallbackQuery and request-boundary.mjs agree on the shared table", () => {
  const cases = vectors.GOOGLE_CALLBACK_QUERY_CASES;
  assert.ok(cases.length >= 20);
  let accepted = 0;
  for (const { label, query, valid } of cases) {
    const boundary = requestBoundaryAcceptsCallbackQuery(query);
    assert.equal(boundary, valid, `request-boundary: ${label}`);
    assert.equal(contract.validGoogleCallbackQuery(query), boundary, `contract: ${label}`);
    if (boundary) accepted += 1;
  }
  // Both outcomes are exercised, so agreement is not vacuous.
  assert.ok(accepted >= 5 && cases.length - accepted >= 5);
  // An absent header is not an invalid one: the boundary keeps the empty
  // query and the edge simply sends no header.
  assert.equal(contract.validGoogleCallbackQuery(undefined), false);
  const absent = buildPublicGoogleRequestUrl(
    contract.GOOGLE_CALLBACK_PATH,
    PRIVATE_HOST,
    PRIVATE_ORIGIN,
    PUBLIC_ORIGIN,
    undefined,
  );
  assert.equal(absent.search, "");
});

test("request-boundary.mjs treats the contract's callback and invoker header names as transport headers", () => {
  const sanitized = sanitizeHeaders({
    [contract.EDGE_HEADERS.callbackQuery]: "?code=synthetic-code",
    [contract.EDGE_HEADERS.invokerToken]: "Bearer synthetic",
    "cf-connecting-ip": "192.0.2.10",
    "x-forwarded-for": "192.0.2.10",
    "content-type": "application/json",
  });
  assert.deepEqual([...sanitized.keys()], ["content-type"]);
});

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//u.test(line))
    .join("\n");
}

test("the contract source is self-contained and runtime-neutral", async () => {
  const [contractSource, boundarySource] = await Promise.all([
    readFile(CONTRACT_PATH, "utf8"),
    readFile(REQUEST_BOUNDARY_PATH, "utf8"),
  ]);
  const code = stripComments(contractSource);
  assert.ok(code.includes("export function parseCloudRunInvokerClaims"));
  for (const [label, pattern] of [
    ["static import", /^\s*import\b/mu],
    ["dynamic import", /\bimport\s*\(/u],
    ["re-export", /\bexport\s+(?:\*|\{[^}]*\})\s*from\b/u],
    ["require", /\brequire\s*\(/u],
    ["node: specifier", /["']node:/u],
    ["Buffer", /\bBuffer\b/u],
    ["process", /\bprocess\b/u],
    ["globalThis", /\bglobalThis\b/u],
    ["Workers cache", /\bcaches\b/u],
    ["Workers HTMLRewriter", /\bHTMLRewriter\b/u],
    ["Workers WebSocketPair", /\bWebSocketPair\b/u],
    ["navigator", /\bnavigator\b/u],
    ["scheduler", /\bscheduler\b/u],
    ["console", /\bconsole\b/u],
  ]) {
    assert.equal(pattern.test(code), false, label);
  }
  // No per-address header, derivation or pattern: the edge-only secret's
  // minimum length is the only identifier that names a client.
  const clientIdentifiers = new Set(code.match(/\w*client\w*/giu) ?? []);
  assert.deepEqual([...clientIdentifiers], ["EDGE_MIN_CLIENT_KEY_SECRET_LENGTH"]);
  // The behavioural table above is authoritative; this pins the mirrored rule
  // textually so a reformatted copy cannot drift unnoticed.
  assert.ok(code.includes(CALLBACK_QUERY_PATTERN_SOURCE), "contract callback pattern");
  assert.ok(boundarySource.includes(CALLBACK_QUERY_PATTERN_SOURCE), "request-boundary callback pattern");
});
