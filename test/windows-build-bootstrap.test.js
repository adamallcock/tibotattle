import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  assertNoWindowsSigningAuthority, inspectWindowsPnpmArchive, prepareWindowsBuildBootstrap,
  readWindowsBuildBootstrapPolicy, validateWindowsBuildBootstrapPolicy,
} from "../scripts/prepare-windows-build-bootstrap.mjs";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const hash = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const nodeBytes = Buffer.from("PK\u0003\u0004synthetic-reviewed-node-archive-never-executed");
const metadata = () => ({ name: "pnpm", version: "11.9.0", bin: { pnpm: "bin/pnpm.mjs" } });
const entries = () => [
  { path: "package/package.json", bytes: Buffer.from(JSON.stringify(metadata())) },
  { path: "package/bin/pnpm.mjs", bytes: Buffer.from('throw new Error("ARCHIVE_EXECUTION_FORBIDDEN");\n') },
  { path: "package/dist/tool.mjs", bytes: Buffer.from("synthetic-transitive-tool-bytes") },
  { path: "package/dist/empty", bytes: Buffer.alloc(0) },
];
function putOctal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
function tarArchive(files, { mutateHeader, trailing = Buffer.alloc(1024) } = {}) {
  const blocks = [];
  for (const [index, file] of files.entries()) {
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, "ascii");
    putOctal(header, 100, 8, file.mode ?? 0o644);
    putOctal(header, 108, 8, 0);
    putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, file.bytes.length);
    putOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (file.type ?? "0").charCodeAt(0);
    header.write(file.link ?? "", 157, 100, "ascii");
    header.write("ustar\0" + "00", 257, 8, "ascii");
    if (file.prefix) header.write(file.prefix, 345, 155, "ascii");
    mutateHeader?.(header, index);
    const checksum = header.reduce((sum, byte, offset) => sum + (offset >= 148 && offset < 156 ? 32 : byte), 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  return Buffer.concat([...blocks, trailing]);
}
function policyFor(archive, files = entries()) {
  const integrity = `sha512-${hash(archive, "sha512", "base64")}`;
  return {
    schemaVersion: "tibotattle-windows-build-bootstrap-v1",
    node: { version: "26.2.0", archiveUrl: "https://nodejs.org/dist/v26.2.0/node-v26.2.0-win-x64.zip",
      archiveSha256: hash(nodeBytes), archiveBytes: nodeBytes.length, archiveRoot: "node-v26.2.0-win-x64" },
    pnpm: { name: "pnpm", version: "11.9.0", archiveUrl: "https://registry.npmjs.org/pnpm/-/pnpm-11.9.0.tgz",
      archiveBytes: archive.length, integrity, fileCount: files.length,
      unpackedBytes: files.reduce((total, file) => total + file.bytes.length, 0), entrypoint: "package/bin/pnpm.mjs",
      signature: { keyId: `SHA256:${hash(Buffer.from(publicKey, "base64"), "sha256", "base64").replace(/=+$/u, "")}`,
        publicKey, signature: sign("sha256", Buffer.from(`pnpm@11.9.0:${integrity}`), pair.privateKey).toString("base64") } },
  };
}
async function withFixture(run, files = entries(), tarOptions) {
  const temporary = await mkdtemp(join(tmpdir(), "tibotattle-bootstrap-test-"));
  const root = await realpath(temporary);
  try {
    const archive = gzipSync(tarArchive(files, tarOptions));
    const policy = policyFor(archive, files);
    const outputRoot = join(root, "bootstrap");
    const requests = [];
    const adapters = { environment: {}, policy,
      async fetcher(url, options) {
        requests.push({ url, options });
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        const bytes = url === policy.node.archiveUrl ? nodeBytes : archive;
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      } };
    await run({ root, outputRoot, archive, policy, files, requests, adapters });
  } finally { await rm(root, { force: true, recursive: true }); }
}
async function absent(path) { await assert.rejects(lstat(path), { code: "ENOENT" }); }
async function tree(root, prefix = "") {
  const output = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.isDirectory()) Object.assign(output, await tree(root, relative));
    else output[relative] = stat.isSymbolicLink() ? "symbolic-link" : hash(await readFile(path));
  }
  return output;
}

