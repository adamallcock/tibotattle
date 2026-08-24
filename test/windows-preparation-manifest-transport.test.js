import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readFile as readBytes,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_PATH = join(
  REPOSITORY_ROOT,
  "scripts/windows-preparation-manifest-transport.ps1",
);
const WORKFLOW_PATH = join(
  REPOSITORY_ROOT,
  ".github/workflows/windows-production-finalizer-signed.yml",
);
const NATIVE_WINDOWS_X64 = process.platform === "win32" && process.arch === "x64";
const MAXIMUM_RAW_BYTES = 256 * 1024;
const MAXIMUM_BASE64_BYTES = 384 * 1024;
const CHUNK_MAXIMUM_BYTES = 24 * 1024;
const MAXIMUM_CHUNKS = 16;
const CHUNK_ENV_PREFIX = "PREPARATION_HANDOFF_CHUNK_";

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseOutput(output) {
  const lines = output.split(/\r?\n/u).filter(Boolean);
  const values = Object.create(null);
  for (const line of lines) {
    const separator = line.indexOf("=");
    assert.ok(separator > 0, `invalid output line: ${line}`);
    const key = line.slice(0, separator);
    assert.equal(values[key], undefined, `duplicate output key: ${key}`);
    values[key] = line.slice(separator + 1);
  }
  return values;
}

function cleanTransportEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      name === "PREPARATION_HANDOFF_CHUNK_COUNT" ||
      name === "PREPARATION_HANDOFF_MANIFEST_BYTES" ||
      name === "PREPARATION_HANDOFF_ENCODED_BYTES" ||
      name === "PREPARATION_HANDOFF_SHA256" ||
      name.startsWith(CHUNK_ENV_PREFIX)
    ) delete environment[name];
  }
  return environment;
}

function runPwsh(arguments_, environment = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        HELPER_PATH,
        ...arguments_,
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (status, signal) => {
      resolveRun({ signal, status, stderr, stdout });
    });
  });
}

function outputEnvironment(values) {
  const environment = cleanTransportEnvironment();
  environment.PREPARATION_HANDOFF_CHUNK_COUNT = values["manifest-chunk-count"];
  environment.PREPARATION_HANDOFF_MANIFEST_BYTES = values["manifest-bytes"];
  environment.PREPARATION_HANDOFF_ENCODED_BYTES = values["manifest-encoded-bytes"];
  environment.PREPARATION_HANDOFF_SHA256 = values["manifest-sha256"];
  for (let index = 0; index < MAXIMUM_CHUNKS; index += 1) {
    const suffix = String(index).padStart(2, "0");
    environment[`${CHUNK_ENV_PREFIX}${suffix}`] = values[`manifest-chunk-${suffix}`] ?? "";
  }
  return environment;
}

