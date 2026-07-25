import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ClaudeStatuslineError,
  formatClaudeStatusline,
  readBoundedClaudeStatusInput,
  runClaudeStatusline,
  sanitizeClaudeStatusline,
  validateClaudeStatusSnapshot,
} from "../src/claude-statusline.js";
import {
  defaultClaudeStatusStateDirectory,
  readClaudeStatusSnapshots,
  writeClaudeStatusSnapshot,
} from "../src/claude-statusline-storage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CLI = join(ROOT, "src", "claude-statusline.js");
const CAPTURED_AT = "2026-07-24T12:00:00.000Z";
const FIVE_HOUR_RESET = 1_774_608_000;
const SEVEN_DAY_RESET = 1_775_212_800;
const CANARY = "PRIVATE_CANARY_/secret/project_prompt_account@example.com";

function input(overrides = {}) {
  return {
    version: "2.1.176",
    model: { id: "claude-opus-4-20260701", display_name: CANARY },
    fast_mode: true,
    session_id: "private-session",
    cwd: `/private/project/${CANARY}`,
    workspace: CANARY,
    transcript_path: `/private/${CANARY}.jsonl`,
    session_name: CANARY,
    prompt_id: CANARY,
    prompt: CANARY,
    account_id: CANARY,
    repository: CANARY,
    branch: CANARY,
    worktree: CANARY,
    rate_limits: {
      five_hour: { used_percentage: 23.55, resets_at: FIVE_HOUR_RESET },
      seven_day: { used_percentage: 41.2, resets_at: SEVEN_DAY_RESET },
    },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return sanitizeClaudeStatusline(input(overrides), CAPTURED_AT, { sessionSecret: Buffer.alloc(32, 7) });
}

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), "claude-statusline-"));
  await chmod(created, 0o700);
  // macOS exposes /var as a system symlink. Use the canonical fixture path so
  // tests exercise the same no-symlink parent-chain policy as production.
  const root = await realpath(created);
  return { root, stateDirectory: join(root, "state") };
}

async function withFixture(fn) {
  const value = await fixture();
  try {
    return await fn(value);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
}

function assertSafeError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ClaudeStatuslineError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes(CANARY), false);
    assert.equal(error.message.includes("/secret/"), false);
    return true;
  });
}

test("Claude status-line sanitizer retains bounded metadata and drops every private routing/content field", () => {
  const value = snapshot();
  const serialized = JSON.stringify(value);
  assert.deepEqual(value.limits.fiveHour, {
    windowMinutes: 300,
    usedPercent: 23.55,
    resetsAt: FIVE_HOUR_RESET,
  });
  assert.deepEqual(value.limits.sevenDay, {
    windowMinutes: 10_080,
    usedPercent: 41.2,
    resetsAt: SEVEN_DAY_RESET,
  });
  assert.equal(value.clientVersion, "2.1.176");
  assert.equal(value.modelId, "claude_opus");
  assert.match(value.sessionPseudonym, /^claude-session:v1:[A-Za-z0-9_-]{43}$/);
  assert.equal(serialized.includes(CANARY), false);
  assert.equal(serialized.includes("private-session"), false);
  assert.equal(serialized.includes("display_name"), false);
  assert.equal(formatClaudeStatusline(value), "Claude 5h 23.6% · 7d 41.2%");
  assert.ok(formatClaudeStatusline(value).length < 64);
});

test("session pseudonyms are deterministic, domain-separated, secret-scoped, and optional", () => {
  const first = sanitizeClaudeStatusline(input(), CAPTURED_AT, { sessionSecret: Buffer.alloc(32, 1) });
  const repeat = sanitizeClaudeStatusline(input(), CAPTURED_AT, { sessionSecret: Buffer.alloc(32, 1) });
  const otherSecret = sanitizeClaudeStatusline(input(), CAPTURED_AT, { sessionSecret: Buffer.alloc(32, 2) });
  const withoutSecret = sanitizeClaudeStatusline(input(), CAPTURED_AT);
  assert.equal(first.sessionPseudonym, repeat.sessionPseudonym);
  assert.notEqual(first.sessionPseudonym, otherSecret.sessionPseudonym);
  assert.equal(withoutSecret.sessionPseudonym, null);
  assertSafeError(() => sanitizeClaudeStatusline(input(), CAPTURED_AT, { sessionSecret: Buffer.alloc(31) }), "session_secret");
});

