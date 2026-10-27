import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const get = appBuilderRequire("@electron/get");
const transport = appBuilderRequire("./out/util/electronDownloadTransport.js");
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "ELECTRON_GET_USE_PROXY", "ELECTRON_BUILDER_CACHE", "ELECTRON_DOWNLOAD_CACHE_MODE"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-build-downloader-"));
  const environment = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  let requests = 0;
  const requestPaths = new Map();
  const body = Buffer.from("synthetic pinned build input\n");
  const server = createServer((request, response) => {
    requests++;
    requestPaths.set(request.url, (requestPaths.get(request.url) ?? 0) + 1);
    if (request.url === "/stall") return;
    if (request.url === "/retry-timeout" && requestPaths.get(request.url) === 1) return;
    if (request.url === "/retry" && requestPaths.get(request.url) === 1) { response.writeHead(503); response.end(); return; }
    if (request.url === "/fail") { response.writeHead(503); response.end(); return; }
    response.writeHead(200, { "content-length": body.length, "cache-control": "private, no-cache, max-age=3600", "set-cookie": "synthetic=only" });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = path => `http://127.0.0.1:${server.address().port}${path}`;
  const config = (options = {}) => ({
    version: "9.9.9", artifactName: "fixture.zip", isGeneric: true,
    cacheRoot: join(root, "cache"), tempDirectory: root,
    cacheMode: get.ElectronDownloadCacheMode.WriteOnly,
    checksums: { "fixture.zip": digest(body) },
    mirrorOptions: { resolveAssetURL: async () => url("/artifact") },
    downloadOptions: { quiet: true, timeout: { request: 1000 } },
    ...options,
  });
  try { await run({ body, config, requests: () => requests, root, server, url }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const key of proxyKeys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("stable builder loads get 5 through its real CommonJS entrypoint", () => {
  assert.equal(appBuilderRequire("./package.json").version, "26.15.7");
  assert.equal(typeof get.downloadArtifact, "function");
  assert.equal(typeof get.FetchDownloader, "function");
  assert.equal(typeof appBuilderRequire("./out/util/electronGet.js").downloadElectronArtifactZip, "function");
});

test("actual downloads preserve checksums, callback shape and validated disk cache", async () => fixture(async ({ config, body, requests }) => {
  const progress = [];
  const input = config({ downloadOptions: { quiet: true, getProgressCallback: async info => { progress.push(info); } } });
  const first = await transport.downloadArtifact(input);
  assert.deepEqual(await readFile(first), body);
  assert.ok(progress.some(info => info.percent === 1 && info.transferred === body.length && info.total === body.length));
  const cached = await transport.downloadArtifact({ ...input, cacheMode: get.ElectronDownloadCacheMode.ReadWrite });
  assert.deepEqual(await readFile(cached), body);
  assert.equal(requests(), 1);
  await writeFile(cached, "synthetic cache corruption");
  assert.deepEqual(await readFile(await transport.downloadArtifact({ ...input, cacheMode: get.ElectronDownloadCacheMode.ReadWrite })), body);
  assert.equal(requests(), 2, "cache corruption must be detected and redownloaded");
  await assert.rejects(transport.downloadArtifact(config({ checksums: { "fixture.zip": "0".repeat(64) } })), /checksum/i);
}));

test("the real builder retries fetch failures and creates a fresh deadline per attempt", async () => fixture(async ({ body, root, requests, url }) => {
  const builder = appBuilderRequire("./out/util/electronGet.js");
  for (const [index, path, deadline] of [[0, "/retry", 1000], [1, "/retry-timeout", 200]]) {
    const name = `fixture-${index}.zip`;
    const result = await builder.downloadElectronArtifactZip({
      version: "9.9.9", platformName: "linux", arch: "x64", artifactName: name,
      cacheDir: join(root, "builder-cache-" + index),
      electronDownload: { isGeneric: true, checksums: { [name]: digest(body) },
        mirrorOptions: { resolveAssetURL: async () => url(path) },
        downloadOptions: { quiet: true, timeout: { request: deadline } } },
    });
    assert.deepEqual(await readFile(result), body);
  }
  assert.equal(requests(), 4);
}));

test("a pre-cancelled caller makes no request and custom downloaders retain their option contract", async () => fixture(async ({ body, config, requests }) => {
  await assert.rejects(transport.downloadArtifact(config({ downloadOptions: { signal: AbortSignal.abort() } })), error => error.name === "AbortError");
  assert.equal(requests(), 0);
  const ownOptions = { syntheticCustomOption: true };
  let seen;
  const result = await transport.downloadArtifact(config({
    downloadOptions: ownOptions,
    downloader: { async download(_url, path, options) { seen = options; await writeFile(path, body); } },
  }));
  assert.equal(seen, ownOptions);
  assert.deepEqual(await readFile(result), body);
}));

test("the stable builder does not retry a caller cancellation with a transient-looking reason", { timeout: 1000 }, async () => fixture(async ({ body, root }) => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("synthetic caller cancellation"), { code: "ECONNRESET" });
  let calls = 0;
  await assert.rejects(appBuilderRequire("./out/util/electronGet.js").downloadElectronArtifactZip({
    version: "9.9.9", platformName: "linux", arch: "x64", artifactName: "fixture.zip", cacheDir: join(root, "cancel-cache"),
    electronDownload: { isGeneric: true, checksums: { "fixture.zip": digest(body) },
      mirrorOptions: { resolveAssetURL: async () => "https://synthetic.invalid/fixture.zip" },
      downloadOptions: { signal: controller.signal },
      downloader: { async download() { calls++; controller.abort(reason); throw reason; } } },
  }), error => error === reason);
  assert.equal(calls, 1);
}));

test("the generic builder download entrypoint also verifies the pinned artifact", async () => fixture(async ({ body, root, url, requests }) => {
  process.env.ELECTRON_BUILDER_CACHE = join(root, "generic-cache");
  const output = join(root, "generic-output.zip");
  await appBuilderRequire("./out/binDownload.js").download(url("/fixture.zip"), output, digest(body));
  assert.deepEqual(await readFile(output), body);
  assert.equal(requests(), 1);
}));

async function syntheticTlsIdentity() {
  const pkijs = appBuilderRequire("pkijs");
  const asn1js = appBuilderRequire("asn1js");
  pkijs.setEngine("synthetic-test", webcrypto, new pkijs.CryptoEngine({ name: "synthetic-test", crypto: webcrypto, subtle: webcrypto.subtle }));
  const pair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, true, ["sign", "verify"]);
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({ value: 1 });
  const commonName = new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: "synthetic loopback" }) });
  certificate.issuer.typesAndValues.push(commonName);
  certificate.subject.typesAndValues.push(commonName);
  certificate.notBefore.value = new Date(Date.now() - 60_000);
  certificate.notAfter.value = new Date(Date.now() + 3600_000);
  certificate.extensions = [new pkijs.Extension({ extnID: "2.5.29.17", extnValue: new pkijs.GeneralNames({ names: [
    new pkijs.GeneralName({ type: 7, value: new asn1js.OctetString({ valueHex: Uint8Array.of(127, 0, 0, 1).buffer }) }),
  ] }).toSchema().toBER(false) })];
  await certificate.subjectPublicKeyInfo.importKey(pair.publicKey);
  await certificate.sign(pair.privateKey, "SHA-256");
  const pem = (label, value) => `-----BEGIN ${label}-----\n${Buffer.from(value).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
  return { key: pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)),
    cert: pem("CERTIFICATE", certificate.toSchema(true).toBER(false)) };
}

test("TLS verification stays enabled; explicit custom trust and strictSSL settings remain effective", async () => fixture(async ({ config, body }) => {
  const identity = await syntheticTlsIdentity();
  const server = createSecureServer(identity, (_request, response) => response.end(body));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const input = config({ mirrorOptions: { resolveAssetURL: async () => `https://127.0.0.1:${server.address().port}/artifact` } });
  try {
    await assert.rejects(transport.downloadArtifact(input), error => error.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
    for (const https of [{ certificateAuthority: identity.cert }, { rejectUnauthorized: false }]) {
      const file = await transport.downloadArtifact({ ...input, downloadOptions: { quiet: true, https } });
      assert.deepEqual(await readFile(file), body);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}));