async function encodeFixture(root, bytes) {
  const inputPath = join(root, "input.json");
  const outputPath = join(root, "github-output.txt");
  await writeFile(inputPath, bytes);
  await writeFile(outputPath, "", "utf8");
  const result = await runPwsh(
    ["-Mode", "Encode", "-InputPath", inputPath, "-OutputFile", outputPath],
    cleanTransportEnvironment(),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  return {
    inputPath,
    outputPath,
    values: parseOutput(await readFile(outputPath, "utf8")),
  };
}

test("Windows preparation transport source contract is fixed, bounded, and content-free", async () => {
  const [helper, workflow] = await Promise.all([
    readFile(HELPER_PATH, "utf8"),
    readFile(WORKFLOW_PATH, "utf8"),
  ]);
  for (const fragment of [
    "[string]$Mode",
    "if ($Mode -cne 'Encode' -and $Mode -cne 'Decode')",
    "if ($Mode -ceq 'Encode')",
    "'Encode'",
    "'Decode'",
    "$MaximumRawBytes = 262144",
    "$MaximumBase64Bytes = 393216",
    "$ChunkMaximumBytes = 24576",
    "$MaximumChunks = 16",
    "[Convert]::FromBase64String",
    "[IO.FileMode]::CreateNew",
    "$stream.Flush($true)",
    "WINDOWS_PREPARATION_MANIFEST_TRANSPORT_UNEXPECTED_CHUNK",
    "WINDOWS_PREPARATION_MANIFEST_TRANSPORT_DIGEST_MISMATCH",
    "WINDOWS_PREPARATION_MANIFEST_TRANSPORT_OUTPUT_PREEXISTS",
  ]) assert.match(helper, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  for (const forbidden of ["Write-Host", "Read-Host", "Write-Error $_", "Write-Output $bytes"]) {
    assert.equal(helper.includes(forbidden), false, `helper must not expose ${forbidden}`);
  }
  assert.match(workflow, /scripts\/windows-preparation-manifest-transport\.ps1/u);
  assert.match(
    workflow,
    /windows-preparation-manifest-transport\.ps1[\s\S]*?-Mode Encode/u,
  );
  assert.match(
    workflow,
    /windows-preparation-manifest-transport\.ps1[\s\S]*?-Mode Decode/u,
  );
  assert.match(
    workflow,
    /build-windows-production-finalizer-preparation-handoff\.mjs[\s\S]*?--verify/u,
  );
});

test("native Windows x64 PowerShell transport round-trips boundaries and rejects tampering", {
  skip: NATIVE_WINDOWS_X64 ? false : "native Windows x64 pwsh proof runs in the Windows portability lane",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-preparation-transport-"));
  try {
    const fixtures = [
      Buffer.from([0x7b]),
      Buffer.alloc(18_432, 0x41),
      Buffer.alloc(18_433, 0x42),
      Buffer.alloc(MAXIMUM_RAW_BYTES, 0x43),
    ];
    for (const bytes of fixtures) {
      const { values } = await encodeFixture(root, bytes);
      const encoded = bytes.toString("base64");
      const expectedChunkCount = Math.ceil(encoded.length / CHUNK_MAXIMUM_BYTES);
      assert.equal(Object.keys(values).length, 4 + MAXIMUM_CHUNKS);
      assert.deepEqual(
        Object.keys(values).sort(),
        [
          "manifest-chunk-count",
          "manifest-bytes",
          "manifest-encoded-bytes",
          "manifest-sha256",
          ...Array.from({ length: MAXIMUM_CHUNKS }, (_, index) =>
            `manifest-chunk-${String(index).padStart(2, "0")}`),
        ].sort(),
      );
      assert.equal(Number(values["manifest-bytes"]), bytes.length);
      assert.equal(Number(values["manifest-encoded-bytes"]), encoded.length);
      assert.equal(Number(values["manifest-chunk-count"]), expectedChunkCount);
      assert.equal(values["manifest-sha256"], sha256Hex(bytes));
      assert.equal(
        Array.from({ length: MAXIMUM_CHUNKS }, (_, index) => {
          const suffix = String(index).padStart(2, "0");
          return values[`manifest-chunk-${suffix}`] ?? "";
        }).join(""),
        encoded,
      );
      const outputPath = join(root, `roundtrip-${bytes.length}.json`);
      const decoded = await runPwsh(
        ["-Mode", "Decode", "-OutputPath", outputPath, "-ExpectedSha256", values["manifest-sha256"]],
        outputEnvironment(values),
      );
      assert.equal(decoded.status, 0, decoded.stderr);
      assert.equal(decoded.stdout, "");
      assert.equal(decoded.stderr, "");
      assert.deepEqual(await readBytes(outputPath), bytes);
    }

    const boundary = await encodeFixture(root, Buffer.alloc(18_433, 0x44));
    const baseline = outputEnvironment(boundary.values);
    async function failure(name, mutate, expectedCode, options = {}) {
      const environment = { ...baseline };
      mutate(environment);
      const outputPath = join(root, `${name}.json`);
      const result = await runPwsh(
        ["-Mode", "Decode", "-OutputPath", outputPath, ...(options.expectedSha256 ? ["-ExpectedSha256", options.expectedSha256] : [])],
        environment,
      );
      assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(`^${expectedCode}\\r?\\n?$`, "u"));
      assert.equal(result.stderr.includes(boundary.inputPath), false);
      assert.equal(result.stderr.includes(outputPath), false);
    }
    await failure(
      "missing",
      (environment) => delete environment.PREPARATION_HANDOFF_CHUNK_00,
      "WINDOWS_PREPARATION_MANIFEST_TRANSPORT_CHUNK_INVALID",
    );
    await failure(
      "extra",
      (environment) => { environment.PREPARATION_HANDOFF_CHUNK_16 = "AAAA"; },
      "WINDOWS_PREPARATION_MANIFEST_TRANSPORT_UNEXPECTED_CHUNK",
    );
    await failure(
      "tampered",
      (environment) => {
        const chunk = environment.PREPARATION_HANDOFF_CHUNK_00;
        environment.PREPARATION_HANDOFF_CHUNK_00 = `${chunk[0] === "A" ? "B" : "A"}${chunk.slice(1)}`;
      },
      "WINDOWS_PREPARATION_MANIFEST_TRANSPORT_DIGEST_MISMATCH",
    );
    await failure(
      "invalid-base64",
      (environment) => { environment.PREPARATION_HANDOFF_CHUNK_00 = "?"; },
      "WINDOWS_PREPARATION_MANIFEST_TRANSPORT_CHUNK_INVALID",
    );
    await failure(
      "wrong-digest",
      () => {},
      "WINDOWS_PREPARATION_MANIFEST_TRANSPORT_DIGEST_MISMATCH",
      { expectedSha256: "0".repeat(64) },
    );

    const existingPath = join(root, "existing.json");
    await writeFile(existingPath, "sentinel", "utf8");
    const existing = await runPwsh(
      ["-Mode", "Decode", "-OutputPath", existingPath, "-ExpectedSha256", boundary.values["manifest-sha256"]],
      baseline,
    );
    assert.notEqual(existing.status, 0);
    assert.equal(existing.stdout, "");
    assert.match(existing.stderr, /^WINDOWS_PREPARATION_MANIFEST_TRANSPORT_OUTPUT_PREEXISTS\r?\n?$/u);
    assert.equal(await readFile(existingPath, "utf8"), "sentinel");

    const oversizedPath = join(root, "oversized.json");
    await writeFile(oversizedPath, Buffer.alloc(MAXIMUM_RAW_BYTES + 1, 0x45));
    const outputFile = join(root, "oversized-output.txt");
    await writeFile(outputFile, "", "utf8");
    const oversized = await runPwsh(
      ["-Mode", "Encode", "-InputPath", oversizedPath, "-OutputFile", outputFile],
      cleanTransportEnvironment(),
    );
    assert.notEqual(oversized.status, 0);
    assert.equal(oversized.stdout, "");
    assert.match(oversized.stderr, /^WINDOWS_PREPARATION_MANIFEST_TRANSPORT_INPUT_BOUNDS_INVALID\r?\n?$/u);
    assert.equal(oversized.stderr.includes(oversizedPath), false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
