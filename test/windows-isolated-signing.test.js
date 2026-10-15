import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { constants, promises as fsPromises } from "node:fs";
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyWindowsSignedSubjects, assertPlainPath, createWindowsSigningSubjectManifest, hashPlainFile,
  readWindowsSigningSubjectManifest, sha256, signingSubjectPaths, validateSignedSubjectReceipt,
  validateSigningSubjectManifest,
} from "../scripts/lib/windows-signing-subjects.mjs";
import {
  downloadWindowsSigningToolchain, verifyWindowsSigningToolchain,
} from "../scripts/lib/windows-signing-toolchain.mjs";
import { signWindowsSubjects, verifyWindowsPublisher } from "../scripts/sign-electron-windows-subjects.mjs";

const SOURCE = "a".repeat(40);
const CANDIDATE = "b".repeat(64);
const CERTIFICATE = "c".repeat(64);
const TOKEN = "synthetic.oidc.token-canary";
const SIGNATURE = Buffer.from("\nsynthetic-authenticode-signature");
const ENVIRONMENT = Object.freeze({
  AZURE_CLIENT_ID: "12345678-1234-1234-1234-123456789012",
  AZURE_TENANT_ID: "87654321-4321-4321-4321-210987654321",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-secret-canary",
  AZURE_CLIENT_SECRET: "synthetic-ambient-secret-canary",
  PATH: "synthetic-untrusted-path",
  NODE_OPTIONS: "synthetic-untrusted-node-options",
});
const clone = (value) => structuredClone(value);
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
async function absent(path) { await assert.rejects(lstat(path), { code: "ENOENT" }); }
async function filesUnder(root, prefix = "") {
  const files = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const path = join(root, relative);
    const state = await lstat(path);
    if (state.isDirectory()) Object.assign(files, await filesUnder(root, relative));
    else if (state.isFile()) files[relative] = sha256(await readFile(path));
    else files[relative] = "link-or-special-file";
  }
  return files;
}
async function assertNoCredentialContent(root) {
  for (const path of Object.keys(await filesUnder(root))) {
    const bytes = await readFile(join(root, path));
    for (const value of [TOKEN, ENVIRONMENT.AZURE_CLIENT_SECRET, ENVIRONMENT.ACTIONS_ID_TOKEN_REQUEST_TOKEN]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, "output retained a synthetic credential canary");
    }
  }
}
async function write(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }

