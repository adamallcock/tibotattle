import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_FIXED_STATUS as STATUS,
  WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_STATUS,
  WindowsProductionFinalizerAuthorityDriverError,
  parseWindowsProductionFinalizerAuthorityDriverArguments,
  parseWindowsProductionFinalizerAuthorityDriverJson,
  runWindowsProductionFinalizerAuthority,
  runWindowsProductionFinalizerAuthorityArguments,
  validateWindowsProductionFinalizerAuthorityDriverOptions,
  writeWindowsProductionFinalizerAuthorityOutputForTest,
} from "../scripts/run-windows-production-finalizer-authority.mjs";
import {
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
  WINDOWS_NATIVE_PRESIGN_MODULES,
  WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
  WINDOWS_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_NATIVE_PRESIGN_STATUS,
  WINDOWS_NATIVE_PRESIGN_TARGET,
  serializeWindowsNativePresignReceipt,
} from "../scripts/windows-native-presign.mjs";
import {
  WINDOWS_FINALIZER_EVENT,
  WINDOWS_FINALIZER_HANDOFF_SCHEMA,
  WINDOWS_FINALIZER_HANDOFF_STATUS,
  WINDOWS_FINALIZER_PRODUCTION_READINESS,
  WINDOWS_FINALIZER_RUN_CONCLUSION,
  WINDOWS_FINALIZER_RUN_STATUS,
  WINDOWS_FINALIZER_TARGET,
  WINDOWS_FINALIZER_WORKFLOW_PATH,
} from "../scripts/verify-windows-finalizer-qualification-handoff.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";

const REVISION = "a".repeat(40);
const PACKAGE_VERSION = "0.1.15";
const PUBLISHER = "CN=TiboTattle Test";
const SOURCE_RUN = 123456789;
const SOURCE_RUN_ATTEMPT = 2;
const FINALIZER_RUN = 987654321;
const BINDING_BYTES = 41;
const BINDING_SHA256 = "b".repeat(64);
const WARM_RECEIPT_SHA256 = "c".repeat(64);
const CLEAN_RECEIPT_SHA256 = "d".repeat(64);
const SIGNER_THUMBPRINT = "e".repeat(40);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function packageBytes(version = PACKAGE_VERSION) {
  return Buffer.from(JSON.stringify({
    name: "app-usagemonitor",
    version,
    private: true,
    type: "module",
  }), "utf8");
}

function qualificationReceipt(cacheMode) {
  const rawReceiptSha256 = cacheMode === "warm"
    ? WARM_RECEIPT_SHA256
    : CLEAN_RECEIPT_SHA256;
  const artifactId = cacheMode === "warm" ? 111 : 222;
  const receiptBytes = cacheMode === "warm" ? 333 : 444;
  return {
    artifact: {
      digest: `sha256:${rawReceiptSha256}`,
      headSha: REVISION,
      id: artifactId,
      name: `tibotattle-windows-electron-qualification-${SOURCE_RUN}-${SOURCE_RUN_ATTEMPT}-${REVISION}-${cacheMode}.json`,
      runId: SOURCE_RUN,
      sizeInBytes: receiptBytes,
    },
    binding: { bytes: BINDING_BYTES, sha256: BINDING_SHA256 },
    cacheMode,
    qualification: {
      failed: 0,
      passed: 37,
      skipped: 0,
      status: "WINDOWS_SECURITY_QUALIFICATION_PASSED",
      tests: 37,
    },
    receiptProvenance: {
      bytes: receiptBytes,
      runId: SOURCE_RUN,
      sha256: rawReceiptSha256,
    },
    runtimeStatus: "WINDOWS_ELECTRON_RUNTIME_SMOKE_PASSED",
    status: "WINDOWS_ELECTRON_DEVELOPMENT_QUALIFICATION_PASSED",
  };
}

function handoffValue() {
  return {
    productionReadiness: WINDOWS_FINALIZER_PRODUCTION_READINESS,
    receipts: [qualificationReceipt("warm"), qualificationReceipt("clean")],
    repository: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
    revision: REVISION,
    run: {
      conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
      databaseId: SOURCE_RUN,
      event: WINDOWS_FINALIZER_EVENT,
      headSha: REVISION,
      ref: WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
      runAttempt: SOURCE_RUN_ATTEMPT,
      status: WINDOWS_FINALIZER_RUN_STATUS,
    },
    schemaVersion: WINDOWS_FINALIZER_HANDOFF_SCHEMA,
    status: WINDOWS_FINALIZER_HANDOFF_STATUS,
    target: WINDOWS_FINALIZER_TARGET,
  };
}

