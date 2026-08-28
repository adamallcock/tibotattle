import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runClaudeCallback } from "../src/claude-callback-runtime.js";
import { readClaudeStatusSnapshots } from "../src/claude-statusline-storage.js";
import { EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES } from "../src/export-identity-keychain.js";

const CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym;
const CAPTURED_AT = "2026-07-25T12:00:00.000Z";
const HERE = dirname(fileURLToPath(import.meta.url));

function payload() {
  return Buffer.from(JSON.stringify({
    version: "2.1.176",
    model: { id: "claude-sonnet-4-20260701" },
    session_id: "PRIVATE-RAW-SESSION",
    transcript_path: "/private/PRIVATE-CONTENT.jsonl",
    rate_limits: {
      five_hour: { used_percentage: 12.3, resets_at: 1_774_608_000 },
      seven_day: { used_percentage: 34.5, resets_at: 1_775_212_800 },
    },
  }));
}

async function withFixture(fn) {
  const created = await mkdtemp(join(tmpdir(), "claude-callback-runtime-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  try {
    return await fn({ root, stateDirectory: join(root, "status") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function backend(secret = Buffer.alloc(32, 8)) {
  return {
    async read(capability) {
      assert.equal(capability, CAPABILITY);
      return Buffer.from(secret);
    },
    async createIfMissing() { throw new Error("unused"); },
    async replaceExact() { throw new Error("unused"); },
    async deleteExact() { throw new Error("unused"); },
  };
}

function outputSink() {
  let value = "";
  return { sink: { write(chunk) { value += chunk; } }, value: () => value };
}

test("runtime fans identical bounded input to the existing command and private collector", async () => {
  await withFixture(async ({ stateDirectory }) => {
    const output = outputSink();
    await runClaudeCallback({
      stdin: Readable.from([payload()]),
      stdout: output.sink,
      env: { PATH: process.env.PATH },
      stateDirectory,
      backend: backend(),
      readRuntimeConfiguration: async () => ({
        previousCommand: "node -e \"process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('existing status'))\"",
      }),
      capturedAt: CAPTURED_AT,
    });
    assert.equal(output.value(), "existing status · Claude 5h 12.3% · 7d 34.5%\n");
    const records = await readClaudeStatusSnapshots({ stateDirectory });
    assert.equal(records.length, 1);
    assert.match(records[0].sessionPseudonym, /^claude-session:v1:/);
    const serialized = JSON.stringify(records);
    assert.equal(serialized.includes("PRIVATE-RAW-SESSION"), false);
    assert.equal(serialized.includes("PRIVATE-CONTENT"), false);
  });
});

test("existing output remains visible when Keychain is locked", async () => {
  const output = outputSink();
  const diagnostic = outputSink();
  const locked = backend();
  locked.read = async () => {
    const error = new Error("PRIVATE-UPSTREAM");
    error.code = "export_identity_keychain_locked";
    throw error;
  };
  const result = await runClaudeCallback({
    stdin: Readable.from([payload()]),
    stdout: output.sink,
    stderr: diagnostic.sink,
    backend: locked,
    readRuntimeConfiguration: async () => ({ previousCommand: "printf 'existing status'" }),
    capturedAt: CAPTURED_AT,
  });
  assert.deepEqual(result, {
    status: "existing_status_only",
    monitorErrorCode: "claude_callback_credential_locked",
  });
  assert.equal(output.value(), "existing status");
  assert.equal(diagnostic.value(), "Claude monitor unavailable [claude_callback_credential_locked]\n");
  assert.equal(diagnostic.value().includes("PRIVATE-UPSTREAM"), false);
});

test("legacy Keychain migration reports the restart-required Claude code", async () => {
  const output = outputSink();
  const diagnostic = outputSink();
  const migrationRequired = backend();
  migrationRequired.read = async () => {
    const error = new Error("PRIVATE-UPSTREAM-MIGRATION");
    error.code = "export_identity_keychain_migration_required";
    throw error;
  };
  const result = await runClaudeCallback({
    stdin: Readable.from([payload()]),
    stdout: output.sink,
    stderr: diagnostic.sink,
    backend: migrationRequired,
    readRuntimeConfiguration: async () => ({
      previousCommand: "printf 'existing status'",
    }),
    capturedAt: CAPTURED_AT,
  });
  assert.deepEqual(result, {
    status: "existing_status_only",
    monitorErrorCode: "claude_callback_credential_migration_required",
  });
  assert.equal(output.value(), "existing status");
  assert.equal(
    diagnostic.value(),
    "Claude monitor unavailable [claude_callback_credential_migration_required]\n",
  );
  assert.equal(diagnostic.value().includes("PRIVATE-UPSTREAM"), false);
});

test("malformed callback input preserves existing output and zeroizes leased secret bytes", async () => {
  const output = outputSink();
  const diagnostic = outputSink();
  let reads = 0;
  const leased = Buffer.alloc(32, 19);
  const selected = backend();
  selected.read = async () => { reads += 1; return leased; };
  const result = await runClaudeCallback({
    stdin: Readable.from([Buffer.from("{not-json")]),
    stdout: output.sink,
    stderr: diagnostic.sink,
    backend: selected,
    readRuntimeConfiguration: async () => ({ previousCommand: "printf 'existing status'" }),
    capturedAt: CAPTURED_AT,
  });
  assert.deepEqual(result, { status: "existing_status_only", monitorErrorCode: "input_json" });
  assert.equal(reads, 1);
  assert.deepEqual(leased, Buffer.alloc(32));
  assert.equal(output.value(), "existing status");
  assert.equal(diagnostic.value(), "Claude monitor unavailable [input_json]\n");
});

test("oversized input is streamed completely to the existing command with bounded monitor memory", async () => {
  const output = outputSink();
  const diagnostic = outputSink();
  let reads = 0;
  const selected = backend();
  selected.read = async () => { reads += 1; return Buffer.alloc(32, 20); };
  const oversized = Buffer.alloc(96 * 1024, 0x61);
  const result = await runClaudeCallback({
    stdin: Readable.from([
      oversized.subarray(0, 48 * 1024),
      oversized.subarray(48 * 1024),
    ]),
    stdout: output.sink,
    stderr: diagnostic.sink,
    backend: selected,
    readRuntimeConfiguration: async () => ({
      previousCommand: "bytes=$(wc -c | tr -d ' '); printf 'existing bytes=%s' \"$bytes\"",
    }),
    capturedAt: CAPTURED_AT,
  });
  assert.deepEqual(result, { status: "existing_status_only", monitorErrorCode: "input_too_large" });
  assert.equal(output.value(), `existing bytes=${oversized.byteLength}`);
  assert.equal(diagnostic.value(), "Claude monitor unavailable [input_too_large]\n");
  assert.equal(reads, 0);
});

test("input stream errors preserve the prior command's partial-stream behavior and fixed diagnostic", async () => {
  const output = outputSink();
  const diagnostic = outputSink();
  const source = new Readable({
    read() {
      this.push(Buffer.from("partial-private-input"));
      this.destroy(new Error("PRIVATE-STREAM-FAILURE"));
    },
  });
  const result = await runClaudeCallback({
    stdin: source,
    stdout: output.sink,
    stderr: diagnostic.sink,
    backend: backend(),
    readRuntimeConfiguration: async () => ({
      previousCommand: "bytes=$(wc -c | tr -d ' '); printf 'existing bytes=%s' \"$bytes\"",
    }),
    capturedAt: CAPTURED_AT,
  });
  assert.deepEqual(result, { status: "existing_status_only", monitorErrorCode: "input_read" });
  assert.equal(output.value(), "existing bytes=21");
  assert.equal(diagnostic.value(), "Claude monitor unavailable [input_read]\n");
  assert.equal(diagnostic.value().includes("PRIVATE-STREAM-FAILURE"), false);
});

test("a closed backpressured output fails promptly instead of waiting forever for drain", async () => {
  await withFixture(async ({ stateDirectory }) => {
    class ClosedOutput extends EventEmitter {
      write() {
        queueMicrotask(() => this.emit("close"));
        return false;
      }
    }
    await assert.rejects(runClaudeCallback({
      stdin: Readable.from([payload()]),
      stdout: new ClosedOutput(),
      stateDirectory,
      backend: backend(),
      readRuntimeConfiguration: async () => ({ previousCommand: null }),
      capturedAt: CAPTURED_AT,
    }), (error) => error.code === "output_write");
  });
});

test("existing-only fallback exits zero so Claude can retain the prior status output", () => {
  const oversized = Buffer.alloc(96 * 1024, 0x61);
  const result = spawnSync(process.execPath, [
    join(HERE, "..", "scripts", "test-fixtures", "claude-callback-existing-status-process.js"),
  ], {
    input: oversized,
    encoding: "utf8",
    maxBuffer: 256 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `existing bytes=${oversized.byteLength}`);
  assert.equal(result.stderr, "Claude monitor unavailable [input_too_large]\n");
});

test("duplicate overlapping invocations serialize without losing records", async () => {
  await withFixture(async ({ stateDirectory }) => {
    await Promise.all(Array.from({ length: 2 }, () => runClaudeCallback({
      stdin: Readable.from([payload()]),
      stdout: outputSink().sink,
      stateDirectory,
      backend: backend(),
      readRuntimeConfiguration: async () => ({ previousCommand: null }),
      capturedAt: CAPTURED_AT,
    })));
    assert.equal((await readClaudeStatusSnapshots({ stateDirectory })).length, 2);
  });
});