test("five-hour and seven-day windows are independently optional rather than synthesized as zero", () => {
  const onlyFive = sanitizeClaudeStatusline(input({ rate_limits: {
    five_hour: { used_percentage: 8, resets_at: FIVE_HOUR_RESET },
  } }), CAPTURED_AT);
  const onlySeven = sanitizeClaudeStatusline(input({ rate_limits: {
    seven_day: { used_percentage: 9, resets_at: SEVEN_DAY_RESET },
  } }), CAPTURED_AT);
  const neither = sanitizeClaudeStatusline({ version: "2.1.176" }, CAPTURED_AT);
  assert.equal(onlyFive.limits.fiveHour.windowMinutes, 300);
  assert.equal(onlyFive.limits.sevenDay, null);
  assert.equal(onlySeven.limits.fiveHour, null);
  assert.equal(onlySeven.limits.sevenDay.windowMinutes, 10_080);
  assert.equal(neither.limits.fiveHour, null);
  assert.equal(neither.limits.sevenDay, null);
  assert.equal(formatClaudeStatusline(neither), "Claude limits unavailable");
});

test("percentages and reset epochs fail closed at strict boundaries", () => {
  for (const value of [-0.01, 100.01, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
    assertSafeError(() => sanitizeClaudeStatusline(input({ rate_limits: {
      five_hour: { used_percentage: value, resets_at: FIVE_HOUR_RESET },
    } }), CAPTURED_AT), "limit_percent");
  }
  for (const value of [1.5, 0, Number.MAX_SAFE_INTEGER, "1774608000"]) {
    assertSafeError(() => sanitizeClaudeStatusline(input({ rate_limits: {
      five_hour: { used_percentage: 50, resets_at: value },
    } }), CAPTURED_AT), "limit_reset_epoch");
  }
  assert.equal(sanitizeClaudeStatusline(input({ rate_limits: {
    five_hour: { used_percentage: 0, resets_at: 946_684_800 },
    seven_day: { used_percentage: 100, resets_at: 7_258_118_400 },
  } }), CAPTURED_AT).limits.sevenDay.usedPercent, 100);
});

test("client version and model identifiers are reduced to low-cardinality values", () => {
  assert.equal(sanitizeClaudeStatusline(input({ version: `2.1.176-${CANARY}` }), CAPTURED_AT).clientVersion, "unknown");
  assert.equal(sanitizeClaudeStatusline(input({ version: CANARY }), CAPTURED_AT).clientVersion, "unknown");
  assert.equal(sanitizeClaudeStatusline(input({ model: { id: CANARY } }), CAPTURED_AT).modelId, "unknown");
  assert.equal(sanitizeClaudeStatusline(input({ model: { id: "claude-sonnet-latest" } }), CAPTURED_AT).modelId, "claude_sonnet");
});

test("accessors and hostile proxies are rejected without invoking or echoing them", () => {
  let invoked = false;
  const getter = {};
  Object.defineProperty(getter, "rate_limits", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error(CANARY);
    },
  });
  assertSafeError(() => sanitizeClaudeStatusline(getter, CAPTURED_AT), "input_shape");
  assert.equal(invoked, false);

  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error(CANARY);
    },
  });
  assertSafeError(() => sanitizeClaudeStatusline(hostile, CAPTURED_AT), "input_shape");
});

test("bounded stdin accepts a complete object and refuses oversized input before accumulating it", async () => {
  const parsed = await readBoundedClaudeStatusInput(Readable.from([Buffer.from('{"version":"2.1.176"}')]), 64);
  assert.equal(parsed.version, "2.1.176");
  await assert.rejects(
    readBoundedClaudeStatusInput(Readable.from([Buffer.alloc(48, 0x61), Buffer.alloc(48, 0x62)]), 64),
    (error) => error instanceof ClaudeStatuslineError && error.code === "input_too_large" && !error.message.includes(CANARY),
  );
});

