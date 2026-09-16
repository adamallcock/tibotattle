#!/usr/bin/env node

import { webcrypto } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = "gcs-test/wrangler.jsonc";
const port = 8799;
const route = "/__gcs_test__/api/v1/release/appcast";
const schema = "usage-monitor-gcs-test-release-guard-v1";
const channel = "gcs-test";
const updateOrigin = "https://gcs-test-updates.invalid";
const namespacePrefix = "gcs-test/runs";
const bucketPrefix = "tibotattle-gcs-test-";
const runIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const maxTokenLifetime = 3_600;
const receiptSchema = "gcs-live-smoke-receipt-v1";
const maxReceiptTargets = 64;
const encoder = new TextEncoder();

let child;
const processes = new Set();
let runDir;
let cleaning = false;
let receiptFile;
let ownedReceipt = false;
let receiptInitialized = false;
let receiptStatus = "running";
let receiptCode;
const attemptedKeys = [];
const createdKeys = [];
const generations = Object.create(null);
const transportEvents = [];

function usage() {
  console.log(`Usage: node apps/worker/scripts/gcs-live-smoke.mjs --bucket <bucket> --access-token-file <0600-file> --expires-at <epoch-seconds> --receipt-file <path> [--run-id <closed-run-id>]\n\nLive GCS smoke is explicitly opt-in. The bucket must start with ${bucketPrefix}. A fresh run namespace is generated unless --run-id is supplied.`);
}

function fail(code) { throw new Error(code); }

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENTS");
    }
    if (values.has(key)) fail("DUPLICATE_ARGUMENT");
    values.set(key, value);
    index += 1;
  }
  if (values.size < 4 || values.size > 5 || !values.has("--bucket")
      || !values.has("--access-token-file") || !values.has("--expires-at")
      || !values.has("--receipt-file")) {
    fail("INVALID_ARGUMENTS");
  }
  if (values.has("--run-id") && !runIdPattern.test(values.get("--run-id") ?? "")) {
    fail("INVALID_RUN_ID");
  }
  if (!values.has("--run-id") && values.size !== 4) fail("INVALID_ARGUMENTS");
  if (values.has("--run-id") && values.size !== 5) fail("INVALID_ARGUMENTS");
  const bucket = values.get("--bucket");
  if (!/^tibotattle-gcs-test-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(bucket ?? "")
      || (bucket?.length ?? 0) > 63) fail("INVALID_BUCKET");
  const expiresAt = values.get("--expires-at");
  if (!/^\d{1,12}$/u.test(expiresAt ?? "")) fail("INVALID_EXPIRY");
  const expiry = Number(expiresAt);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry - now > maxTokenLifetime) {
    fail("INVALID_EXPIRY");
  }
  const receiptPath = values.get("--receipt-file");
  if (typeof receiptPath !== "string" || receiptPath.length === 0) fail("INVALID_RECEIPT_FILE");
  const runId = values.get("--run-id") ?? Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("hex");
  return {
    bucket,
    tokenFile: resolve(values.get("--access-token-file")),
    expiry,
    receiptFile: resolve(receiptPath),
    runId,
  };
}