test("reviewed bootstrap policy verifies the pinned registry signature without network", async () => {
  const policy = await readWindowsBuildBootstrapPolicy();
  assert.equal(policy.node.version, "26.2.0");
  assert.equal(policy.node.archiveBytes, 39038614);
  assert.equal(policy.node.archiveSha256, "371071a4f7e2c8a5dd280730049c685911feecc59f50ebc488d675dc1087c69c");
  assert.equal(policy.pnpm.version, "11.9.0");
  assert.equal(policy.pnpm.archiveBytes, 4603130);
  assert.equal(policy.pnpm.fileCount, 450);
  assert.equal(policy.pnpm.unpackedBytes, 18742792);
  assert.equal(validateWindowsBuildBootstrapPolicy(policy), policy);
});

test("bootstrap verifies the complete closure before writing and never executes package code", async () => {
  await withFixture(async f => {
    const receipt = await prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters);
    assert.equal(receipt.status, "verified_not_executed");
    assert.equal(receipt.nodeArchive, "node.zip");
    assert.equal(receipt.pnpmEntrypoint, "pnpm/package/bin/pnpm.mjs");
    assert.equal(receipt.pnpm.registrySignature, "verified");
    assert.deepEqual(f.requests.map(request => request.url), [f.policy.node.archiveUrl, f.policy.pnpm.archiveUrl]);
    const expected = { "node.zip": hash(nodeBytes), "bootstrap-receipt.json": hash(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)) };
    for (const file of f.files) {
      expected[`pnpm/${file.path}`] = hash(file.bytes);
      assert.deepEqual(await readFile(join(f.outputRoot, "pnpm", file.path)), file.bytes);
    }
    assert.deepEqual(await tree(f.outputRoot), expected);
  });
});

test("bootstrap refuses signing authority before policy, network, or filesystem access", async () => {
  for (const name of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "AZURE_CLIENT_ID", "AZURE_TENANT_ID",
    "AZURE_CLIENT_SECRET", "AZURE_FEDERATED_TOKEN_FILE", "AZURE_CONFIG_DIR", "AZURE_ACCESS_TOKEN", "AZURE_AUTH_LOCATION",
    "ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_OIDC_TOKEN", "CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) {
    const adapters = { environment: { [name]: "synthetic-authority-canary" },
      get policy() { assert.fail("authority must be rejected before policy read"); },
      get fetcher() { assert.fail("authority must be rejected before downloader selection"); } };
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: "\0" }, adapters), /WINDOWS_BUILD_BOOTSTRAP_SIGNING_AUTHORITY_PRESENT/u);
  }
  assert.throws(() => assertNoWindowsSigningAuthority({ TIBOTATTLE_ELECTRON_SIGNING_MODE: "azure-trusted-signing" }), /WINDOWS_BUILD_BOOTSTRAP_SIGNING_AUTHORITY_PRESENT/u);
  assert.doesNotThrow(() => assertNoWindowsSigningAuthority({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "", unrelated: "allowed" }));
});

test("policy schema, versions, URLs, resource bounds, and registry signature fail closed", async () => {
  const mutations = [
    value => { value.extra = true; }, value => { value.node.archiveBytes = 64 * 1024 * 1024 + 1; },
    value => { value.node.archiveUrl = "https://attacker.invalid/node.zip"; }, value => { value.node.archiveRoot = "../outside"; },
    value => { value.pnpm.archiveBytes = 16 * 1024 * 1024 + 1; }, value => { value.pnpm.fileCount = 2049; },
    value => { value.pnpm.unpackedBytes = 32 * 1024 * 1024 + 1; }, value => { value.pnpm.entrypoint = "package/other.mjs"; },
    value => { value.pnpm.archiveUrl += "#fragment"; }, value => { value.pnpm.version = "latest"; },
    value => { value.pnpm.integrity = `sha512-${"a".repeat(86)}==`; },
    value => { value.pnpm.signature.signature = Buffer.alloc(70).toString("base64"); },
    value => { value.pnpm.signature.publicKey = Buffer.from("invalid-public-key").toString("base64"); },
  ];
  for (const mutate of mutations) await withFixture(async f => {
    mutate(f.policy);
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_(?:POLICY_INVALID|REGISTRY_SIGNATURE_INVALID)/u);
    assert.equal(f.requests.length, 0);
    await absent(f.outputRoot);
  });
});

