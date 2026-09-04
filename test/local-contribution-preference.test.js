import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalContributionPreference } from "../src/application/index.js";
import { createOwnerOnlyAutomaticContributionStorageContext } from "../src/platform/index.js";

const OPTIONS = { settingsFile: "/synthetic/preference.json", policyVersion: "electron-accountless-v1",
  destinationOrigin: "https://example.test", installationState: "fresh", defaultEnabled: true,
  now: () => new Date("2026-09-04T12:00:00.000Z") };
function memoryStorage(initial = null) {
  let text = initial;
  return { readSettingsText: async () => text,
    writeSettingsText: async (value) => { text = value.text; }, text: () => text };
}
function create(storage, options = {}) {
  return createLocalContributionPreference({ ...OPTIONS, ...options }, { storage });
}

test("fresh explicitly configured policy records a default without inventing consent", async () => {
  const storage = memoryStorage();
  const result = await create(storage).initialize();
  assert.equal(result.enabled, true);
  assert.equal(result.basis, "default_on");
  assert.equal(Object.hasOwn(JSON.parse(storage.text()), "consentedAt"), false);
});

test("missing settings do not prove installation freshness", async () => {
  for (const installationState of ["existing", "unknown"]) {
    assert.equal((await create(memoryStorage(), { installationState }).initialize()).enabled, false);
  }
  assert.equal((await create(memoryStorage(), { defaultEnabled: false }).initialize()).enabled, false);
});

test("opt-out survives restart, policy replacement and a fresh-install hint", async () => {
  const storage = memoryStorage();
  await create(storage).setEnabled(false);
  assert.equal((await create(storage).initialize()).enabled, false);
  const next = create(storage, { policyVersion: "electron-accountless-v2" });
  assert.equal((await next.initialize()).enabled, false);
  assert.equal((await next.inspect()).current, false);
  assert.equal((await next.setEnabled(true)).basis, "user_choice");
});

test("opting out as the first operation never writes a transient enabled default", async () => {
  const storage = memoryStorage();
  const written = [];
  const write = storage.writeSettingsText;
  storage.writeSettingsText = async (value) => {
    written.push(JSON.parse(value.text));
    await write(value);
  };
  await create(storage).setEnabled(false);
  assert.ok(written.length > 0);
  assert.ok(written.every((record) => record.enabled === false && record.basis === "user_choice"));
});

test("a destination or policy change requires a new explicit selection", async () => {
  const storage = memoryStorage();
  await create(storage).initialize();
  for (const options of [{ destinationOrigin: "https://elsewhere.test" }, { policyVersion: "v2" }]) {
    const next = await create(storage, options).initialize();
    assert.equal(next.enabled, false);
    assert.equal(next.current, false);
    assert.equal(next.basis, "default_on");
  }
});

test("unknown schema, content fields, malformed and unreadable state never get overwritten", async () => {
  const original = memoryStorage();
  await create(original).initialize();
  const good = JSON.parse(original.text());
  for (const text of ["{broken", JSON.stringify({ ...good, schemaVersion: "future" }),
    JSON.stringify({ ...good, privateContent: "not allowed" }),
    JSON.stringify({ ...good, enabled: false }), "x".repeat(4097)]) {
    const storage = memoryStorage(text);
    const controller = create(storage);
    assert.equal((await controller.initialize()).available, false);
    await assert.rejects(controller.setEnabled(true), { code: "contribution_preference_unavailable" });
    assert.equal(storage.text(), text);
  }
  const controller = create({ readSettingsText: async () => { throw new Error("locked"); },
    writeSettingsText: async () => assert.fail("must not overwrite") });
  assert.equal((await controller.initialize()).enabled, false);
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

test("concurrent user selections persist in order", async () => {
  const storage = memoryStorage();
  const controller = create(storage);
  await Promise.all([controller.setEnabled(true), controller.setEnabled(false)]);
  assert.equal((await controller.inspect()).enabled, false);
  assert.equal((await create(storage).initialize()).enabled, false);
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