function handoffBytes(value = handoffValue()) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceRunMetadata(overrides = {}) {
  return {
    conclusion: WINDOWS_FINALIZER_RUN_CONCLUSION,
    event: WINDOWS_FINALIZER_EVENT,
    head_branch: "main",
    head_sha: REVISION,
    id: SOURCE_RUN,
    path: `${WINDOWS_FINALIZER_WORKFLOW_PATH}@${WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF}`,
    repository: { full_name: WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY },
    run_attempt: SOURCE_RUN_ATTEMPT,
    status: WINDOWS_FINALIZER_RUN_STATUS,
    html_url: "https://api.github.example.invalid/private-run",
    actor: { login: "private-actor-payload" },
    ...overrides,
  };
}

function authenticode(overrides = {}) {
  return {
    status: "Valid",
    publisher: PUBLISHER,
    signerThumbprint: SIGNER_THUMBPRINT,
    timestampPresent: true,
    policy: "authenticode-pa",
    signtoolPaValid: true,
    ...overrides,
  };
}

function presignValue(qualificationHandoffSha256, overrides = {}) {
  return {
    schemaVersion: WINDOWS_NATIVE_PRESIGN_SCHEMA,
    status: WINDOWS_NATIVE_PRESIGN_STATUS,
    target: WINDOWS_NATIVE_PRESIGN_TARGET,
    revision: REVISION,
    packageVersion: PACKAGE_VERSION,
    qualificationHandoffSha256,
    signingRequestPolicy: { ...WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY },
    modules: [
      {
        name: WINDOWS_NATIVE_PRESIGN_MODULES[0].name,
        packagedPath: WINDOWS_NATIVE_PRESIGN_MODULES[0].packagedPath,
        unsignedBytes: BINDING_BYTES,
        signedBytes: BINDING_BYTES + 10,
        unsignedSha256: BINDING_SHA256,
        signedSha256: "1".repeat(64),
        authenticode: authenticode(),
      },
      {
        name: WINDOWS_NATIVE_PRESIGN_MODULES[1].name,
        packagedPath: WINDOWS_NATIVE_PRESIGN_MODULES[1].packagedPath,
        unsignedBytes: 200,
        signedBytes: 210,
        unsignedSha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
        signedSha256: "2".repeat(64),
        authenticode: authenticode(),
      },
    ],
    ...overrides,
  };
}

function factsFor(presign) {
  return {
    filesystemBinding: { bytes: BINDING_BYTES, sha256: BINDING_SHA256 },
    keytarBinding: { bytes: presign.modules[1].unsignedBytes, sha256: WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256 },
    signerPolicy: { publisher: PUBLISHER, match: "exact" },
    nativeModules: presign.modules.map(({ authenticode: _authenticode, ...module }) => module),
    runtimeManifest: {
      packagedPath: WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
      bytes: 512,
      sha256: "f".repeat(64),
    },
    finalizer: {
      run: FINALIZER_RUN,
      runAttempt: 1,
      headSha: REVISION,
    },
  };
}

function fixture() {
  const selectedHandoffBytes = handoffBytes();
  const selectedPresign = presignValue(sha256(selectedHandoffBytes));
  const source = sourceRunMetadata();
  const facts = factsFor(selectedPresign);
  return {
    files: {
      handoff: selectedHandoffBytes,
      nativePresign: Buffer.from(serializeWindowsNativePresignReceipt(selectedPresign), "utf8"),
      checkoutPackageJson: packageBytes(),
      sourceRunMetadata: Buffer.from(JSON.stringify(source), "utf8"),
    },
    facts,
  };
}

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-authority-driver-"));
  const value = fixture();
  await writeFile(join(root, "handoff.json"), value.files.handoff, { mode: 0o600 });
  await writeFile(join(root, "native-presign.json"), value.files.nativePresign, { mode: 0o600 });
  await writeFile(join(root, "package.json"), value.files.checkoutPackageJson, { mode: 0o600 });
  await writeFile(join(root, "source-run.json"), value.files.sourceRunMetadata, { mode: 0o600 });
  await writeFile(join(root, "facts.json"), JSON.stringify(value.facts), { mode: 0o600 });
  return { root, value };
}

