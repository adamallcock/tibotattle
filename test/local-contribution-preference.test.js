import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONTRIBUTION_PREFERENCE_SCHEMA_VERSION,
  createLocalContributionPreference,
} from "../src/application/index.js";
import { createOwnerOnlyAutomaticContributionStorageContext } from "../src/platform/index.js";

const START = "2026-09-04T12:00:00.000Z";
const DAY = 24 * 60 * 60 * 1_000;
const OPTIONS = {
  settingsFile: "/synthetic/preference.json",
  policyVersion: "electron-accountless-v1",
  destinationOrigin: "https://example.test",
  installationState: "fresh",
  defaultEnabled: true,
  now: () => new Date(START),
};

function memoryStorage(initial = null) {
  let text = initial;
  let writes = 0;
  return {
    readSettingsText: async () => text,
    writeSettingsText: async (value) => { writes += 1; text = value.text; },
    text: () => text,
    writes: () => writes,
  };
}

function createClock(initial = START) {
  let milliseconds = Date.parse(initial);
  return {
    now: () => new Date(milliseconds),
    set(value) { milliseconds = typeof value === "number" ? value : Date.parse(value); },
    advance(value) { milliseconds += value; },
    value: () => milliseconds,
  };
}

function create(storage, options = {}) {
  return createLocalContributionPreference({ ...OPTIONS, ...options }, { storage });
}

async function pendingController(storage, clock = createClock()) {
  const controller = create(storage, {
    installationState: "existing_unselected",
    now: clock.now,
  });
  await controller.initialize();
  return { controller, clock };
}

test("fresh installations honor the composition default without entering notices", async () => {
  const storage = memoryStorage();
  const result = await create(storage).initialize();
  assert.equal(result.enabled, true);
  assert.equal(result.basis, "default_on");
  assert.equal(result.state, "enabled");
  assert.equal(result.noticeCount, 0);
  assert.equal(Object.hasOwn(JSON.parse(storage.text()), "consentedAt"), false);
  assert.equal(JSON.parse(storage.text()).schemaVersion, CONTRIBUTION_PREFERENCE_SCHEMA_VERSION);
  const legacyHintOff = await create(memoryStorage(), { defaultEnabled: false }).initialize();
  assert.equal(legacyHintOff.enabled, false);
  assert.equal(legacyHintOff.basis, "default_off");
});

test("only a positively classified existing-unselected installation enters the notice transition", async () => {
  const pending = await create(memoryStorage(), { installationState: "existing_unselected" }).initialize();
  assert.equal(pending.enabled, false);
  assert.equal(pending.state, "pending_notices");
  assert.equal(pending.basis, "default_off");
  assert.equal(pending.noticeCount, 0);
  assert.equal(pending.nextNoticeIndex, 1);
  assert.equal(pending.noticeDue, true);
  for (const installationState of ["existing_opted_out", "existing", "unknown"]) {
    const result = await create(memoryStorage(), { installationState }).initialize();
    assert.equal(result.enabled, false);
    assert.equal(result.state, "legacy_preserved");
    assert.equal(result.nextNoticeIndex, null);
  }
});

test("notice receipts require visibility order, day cadence, and trusted controller time", async () => {
  const storage = memoryStorage();
  const { controller, clock } = await pendingController(storage);
  await assert.rejects(controller.markNoticePresented(2), { code: "contribution_preference_notice_out_of_order" });
  assert.equal((await controller.inspect()).noticeCount, 0);

  const first = await controller.markNoticePresented(1, { presentedAt: "2099-01-01T00:00:00.000Z" });
  assert.equal(first.noticeCount, 1);
  assert.equal(first.nextNoticeIndex, 2);
  assert.equal(first.noticeDue, false);
  assert.equal(first.nextNoticeAt, "2026-09-07T12:00:00.000Z");

  clock.advance(2 * DAY);
  await assert.rejects(controller.markNoticePresented(2), { code: "contribution_preference_notice_not_due" });
  clock.advance(DAY);
  const second = await controller.markNoticePresented(2);
  assert.equal(second.noticeCount, 2);
  clock.advance(23 * 60 * 60 * 1_000);
  await assert.rejects(controller.markNoticePresented(3), { code: "contribution_preference_notice_not_due" });
  clock.advance(60 * 60 * 1_000);
  clock.advance(2 * DAY);
  const third = await controller.markNoticePresented(3);
  assert.equal(third.noticeCount, 3);
  assert.equal(third.nextNoticeIndex, null);
  assert.equal(third.activatesAt, "2026-09-11T12:00:00.000Z");
  assert.equal((await controller.evaluateAutomatic()).enabled, false);

  clock.advance(DAY);
  const activated = await controller.evaluateAutomatic();
  assert.equal(activated.enabled, true);
  assert.equal(activated.state, "enabled");
  assert.equal(activated.basis, "migration_default_on");

  const impossibleTimeline = JSON.parse(storage.text());
  impossibleTimeline.updatedAt = "2026-09-10T12:00:00.000Z";
  assert.equal(
    (await create(memoryStorage(JSON.stringify(impossibleTimeline)), { now: clock.now }).initialize()).available,
    false,
  );
});