test("tampered Node and pnpm archives are refused before any extraction", async () => {
  for (const target of ["node", "pnpm"]) await withFixture(async f => {
    const original = f.adapters.fetcher;
    f.adapters.fetcher = async (url, options) => {
      const response = await original(url, options);
      if (url !== f.policy[target].archiveUrl) return response;
      const bytes = Buffer.from(await response.arrayBuffer());
      bytes[bytes.length - 1] ^= 1;
      return new Response(bytes);
    };
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), new RegExp(`WINDOWS_BUILD_BOOTSTRAP_${target.toUpperCase()}_ARCHIVE_DIGEST_MISMATCH`, "u"));
    await absent(f.outputRoot);
  });
});

test("download redirects, wrong content length, short and oversized streams fail before writes", async () => {
  const responses = [
    () => ({ ok: true, redirected: true, body: new Response(nodeBytes).body }),
    () => ({ ok: true, url: "https://attacker.invalid/file", body: new Response(nodeBytes).body }),
    () => new Response(nodeBytes, { headers: { "content-length": String(nodeBytes.length + 1) } }),
    () => new Response(nodeBytes.subarray(0, -1)),
    () => new Response(Buffer.concat([nodeBytes, Buffer.from("extra")])),
    () => new Response("unavailable", { status: 503 }),
  ];
  for (const response of responses) await withFixture(async f => {
    f.adapters.fetcher = async () => response();
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_DOWNLOAD_(?:FAILED|SIZE_INVALID)/u);
    await absent(f.outputRoot);
  });
});

test("download timeout bounds fetch, idle streams, and slow-drip streams without awaiting cancellation", async () => {
  for (const mode of ["fetch", "idle", "slow-drip"]) await withFixture(async f => {
    f.adapters.downloadDeadlineMs = 25;
    let cancellations = 0;
    let bytes = 0;
    f.adapters.fetcher = mode === "fetch" ? async () => new Promise(() => {}) : async () => ({ ok: true,
      body: { getReader: () => ({
        read: mode === "idle" ? async () => new Promise(() => {}) : async () => {
          await new Promise(resolve => setTimeout(resolve, 8));
          bytes += 1;
          return { done: false, value: Buffer.from("a") };
        },
        cancel: () => { cancellations += 1; return new Promise(() => {}); },
      }) },
    });
    const started = Date.now();
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_DOWNLOAD_TIMEOUT/u);
    assert.ok(Date.now() - started < 1000);
    if (mode !== "fetch") assert.equal(cancellations, 1);
    if (mode === "slow-drip") assert.ok(bytes > 0 && bytes < nodeBytes.length);
    await absent(f.outputRoot);
  });
});

test("archive admission rejects traversal, absolute and Windows-special paths, and path collisions", async () => {
  for (const path of ["../outside", "/absolute", "package/../outside", "package//file", "package/./file", "package/C:/file",
    "package\\file", "package/con.txt", "package/aux", "package/file.", "package/bad name", "package/file\nname"]) {
    const files = entries(); files[2].path = path;
    await withFixture(async f => {
      await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_TAR_(?:PATH_INVALID|HEADER_INVALID)/u);
      await absent(f.outputRoot);
      await absent(join(f.root, "outside"));
    }, files);
  }
  for (const extra of [
    { path: "package/bin/pnpm.mjs", bytes: Buffer.from("duplicate") },
    { path: "package/BIN/PNPM.MJS", bytes: Buffer.from("case-collision") },
    { path: "package/bin", bytes: Buffer.from("file-versus-directory") },
  ]) await withFixture(async f => {
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_TAR_PATH_COLLISION/u);
    await absent(f.outputRoot);
  }, [...entries(), extra]);
});

test("archive rejects links, devices, directories, sparse/PAX metadata, privileged modes, and bad checksums", async () => {
  for (const type of ["1", "2", "3", "4", "5", "6", "S", "x", "g", "L"]) {
    const files = entries(); files[2].type = type; files[2].link = "target";
    await withFixture(async f => {
      assert.throws(() => inspectWindowsPnpmArchive(f.archive, f.policy), /WINDOWS_BUILD_BOOTSTRAP_TAR_HEADER_INVALID/u);
      await absent(f.outputRoot);
    }, files);
  }
  const privileged = entries(); privileged[2].mode = 0o4755;
  await withFixture(async f => assert.throws(() => inspectWindowsPnpmArchive(f.archive, f.policy), /WINDOWS_BUILD_BOOTSTRAP_TAR_MODE_INVALID/u), privileged);
  await withFixture(async f => {
    const tar = tarArchive(f.files); tar[0] ^= 1;
    const archive = gzipSync(tar); const policy = policyFor(archive, f.files);
    assert.throws(() => inspectWindowsPnpmArchive(archive, policy), /WINDOWS_BUILD_BOOTSTRAP_TAR_HEADER_INVALID/u);
  });
});