function options(root, facts) {
  return {
    evidenceRoot: root,
    output: "authority.json",
    handoff: "handoff.json",
    nativePresign: "native-presign.json",
    checkoutPackageJson: "package.json",
    sourceRunMetadata: "source-run.json",
    facts,
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(error instanceof WindowsProductionFinalizerAuthorityDriverError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows production finalizer authority driver failed");
    return true;
  };
}

test("builds, independently cross-checks, and writes one canonical authority snapshot", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const result = await runWindowsProductionFinalizerAuthority(
    options(workspace.root, workspace.value.facts),
  );
  assert.equal(result.status, WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_DRIVER_STATUS);
  const output = await readFile(join(workspace.root, "authority.json"), "utf8");
  assert.equal(output, serializeWindowsProductionAuthorityManifest(result.authority));
  assert.equal((await stat(join(workspace.root, "authority.json"))).mode & 0o777, 0o600);
  assert.equal(output.includes("signerThumbprint"), false);
  assert.equal(output.includes("private-actor-payload"), false);
});

test("supports the options document and fixed evidence-file flags", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const selected = options(workspace.root, workspace.value.facts);
  await rm(join(workspace.root, "authority.json"), { force: true });
  await runWindowsProductionFinalizerAuthorityArguments([
    "--evidence-root", workspace.root,
    "--output", "authority.json",
    "--handoff", "handoff.json",
    "--native-presign", "native-presign.json",
    "--checkout-package-json", "package.json",
    "--source-run-metadata", "source-run.json",
    "--facts", "facts.json",
  ]);
  const optionsOutput = await readFile(join(workspace.root, "authority.json"));
  await rm(join(workspace.root, "authority.json"), { force: true });
  const optionsPath = join(workspace.root, "options.json");
  await writeFile(optionsPath, JSON.stringify(selected), { mode: 0o600 });
  await runWindowsProductionFinalizerAuthorityArguments(["--options", optionsPath]);
  assert.equal((await stat(join(workspace.root, "authority.json"))).isFile(), true);
  assert.deepEqual(await readFile(join(workspace.root, "authority.json")), optionsOutput);
});

test("rejects unknown or duplicate flags, duplicate JSON keys, and open option schemas", () => {
  assert.throws(
    () => parseWindowsProductionFinalizerAuthorityDriverArguments(["--unknown", "x"]),
    expectCode(STATUS.inputInvalid),
  );
  assert.throws(
    () => parseWindowsProductionFinalizerAuthorityDriverArguments([
      "--options", "/tmp/options.json", "--output", "x",
    ]),
    expectCode(STATUS.inputInvalid),
  );
  assert.throws(
    () => parseWindowsProductionFinalizerAuthorityDriverArguments([
      "--output", "a", "--output", "b",
    ]),
    expectCode(STATUS.inputInvalid),
  );
  assert.throws(
    () => parseWindowsProductionFinalizerAuthorityDriverJson('{"a":1,"a":1}'),
    expectCode(STATUS.optionsInvalid),
  );
  const root = "/tmp/tibotattle-authority-root";
  const value = {
    evidenceRoot: root,
    output: "authority.json",
    handoff: "handoff.json",
    nativePresign: "native-presign.json",
    checkoutPackageJson: "package.json",
    sourceRunMetadata: "source-run.json",
    facts: {},
    extra: true,
  };
  assert.throws(
    () => validateWindowsProductionFinalizerAuthorityDriverOptions(value),
    expectCode(STATUS.optionsInvalid),
  );
  const accessor = { ...value };
  delete accessor.extra;
  Object.defineProperty(accessor, "facts", { enumerable: true, get: () => ({}) });
  assert.throws(
    () => validateWindowsProductionFinalizerAuthorityDriverOptions(accessor),
    expectCode(STATUS.optionsInvalid),
  );
  assert.throws(
    () => validateWindowsProductionFinalizerAuthorityDriverOptions(new Proxy(value, {})),
    expectCode(STATUS.optionsInvalid),
  );
});