test("fetch does not reuse restricted HTTP responses through max-stale", async () => fixture(async ({ config, requests }) => {
  const input = config({ downloadOptions: { quiet: true, headers: { "cache-control": "max-stale=999999" } } });
  await transport.downloadArtifact(input);
  await transport.downloadArtifact(input);
  assert.equal(requests(), 2, "write-only artifact cache must make two real HTTP requests");
}));

test("request deadlines and caller cancellation abort actual stalled transfers", async () => fixture(async ({ config, url, requests }) => {
  const stalled = config({ mirrorOptions: { resolveAssetURL: async () => url("/stall") }, downloadOptions: { quiet: true, timeout: { request: 200 } } });
  await assert.rejects(transport.downloadArtifact(stalled), error => error.name === "TimeoutError");
  assert.equal(requests(), 1);
  const controller = new AbortController();
  const cancelled = transport.downloadArtifact({ ...stalled, downloadOptions: { quiet: true, timeout: { request: 5000 }, signal: controller.signal } });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(cancelled, error => error.name === "AbortError");
}));

test("unsupported legacy options fail before a network request", async () => fixture(async ({ config, requests }) => {
  for (const downloadOptions of [{ agent: {} }, { timeout: { socket: 1 } }, { hooks: {} }, { https: { unknown: true } }, { timeout: -1 }]) {
    await assert.rejects(transport.downloadArtifact(config({ downloadOptions })), /Unsupported|Invalid/);
  }
  for (const downloader of [false, {}, "invalid"]) {
    await assert.rejects(transport.downloadArtifact(config({ downloader })), /Invalid custom downloader/);
  }
  assert.equal(requests(), 0);
}));