test("archive bounds reject incomplete termination, trailing data, mismatched count, and decompression expansion", async () => {
  for (const trailing of [Buffer.alloc(0), Buffer.alloc(512), Buffer.concat([Buffer.alloc(1024), Buffer.from("unreviewed")])]) {
    await withFixture(async f => assert.throws(() => inspectWindowsPnpmArchive(f.archive, f.policy), /WINDOWS_BUILD_BOOTSTRAP_TAR_/u), entries(), { trailing });
  }
  await withFixture(async f => {
    f.policy.pnpm.fileCount += 1;
    assert.throws(() => inspectWindowsPnpmArchive(f.archive, f.policy), /WINDOWS_BUILD_BOOTSTRAP_TAR_SET_INVALID/u);
  });
  await withFixture(async f => {
    const archive = gzipSync(Buffer.alloc(1024 * 1024));
    const policy = policyFor(archive, f.files);
    assert.throws(() => inspectWindowsPnpmArchive(archive, policy), /WINDOWS_BUILD_BOOTSTRAP_TAR_INVALID_OR_TOO_LARGE/u);
  });
});

test("package identity, entrypoint and undeclared external dependency needs are refused", async () => {
  for (const mutate of [value => { value.name = "other"; }, value => { value.version = "11.9.1"; },
    value => { value.bin.pnpm = "other.mjs"; }, value => { value.dependencies = { unexpected: "1" }; },
    value => { value.optionalDependencies = {}; }]) {
    const files = entries(); const value = metadata(); mutate(value); files[0].bytes = Buffer.from(JSON.stringify(value));
    await withFixture(async f => {
      await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_PACKAGE_METADATA_INVALID/u);
      await absent(f.outputRoot);
    }, files);
  }
  const missing = entries().filter(file => file.path !== "package/bin/pnpm.mjs");
  await withFixture(async f => assert.throws(() => inspectWindowsPnpmArchive(f.archive, f.policy), /WINDOWS_BUILD_BOOTSTRAP_TAR_SET_INVALID/u), missing);
});

test("bootstrap preserves preexisting output and rejects linked output ancestors before network", async () => {
  await withFixture(async f => {
    await mkdir(f.outputRoot); await writeFile(join(f.outputRoot, "owner-data"), "preserve");
    const before = await tree(f.outputRoot);
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_OUTPUT_EXISTS/u);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await tree(f.outputRoot), before);
  });
  await withFixture(async f => {
    const target = join(f.root, "target"); await mkdir(target);
    const linked = join(f.root, "linked"); await symlink(target, linked, "junction");
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: join(linked, "bootstrap") }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_OUTPUT_PATH_UNSAFE/u);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await tree(target), {});
  });
});