test("standalone JSON Schema validates the normalized record and rejects extra properties", async () => {
  const schema = JSON.parse(await readFile(join(ROOT, "schemas", "claude-statusline-v0.2", "claude-statusline-record.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(snapshot()), true, JSON.stringify(validate.errors));
  const extra = { ...snapshot(), cwd: CANARY };
  assert.equal(validate(extra), false);
  assertSafeError(() => validateClaudeStatusSnapshot(extra), "snapshot_shape");
});

test("default destination is an OS-stable application-state path", () => {
  assert.equal(
    defaultClaudeStatusStateDirectory({ platform: "darwin", env: {}, homeDirectory: "/Users/tester" }),
    "/Users/tester/Library/Application Support/app-usagemonitor/claude-statusline-v0.2",
  );
  assert.equal(
    defaultClaudeStatusStateDirectory({ platform: "linux", env: { XDG_STATE_HOME: "/state" }, homeDirectory: "/home/tester" }),
    "/state/app-usagemonitor/claude-statusline-v0.2",
  );
  assertSafeError(
    () => defaultClaudeStatusStateDirectory({ platform: "linux", env: { XDG_STATE_HOME: CANARY }, homeDirectory: "/home/tester" }),
    "state_root",
  );
});

test("default application-state layout is created safely and rejects an aliased parent", async () => {
  await withFixture(async ({ root }) => {
    const home = join(root, "safe-home");
    await mkdir(home, { mode: 0o700 });
    const stateDirectory = defaultClaudeStatusStateDirectory({ platform: "darwin", env: {}, homeDirectory: home });
    await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
    assert.equal((await readClaudeStatusSnapshots({ stateDirectory })).length, 1);
  });
  await withFixture(async ({ root }) => {
    const home = join(root, "aliased-home");
    const outside = join(root, "outside-library");
    await mkdir(home, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(home, "Library"));
    const stateDirectory = defaultClaudeStatusStateDirectory({ platform: "darwin", env: {}, homeDirectory: home });
    await assert.rejects(
      writeClaudeStatusSnapshot(snapshot(), { stateDirectory }),
      (error) => error.code === "state_parent_type",
    );
  });
});

test("ledger creates owner-only directories and complete owner-only records", async () => withFixture(async ({ stateDirectory }) => {
  const result = await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.recordsDirectory)).mode & 0o777, 0o700);
  const recordStats = await stat(result.recordFile);
  assert.equal(recordStats.mode & 0o777, 0o600);
  assert.equal(recordStats.nlink, 1);
  assert.deepEqual(await readClaudeStatusSnapshots({ stateDirectory }), [snapshot()]);
}));

test("capture runner stores one normalized record and emits only the short status line", async () => withFixture(async ({ stateDirectory }) => {
  let output = "";
  const secret = Buffer.alloc(32, 9).toString("base64url");
  const value = await runClaudeStatusline({
    stdin: Readable.from([Buffer.from(JSON.stringify(input()))]),
    stdout: { write(chunk) { output += chunk; } },
    env: {
      USAGEMONITOR_CLAUDE_STATE_DIR: stateDirectory,
      USAGEMONITOR_CLAUDE_SESSION_SECRET_B64URL: secret,
    },
    capturedAt: CAPTURED_AT,
  });
  assert.equal(output, "Claude 5h 23.6% · 7d 41.2%\n");
  assert.equal(output.includes(CANARY), false);
  assert.deepEqual(await readClaudeStatusSnapshots({ stateDirectory }), [value]);
}));

test("ledger rejects symlink, hardlink, and unsafe-mode substitutions", async () => {
  await withFixture(async ({ root, stateDirectory }) => {
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, stateDirectory);
    await assert.rejects(writeClaudeStatusSnapshot(snapshot(), { stateDirectory }), (error) => error.code === "state_directory_type");
  });
  await withFixture(async ({ stateDirectory }) => {
    await mkdir(stateDirectory, { mode: 0o755 });
    await assert.rejects(writeClaudeStatusSnapshot(snapshot(), { stateDirectory }), (error) => error.code === "state_directory_mode");
  });
  await withFixture(async ({ root }) => {
    const actualParent = join(root, "actual-parent");
    const aliasParent = join(root, "alias-parent");
    await mkdir(actualParent, { mode: 0o700 });
    await symlink(actualParent, aliasParent);
    await assert.rejects(
      writeClaudeStatusSnapshot(snapshot(), { stateDirectory: join(aliasParent, "state") }),
      (error) => error.code === "state_parent_type",
    );
  });
  await withFixture(async ({ root, stateDirectory }) => {
    const result = await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
    await link(result.recordFile, join(root, "extra-link"));
    await assert.rejects(readClaudeStatusSnapshots({ stateDirectory }), (error) => error.code === "state_file_links");
  });
  await withFixture(async ({ stateDirectory }) => {
    const result = await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
    await chmod(result.recordFile, 0o644);
    await assert.rejects(readClaudeStatusSnapshots({ stateDirectory }), (error) => error.code === "state_file_mode");
  });
});

