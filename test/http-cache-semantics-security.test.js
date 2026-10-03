import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createRequire } from "node:module";
import { createServer, request } from "node:http";
import { once } from "node:events";
import test from "node:test";

// Enter the actual builder dependency chain. Direct root resolution would
// not prove the copy used by Electron's download tooling.
const rootRequire = createRequire(import.meta.url);
const builderRequire = createRequire(rootRequire.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const getRequire = createRequire(appBuilderRequire.resolve("@electron/get/package.json"));
const gotRequire = createRequire(getRequire.resolve("got/package.json"));
const cacheRequire = createRequire(gotRequire.resolve("cacheable-request/package.json"));
const CachePolicy = cacheRequire("http-cache-semantics");
const CacheableRequest = gotRequire("cacheable-request");
const requestData = (cacheControl) => ({ url: "https://cache.invalid/example", method: "GET",
  headers: { host: "cache.invalid", ...(cacheControl ? { "cache-control": cacheControl } : {}) } });
const response = (headers) => ({ status: 200, headers: { date: new Date().toUTCString(), ...headers } });

test("the installed builder chain uses the reviewed pinned patch bytes", () => {
  const bytes = readFileSync(cacheRequire.resolve("http-cache-semantics"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "fc7b3f0265b7a7d0fee83bafa47186a66495720d3179801c2be3083de6d0cf76");
});

test("max-stale cannot reuse responses restricted for security", () => {
  for (const headers of [
    { "cache-control": "max-age=3600", "set-cookie": "session=synthetic" },
    { "cache-control": "max-age=3600, proxy-revalidate" },
    { "cache-control": "max-age=3600, no-cache" },
    { "cache-control": "max-age=3600, no-store" },
    { "cache-control": "max-age=3600, private" },
  ]) {
    const policy = new CachePolicy(requestData(), response(headers));
    assert.equal(policy.satisfiesWithoutRevalidation(requestData("max-stale=999999")), false);
    assert.equal(policy.evaluateRequest(requestData("max-stale=999999")).response, undefined);
  }
});

test("ordinary fresh, expired, explicit public and private caches retain reuse behavior", () => {
  const ordinary = new CachePolicy(requestData(), response({ "cache-control": "max-age=60" }));
  assert.equal(ordinary.satisfiesWithoutRevalidation(requestData()), true);
  const originalNow = ordinary.now();
  ordinary.now = () => originalNow + 120_000;
  assert.equal(ordinary.satisfiesWithoutRevalidation(requestData()), false);
  assert.equal(ordinary.satisfiesWithoutRevalidation(requestData("max-stale=300")), true);
  const publicCookie = new CachePolicy(requestData(), response({ "cache-control": "public, max-age=3600", "set-cookie": "session=synthetic" }));
  assert.equal(publicCookie.satisfiesWithoutRevalidation(requestData()), true);
  const privateCookie = new CachePolicy(requestData(), response({ "cache-control": "private, max-age=3600", "set-cookie": "session=synthetic" }), { shared: false });
  assert.equal(privateCookie.satisfiesWithoutRevalidation(requestData()), true);
  const privateProxy = new CachePolicy(requestData(), response({ "cache-control": "proxy-revalidate, max-age=3600" }), { shared: false });
  assert.equal(privateProxy.satisfiesWithoutRevalidation(requestData()), true);
});

test("builder CommonJS dependency entrypoints still load", () => {
  assert.equal(typeof appBuilderRequire("@electron/get").downloadArtifact, "function");
  assert.equal(typeof getRequire("got"), "function");
  assert.equal(typeof CacheableRequest, "function");
  assert.equal(typeof CachePolicy, "function");
});

test("cacheable-request revalidates a shared cookie response despite client max-stale", { timeout: 10_000 }, async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.writeHead(200, { "cache-control": "max-age=3600", ...(req.url === "/cache" ? { "set-cookie": "session=synthetic" } : {}) });
    res.end(`response-${requests}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const cachedRequest = new CacheableRequest(request, new Map());
  const fetch = (headers = {}, path = "/cache") => new Promise((resolve, reject) => {
    const emitter = cachedRequest({ hostname: "127.0.0.1", port: server.address().port, path, headers }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    });
    emitter.on("request", req => { req.on("error", reject); req.end(); });
    emitter.on("error", reject);
  });
  try {
    assert.equal(await fetch(), "response-1");
    // Let asynchronous cache storage settle. The normal adapter may expire
    // zero-lifetime entries; unit tests above also cover retained entries.
    await nextTurn();
    assert.equal(await fetch({ "cache-control": "max-stale=999999" }), "response-2");
    assert.equal(requests, 2);
    assert.equal(await fetch({}, "/public"), "response-3");
    await nextTurn();
    assert.equal(await fetch({}, "/public"), "response-3");
    assert.equal(requests, 3);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