test("uses strict direct-child portable filenames and rejects escaped path aliases", () => {
  const root = "/tmp/tibotattle-authority-root";
  const base = options(root, fixture().facts);
  for (const filename of [
    "../authority.json",
    "nested.json/child",
    "nested/child.json",
    "nested\\child.json",
    "authority:stream",
    "authority.",
    "authority ",
    "CON",
    "con.json",
    "AUX.txt",
    "NUL",
    "COM1.log",
    "LPT9.txt",
  ]) {
    assert.throws(
      () => validateWindowsProductionFinalizerAuthorityDriverOptions({ ...base, output: filename }),
      expectCode(STATUS.optionsInvalid),
    );
  }
  assert.throws(
    () => validateWindowsProductionFinalizerAuthorityDriverOptions({
      ...base,
      nativePresign: "HANDOFF.JSON",
    }),
    expectCode(STATUS.optionsInvalid),
  );
  const escaped = JSON.stringify({ ...base, output: "secret/outside.json" })
    .replace("secret/outside.json", "secret\\u002foutside.json");
  let parsed;
  try {
    parsed = parseWindowsProductionFinalizerAuthorityDriverJson(escaped);
    validateWindowsProductionFinalizerAuthorityDriverOptions(parsed);
    assert.fail("escaped path should be rejected");
  } catch (error) {
    assert.equal(error instanceof WindowsProductionFinalizerAuthorityDriverError, true);
    assert.equal(error.code, STATUS.optionsInvalid);
    assert.equal(error.message.includes("secret"), false);
    assert.equal(error.message.includes("outside"), false);
  }
});

test("rejects deep or wide malformed JSON and an injected builder option", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const selected = options(workspace.root, workspace.value.facts);
  let deep = "0";
  for (let index = 0; index < 70; index += 1) deep = `{"nested":${deep}}`;
  assert.throws(
    () => parseWindowsProductionFinalizerAuthorityDriverJson(deep),
    expectCode(STATUS.optionsInvalid),
  );
  const wide = `{"values":[${Array.from({ length: 4100 }, () => "0").join(",")}]}`;
  assert.throws(
    () => parseWindowsProductionFinalizerAuthorityDriverJson(wide),
    expectCode(STATUS.optionsInvalid),
  );
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(selected, {
      buildAuthority: () => {
        throw new Error("injected builder must not run");
      },
    }),
    expectCode(STATUS.inputInvalid),
  );
});

test("rejects path escape, symlink and hard-link evidence, and oversized inputs", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const selected = options(workspace.root, workspace.value.facts);
  const outside = join(workspace.root, "..", `${basename(workspace.root)}-outside-handoff.json`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, workspace.value.files.handoff, { mode: 0o600 });
  await rm(join(workspace.root, "handoff.json"));
  await symlink(outside, join(workspace.root, "handoff.json"));
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(selected),
    expectCode(STATUS.handoffInvalid),
  );
  await rm(join(workspace.root, "handoff.json"));
  await link(outside, join(workspace.root, "handoff.json"));
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(selected),
    expectCode(STATUS.handoffInvalid),
  );
  const escape = { ...selected, output: "../authority.json" };
  assert.throws(
    () => validateWindowsProductionFinalizerAuthorityDriverOptions(escape),
    expectCode(STATUS.optionsInvalid),
  );
  await rm(join(workspace.root, "handoff.json"));
  await writeFile(join(workspace.root, "handoff.json"), workspace.value.files.handoff);
  await writeFile(join(workspace.root, "package.json"), Buffer.alloc(64 * 1024 + 1, 0x20));
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(selected),
    expectCode(STATUS.packageInvalid),
  );
});

test("keeps qualification provenance on portability workflow and rejects signing-path aliases", async (t) => {
  for (const path of [
    ".github/workflows/windows-production-finalizer.yml@refs/heads/main",
    `${WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW}@refs/heads/main`,
    WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  ]) {
    const workspace = await makeWorkspace();
    t.after(() => rm(workspace.root, { recursive: true, force: true }));
    const source = JSON.parse(workspace.value.files.sourceRunMetadata.toString("utf8"));
    source.path = path;
    await writeFile(
      join(workspace.root, "source-run.json"),
      Buffer.from(JSON.stringify(source), "utf8"),
    );
    await assert.rejects(
      runWindowsProductionFinalizerAuthority(options(workspace.root, workspace.value.facts)),
      expectCode(STATUS.sourceRunInvalid),
    );
  }
});