test("concurrent writers serialize and publish only complete records", async () => withFixture(async ({ stateDirectory }) => {
  const values = Array.from({ length: 48 }, (_, index) => sanitizeClaudeStatusline(input({
    rate_limits: { five_hour: { used_percentage: index, resets_at: FIVE_HOUR_RESET } },
  }), `2026-07-24T12:00:${String(index).padStart(2, "0")}.000Z`));
  await Promise.all(values.map((value) => writeClaudeStatusSnapshot(value, { stateDirectory })));
  const stored = await readClaudeStatusSnapshots({ stateDirectory });
  assert.equal(stored.length, values.length);
  assert.deepEqual(stored.map((value) => value.limits.fiveHour.usedPercent).sort((a, b) => a - b),
    values.map((value) => value.limits.fiveHour.usedPercent));
  const names = await readdir(join(stateDirectory, "records"));
  assert.equal(names.some((name) => name.startsWith(".pending-")), false);
  assert.equal(names.includes(".writer.lock"), false);
}));

test("writer fails closed when the records directory is replaced between identity check and file open", async () => withFixture(async ({ stateDirectory }) => {
  await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
  const recordsDirectory = join(stateDirectory, "records");
  const displaced = join(stateDirectory, "records-displaced");
  let replaced = false;
  await assert.rejects(
    writeClaudeStatusSnapshot(snapshot({ rate_limits: {
      five_hour: { used_percentage: 55, resets_at: FIVE_HOUR_RESET },
    } }), {
      stateDirectory,
      async failpoint(point) {
        if (point !== "before_pending_open" || replaced) return;
        replaced = true;
        await rename(recordsDirectory, displaced);
        await mkdir(recordsDirectory, { mode: 0o700 });
      },
    }),
    (error) => error.code === "state_directory_replaced" && !error.message.includes(CANARY),
  );
  assert.deepEqual(await readdir(recordsDirectory), []);
}));

test("reader verifies directory and file descriptors before bounded record allocation", async () => withFixture(async ({ stateDirectory }) => {
  const result = await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
  const displaced = join(stateDirectory, "records-displaced");
  let replaced = false;
  await assert.rejects(
    readClaudeStatusSnapshots({
      stateDirectory,
      async failpoint(point, recordName) {
        if (point !== "before_record_open" || replaced) return;
        replaced = true;
        await rename(result.recordsDirectory, displaced);
        await mkdir(result.recordsDirectory, { mode: 0o700 });
        await writeFile(join(result.recordsDirectory, recordName), Buffer.alloc(1024 * 1024, 0x61), { mode: 0o600 });
      },
    }),
    (error) => error.code === "record_replaced" && !error.message.includes(CANARY),
  );
}));

test("partial pending records are discarded and torn published records fail closed", async () => withFixture(async ({ stateDirectory }) => {
  const first = await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
  const pending = join(first.recordsDirectory, ".pending-11111111-1111-4111-8111-111111111111");
  await writeFile(pending, `{"prompt":"${CANARY}`, { mode: 0o600 });
  await writeClaudeStatusSnapshot(snapshot({ rate_limits: {
    seven_day: { used_percentage: 80, resets_at: SEVEN_DAY_RESET },
  } }), { stateDirectory });
  assert.equal((await readdir(first.recordsDirectory)).includes(".pending-11111111-1111-4111-8111-111111111111"), false);
  assert.equal((await readClaudeStatusSnapshots({ stateDirectory })).length, 2);

  const recordName = (await readdir(first.recordsDirectory)).find((name) => name.endsWith(".json"));
  await writeFile(join(first.recordsDirectory, recordName), "{}", { mode: 0o600 });
  await assert.rejects(readClaudeStatusSnapshots({ stateDirectory }), (error) => ["record_torn", "snapshot_shape"].includes(error.code));
}));

