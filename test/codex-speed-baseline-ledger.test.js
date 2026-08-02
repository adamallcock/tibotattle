// Deep-dive coverage for src/codex-speed-baseline.js, on top of the
// end-to-end coverage already in test/fast-mode-accounting.test.js (which
// covers no-backfill, the uncovered gap after a change, and observation
// beating a declared baseline).
//
// This file focuses on the ledger's own bookkeeping invariants: the bounded
// window count, refusal to trust a clock that moved backwards or is
// unparseable, and the token-to-mode mapping staying an explicit allowlist.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  CODEX_SPEED_BASELINE_SCHEMA_VERSION,
  CodexSpeedBaselineError,
  codexServiceTierSpeedMode,
  createCodexSpeedBaselineController,
  declaredSpeedModeAt,
} from "../src/codex-speed-baseline.js";

const MAXIMUM_WINDOWS = 64;

async function configRoot(contents) {
  const root = await mkdtemp(join(tmpdir(), "codex-speed-baseline-ledger-"));
  const configFile = join(root, "config.toml");
  if (contents !== null) {
    await writeFile(configFile, contents, { mode: 0o600 });
  }
  return { configFile, ledgerFile: join(root, "private", "baseline.json"), root };
}

/** `count` disjoint, alternating-mode, one-instant windows, 60s apart. */
function seededWindows(count, baseMs) {
  const windows = [];
  let mode = "standard";
  for (let index = 0; index < count; index += 1) {
    const at = new Date(baseMs + index * 60_000).toISOString();
    windows.push({ firstSeenAt: at, lastSeenAt: at, mode });
    mode = mode === "standard" ? "fast" : "standard";
  }
  return windows;
}