test("a choice is durable, idempotent, and cancels all pending reminders while retaining receipts", async () => {
  const storage = memoryStorage();
  const { controller, clock } = await pendingController(storage);
  await controller.markNoticePresented(1);
  const writesBeforeChoice = storage.writes();
  const off = await controller.setEnabled(false);
  assert.equal(off.enabled, false);
  assert.equal(off.state, "disabled");
  assert.equal(off.basis, "user_choice");
  assert.equal(off.noticeCount, 1);
  assert.equal(off.nextNoticeIndex, null);
  const writesAfterChoice = storage.writes();
  assert.equal((await controller.setEnabled(false)).updatedAt, off.updatedAt);
  assert.equal(storage.writes(), writesAfterChoice);

  clock.advance(10 * DAY);
  assert.equal((await controller.evaluateAutomatic()).enabled, false);
  const restarted = await create(storage, { installationState: "existing_unselected", now: clock.now }).initialize();
  assert.equal(restarted.enabled, false);
  assert.equal(restarted.state, "disabled");
  assert.equal(restarted.nextNoticeIndex, null);
  assert.equal(restarted.noticeCount, 1);
  assert.ok(writesAfterChoice > writesBeforeChoice);
});

test("share now is an immediate explicit choice and setEnabled remains compatible", async () => {
  const storage = memoryStorage();
  const { controller } = await pendingController(storage);
  const shared = await controller.setEnabled(true);
  assert.equal(shared.enabled, true);
  assert.equal(shared.basis, "user_choice");
  assert.equal(shared.state, "enabled");
  assert.equal(shared.nextNoticeIndex, null);
  assert.equal((await controller.setEnabled(true)).updatedAt, shared.updatedAt);

  const freshStorage = memoryStorage();
  const fresh = create(freshStorage);
  const off = await fresh.setEnabled(false);
  assert.equal(off.enabled, false);
  assert.equal(off.basis, "user_choice");
  assert.equal(JSON.parse(freshStorage.text()).enabled, false);
  assert.equal((await create(freshStorage, { installationState: "existing_unselected" }).initialize()).basis, "user_choice");
});

test("explicit opt-out survives V1 migration, restart, policy replacement, and a fresh-install hint", async () => {
  const legacy = JSON.stringify({
    basis: "user_choice",
    destinationOrigin: "https://example.test",
    enabled: false,
    policyVersion: "electron-accountless-v1",
    schemaVersion: "local-contribution-preference-v1",
    updatedAt: START,
  });
  const storage = memoryStorage(legacy);
  const migrated = await create(storage, { installationState: "fresh" }).initialize();
  assert.equal(migrated.enabled, false);
  assert.equal(migrated.basis, "user_choice");
  assert.equal(migrated.state, "disabled");
  assert.equal(JSON.parse(storage.text()).schemaVersion, CONTRIBUTION_PREFERENCE_SCHEMA_VERSION);

  const next = create(storage, { policyVersion: "electron-accountless-v2", installationState: "existing_unselected" });
  const replaced = await next.initialize();
  assert.equal(replaced.enabled, false);
  assert.equal(replaced.current, false);
  assert.equal(replaced.state, "disabled");
  assert.equal(replaced.nextNoticeIndex, null);
});