test("a dead writer lock and its partial record are recovered on the next capture", async () => withFixture(async ({ stateDirectory }) => {
  const first = await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
  await writeFile(join(stateDirectory, ".writer.lock"), "2147483647\n", { mode: 0o600 });
  await writeFile(join(first.recordsDirectory, ".pending-22222222-2222-4222-8222-222222222222"), "{", { mode: 0o600 });
  await writeClaudeStatusSnapshot(snapshot({ rate_limits: {
    five_hour: { used_percentage: 90, resets_at: FIVE_HOUR_RESET },
  } }), { stateDirectory });
  assert.equal((await readdir(stateDirectory)).includes(".writer.lock"), false);
  assert.equal((await readdir(first.recordsDirectory)).some((name) => name.startsWith(".pending-")), false);
  assert.equal((await readClaudeStatusSnapshots({ stateDirectory })).length, 2);
}));

test("an old lock owned by a live PID is never reaped solely because of age", async () => withFixture(async ({ stateDirectory }) => {
  await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
  const lockPath = join(stateDirectory, ".writer.lock");
  await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 });
  const old = new Date(Date.now() - (10 * 60 * 1000));
  await utimes(lockPath, old, old);
  await assert.rejects(
    writeClaudeStatusSnapshot(snapshot(), { stateDirectory, lockRetryMilliseconds: 25 }),
    (error) => error.code === "state_busy",
  );
  assert.equal(await readFile(lockPath, "utf8"), `${process.pid}\n`);
  await unlink(lockPath);
}));

test("ledger enforces both record-count and byte ceilings", async () => withFixture(async ({ stateDirectory }) => {
  for (let index = 0; index < 8; index += 1) {
    await writeClaudeStatusSnapshot(sanitizeClaudeStatusline(input({
      rate_limits: { five_hour: { used_percentage: index, resets_at: FIVE_HOUR_RESET } },
    }), `2026-07-24T12:01:${String(index).padStart(2, "0")}.000Z`), {
      stateDirectory,
      maxRecords: 3,
      maxLedgerBytes: 4096,
    });
  }
  const stored = await readClaudeStatusSnapshots({ stateDirectory, maxRecords: 3, maxLedgerBytes: 4096 });
  assert.equal(stored.length, 3);
  assert.deepEqual(stored.map((value) => value.limits.fiveHour.usedPercent), [5, 6, 7]);
  const recordNames = await readdir(join(stateDirectory, "records"));
  let total = 0;
  for (const name of recordNames) total += (await lstat(join(stateDirectory, "records", name))).size;
  assert.ok(total <= 4096);
}));

test("persisted ledger and all surfaced errors remain content-free", async () => withFixture(async ({ stateDirectory }) => {
  await writeClaudeStatusSnapshot(snapshot(), { stateDirectory });
  const recordsDirectory = join(stateDirectory, "records");
  const contents = await Promise.all((await readdir(recordsDirectory)).map((name) => readFile(join(recordsDirectory, name), "utf8")));
  assert.equal(contents.join("\n").includes(CANARY), false);
  assert.equal(contents.join("\n").includes("private-session"), false);
  await writeFile(join(recordsDirectory, CANARY.replaceAll("/", "_")), CANARY, { mode: 0o600 });
  await assert.rejects(readClaudeStatusSnapshots({ stateDirectory }), (error) => {
    assert.equal(error.code, "ledger_entry");
    assert.equal(error.message.includes(CANARY), false);
    return true;
  });
}));

test("CLI rejects oversized input with a deterministic content-free diagnostic", async () => withFixture(async ({ stateDirectory }) => {
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [CLI], {
      cwd: ROOT,
      env: { ...process.env, USAGEMONITOR_CLAUDE_STATE_DIR: stateDirectory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ prompt: CANARY, padding: "x".repeat(70 * 1024) }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Claude limits unavailable [input_too_large]\n");
  assert.equal(result.stderr.includes(CANARY), false);
}));