async function seedLedger(ledgerFile, windows) {
  const document = { schemaVersion: CODEX_SPEED_BASELINE_SCHEMA_VERSION, windows };
  await mkdir(dirname(ledgerFile), { recursive: true, mode: 0o700 });
  await writeFile(ledgerFile, `${JSON.stringify(document)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// The window cap (64) holds on write, and a ledger that already exceeds it
// (however that happened) is refused on read rather than trusted.
// ---------------------------------------------------------------------------

test("the ledger never grows past 64 windows; the oldest is dropped first", async () => {
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const seed = seededWindows(MAXIMUM_WINDOWS, baseMs);
  // Seed sanity: alternating modes, so index 63 (the 64th window) is "fast".
  assert.equal(seed.length, MAXIMUM_WINDOWS);
  assert.equal(seed.at(-1).mode, "fast");
  const oldest = seed[0];
  const secondOldest = seed[1];

  const { configFile, ledgerFile, root } = await configRoot('service_tier = "default"\n');
  try {
    await seedLedger(ledgerFile, seed);
    const nextAt = baseMs + MAXIMUM_WINDOWS * 60_000;
    const controller = createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => new Date(nextAt),
    });

    // "default" -> standard, which differs from the newest seeded window
    // ("fast"), so this opens a new window rather than extending.
    const opened = await controller.record();
    assert.equal(opened.status, "opened");
    assert.equal(opened.windows.length, MAXIMUM_WINDOWS);
    // The single oldest window was dropped; everything else shifted down.
    assert.equal(
      opened.windows.some((window) => window.firstSeenAt === oldest.firstSeenAt),
      false,
    );
    assert.equal(opened.windows[0].firstSeenAt, secondOldest.firstSeenAt);
    assert.equal(opened.windows[0].mode, secondOldest.mode);
    assert.deepEqual(opened.windows.at(-1), {
      firstSeenAt: new Date(nextAt).toISOString(),
      lastSeenAt: new Date(nextAt).toISOString(),
      mode: "standard",
    });

    // The trimmed state is what actually landed on disk, not just in memory.
    const onDisk = JSON.parse(await readFile(ledgerFile, "utf8"));
    assert.equal(onDisk.windows.length, MAXIMUM_WINDOWS);
    assert.equal(JSON.stringify(onDisk).includes(oldest.firstSeenAt), false);

    // Extending the newest window at the cap must NOT shift anything else:
    // extension never grows the array, so no drop should occur here.
    const extendAt = nextAt + 60_000;
    const stillAtCap = await createCodexSpeedBaselineController({
      ledgerFile,
      configFile, // still "default" -> standard, same as the newest window
      now: () => new Date(extendAt),
    }).record();
    assert.equal(stillAtCap.status, "extended");
    assert.equal(stillAtCap.windows.length, MAXIMUM_WINDOWS);
    assert.equal(stillAtCap.windows[0].firstSeenAt, secondOldest.firstSeenAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a ledger already past the window cap is refused on read, not truncated silently", async () => {
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const { configFile, ledgerFile, root } = await configRoot('service_tier = "priority"\n');
  try {
    await seedLedger(ledgerFile, seededWindows(MAXIMUM_WINDOWS + 1, baseMs));
    const controller = createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => new Date(baseMs + (MAXIMUM_WINDOWS + 2) * 60_000),
    });
    await assert.rejects(
      () => controller.inspect(),
      (error) => error instanceof CodexSpeedBaselineError
        && error.code === "codex_speed_baseline_unavailable",
    );
    // The non-throwing reader degrades to no coverage, never a silently
    // truncated 64-window view of an invalid 65-window document.
    assert.deepEqual(await controller.readWindows(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A clock that moves backwards, throws, or produces an unparseable instant
// must leave the ledger byte-for-byte untouched.
// ---------------------------------------------------------------------------

test("a backwards or invalid clock leaves the ledger untouched", async () => {
  const { configFile, ledgerFile, root } = await configRoot('service_tier = "priority"\n');
  try {
    const controller = createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    const opened = await controller.record();
    assert.equal(opened.status, "opened");
    const afterFirstWrite = await readFile(ledgerFile, "utf8");

    // The tier really did change, so a healthy clock would open a new
    // window here. A clock that moved backwards must refuse to act on it.
    await writeFile(configFile, 'service_tier = "default"\n', { mode: 0o600 });
    const backwards = await createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => new Date("2026-08-01T11:00:00.000Z"),
    }).record();
    assert.equal(backwards.status, "undeclared");
    assert.deepEqual([...backwards.windows], [...opened.windows]);
    assert.equal(await readFile(ledgerFile, "utf8"), afterFirstWrite);

    // A throwing clock must degrade the same way instead of propagating.
    const throwing = await createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => {
        throw new Error("clock unavailable");
      },
    }).record();
    assert.equal(throwing.status, "undeclared");
    assert.deepEqual([...throwing.windows], [...opened.windows]);
    assert.equal(await readFile(ledgerFile, "utf8"), afterFirstWrite);

    // An unparseable instant (NaN) must degrade the same way, not fall back
    // to the Unix epoch or to "now" via some other implicit conversion.
    const nanClock = await createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => Number.NaN,
    }).record();
    assert.equal(nanClock.status, "undeclared");
    assert.deepEqual([...nanClock.windows], [...opened.windows]);
    assert.equal(await readFile(ledgerFile, "utf8"), afterFirstWrite);

    // A clock returning a non-date, non-numeric, non-string object behaves
    // identically.
    const objectClock = await createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => ({ not: "a date" }),
    }).record();
    assert.equal(objectClock.status, "undeclared");
    assert.deepEqual([...objectClock.windows], [...opened.windows]);
    assert.equal(await readFile(ledgerFile, "utf8"), afterFirstWrite);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid clock never opens a window even when the ledger starts empty", async () => {
  // With no prior window, the backwards-clock guard has nothing to compare
  // against and cannot fire. This isolates readingInstant() itself: it must
  // return null - never the Unix epoch or any other placeholder timestamp -
  // or a bug there could silently open a window stamped with a fake time
  // while still reading "undeclared" by coincidence (via the backwards
  // guard) once a later window exists, which is what the sibling test above
  // would miss on its own.
  for (const badNow of [
    () => Number.NaN,
    () => {
      throw new Error("clock unavailable");
    },
    () => ({ not: "a date" }),
  ]) {
    const { configFile, ledgerFile, root } = await configRoot('service_tier = "priority"\n');
    try {
      const controller = createCodexSpeedBaselineController({
        ledgerFile,
        configFile,
        now: badNow,
      });
      const result = await controller.record();
      assert.equal(result.status, "undeclared");
      assert.deepEqual([...result.windows], []);
      assert.equal(
        await readFile(ledgerFile, "utf8").catch((error) => error.code),
        "ENOENT",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// The token -> mode mapping is an explicit allowlist. Anything outside it,
// including near-miss casing/whitespace, resolves to null - never a guess.
// ---------------------------------------------------------------------------

test("codexServiceTierSpeedMode only recognises the two published tokens", () => {
  assert.equal(codexServiceTierSpeedMode("priority"), "fast");
  assert.equal(codexServiceTierSpeedMode("default"), "standard");
  for (const token of [
    "turbo",
    "PRIORITY",
    "Default",
    "priority ",
    " default",
    "fast",
    "standard",
    "",
    null,
    undefined,
    42,
    {},
    ["priority"],
  ]) {
    assert.equal(codexServiceTierSpeedMode(token), null, `token: ${JSON.stringify(token)}`);
  }
});

test("an unrecognised token leaves the ledger exactly as it was, with no write at all", async () => {
  const { configFile, ledgerFile, root } = await configRoot('service_tier = "turbo"\n');
  try {
    const controller = createCodexSpeedBaselineController({
      ledgerFile,
      configFile,
      now: () => new Date("2026-08-01T10:00:00.000Z"),
    });
    const recorded = await controller.record();
    assert.equal(recorded.status, "undeclared");
    assert.deepEqual([...recorded.windows], []);
    // Fail-closed means no file is created at all, not an empty one.
    assert.equal(await readFile(ledgerFile, "utf8").catch((error) => error.code), "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// declaredSpeedModeAt: malformed input is refused without throwing, and a
// corrupted entry mixed in with valid ones is skipped rather than crashing
// or matching by accident.
// ---------------------------------------------------------------------------

test("declaredSpeedModeAt rejects malformed input and skips corrupted entries", () => {
  assert.equal(declaredSpeedModeAt(null, Date.now()), null);
  assert.equal(declaredSpeedModeAt(undefined, Date.now()), null);
  assert.equal(declaredSpeedModeAt("not-an-array", Date.now()), null);
  assert.equal(declaredSpeedModeAt([], Number.NaN), null);
  assert.equal(declaredSpeedModeAt([], Number.POSITIVE_INFINITY), null);

  const valid = {
    firstSeenAt: "2026-08-01T12:00:00.000Z",
    lastSeenAt: "2026-08-01T13:00:00.000Z",
    mode: "fast",
  };
  const missingKeys = { firstSeenAt: "2026-08-01T12:00:00.000Z" };
  const badMode = { ...valid, mode: "turbo" };
  const invertedRange = {
    firstSeenAt: "2026-08-01T13:00:00.000Z",
    lastSeenAt: "2026-08-01T12:00:00.000Z",
    mode: "fast",
  };
  const at = Date.parse("2026-08-01T12:30:00.000Z");

  // A corrupted entry ahead of a valid one is skipped, not fatal.
  assert.equal(declaredSpeedModeAt([missingKeys, valid], at), "fast");
  assert.equal(declaredSpeedModeAt([badMode, valid], at), "fast");
  assert.equal(declaredSpeedModeAt([invertedRange, valid], at), "fast");
  // With only corrupted entries, the result is null, not a crash.
  assert.equal(declaredSpeedModeAt([missingKeys, badMode, invertedRange], at), null);
});