test("interrupted extraction removes only its newly created output and emits no receipt", async (t) => {
  await withFixture(async f => {
    const ownerFile = join(f.root, "unrelated-owner-data"); await writeFile(ownerFile, "preserve");
    const nativeWriteFile = fsPromises.writeFile;
    let writes = 0;
    const mockedWrite = t.mock.method(fsPromises, "writeFile", async (path, bytes, options) => {
      writes += 1;
      if (String(path).endsWith("pnpm.mjs")) throw Object.assign(new Error("synthetic-write-failure"), { code: "EIO" });
      return nativeWriteFile(path, bytes, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_EXTRACTION_FAILED/u);
      assert.ok(writes >= 2);
      await absent(f.outputRoot);
      assert.equal(await readFile(ownerFile, "utf8"), "preserve");
    } finally { mockedWrite.mock.restore(); syncBuiltinESMExports(); }
  });
});

test("bootstrap CLI reports only a fixed refusal when signing authority is present", async () => {
  const script = fileURLToPath(new URL("../scripts/prepare-windows-build-bootstrap.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--output-root", "synthetic-private-path-canary"], {
    encoding: "utf8", timeout: 15_000, env: { ...process.env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-authority-canary" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "WINDOWS_BUILD_BOOTSTRAP_SIGNING_AUTHORITY_PRESENT\n");
});

test("download chunk flooding is bounded independently of payload bytes and timer scheduling", async () => {
  await withFixture(async f => {
    let reads = 0;
    let cancellations = 0;
    f.adapters.fetcher = async () => ({ ok: true, body: { getReader: () => ({
      async read() { reads += 1; return { done: false, value: new Uint8Array() }; },
      cancel: () => { cancellations += 1; return new Promise(() => {}); },
    }) } });
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_DOWNLOAD_EMPTY_CHUNK_FLOOD/u);
    assert.equal(reads, 17);
    assert.equal(cancellations, 1);
    await absent(f.outputRoot);
  });
  await withFixture(async f => {
    f.adapters.downloadDeadlineMs = 20;
    let reads = 0;
    f.adapters.fetcher = async () => ({ ok: true, body: { getReader: () => ({
      async read() {
        reads += 1;
        const until = Date.now() + 5;
        while (Date.now() < until) { /* Model a synchronously fulfilled, CPU-heavy reader. */ }
        return { done: false, value: Buffer.from("a") };
      },
      cancel: async () => {},
    }) } });
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_DOWNLOAD_TIMEOUT/u);
    assert.ok(reads < nodeBytes.length);
    await absent(f.outputRoot);
  });
});

test("an output created during downloading is preserved without extraction or cleanup", async () => {
  await withFixture(async f => {
    const original = f.adapters.fetcher;
    f.adapters.fetcher = async (url, options) => {
      if (url === f.policy.pnpm.archiveUrl) {
        await mkdir(f.outputRoot);
        await writeFile(join(f.outputRoot, "new-owner-data"), "preserve-created-during-download");
      }
      return original(url, options);
    };
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_EXTRACTION_FAILED/u);
    assert.deepEqual(await tree(f.outputRoot), { "new-owner-data": hash(Buffer.from("preserve-created-during-download")) });
  });
});

test("an ancestor replaced by a symlink during downloading refuses before extraction", async () => {
  await withFixture(async f => {
    const parent = join(f.root, "new-parent");
    const target = join(f.root, "unrelated-target");
    await mkdir(target);
    await writeFile(join(target, "owner-data"), "preserve-linked-target");
    f.outputRoot = join(parent, "bootstrap");
    const original = f.adapters.fetcher;
    f.adapters.fetcher = async (url, options) => {
      if (url === f.policy.pnpm.archiveUrl) await symlink(target, parent, "junction");
      return original(url, options);
    };
    await assert.rejects(prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters), /WINDOWS_BUILD_BOOTSTRAP_OUTPUT_PATH_UNSAFE/u);
    assert.deepEqual(await tree(target), { "owner-data": hash(Buffer.from("preserve-linked-target")) });
    assert.equal((await lstat(parent)).isSymbolicLink(), true);
  });
});

test("tiny-chunk reads release each deadline timer while preserving one absolute deadline", async (t) => {
  await withFixture(async f => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const active = new Set();
    let created = 0;
    let peak = 0;
    let reads = 0;
    const mockedSetTimeout = t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      let timer;
      timer = realSetTimeout(() => { active.delete(timer); callback(...args); }, delay);
      created += 1;
      active.add(timer);
      peak = Math.max(peak, active.size);
      return timer;
    });
    const mockedClearTimeout = t.mock.method(globalThis, "clearTimeout", timer => { active.delete(timer); return realClearTimeout(timer); });
    f.adapters.fetcher = async url => {
      const bytes = url === f.policy.node.archiveUrl ? nodeBytes : f.archive;
      let position = 0;
      let empty = false;
      return { ok: true, body: { getReader: () => ({
        async read() {
          reads += 1;
          if (position === bytes.length) return { done: true };
          empty = !empty;
          if (empty) return { done: false, value: new Uint8Array() };
          return { done: false, value: bytes.subarray(position, ++position) };
        },
        cancel: async () => {},
      }) } };
    };
    try {
      const receipt = await prepareWindowsBuildBootstrap({ outputRoot: f.outputRoot }, f.adapters);
      assert.equal(receipt.status, "verified_not_executed");
      assert.ok(reads > nodeBytes.length + f.archive.length);
      assert.equal(created, reads + 2);
      assert.equal(peak, 1);
      assert.equal(active.size, 0);
    } finally { mockedSetTimeout.mock.restore(); mockedClearTimeout.mock.restore(); }
  });
});