async function withFixture(run, stage = "native") {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-isolated-signer-"));
  try {
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const toolchainRoot = join(root, "tools");
    await mkdir(inputRoot);
    await mkdir(toolchainRoot);
    const toolBytes = new Map([
      ["sdk/signtool.exe", Buffer.from("synthetic-reviewed-signtool")],
      ["dlib/Azure.CodeSigning.Dlib.dll", Buffer.from("synthetic-reviewed-dlib")],
      ["dlib/runtime/credential.dll", Buffer.from("synthetic-reviewed-transitive-runtime")],
      ["dlib/runtime/dependencies.json", Buffer.from('{"synthetic":true}')],
    ]);
    const policy = { schemaVersion: "tibotattle-windows-signing-toolchain-v1", status: "reviewed",
      tools: { signtool: "sdk/signtool.exe", dlib: "dlib/Azure.CodeSigning.Dlib.dll" },
      files: [...toolBytes].map(([path, bytes]) => ({ path, sha256: sha256(bytes), sizeBytes: bytes.length,
        sourceUrl: `https://example.invalid/signing-tools/${path}`,
        publisherCertificateSha256: /\.(?:exe|dll)$/u.test(path) ? CERTIFICATE : null })) };
    for (const [path, bytes] of toolBytes) await write(join(toolchainRoot, path), bytes);
    const paths = signingSubjectPaths(stage, "1.2.3");
    for (const path of paths) await write(join(inputRoot, path), Buffer.from(`synthetic-unsigned-subject:${path}`));
    await write(join(inputRoot, "unrelated.txt"), "preserve unrelated input");
    const manifest = await createWindowsSigningSubjectManifest({ root: inputRoot, sourceRevision: SOURCE,
      candidateSha256: CANDIDATE, version: "1.2.3", buildNumber: "123", stage });
    const manifestPath = join(root, "subjects.json");
    await writeFile(manifestPath, json(manifest));
    const options = { inputRoot, outputRoot, toolchainRoot, manifestPath, manifestSha256: sha256(json(manifest)),
      expectedSourceRevision: SOURCE, expectedCandidateSha256: CANDIDATE, expectedStage: stage };
    const calls = { tokens: 0, signs: [], publishers: [], verified: [] };
    const adapters = { policy, platform: "win32", arch: "x64", environment: { ...ENVIRONMENT },
      async getToken(environment) { calls.tokens += 1; assert.equal(environment.AZURE_CLIENT_ID, ENVIRONMENT.AZURE_CLIENT_ID); return TOKEN; },
      async verifyPublisher(path, certificate) { calls.publishers.push(path); assert.equal(certificate, CERTIFICATE); return true; },
      async execute(command, args, environment) {
        assert.equal(command, join(toolchainRoot, policy.tools.signtool));
        assert.equal(args[0], "sign");
        assert.deepEqual(Object.keys(environment).sort(), ["AZURE_CLIENT_ID", "AZURE_FEDERATED_TOKEN_FILE", "AZURE_TENANT_ID"]);
        assert.equal(await readFile(environment.AZURE_FEDERATED_TOKEN_FILE, "utf8"), TOKEN);
        // POSIX mode cannot establish the Windows runner's inherited ACLs.
        if (process.platform !== "win32") assert.equal((await lstat(environment.AZURE_FEDERATED_TOKEN_FILE)).mode & 0o777, 0o600);
        const target = args.at(-1);
        assert.equal(args[args.indexOf("/dlib") + 1], join(toolchainRoot, policy.tools.dlib));
        const metadata = JSON.parse(await readFile(args[args.indexOf("/dmdf") + 1], "utf8"));
        assert.equal(metadata.Endpoint, "https://eus.codesigning.azure.net/");
        assert.ok(metadata.ExcludeCredentials.includes("EnvironmentCredential"));
        assert.ok(metadata.ExcludeCredentials.includes("AzureCliCredential"));
        assert.ok(!metadata.ExcludeCredentials.includes("WorkloadIdentityCredential"));
        assert.ok(!JSON.stringify([args, environment, metadata]).includes(TOKEN));
        calls.signs.push(target);
        await appendFile(target, SIGNATURE);
        return true;
      },
      async verifySigned(path) { calls.verified.push(path); return (await readFile(path)).subarray(-SIGNATURE.length).equals(SIGNATURE); },
    };
    await run({ root, options, policy, manifest, toolBytes, calls, adapters,
      async replaceManifest(value) { const bytes = json(value); await writeFile(manifestPath, bytes); options.manifestSha256 = sha256(bytes); } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function assertPreAuthorityRefusal(fixture, pattern, label) {
  await assert.rejects(signWindowsSubjects(fixture.options, fixture.adapters), pattern, label);
  assert.equal(fixture.calls.tokens, 0);
  assert.equal(fixture.calls.signs.length, 0);
  await absent(fixture.options.outputRoot);
}

test("isolated signer verifies and applies only the exact approved subjects for every signing stage", async () => {
  for (const stage of ["native", "application", "uninstaller", "installer"]) {
    await withFixture(async ({ options, adapters, manifest, calls }) => {
      const before = await filesUnder(options.inputRoot);
      const result = await signWindowsSubjects(options, adapters);
      assert.equal(calls.tokens, 1);
      assert.deepEqual(calls.signs, manifest.files.map(file => join(options.outputRoot, file.path)));
      assert.deepEqual(calls.verified, calls.signs);
      assert.equal(result.receiptSha256, sha256(await readFile(join(options.outputRoot, "signed-subjects.json"))));
      assert.equal(validateSignedSubjectReceipt(result.receipt, manifest, options.manifestSha256), result.receipt);
      assert.deepEqual(await filesUnder(options.inputRoot), before);
      await absent(join(options.outputRoot, ".signer-private"));
      assert.ok(!JSON.stringify(result).includes(TOKEN));
      await assertNoCredentialContent(options.outputRoot);
      await applyWindowsSignedSubjects({ root: options.inputRoot, signedRoot: options.outputRoot,
        manifest, receipt: result.receipt, expectedManifestSha256: options.manifestSha256 });
      const after = await filesUnder(options.inputRoot);
      assert.deepEqual(Object.keys(after), Object.keys(before));
      assert.equal(after["unrelated.txt"], before["unrelated.txt"]);
      for (const file of result.receipt.files) assert.equal(after[file.path], file.afterSha256);
    }, stage);
  }
});

test("toolchain missing, extra, wrong-size, altered, and linked transitive files refuse before OIDC", async () => {
  const cases = [
    ["missing", async (f, path) => rm(path)],
    ["extra file", async (f) => write(join(f.options.toolchainRoot, "dlib/runtime/unreviewed.dll"), "unreviewed")],
    ["extra directory", async (f) => mkdir(join(f.options.toolchainRoot, "unreviewed"))],
    ["wrong size", async (f) => { f.policy.files[2].sizeBytes += 1; }],
    ["tampered", async (f, path) => writeFile(path, "changed transitive tool bytes")],
    ["hardlink", async (f, path) => link(path, join(f.root, "transitive-hardlink"))],
    ["symlink", async (f, path) => { const other = join(f.root, "transitive-target"); await rename(path, other); await symlink(other, path); }],
    ["ancestor symlink", async (f) => { const path = join(f.options.toolchainRoot, "dlib/runtime"); const other = join(f.root, "runtime-target"); await rename(path, other); await symlink(other, path, "junction"); }],
    ["publisher mismatch", async (f) => { f.adapters.verifyPublisher = async () => false; }],
  ];
  for (const [name, corrupt] of cases) {
    await withFixture(async f => {
      await corrupt(f, join(f.options.toolchainRoot, "dlib/runtime/credential.dll"));
      await assertPreAuthorityRefusal(f, undefined, name);
    });
  }
});

test("unreviewed and malformed tool policies refuse before authority or filesystem output", async () => {
  const mutations = [
    policy => { policy.status = "provisioning_required"; policy.tools = null; policy.files = []; },
    policy => { policy.extra = true; },
    policy => { policy.files.pop(); policy.files.push(clone(policy.files[0])); },
    policy => { policy.files[0].path = "../signtool.exe"; },
    policy => { policy.files[0].sizeBytes = 256 * 1024 * 1024 + 1; },
    policy => { policy.files[0].publisherCertificateSha256 = null; },
    policy => { policy.files[3].publisherCertificateSha256 = CERTIFICATE; },
    policy => { policy.files[0].sourceUrl = "https://user:password@example.invalid/tool.exe"; },
    policy => { policy.files[0].sourceUrl = "https://example.invalid/tool.exe#fragment"; },
    policy => { policy.files[0].sourceUrl = "http://example.invalid/tool.exe"; },
    policy => { policy.tools.signtool = "sdk/arbitrary.exe"; },
  ];
  for (const mutate of mutations) await withFixture(async f => { mutate(f.policy); await assertPreAuthorityRefusal(f, /^Error: WINDOWS_SIGNING_TOOLCHAIN_/u); });
});

test("source, candidate, stage, manifest digest, and subject-set errors refuse before OIDC", async () => {
  for (const [key, value] of [["expectedSourceRevision", "d".repeat(40)], ["expectedCandidateSha256", "d".repeat(64)],
    ["expectedStage", "installer"], ["manifestSha256", "d".repeat(64)]]) {
    await withFixture(async f => { f.options[key] = value; await assertPreAuthorityRefusal(f, /^Error: WINDOWS_SIGNING_/u); });
  }
  for (const mutate of [value => { value.files.pop(); }, value => { value.files.push(clone(value.files[0])); },
    value => { value.files[0].path = "app/unreviewed.node"; }, value => { value.files[0].sizeBytes += 1; },
    value => { value.files[0].sha256 = "d".repeat(64); }, value => { value.extra = true; }]) {
    await withFixture(async f => { const value = clone(f.manifest); mutate(value); await f.replaceManifest(value); await assertPreAuthorityRefusal(f, /^Error: WINDOWS_SIGNING_/u); });
  }
});

test("subject missing, tampered, symlink, hardlink, and linked manifest inputs refuse before OIDC", async () => {
  for (const kind of ["missing", "tamper", "symlink", "hardlink", "manifest-symlink", "manifest-hardlink"]) {
    await withFixture(async f => {
      const path = kind.startsWith("manifest") ? f.options.manifestPath : join(f.options.inputRoot, f.manifest.files[0].path);
      if (kind === "missing") await rm(path);
      if (kind === "tamper") await appendFile(path, "changed");
      if (kind.includes("symlink")) { const other = join(f.root, "replaced-target"); await rename(path, other); await symlink(other, path); }
      if (kind.includes("hardlink")) await link(path, join(f.root, "linked-target"));
      await assertPreAuthorityRefusal(f, undefined);
    });
  }
});

test("subject paths and entry bounds form a closed contract", async () => {
  await withFixture(async f => {
    for (const path of ["", "/absolute", "../outside", "app/../outside", "app//file", "./file", "C:/file", "app\\file"]) {
      await assert.rejects(assertPlainPath(f.options.inputRoot, path), /WINDOWS_SIGNING_PATH_INVALID/u);
    }
    for (const sizeBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, 1024 * 1024 * 1024 + 1]) {
      const value = clone(f.manifest); value.files[0].sizeBytes = sizeBytes;
      assert.throws(() => validateSigningSubjectManifest(value), /WINDOWS_SIGNING_SUBJECT_ENTRY_INVALID/u);
    }
    assert.throws(() => signingSubjectPaths("unreviewed", "1.2.3"), /WINDOWS_SIGNING_SUBJECT_STAGE_INVALID/u);
    assert.throws(() => signingSubjectPaths("native", "1.2.3-beta"), /WINDOWS_SIGNING_SUBJECT_VERSION_INVALID/u);
    await assert.rejects(readWindowsSigningSubjectManifest(f.options.manifestPath, "bad-digest"), /WINDOWS_SIGNING_MANIFEST_DIGEST_REQUIRED/u);
    await assert.rejects(hashPlainFile(f.options.inputRoot, f.manifest.files[0].path, 1), /WINDOWS_SIGNING_FILE_UNSAFE/u);
  });
});

test("signing failure, rejected output publisher, and unchanged output leave no token or success receipt", async () => {
  for (const mode of ["token-failure", "sign-failure", "publisher-failure", "unchanged-output"]) {
    await withFixture(async f => {
      if (mode === "token-failure") f.adapters.getToken = async () => { f.calls.tokens += 1; throw new Error("synthetic-token-unavailable"); };
      if (mode === "sign-failure") f.adapters.execute = async () => false;
      if (mode === "publisher-failure") f.adapters.verifySigned = async () => false;
      if (mode === "unchanged-output") f.adapters.execute = async () => true;
      const before = await filesUnder(f.options.inputRoot);
      await assert.rejects(signWindowsSubjects(f.options, f.adapters));
      assert.equal(f.calls.tokens, 1);
      await absent(join(f.options.outputRoot, ".signer-private"));
      await absent(join(f.options.outputRoot, "signed-subjects.json"));
      assert.deepEqual(await filesUnder(f.options.inputRoot), before);
      await assertNoCredentialContent(f.options.outputRoot);
    });
  }
});

test("a changed tool closure after the first signature stops subsequent invocations and receipt creation", async () => {
  await withFixture(async f => {
    const execute = f.adapters.execute;
    f.adapters.execute = async (...args) => { const result = await execute(...args); await appendFile(join(f.options.toolchainRoot, "dlib/runtime/credential.dll"), "changed"); return result; };
    await assert.rejects(signWindowsSubjects(f.options, f.adapters), /WINDOWS_SIGNING_TOOLCHAIN_DIGEST_MISMATCH/u);
    assert.equal(f.calls.tokens, 1);
    assert.equal(f.calls.signs.length, 1);
    await absent(join(f.options.outputRoot, "signed-subjects.json"));
    await absent(join(f.options.outputRoot, ".signer-private"));
  });
});

test("preexisting output and transfer files are never overwritten or deleted", async () => {
  await withFixture(async f => {
    await mkdir(f.options.outputRoot);
    await write(join(f.options.outputRoot, ".signer-private/federated-token"), "preexisting-private-owner-content");
    const before = await filesUnder(f.options.outputRoot);
    await assert.rejects(signWindowsSubjects(f.options, f.adapters), { code: "EEXIST" });
    assert.equal(f.calls.tokens, 0);
    assert.deepEqual(await filesUnder(f.options.outputRoot), before);
  });
  await withFixture(async f => {
    const signed = await signWindowsSubjects(f.options, f.adapters);
    const temporary = join(f.options.inputRoot, `${f.manifest.files[0].path}.signed-transfer`);
    await writeFile(temporary, "preexisting-transfer-owner-content");
    const before = await filesUnder(f.options.inputRoot);
    await assert.rejects(applyWindowsSignedSubjects({ root: f.options.inputRoot, signedRoot: f.options.outputRoot,
      manifest: f.manifest, receipt: signed.receipt, expectedManifestSha256: f.options.manifestSha256 }), { code: "EEXIST" });
    assert.deepEqual(await filesUnder(f.options.inputRoot), before);
  });
});

test("stale or mismatched receipts and altered signed batches cannot mutate unsigned inputs", async () => {
  await withFixture(async f => {
    const signed = await signWindowsSubjects(f.options, f.adapters);
    const before = await filesUnder(f.options.inputRoot);
    const mutations = [value => { value.manifestSha256 = "d".repeat(64); }, value => { value.sourceRevision = "d".repeat(40); },
      value => { value.candidateSha256 = "d".repeat(64); }, value => { value.stage = "installer"; },
      value => { value.files.pop(); }, value => { value.files[1] = clone(value.files[0]); },
      value => { value.files[0].beforeSha256 = "d".repeat(64); }, value => { value.files[0].path = "../outside"; },
      value => { value.files[0].afterSha256 = value.files[0].beforeSha256; }, value => { value.extra = true; }];
    for (const mutate of mutations) {
      const receipt = clone(signed.receipt); mutate(receipt);
      await assert.rejects(applyWindowsSignedSubjects({ root: f.options.inputRoot, signedRoot: f.options.outputRoot,
        manifest: f.manifest, receipt, expectedManifestSha256: f.options.manifestSha256 }), /WINDOWS_SIGNING_SIGNED_RECEIPT_INVALID/u);
      assert.deepEqual(await filesUnder(f.options.inputRoot), before);
    }
    await appendFile(join(f.options.outputRoot, f.manifest.files.at(-1).path), "changed final signed subject");
    await assert.rejects(applyWindowsSignedSubjects({ root: f.options.inputRoot, signedRoot: f.options.outputRoot,
      manifest: f.manifest, receipt: signed.receipt, expectedManifestSha256: f.options.manifestSha256 }), /WINDOWS_SIGNING_SIGNED_SUBJECT_MISMATCH/u);
    assert.deepEqual(await filesUnder(f.options.inputRoot), before);
  });
});

test("tool downloads require exact reviewed bytes and preserve a preexisting destination", async () => {
  await withFixture(async f => {
    const downloadRoot = join(f.root, "downloaded");
    const requests = [];
    const fetcher = async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      const file = f.policy.files.find(file => file.sourceUrl === url);
      const bytes = f.toolBytes.get(file.path);
      return { ok: true, body: (async function* () { yield bytes.subarray(0, 2); yield bytes.subarray(2); })() };
    };
    await downloadWindowsSigningToolchain({ root: downloadRoot, policy: f.policy, fetcher });
    assert.equal(requests.length, f.policy.files.length);
    await verifyWindowsSigningToolchain({ root: downloadRoot, policy: f.policy, verifyPublisher: f.adapters.verifyPublisher });
    const before = await filesUnder(downloadRoot);
    await assert.rejects(downloadWindowsSigningToolchain({ root: downloadRoot, policy: f.policy, fetcher }), { code: "EEXIST" });
    assert.equal(requests.length, f.policy.files.length);
    assert.deepEqual(await filesUnder(downloadRoot), before);
  });
  for (const bytes of [Buffer.alloc(1), Buffer.alloc(2048), Buffer.from("synthetic-wrong-digest")]) {
    await withFixture(async f => {
      const downloadRoot = join(f.root, "bad-download");
      await assert.rejects(downloadWindowsSigningToolchain({ root: downloadRoot, policy: f.policy,
        fetcher: async () => ({ ok: true, body: (async function* () { yield bytes; })() }) }), /WINDOWS_SIGNING_TOOLCHAIN_DOWNLOAD_/u);
      assert.deepEqual(await filesUnder(downloadRoot), {});
    });
  }
});

test("tool downloads bound chunk floods, stalled reads, and cancellation independently of peer behavior", async () => {
  for (const mode of ["empty-flood", "fetch-stall", "read-stall", "synchronous-slow-read"]) {
    await withFixture(async f => {
      const root = join(f.root, `bounded-${mode}`);
      const never = () => new Promise(() => {});
      let cancelled = false;
      let returned = false;
      const fetcher = async (_url, { signal }) => {
        signal.addEventListener("abort", () => { cancelled = true; });
        if (mode === "fetch-stall") return never();
        return { ok: true, body: { [Symbol.asyncIterator]() { return {
          next() {
            if (mode === "read-stall") return never();
            if (mode === "synchronous-slow-read") {
              const end = Date.now() + 5;
              while (Date.now() < end) { /* Exercise an event-loop-starving peer. */ }
              return Promise.resolve({ done: false, value: Buffer.from([0]) });
            }
            return Promise.resolve({ done: false, value: Buffer.alloc(0) });
          },
          return() { returned = true; return never(); },
        }; } } };
      };
      await assert.rejects(downloadWindowsSigningToolchain({ root, policy: f.policy, fetcher, downloadDeadlineMs: 20 }),
        mode === "empty-flood" ? /DOWNLOAD_EMPTY_CHUNK_FLOOD/u : /DOWNLOAD_TIMEOUT/u);
      assert.equal(cancelled, true);
      assert.equal(returned, mode !== "fetch-stall");
      assert.deepEqual(await filesUnder(root), {});
    });
  }
});

test("platform publisher inspection uses a fixed executable and strips ambient credential variables", async (t) => {
  const previous = {};
  for (const [name, value] of Object.entries(ENVIRONMENT)) { previous[name] = process.env[name]; process.env[name] = value; }
  const calls = [];
  const mockedSpawn = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options }); return { status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    assert.equal(verifyWindowsPublisher("synthetic-approved-tool.exe", CERTIFICATE), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(calls[0].options.shell, false);
    assert.ok(calls[0].args.includes("-NoProfile"));
    for (const name of Object.keys(ENVIRONMENT)) assert.equal(calls[0].options.env[name], undefined);
    assert.equal(calls[0].options.env.TIBOTATTLE_VERIFY_CERTIFICATE, CERTIFICATE);
    assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  } finally {
    mockedSpawn.mock.restore(); syncBuiltinESMExports();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test("CLI refusal does not echo malformed paths or ambient credential canaries", () => {
  const script = fileURLToPath(new URL("../scripts/sign-electron-windows-subjects.mjs", import.meta.url));
  const result = childProcess.spawnSync(process.execPath, [script, "sign", "--input-root", "synthetic-private-path-canary"], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, AZURE_CLIENT_SECRET: ENVIRONMENT.AZURE_CLIENT_SECRET,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: ENVIRONMENT.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "WINDOWS_ISOLATED_SIGNER_REFUSED\n");
});

test("wrong host and malformed Azure identity refuse before authority", async () => {
  for (const mutate of [f => { f.adapters.platform = "linux"; }, f => { f.adapters.arch = "arm64"; },
    f => { f.adapters.environment.AZURE_CLIENT_ID = "not-a-uuid"; },
    f => { delete f.adapters.environment.AZURE_TENANT_ID; }]) {
    await withFixture(async f => { mutate(f); await assertPreAuthorityRefusal(f, /WINDOWS_ISOLATED_SIGNER_(?:WINDOWS_X64_REQUIRED|AZURE_IDENTITY_INVALID)/u); });
  }
});

test("publisher-time tool mutation is detected before OIDC", async () => {
  await withFixture(async f => {
    f.adapters.verifyPublisher = async path => { await appendFile(path, "changed-during-publisher-check"); return true; };
    await assertPreAuthorityRefusal(f, /WINDOWS_SIGNING_TOOLCHAIN_CHANGED/u);
  });
});

test("changed unsigned inputs and linked signed outputs refuse application before any replacement", async () => {
  for (const kind of ["stale-original", "signed-hardlink", "signed-symlink"]) {
    await withFixture(async f => {
      const signed = await signWindowsSubjects(f.options, f.adapters);
      const file = f.manifest.files.at(-1).path;
      if (kind === "stale-original") await appendFile(join(f.options.inputRoot, file), "stale-input");
      if (kind === "signed-hardlink") await link(join(f.options.outputRoot, file), join(f.root, "linked-signed-file"));
      if (kind === "signed-symlink") { const other = join(f.root, "external-signed-file"); await rename(join(f.options.outputRoot, file), other); await symlink(other, join(f.options.outputRoot, file)); }
      const before = await filesUnder(f.options.inputRoot);
      await assert.rejects(applyWindowsSignedSubjects({ root: f.options.inputRoot, signedRoot: f.options.outputRoot,
        manifest: f.manifest, receipt: signed.receipt, expectedManifestSha256: f.options.manifestSha256 }), /WINDOWS_SIGNING_(?:SUBJECT_DIGEST_MISMATCH|FILE_UNSAFE|PATH_UNSAFE)/u);
      assert.deepEqual(await filesUnder(f.options.inputRoot), before);
    });
  }
});

test("tool download rejects a same-size digest substitution", async () => {
  await withFixture(async f => {
    const root = join(f.root, "same-size-substitution");
    const bytes = Buffer.alloc(f.policy.files[0].sizeBytes, 0x78);
    await assert.rejects(downloadWindowsSigningToolchain({ root, policy: f.policy,
      fetcher: async () => ({ ok: true, body: (async function* () { yield bytes; })() }) }), /WINDOWS_SIGNING_TOOLCHAIN_DOWNLOAD_DIGEST_MISMATCH/u);
    assert.deepEqual(await filesUnder(root), {});
  });
});

test("hash reader requests nonblocking opens and rejects a special-file replacement before reading", async (t) => {
  await withFixture(async f => {
    let closed = false;
    const mockedOpen = t.mock.method(fsPromises, "open", async (path, flags) => {
      assert.equal(path, join(f.options.inputRoot, f.manifest.files[0].path));
      assert.equal(flags & (constants.O_NONBLOCK ?? 0), constants.O_NONBLOCK ?? 0);
      assert.equal(flags & (constants.O_NOFOLLOW ?? 0), constants.O_NOFOLLOW ?? 0);
      return { stat: async () => ({ isFile: () => false }),
        createReadStream: () => assert.fail("must not read a special-file descriptor"),
        close: async () => { closed = true; } };
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(hashPlainFile(f.options.inputRoot, f.manifest.files[0].path), /WINDOWS_SIGNING_FILE_UNSAFE/u);
      assert.equal(closed, true);
    } finally { mockedOpen.mock.restore(); syncBuiltinESMExports(); }
  });
});

test("hash reader rejects a file that acquires another link during the read", async (t) => {
  await withFixture(async f => {
    const path = join(f.options.inputRoot, f.manifest.files[0].path);
    const metadata = await lstat(path);
    const bytes = await readFile(path);
    let stats = 0;
    let closed = false;
    const mockedOpen = t.mock.method(fsPromises, "open", async () => ({
      async stat() { stats += 1; return stats === 1 ? metadata : { ...metadata, nlink: 2 }; },
      createReadStream: () => (async function* () { yield bytes; })(),
      async close() { closed = true; },
    }));
    syncBuiltinESMExports();
    try {
      await assert.rejects(hashPlainFile(f.options.inputRoot, f.manifest.files[0].path), /WINDOWS_SIGNING_FILE_CHANGED/u);
      assert.equal(closed, true);
    } finally { mockedOpen.mock.restore(); syncBuiltinESMExports(); }
  });
});

test("successful and failed signing emit no token or credential content to process output", async (t) => {
  for (const failSigning of [false, true]) {
    await withFixture(async f => {
      if (failSigning) f.adapters.execute = async () => false;
      const output = [];
      const stdout = t.mock.method(process.stdout, "write", value => { output.push(String(value)); return true; });
      const stderr = t.mock.method(process.stderr, "write", value => { output.push(String(value)); return true; });
      try {
        if (failSigning) await assert.rejects(signWindowsSubjects(f.options, f.adapters), /WINDOWS_ISOLATED_SIGNER_SIGN_FAILED/u);
        else await signWindowsSubjects(f.options, f.adapters);
      } finally { stdout.mock.restore(); stderr.mock.restore(); }
      assert.equal(output.join(""), "");
    });
  }
});

test("OIDC acquisition admits only the fixed GitHub host class and bounded valid tokens", async (t) => {
  const responses = [
    [JSON.stringify({ value: TOKEN }), true],
    [JSON.stringify({ value: "invalid-token" }), false],
    ["not-json", false],
    [JSON.stringify({ value: `head.body.${"x".repeat(33 * 1024)}` }), false],
  ];
  for (const [body, accepted] of responses) {
    await withFixture(async f => {
      delete f.adapters.getToken;
      f.adapters.environment.ACTIONS_ID_TOKEN_REQUEST_URL = "https://oidc.actions.githubusercontent.com/request";
      let requests = 0;
      const mockFetch = t.mock.method(globalThis, "fetch", async (url, options) => {
        requests += 1;
        assert.equal(new URL(url).searchParams.get("audience"), "api://AzureADTokenExchange");
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.headers.Authorization, `Bearer ${ENVIRONMENT.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`);
        return new Response(body);
      });
      try {
        if (accepted) await signWindowsSubjects(f.options, f.adapters);
        else await assert.rejects(signWindowsSubjects(f.options, f.adapters), /WINDOWS_ISOLATED_SIGNER_OIDC_FAILED/u);
        assert.equal(requests, 1);
        if (!accepted) { assert.equal(f.calls.signs.length, 0); await absent(join(f.options.outputRoot, "signed-subjects.json")); }
        await absent(join(f.options.outputRoot, ".signer-private"));
      } finally { mockFetch.mock.restore(); }
    });
  }
  for (const url of ["https://attacker.invalid/request", "http://oidc.actions.githubusercontent.com/request",
    "https://oidc.actions.githubusercontent.com.attacker.invalid/request", "https://user:pass@oidc.actions.githubusercontent.com/request",
    "https://oidc.actions.githubusercontent.com:8443/request", "https://oidc.actions.githubusercontent.com/request#fragment"] ) {
    await withFixture(async f => {
      delete f.adapters.getToken;
      f.adapters.environment.ACTIONS_ID_TOKEN_REQUEST_URL = url;
      let requests = 0;
      const mockFetch = t.mock.method(globalThis, "fetch", async () => { requests += 1; assert.fail("unapproved OIDC URL reached fetch"); });
      try {
        await assert.rejects(signWindowsSubjects(f.options, f.adapters), /WINDOWS_ISOLATED_SIGNER_OIDC_UNAVAILABLE/u);
        assert.equal(requests, 0);
        assert.equal(f.calls.signs.length, 0);
        await absent(join(f.options.outputRoot, ".signer-private"));
      } finally { mockFetch.mock.restore(); }
    });
  }
});

test("manifest reads stay on one bounded descriptor even if the candidate grows", async (t) => {
  for (const grows of [false, true]) {
    await withFixture(async f => {
      const path = f.options.manifestPath;
      const metadata = await lstat(path);
      const source = await readFile(path);
      let opened = 0;
      let totalRequested = 0;
      let closed = false;
      const mockedReadFile = t.mock.method(fsPromises, "readFile", async () => assert.fail("manifest reader must not reopen an unbounded readFile"));
      const mockedOpen = t.mock.method(fsPromises, "open", async (selected, flags) => {
        opened += 1;
        assert.equal(selected, path);
        assert.equal(flags & (constants.O_NONBLOCK ?? 0), constants.O_NONBLOCK ?? 0);
        return { stat: async () => metadata,
          async read(buffer, offset, length, position) {
            assert.ok(buffer.length <= metadata.size + 1);
            totalRequested += length;
            const available = grows ? length : Math.max(0, Math.min(source.length - position, length));
            if (grows) buffer.fill(0x20, offset, offset + available);
            else source.copy(buffer, offset, position, position + available);
            return { bytesRead: available };
          },
          async close() { closed = true; },
        };
      });
      syncBuiltinESMExports();
      try {
        if (grows) await assert.rejects(readWindowsSigningSubjectManifest(path, f.options.manifestSha256), /WINDOWS_SIGNING_FILE_CHANGED/u);
        else assert.deepEqual(await readWindowsSigningSubjectManifest(path, f.options.manifestSha256), f.manifest);
        assert.equal(opened, 1);
        assert.equal(closed, true);
        assert.ok(totalRequested <= metadata.size + 2);
      } finally {
        mockedReadFile.mock.restore(); mockedOpen.mock.restore(); syncBuiltinESMExports();
      }
    });
  }
});

test("signed-subject application rechecks each original after an intervening mutation", async (t) => {
  await withFixture(async f => {
    const signed = await signWindowsSubjects(f.options, f.adapters);
    const first = f.manifest.files[0].path;
    const second = f.manifest.files[1].path;
    const secondPath = join(f.options.inputRoot, second);
    const originalSecond = await readFile(secondPath);
    const mutation = Buffer.from("intervening-unsigned-subject-change");
    const nativeRename = fsPromises.rename;
    let renames = 0;
    const mockedRename = t.mock.method(fsPromises, "rename", async (source, target) => {
      renames += 1;
      await nativeRename(source, target);
      if (target === join(f.options.inputRoot, first)) await appendFile(secondPath, mutation);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(applyWindowsSignedSubjects({ root: f.options.inputRoot, signedRoot: f.options.outputRoot,
        manifest: f.manifest, receipt: signed.receipt, expectedManifestSha256: f.options.manifestSha256 }), /WINDOWS_SIGNING_SUBJECT_DIGEST_MISMATCH/u);
      assert.equal(renames, 1);
      assert.equal(sha256(await readFile(join(f.options.inputRoot, first))), signed.receipt.files[0].afterSha256);
      assert.deepEqual(await readFile(secondPath), Buffer.concat([originalSecond, mutation]));
      await absent(`${secondPath}.signed-transfer`);
    } finally { mockedRename.mock.restore(); syncBuiltinESMExports(); }
  });
});

test("post-copy tampering and replacement failure remove only the owned temporary", async (t) => {
  for (const failure of ["tampered-copy", "rename-failure"]) {
    await withFixture(async f => {
      const signed = await signWindowsSubjects(f.options, f.adapters);
      const before = await filesUnder(f.options.inputRoot);
      const signedBefore = await filesUnder(f.options.outputRoot);
      const temporary = join(f.options.inputRoot, `${f.manifest.files[0].path}.signed-transfer`);
      const nativeCopyFile = fsPromises.copyFile;
      let copied = 0;
      const mockedCopy = t.mock.method(fsPromises, "copyFile", async (source, target, flags) => {
        copied += 1;
        assert.equal(target, temporary);
        assert.equal(flags, constants.COPYFILE_EXCL);
        await nativeCopyFile(source, target, flags);
        if (failure === "tampered-copy") await appendFile(target, "synthetic-post-copy-substitution");
      });
      const mockedRename = t.mock.method(fsPromises, "rename", async () => {
        if (failure === "tampered-copy") assert.fail("tampered bytes must not reach replacement");
        throw Object.assign(new Error("synthetic-replacement-failure"), { code: "EIO" });
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(applyWindowsSignedSubjects({ root: f.options.inputRoot, signedRoot: f.options.outputRoot,
          manifest: f.manifest, receipt: signed.receipt, expectedManifestSha256: f.options.manifestSha256 }),
        failure === "tampered-copy" ? /WINDOWS_SIGNING_SIGNED_SUBJECT_MISMATCH/u : { code: "EIO" });
        assert.equal(copied, 1);
        await absent(temporary);
        assert.deepEqual(await filesUnder(f.options.inputRoot), before);
        assert.deepEqual(await filesUnder(f.options.outputRoot), signedBefore);
      } finally {
        mockedCopy.mock.restore(); mockedRename.mock.restore(); syncBuiltinESMExports();
      }
    });
  }
});
