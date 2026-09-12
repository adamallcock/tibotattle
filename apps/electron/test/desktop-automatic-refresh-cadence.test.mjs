import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDesktopAutomaticRefreshCadence,
  createDesktopAutomaticRefreshCadenceBackend,
  DESKTOP_AUTOMATIC_REFRESH_CADENCE_FILE_NAME,
  DESKTOP_AUTOMATIC_REFRESH_CADENCE_INTERVAL_MS,
  DESKTOP_AUTOMATIC_REFRESH_CADENCE_SCHEMA_VERSION,
  DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC,
} from "../desktop-automatic-refresh-cadence.js";

const INTERVAL = DESKTOP_AUTOMATIC_REFRESH_CADENCE_INTERVAL_MS;
const TOKEN_A = "00000000-0000-4000-8000-000000000001";
const TOKEN_B = "00000000-0000-4000-8000-000000000002";

function backendFixture({ stored = null, loadError = null, saveError = null } = {}) {
  let value = stored;
  let saveCalls = 0;
  return {
    get stored() {
      return value;
    },
    get saveCalls() {
      return saveCalls;
    },
    async load() {
      if (loadError !== null) throw loadError;
      return value;
    },
    async save(next) {
      saveCalls += 1;
      if (saveError !== null) throw saveError;
      value = next;
      return next;
    },
  };
}

function state(lastAutomaticDetailedAtMs, reservationToken = null) {
  return {
    schemaVersion: DESKTOP_AUTOMATIC_REFRESH_CADENCE_SCHEMA_VERSION,
    lastAutomaticDetailedAtMs,
    reservationToken,
  };
}

test("missing state seeds one quick-first timestamp", async () => {
  let now = 10_000;
  const backend = backendFixture();
  const cadence = createDesktopAutomaticRefreshCadence({
    backend,
    clock: () => now,
    tokenFactory: () => TOKEN_A,
  });

  assert.equal(await cadence.initialize(), "missing");
  assert.equal(await cadence.automaticMode(), "quick");
  assert.deepEqual(backend.stored, state(now));
  assert.equal(await cadence.automaticMode(), "quick");
  assert.equal(backend.saveCalls, 1);
});

test("the hourly reservation survives a new coordinator instance", async () => {
  let now = 0;
  const backend = backendFixture();
  const first = createDesktopAutomaticRefreshCadence({
    backend,
    clock: () => now,
    tokenFactory: () => TOKEN_A,
  });
  assert.equal(await first.automaticMode(), "quick");

  now = INTERVAL - 1;
  assert.equal(await first.automaticMode(), "quick");
  now = INTERVAL;
  assert.equal(await first.automaticMode(), "detailed");
  const reservation = await first.recordDetailedAttempt();
  assert.equal(reservation.token, TOKEN_A);
  assert.deepEqual(backend.stored, state(INTERVAL, TOKEN_A));

  const second = createDesktopAutomaticRefreshCadence({
    backend,
    clock: () => now,
    tokenFactory: () => TOKEN_B,
  });
  assert.equal(await second.automaticMode(), "quick");
  now = INTERVAL * 2;
  assert.equal(await second.automaticMode(), "detailed");
  const secondReservation = await second.recordDetailedAttempt();
  assert.equal(secondReservation.token, TOKEN_B);
  assert.deepEqual(backend.stored, state(INTERVAL * 2, TOKEN_B));
});

test("rollback cannot unlock a second attempt, and a future persisted time reseeds safely", async () => {
  let now = 0;
  const backend = backendFixture();
  const cadence = createDesktopAutomaticRefreshCadence({
    backend,
    clock: () => now,
    tokenFactory: () => TOKEN_A,
  });
  assert.equal(await cadence.automaticMode(), "quick");
  now = INTERVAL;
  assert.equal(await cadence.automaticMode(), "detailed");
  assert.ok(await cadence.recordDetailedAttempt());

  now = INTERVAL - 1;
  assert.equal(await cadence.automaticMode(), "quick");
  now = 0;
  assert.equal(await cadence.automaticMode(), "quick");
  assert.deepEqual(backend.stored, state(INTERVAL, TOKEN_A));

  const future = backendFixture({ stored: state(INTERVAL * 4, TOKEN_A) });
  now = 100;
  const restarted = createDesktopAutomaticRefreshCadence({
    backend: future,
    clock: () => now,
    tokenFactory: () => TOKEN_B,
  });
  assert.equal(await restarted.automaticMode(), "quick");
  assert.deepEqual(future.stored, state(now));
});