test("fetch errors preserve transient retry and permanent/cancellation refusal", async () => fixture(async ({ config, url }) => {
  let failure;
  try { await transport.downloadArtifact(config({ mirrorOptions: { resolveAssetURL: async () => url("/fail") } })); }
  catch (error) { failure = error; }
  assert.equal(failure.response.status, 503);
  assert.equal(transport.shouldRetryDownloadError(failure), true);
  for (const error of [{ name: "HTTPError", response: { status: 429 } }, { cause: { code: "UND_ERR_SOCKET" } }, { name: "TimeoutError" }, { code: "ECONNRESET" }]) {
    assert.equal(transport.shouldRetryDownloadError(error), true);
  }
  for (const error of [null, {}, { name: "HTTPError", response: { status: 404 } }, { name: "AbortError" }, { code: "CERT_HAS_EXPIRED" }]) {
    assert.equal(transport.shouldRetryDownloadError(error), false);
  }
}));

test("HTTP/HTTPS proxies route downloads and NO_PROXY preserves direct loopback downloads", async () => fixture(async ({ config, body, requests }) => {
  let tunnels = 0;
  const sockets = new Set();
  const proxy = createServer();
  proxy.on("connect", (request, client, head) => {
    tunnels++;
    const target = new URL(`http://${request.url}`);
    assert.equal(target.hostname, "127.0.0.1");
    const upstream = connect(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy()); }
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  try {
    assert.deepEqual(await readFile(await transport.downloadArtifact(config())), body);
    assert.equal(tunnels, 1);
    process.env.NO_PROXY = "127.0.0.1";
    await transport.downloadArtifact(config());
    assert.equal(tunnels, 1);
    assert.equal(requests(), 2);
    delete process.env.HTTP_PROXY;
    delete process.env.NO_PROXY;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;
    const identity = await syntheticTlsIdentity();
    const secure = createSecureServer(identity, (_request, response) => response.end(body));
    secure.listen(0, "127.0.0.1");
    await once(secure, "listening");
    try {
      const file = await transport.downloadArtifact(config({
        mirrorOptions: { resolveAssetURL: async () => `https://127.0.0.1:${secure.address().port}/artifact` },
        downloadOptions: { quiet: true, https: { certificateAuthority: identity.cert } },
      }));
      assert.deepEqual(await readFile(file), body);
      assert.equal(tunnels, 2);
    } finally {
      secure.closeAllConnections();
      await new Promise(resolve => secure.close(resolve));
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
}));

test("a caller-owned dispatcher remains usable after multiple transfers", async () => fixture(async ({ config, requests }) => {
  const getRequire = createRequire(appBuilderRequire.resolve("@electron/get"));
  const { Agent } = getRequire("undici");
  const dispatcher = new Agent();
  try {
    const input = config({ downloadOptions: { quiet: true, dispatcher } });
    await transport.downloadArtifact(input);
    await transport.downloadArtifact(input);
    assert.equal(requests(), 2);
  } finally { await dispatcher.destroy(); }
}));