test("policy, destination, and schedule drift prevent pending activation without erasing state", async () => {
  const storage = memoryStorage();
  const clock = createClock();
  const { controller } = await pendingController(storage, clock);
  await controller.markNoticePresented(1);
  clock.advance(6 * DAY);
  await controller.markNoticePresented(2);
  clock.advance(3 * DAY);
  await controller.markNoticePresented(3);
  const policyChanged = create(storage, { policyVersion: "electron-accountless-v2", now: clock.now });
  const policySnapshot = await policyChanged.initialize();
  assert.equal(policySnapshot.current, false);
  assert.equal(policySnapshot.enabled, false);
  assert.equal(policySnapshot.nextNoticeIndex, null);
  assert.equal((await policyChanged.evaluateAutomatic()).enabled, false);

  const scheduleChanged = create(storage, {
    now: clock.now,
    noticeSchedule: { version: "accountless-default-on-v2" },
  });
  const scheduleSnapshot = await scheduleChanged.initialize();
  assert.equal(scheduleSnapshot.current, true);
  assert.equal(scheduleSnapshot.scheduleCurrent, false);
  assert.equal(scheduleSnapshot.nextNoticeIndex, null);
  assert.equal((await scheduleChanged.evaluateAutomatic()).enabled, false);
});

test("invalid, future, and unreadable state stays unchanged and unavailable", async () => {
  const original = memoryStorage();
  await create(original).initialize();
  const good = JSON.parse(original.text());
  const future = { ...good, updatedAt: "2026-09-05T12:00:00.000Z" };
  for (const text of [
    "{broken",
    JSON.stringify(future),
    JSON.stringify({ ...good, schemaVersion: "future" }),
    JSON.stringify({ ...good, privateContent: "not allowed" }),
    JSON.stringify({ ...good, enabled: false }),
    "x".repeat(4_097),
  ]) {
    const storage = memoryStorage(text);
    const controller = create(storage);
    assert.equal((await controller.initialize()).available, false);
    await assert.rejects(controller.setEnabled(true), { code: "contribution_preference_unavailable" });
    assert.equal(storage.text(), text);
  }
  const unreadable = create({
    readSettingsText: async () => { throw new Error("locked"); },
    writeSettingsText: async () => assert.fail("must not overwrite"),
  });
  assert.equal((await unreadable.initialize()).available, false);
});

test("clock regression poisons the controller and never reopens pending state", async () => {
  const clock = createClock();
  const storage = memoryStorage();
  const { controller } = await pendingController(storage, clock);
  await controller.markNoticePresented(1);
  clock.advance(-1);
  assert.equal((await controller.inspect()).available, false);
  await assert.rejects(controller.markNoticePresented(2), { code: "contribution_preference_unavailable" });
  assert.equal((await create(storage, { installationState: "existing_unselected", now: clock.now }).initialize()).available, false);
});

test("concurrent notice receipts and choices serialize without duplicate transitions", async () => {
  const storage = memoryStorage();
  const { controller } = await pendingController(storage);
  const writesBefore = storage.writes();
  const [first, duplicate] = await Promise.all([
    controller.markNoticePresented(1),
    controller.markNoticePresented(1),
  ]);
  assert.equal(first.noticeCount, 1);
  assert.equal(duplicate.noticeCount, 1);
  assert.equal(storage.writes(), writesBefore + 1);
  const [shared, off] = await Promise.all([
    controller.setEnabled(true),
    controller.setEnabled(false),
  ]);
  assert.equal(shared.enabled, true);
  assert.equal(off.enabled, false);
  assert.equal((await controller.inspect()).enabled, false);
  assert.equal((await create(storage).initialize()).enabled, false);
});

test("a failed write never grants authority and poisons further mutations", async () => {
  const storage = memoryStorage();
  const controller = create(storage);
  await controller.initialize();
  storage.writeSettingsText = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(controller.setEnabled(false), { code: "contribution_preference_unavailable" });
  assert.equal((await controller.inspect()).enabled, false);
  await assert.rejects(controller.setEnabled(true), { code: "contribution_preference_unavailable" });
});

test("owner-only settings adapter preserves opt-out across a real restart and refuses corrupt state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-preference-"));
  const settingsFile = join(directory, "preference.json");
  const storage = createOwnerOnlyAutomaticContributionStorageContext({
    createError: (code) => Object.assign(new Error("storage unavailable"), { code }),
  });
  try {
    await create(storage, { settingsFile }).setEnabled(false);
    assert.equal((await create(storage, { settingsFile }).initialize()).enabled, false);
    const text = await readFile(settingsFile, "utf8");
    await writeFile(settingsFile, "corrupt", { mode: 0o600 });
    assert.equal((await create(storage, { settingsFile }).initialize()).available, false);
    assert.equal(await readFile(settingsFile, "utf8"), "corrupt");
    assert.equal(JSON.parse(text).basis, "user_choice");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