test("a confirmed quick join restores only the matching reservation", async () => {
  let now = 0;
  let token = TOKEN_A;
  const backend = backendFixture();
  const cadence = createDesktopAutomaticRefreshCadence({
    backend,
    clock: () => now,
    tokenFactory: () => token,
  });
  await cadence.automaticMode();
  now = INTERVAL;
  await cadence.automaticMode();
  const reservation = await cadence.recordDetailedAttempt();
  assert.equal(await cadence.restoreAfterQuickJoin(reservation, { mode: "detailed" }), false);
  assert.equal(await cadence.restoreAfterQuickJoin(reservation, { mode: "quick" }), true);
  assert.deepEqual(backend.stored, state(0));
  assert.equal(await cadence.restoreAfterQuickJoin(reservation, { mode: "quick" }), false);

  now = INTERVAL;
  token = TOKEN_B;
  await cadence.automaticMode();
  const newer = await cadence.recordDetailedAttempt();
  assert.equal(await cadence.restoreAfterQuickJoin(reservation, { mode: "quick" }), false);
  assert.equal(newer.previousAttemptAtMs, 0);

  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("hostile reservation");
    },
  });
  assert.equal(await cadence.restoreAfterQuickJoin(hostile, { mode: "quick" }), false);
});

test("invalid persisted state and invalid clocks remain quick and recover only with a valid clock", async () => {
  let now = Number.NaN;
  const malformed = backendFixture({
    stored: { schemaVersion: "wrong", lastAutomaticDetailedAtMs: "secret", reservationToken: null },
  });
  const cadence = createDesktopAutomaticRefreshCadence({
    backend: malformed,
    clock: () => now,
  });
  assert.equal(await cadence.automaticMode(), "quick");
  assert.equal(malformed.saveCalls, 0);

  now = 50;
  assert.equal(await cadence.automaticMode(), "quick");
  assert.deepEqual(malformed.stored, state(now));

  const unavailable = backendFixture({ loadError: new Error("backend") });
  const failed = createDesktopAutomaticRefreshCadence({
    backend: unavailable,
    clock: () => INTERVAL * 10,
  });
  assert.equal(await failed.automaticMode(), "quick");
  assert.equal(unavailable.saveCalls, 0);
});

test("concurrent operations serialize and a failed reservation cannot authorize detailed work", async () => {
  let now = INTERVAL;
  const backend = backendFixture({ stored: state(0) });
  const cadence = createDesktopAutomaticRefreshCadence({
    backend,
    clock: () => now,
    tokenFactory: () => TOKEN_A,
  });
  const [first, second] = await Promise.all([
    cadence.recordDetailedAttempt(),
    cadence.recordDetailedAttempt(),
  ]);
  assert.ok(first);
  assert.equal(second, null);
  assert.deepEqual(backend.stored, state(INTERVAL, TOKEN_A));

  const failing = backendFixture({ stored: state(0), saveError: new Error("write") });
  const blocked = createDesktopAutomaticRefreshCadence({
    backend: failing,
    clock: () => INTERVAL,
    tokenFactory: () => TOKEN_B,
  });
  assert.equal(await blocked.automaticMode(), "detailed");
  assert.equal(await blocked.recordDetailedAttempt(), null);
  assert.deepEqual(failing.stored, state(0));
});

test("the cadence codec is exact and the production backend uses the protected filename", async (t) => {
  const encoded = DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC.encode(state(1));
  assert.deepEqual(
    DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC.decodeBytes(encoded.bytes),
    encoded.value,
  );
  assert.throws(
    () => DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC.decodeValue({
      ...state(1),
      unexpected: true,
    }),
    TypeError,
  );
  assert.throws(
    () => DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC.decodeValue(state(null, TOKEN_A)),
    TypeError,
  );

  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "tibotattle-automatic-cadence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = createDesktopAutomaticRefreshCadenceBackend({
    platform: process.platform,
    rootPath: root,
  });
  const cadence = createDesktopAutomaticRefreshCadence({
    backend,
    clock: () => 12,
  });
  assert.equal(await cadence.automaticMode(), "quick");
  const path = join(root, DESKTOP_AUTOMATIC_REFRESH_CADENCE_FILE_NAME);
  const metadata = await lstat(path);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.match(await readFile(path, "utf8"), /automatic-refresh-cadence-v1/u);
  await chmod(root, 0o700);
});