async function read0600Token(file) {
  let handle;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await fs.open(file, flags);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
        || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096
        || (process.getuid && stat.uid !== process.getuid())) fail("TOKEN_FILE_PERMISSIONS");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) fail("TOKEN_FILE_PERMISSIONS");
    const raw = buffer.toString("utf8", 0, bytesRead);
    const token = raw.replace(/\r?\n$/u, "");
    if (token.length === 0 || /[\u0000-\u001f\u007f\s]/u.test(token)) fail("INVALID_ACCESS_TOKEN");
    return token;
  } catch (error) {
    if (error?.message?.startsWith("TOKEN_FILE_") || error?.message === "INVALID_ACCESS_TOKEN") throw error;
    fail("TOKEN_FILE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeDevVars(file, values) {
  const body = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  let handle;
  try {
    handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(body, "utf8");
    await handle.chmod(0o600);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) fail("DEV_VARS_PERMISSIONS");
}

function runPrefix(runId) {
  if (!runIdPattern.test(runId)) fail("INVALID_RUN_ID");
  return `${namespacePrefix}/${runId}`;
}

function receiptSnapshot() {
  if (!receiptFile || !receiptContext) return null;
  return {
    schemaVersion: receiptSchema,
    status: receiptStatus,
    ...(receiptCode === undefined ? {} : { code: receiptCode }),
    bucket: receiptContext.bucket,
    runId: receiptContext.runId,
    runPrefix: receiptContext.runPrefix,
    attemptedKeys: [...attemptedKeys],
    createdKeys: [...createdKeys],
    generations: { ...generations },
    transportEvents: [...transportEvents],
  };
}

let receiptContext;

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await handle.sync();
  } catch {
    // Directory fsync is a best-effort durability improvement. The receipt
    // file itself is always synced before this helper is reached; platforms
    // that do not allow fsync on directories still retain that guarantee.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeReceiptSnapshot(initial = false) {
  const snapshot = receiptSnapshot();
  if (snapshot === null) return;
  if (!initial && (!ownedReceipt || !receiptInitialized)) return;
  const serialized = `${JSON.stringify(snapshot)}\n`;
  if (initial) {
    let handle;
    try {
      handle = await fs.open(
        receiptFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      ownedReceipt = true;
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.chmod(0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        ownedReceipt = false;
        fail("RECEIPT_ALREADY_EXISTS");
      }
      fail("RECEIPT_WRITE_FAILED");
    } finally {
      await handle?.close().catch(() => undefined);
    }
    receiptInitialized = true;
    await syncDirectory(dirname(receiptFile));
    return;
  }
  const temporary = `${receiptFile}.tmp-${process.pid}-${Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
  let handle;
  try {
    handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } catch {
    fail("RECEIPT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  try {
    await fs.rename(temporary, receiptFile);
    await syncDirectory(dirname(receiptFile));
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    fail("RECEIPT_WRITE_FAILED");
  }
}

async function journalAttempt(key) {
  if (!key.startsWith(`${receiptContext.runPrefix}/`)) fail("KEY_OUTSIDE_RUN_PREFIX");
  if (attemptedKeys.length >= maxReceiptTargets) fail("RECEIPT_TARGET_LIMIT");
  attemptedKeys.push(key);
  await writeReceiptSnapshot();
}

async function journalCreated(key) {
  if (!attemptedKeys.includes(key)) fail("RECEIPT_TARGET_UNKNOWN");
  if (!createdKeys.includes(key)) createdKeys.push(key);
  await writeReceiptSnapshot();
}

async function journalGeneration(key, generation) {
  if (!createdKeys.includes(key)
      || typeof generation !== "string"
      || !/^[1-9][0-9]{0,18}$/u.test(generation)) {
    fail("RECEIPT_GENERATION_INVALID");
  }
  generations[key] = generation;
  await writeReceiptSnapshot();
}

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function digest(bytes) {
  return new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes));
}

async function digestHex(bytes) {
  return Buffer.from(await digest(bytes)).toString("hex");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function signingFields() {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicBytes = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  return {
    pair,
    publicKey: base64(publicBytes),
    publicKeySha256: await digestHex(publicBytes),
    releaseToken: randomToken(),
  };
}

function sleep(milliseconds) { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const processHandle = spawn(command, args, { cwd: workerDir, env, stdio: ["ignore", "pipe", "pipe"] });
    processes.add(processHandle);
    const timer = setTimeout(() => {
      void stopProcess(processHandle);
      reject(new Error("LOCAL_TOOL_TIMEOUT"));
    }, 60_000);
    processHandle.stdout?.on("data", () => undefined);
    processHandle.stderr?.on("data", () => undefined);
    processHandle.once("error", () => { clearTimeout(timer); reject(new Error("LOCAL_TOOL_FAILED")); });
    processHandle.once("exit", (code) => {
      processes.delete(processHandle);
      clearTimeout(timer);
      code === 0 ? resolvePromise() : reject(new Error("LOCAL_TOOL_FAILED"));
    });
  });
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;
  const exited = new Promise((resolvePromise) => {
    if (processHandle.exitCode !== null) resolvePromise();
    else processHandle.once("exit", resolvePromise);
  });
  processHandle.kill("SIGTERM");
  await Promise.race([
    exited,
    sleep(5_000),
  ]);
  if (processHandle.exitCode === null) {
    processHandle.kill("SIGKILL");
    await Promise.race([exited, sleep(1_000)]);
  }
}

async function startWorker(env, stateDir, varsFile) {
  const wrangler = join(workerDir, "node_modules", ".bin", "wrangler");
  const childEnv = { ...env, WRANGLER_REGISTRY_PATH: join(runDir, "registry"),
    WRANGLER_LOG_PATH: join(runDir, "logs"), WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false" };
  // Wrangler process values can override --env-file secrets. Only this run's
  // explicit credential/configuration file may select the test target.
  for (const key of ["GCS_TEST_BUCKET", "GCS_ACCESS_TOKEN", "GCS_ACCESS_TOKEN_EXPIRES_AT",
    "GCS_TEST_RUN_ID", "GCS_TEST_RELEASE_TOKEN", "GCS_TEST_PUBLIC_ED_KEY", "GCS_TEST_PUBLIC_ED_KEY_SHA256"]) {
    delete childEnv[key];
  }
  try {
    const probe = await fetch(`http://127.0.0.1:${port}/not-approved`, { signal: AbortSignal.timeout(1_000) });
    if (probe.status !== 404) fail("LOCAL_WORKER_MISMATCH");
    fail("LOCAL_PORT_IN_USE");
  } catch (error) {
    if (error?.message === "LOCAL_PORT_IN_USE") throw error;
  }
  await run(wrangler, ["d1", "execute", "TEST_RELEASE_NONCES", "--config", configPath,
    "--local", "--persist-to", stateDir, "--env-file", varsFile, "--file",
    "migrations/0029_sparkle_appcast_guard_nonces.sql", "--yes"], childEnv);
  child = spawn(wrangler, ["dev", "--config", configPath, "--local", "--ip", "127.0.0.1",
    "--port", String(port), "--persist-to", stateDir, "--env-file", varsFile,
    "--log-level", "error", "--show-interactive-dev-session=false"], {
    cwd: workerDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  processes.add(child);
  child.stdout?.on("data", () => undefined);
  const inspectEvents = (chunk) => {
    const text = String(chunk);
    for (const match of text.matchAll(/GCS_SMOKE_EVENT (\{[^\n]*\})/gu)) {
      try {
        const event = JSON.parse(match[1]);
        if (Number.isInteger(event.status)) transportEvents.push({status: event.status});
        else if (["tls", "cache", "invocation", "transport"].includes(event.error)) transportEvents.push({error: event.error});
      } catch { /* ignore incomplete log lines */ }
    }
  };
  child.stdout?.on("data", inspectEvents);
  child.stderr?.on("data", inspectEvents);
  child.once("exit", () => processes.delete(child));
  child.once("error", () => undefined);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) fail("LOCAL_WORKER_FAILED");
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/not-approved`, { signal: AbortSignal.timeout(1_000) });
      if (probe.status !== 404 || child.exitCode !== null) fail("LOCAL_WORKER_MISMATCH");
      return;
    } catch (error) {
      if (error?.message === "LOCAL_WORKER_MISMATCH") throw error;
      await sleep(100);
    }
  }
  fail("LOCAL_WORKER_TIMEOUT");
}

async function bundleAdapter(bundleFile) {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(workerDir, "src", "gcs-release-object-store.ts")],
    outfile: bundleFile, bundle: true, platform: "node", format: "esm", target: "es2022",
    absWorkingDir: workerDir, logLevel: "silent", sourcemap: false,
  });
  return (await import(`${pathToFileURL(bundleFile).href}?run=${Date.now()}`)).GcsReleaseObjectStore;
}

async function signedPublish(payload, releaseToken, nonce, timestamp) {
  const body = JSON.stringify(payload);
  const bodyHash = await digestHex(encoder.encode(body));
  const canonical = `${schema}\0POST\0${route}\0${timestamp}\0${nonce}\0${bodyHash}`;
  const hmacKey = await webcrypto.subtle.importKey("raw", encoder.encode(releaseToken),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await webcrypto.subtle.sign("HMAC", hmacKey, encoder.encode(canonical)));
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", signal: AbortSignal.timeout(35_000), redirect: "error", headers: {
      "content-type": "application/json",
      "x-usage-monitor-release-timestamp": String(timestamp),
      "x-usage-monitor-release-nonce": nonce,
      "x-usage-monitor-release-signature": base64url(signature),
    }, body,
  });
}

async function assertLocalIsolation() {
  for (const name of [".dev.vars", ".env", ".env.local"]) {
    try {
      await fs.lstat(join(workerDir, "gcs-test", name));
      fail("EXISTING_LOCAL_CREDENTIALS");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error("LOCAL_PORT_IN_USE")));
    server.listen(port, "127.0.0.1", () => server.close(resolvePromise));
  });
}

async function smoke(args) {
  await assertLocalIsolation();
  const token = await read0600Token(args.tokenFile);
  receiptFile = args.receiptFile;
  receiptContext = {
    bucket: args.bucket,
    runId: args.runId,
    runPrefix: runPrefix(args.runId),
  };
  await writeReceiptSnapshot(true);
  runDir = await fs.mkdtemp(join(tmpdir(), "tibotattle-gcs-smoke-"));
  await fs.chmod(runDir, 0o700);
  const fields = await signingFields();
  const varsFile = join(runDir, ".dev.vars");
  await writeDevVars(varsFile, {
    GCS_TEST_BUCKET: args.bucket, GCS_ACCESS_TOKEN: token,
    GCS_ACCESS_TOKEN_EXPIRES_AT: String(args.expiry),
    GCS_TEST_RUN_ID: args.runId,
    GCS_TEST_RELEASE_TOKEN: fields.releaseToken,
    GCS_TEST_PUBLIC_ED_KEY: fields.publicKey,
    GCS_TEST_PUBLIC_ED_KEY_SHA256: fields.publicKeySha256,
  });
  const Adapter = await bundleAdapter(join(runDir, "gcs-release-object-store.mjs"));
  const store = new Adapter(args.bucket, async () => {
    if (Math.floor(Date.now() / 1000) >= args.expiry) fail("TOKEN_EXPIRED");
    return token;
  });
  const appcastKey = `${receiptContext.runPrefix}/appcast.xml`;
  const objectPrefix = `${receiptContext.runPrefix}/releases`;
  const existing = await store.head(appcastKey);
  if (existing !== null) fail("APPCAST_ALREADY_EXISTS");

  await startWorker(process.env, join(runDir, "state"), varsFile);
  const unauthenticated = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5_000),
  });
  if (unauthenticated.status !== 401) fail("LOCAL_CONFIGURATION_PREFLIGHT_FAILED");
  const artifactBytes = encoder.encode("synthetic-gcs-adapter-qualification-artifact");
  const artifactDigest = await digestHex(artifactBytes);
  const artifactKey = `${objectPrefix}/1.0.0/${artifactDigest}/TiboTattle.dmg`;
  await journalAttempt(artifactKey);
  const artifactWrite = await store.put(artifactKey, artifactBytes, {
    condition: { kind: "absent" }, sha256: await digest(artifactBytes),
    contentType: "application/x-apple-diskimage", cacheControl: "no-store",
  });
  if (artifactWrite.status === "stored") {
    await journalCreated(artifactKey);
    await journalGeneration(artifactKey, artifactWrite.metadata.version);
  } else {
    fail("ARTIFACT_ALREADY_EXISTS");
  }

  const artifactSignature = base64(new Uint8Array(await webcrypto.subtle.sign(
    { name: "Ed25519" }, fields.pair.privateKey, artifactBytes,
  )));
  const candidate = encoder.encode(`<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>\n<enclosure url="${updateOrigin}/${artifactKey}" length="${artifactBytes.byteLength}" sparkle:version="1.0.0" sparkle:edSignature="${artifactSignature}" />\n</item></channel></rss>`);
  const payload = {
    schemaVersion: schema, channel, bucket: args.bucket, key: appcastKey,
    contentType: "application/xml; charset=utf-8", cacheControl: "no-store",
    expectedCurrent: { state: "empty", bytes: 0, sha256: null, etag: null },
    candidate: { bytes: candidate.byteLength, sha256: await digestHex(candidate), base64: base64url(candidate) },
  };
  const timestamp = Math.floor(Date.now() / 1000);
  await journalAttempt(appcastKey);
  const first = await signedPublish(payload, fields.releaseToken, `gcs-smoke-${args.runId}-01`, timestamp);
  if (first.status !== 200) {
    const result = await first.json().catch(() => null);
    const code = result?.error?.code;
    const phase = first.headers.get("x-gcs-test-phase");
    if (phase && /^[a-z0-9-]{1,50}$/u.test(phase)) transportEvents.push({ phase });
    await writeReceiptSnapshot();
    fail(`PUBLISH_HTTP_${first.status}_${typeof code === "string" && /^[A-Z_]{1,100}$/u.test(code) ? code : "UNKNOWN"}`);
  }
  await journalCreated(appcastKey);
  const replay = await signedPublish(payload, fields.releaseToken, `gcs-smoke-${args.runId}-01`, timestamp);
  if (replay.status !== 401) fail("REPLAY_NOT_REJECTED");

  const current = await store.head(appcastKey);
  if (current === null) fail("CURRENT_READ_MISSING");
  const currentRead = await store.get(appcastKey, current.version);
  if (currentRead.status !== "found" || await digestHex(await currentRead.arrayBuffer()) !== await digestHex(candidate)) {
    fail("CURRENT_READ_FAILED");
  }

  await journalGeneration(appcastKey, current.version);
  const replaceKey = `${receiptContext.runPrefix}/scratch/replace.bin`;
  const firstBytes = encoder.encode(`replace-before-${args.runId}`);
  const secondBytes = encoder.encode(`replace-after-${args.runId}`);
  await journalAttempt(replaceKey);
  const firstReplace = await store.put(replaceKey, firstBytes, {
    condition: { kind: "absent" }, sha256: await digest(firstBytes), contentType: "application/octet-stream", cacheControl: "no-store",
  });
  if (firstReplace.status !== "stored") fail("REPLACE_CREATE_FAILED");
  await journalCreated(replaceKey);
  const replaceHead = await store.head(replaceKey);
  if (replaceHead === null) fail("REPLACE_HEAD_FAILED");
  const replaced = await store.put(replaceKey, secondBytes, {
    condition: { kind: "version", version: replaceHead.version }, sha256: await digest(secondBytes), contentType: "application/octet-stream", cacheControl: "no-store",
  });
  if (replaced.status !== "stored") fail("REPLACE_FAILED");
  const stale = await store.put(replaceKey, firstBytes, {
    condition: { kind: "version", version: replaceHead.version }, sha256: await digest(firstBytes), contentType: "application/octet-stream", cacheControl: "no-store",
  });
  if (stale.status !== "conflict") fail("STALE_WRITE_ACCEPTED");
  const staleRead = await store.get(replaceKey, replaceHead.version);
  if (staleRead.status !== "conflict") fail("STALE_READ_ACCEPTED");
  const replacementHead = await store.head(replaceKey);
  if (replacementHead?.version !== replaced.metadata.version) fail("REPLACEMENT_CHANGED");
  const replacementRead = await store.get(replaceKey, replacementHead.version);
  if (replacementRead.status !== "found"
      || await digestHex(await replacementRead.arrayBuffer()) !== await digestHex(secondBytes)) fail("REPLACEMENT_BYTES_INVALID");
  await journalGeneration(replaceKey, replacementHead.version);

  const raceKey = `${receiptContext.runPrefix}/scratch/race.bin`;
  const raceA = encoder.encode(`race-a-${args.runId}`);
  const raceB = encoder.encode(`race-b-${args.runId}`);
  await journalAttempt(raceKey);
  const race = await Promise.all([
    store.put(raceKey, raceA, { condition: { kind: "absent" }, sha256: await digest(raceA), contentType: "application/octet-stream", cacheControl: "no-store" }),
    store.put(raceKey, raceB, { condition: { kind: "absent" }, sha256: await digest(raceB), contentType: "application/octet-stream", cacheControl: "no-store" }),
  ]);
  if (race.filter((result) => result.status === "stored").length !== 1
      || race.filter((result) => result.status === "conflict").length !== 1) fail("RACE_CONDITION_UNPROVEN");
  await journalCreated(raceKey);
  const winner = race.findIndex((result) => result.status === "stored");
  const winnerVersion = race[winner].metadata.version;
  const winnerRead = await store.get(raceKey, winnerVersion);
  if (winnerRead.status !== "found"
      || await digestHex(await winnerRead.arrayBuffer()) !== await digestHex(winner === 0 ? raceA : raceB)) fail("RACE_BYTES_INVALID");
  await journalGeneration(raceKey, winnerVersion);
  return { appcastKey, artifactKey, replaceKey, raceKey, appcastVersion: current.version };
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  for (const processHandle of [...processes]) await stopProcess(processHandle);
  if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    receiptStatus = "interrupted";
    receiptCode = "INTERRUPTED";
    void writeReceiptSnapshot().catch(() => undefined).finally(async () => {
      console.error(JSON.stringify({
        status: "interrupted",
        code: "INTERRUPTED",
        ...(receiptContext === undefined ? {} : {
          bucket: receiptContext.bucket,
          runId: receiptContext.runId,
          runPrefix: receiptContext.runPrefix,
        }),
        attemptedKeys,
        createdKeys,
        generations,
        transportEvents,
      }));
      await cleanup();
      process.exit(128 + (signal === "SIGINT" ? 2 : 15));
    });
  });
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    usage();
  } else {
    const receipt = await smoke(parsed);
    receiptStatus = "passed";
    receiptCode = undefined;
    await writeReceiptSnapshot();
    console.log(JSON.stringify({
      status: "passed",
      bucket: parsed.bucket,
      runId: parsed.runId,
      runPrefix: receiptContext.runPrefix,
      receiptFile: parsed.receiptFile,
      attemptedKeys,
      createdKeys,
      generations,
      transportEvents,
      ...receipt,
    }));
  }
} catch (error) {
  const message = typeof error?.message === "string" && /^[A-Z0-9_]+$/u.test(error.message)
    ? error.message : "LIVE_SMOKE_FAILED";
  receiptStatus = "failed";
  receiptCode = message;
  await writeReceiptSnapshot().catch(() => undefined);
  console.error(JSON.stringify({
    status: "failed",
    code: message,
    ...(receiptContext === undefined ? {} : {
      bucket: receiptContext.bucket,
      runId: receiptContext.runId,
      runPrefix: receiptContext.runPrefix,
      receiptFile,
    }),
    attemptedKeys,
    createdKeys,
    generations,
    transportEvents,
  }));
  process.exitCode = 1;
} finally {
  await cleanup();
}