test("keeps finalizer facts closed against workflow extras, getters, and proxies", () => {
  const base = options("/tmp/tibotattle-authority-root", fixture().facts);

  const extra = structuredClone(base.facts);
  extra.finalizer.workflow = WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW;
  assert.throws(
    () => validateWindowsProductionFinalizerAuthorityDriverOptions({ ...base, facts: extra }),
    expectCode(STATUS.factsInvalid),
  );

  const getterFacts = { ...base.facts };
  Object.defineProperty(getterFacts, "finalizer", {
    enumerable: true,
    get() {
      return base.facts.finalizer;
    },
  });
  assert.throws(
    () => validateWindowsProductionFinalizerAuthorityDriverOptions({ ...base, facts: getterFacts }),
    expectCode(STATUS.factsInvalid),
  );

  const proxyFacts = { ...base.facts, finalizer: new Proxy(base.facts.finalizer, {}) };
  assert.throws(
    () => validateWindowsProductionFinalizerAuthorityDriverOptions({ ...base, facts: proxyFacts }),
    expectCode(STATUS.factsInvalid),
  );
});

test("rejects runner-root replacement and duplicate checkout package keys", async (t) => {
  const workspace = await makeWorkspace();
  const movedRoot = `${workspace.root}.moved`;
  t.after(async () => {
    await rm(workspace.root, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
  });
  await rename(workspace.root, movedRoot);
  await symlink(movedRoot, workspace.root);
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(options(workspace.root, workspace.value.facts)),
    expectCode(STATUS.evidenceRootInvalid),
  );
  await rm(workspace.root, { force: true });
  await rename(movedRoot, workspace.root);
  await writeFile(join(workspace.root, "package.json"), Buffer.from(
    '{"name":"app-usagemonitor","version":"0.1.15","version":"0.1.15","private":true,"type":"module"}',
    "utf8",
  ));
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(options(workspace.root, workspace.value.facts)),
    expectCode(STATUS.packageInvalid),
  );
});

test("publishes through an owned temp and cleans it on write/sync/publish faults", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const outputBytes = Buffer.from("{\"status\":\"test\"}\n", "utf8");
  for (const faultAt of [
    "after-temp-open",
    "after-temp-write",
    "after-temp-sync",
    "before-publish",
  ]) {
    await assert.rejects(
      writeWindowsProductionFinalizerAuthorityOutputForTest(
        workspace.root,
        "fault.json",
        outputBytes,
        faultAt,
      ),
      expectCode(STATUS.outputInvalid),
    );
    assert.equal((await readdir(workspace.root)).some((name) => name.endsWith(".tmp")), false);
    await rm(join(workspace.root, "fault.json"), { force: true });
  }
  await assert.rejects(
    writeWindowsProductionFinalizerAuthorityOutputForTest(
      workspace.root,
      "published.json",
      outputBytes,
      "after-publish",
    ),
    expectCode(STATUS.outputInvalid),
  );
  assert.equal((await readdir(workspace.root)).some((name) => name.endsWith(".tmp")), false);
  assert.deepEqual(await readFile(join(workspace.root, "published.json")), outputBytes);
  await assert.rejects(
    writeWindowsProductionFinalizerAuthorityOutputForTest(
      workspace.root,
      "published.json",
      outputBytes,
    ),
    expectCode(STATUS.outputExists),
  );
});

test("keeps canonical/mismatch failures fixed and never clobbers an output", async (t) => {
  const workspace = await makeWorkspace();
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  const selected = options(workspace.root, workspace.value.facts);
  await writeFile(join(workspace.root, "handoff.json"), Buffer.concat([
    workspace.value.files.handoff,
    Buffer.from(" "),
  ]));
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(selected),
    expectCode(STATUS.handoffNoncanonical),
  );
  await writeFile(join(workspace.root, "handoff.json"), workspace.value.files.handoff);
  const facts = structuredClone(workspace.value.facts);
  facts.nativeModules[0].signedBytes += 1;
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(options(workspace.root, facts)),
    expectCode(STATUS.bindingMismatch),
  );
  const output = join(workspace.root, "authority.json");
  await writeFile(output, "sentinel\n", { mode: 0o600 });
  await assert.rejects(
    runWindowsProductionFinalizerAuthority(selected),
    expectCode(STATUS.outputExists),
  );
  assert.equal(await readFile(output, "utf8"), "sentinel\n");
});
