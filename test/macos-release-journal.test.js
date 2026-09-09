import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { artifactDigest, runJournaledMacOSRelease } from "../scripts/macos-release-journal.js";
import { readOperation } from "../scripts/lib/release-operation.mjs";
import { submitAppleNotaryWithId, waitForAppleNotary } from "../scripts/macos-release-core.js";

const PHASES = ["build", "sign-app", "archive", "staple-app", "package", "sign-dmg", "staple-dmg"];
const interrupted = () => Object.assign(new Error("synthetic interruption"), { code: "SYNTHETIC_INTERRUPTION" });

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-release-journal-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "TiboTattle-1.2.3-macOS-arm64.dmg");
  const directory = `${output}.operation`;
  const manifestPath = `${output}.release.json`;
  const binding = { source: "synthetic-reviewed-source", channel: "stable", architecture: "arm64" };
  const calls = [];
  const materialize = async (phase, from, attempt) => {
    calls.push(phase);
    const path = join(attempt, "artifact");
    await writeFile(path, `${from ? await readFile(from, "utf8") : "synthetic fixture"}\n${phase}`, { mode: 0o600 });
    return path;
  };
  const actions = {
    build: (attempt) => materialize("build", null, attempt),
    signApp: (from, attempt) => materialize("sign-app", from, attempt),
    archive: (from, attempt) => materialize("archive", from, attempt),
    stapleApp: (from, attempt) => materialize("staple-app", from, attempt),
    package: (from, attempt) => materialize("package", from, attempt),
    signDMG: (from, attempt) => materialize("sign-dmg", from, attempt),
    stapleDMG: (from, attempt) => materialize("staple-dmg", from, attempt),
    async submit() { calls.push("submit"); return { id: randomUUID() }; },
    async wait() { calls.push("wait"); return { status: "Accepted" }; },
    async validateApp() { calls.push("validate-app"); },
    async validateDMG() { calls.push("validate-dmg"); },
    async manifest(_built, dmg) {
      calls.push("manifest");
      return { channel: { name: "stable" }, artifact: { sha256: createHash("sha256").update(await readFile(dmg)).digest("hex") } };
    },
  };
  return { root, output, directory, manifestPath, binding, calls, actions,
    run: (options = {}) => runJournaledMacOSRelease({ directory, binding, output, manifestPath, actions, ...options }) };
}

async function mutateJournal(f, mutate) {
  const record = await readOperation(f.directory);
  mutate(record);
  await writeFile(join(f.directory, "operation.json"), JSON.stringify(record), { mode: 0o600 });
}

for (const phase of PHASES) {
  test(`native resume reuses completed ${phase} and never resubmits completed notary work`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.run({ progress(event) {
      if (event.phase === phase && event.state === "passed") throw interrupted();
    } }), { code: "SYNTHETIC_INTERRUPTION" });
    assert.equal((await f.run({ resume: true })).channel, "stable");
    for (const name of PHASES) assert.equal(f.calls.filter((call) => call === name).length, 1, name);
    assert.equal(f.calls.filter((call) => call === "submit").length, 2);
    assert.equal((await readOperation(f.directory)).state.install.status, "complete");
    for (const path of [f.output, f.manifestPath]) assert.equal((await lstat(path)).mode & 0o777, 0o444);
    const priorAppChecks = f.calls.filter((call) => call === "validate-app").length;
    const priorDMGChecks = f.calls.filter((call) => call === "validate-dmg").length;
    await f.run({ resume: true });
    assert.equal(f.calls.filter((call) => call === "submit").length, 2);
    assert.equal(f.calls.filter((call) => call === "validate-app").length, priorAppChecks + 1);
    assert.equal(f.calls.filter((call) => call === "validate-dmg").length, priorDMGChecks + 1);
  });
}

test("native uncertain submission refuses resubmission", async (t) => {
  const f = await fixture(t);
  f.actions.submit = async () => { f.calls.push("submit"); throw interrupted(); };
  await assert.rejects(f.run(), { code: "SYNTHETIC_INTERRUPTION" });
  const record = (await readOperation(f.directory)).state.notary.app;
  assert.equal(record.status, "submitting");
  assert.equal(record.id, null);
  await assert.rejects(f.run({ resume: true }), { code: "MACOS_NOTARY_SUBMISSION_UNCERTAIN" });
  assert.equal(f.calls.filter((call) => call === "submit").length, 1);
});

test("native known submission is polled after interruption without resubmitting", async (t) => {
  const f = await fixture(t);
  f.actions.wait = async () => { throw interrupted(); };
  await assert.rejects(f.run(), { code: "SYNTHETIC_INTERRUPTION" });
  const id = (await readOperation(f.directory)).state.notary.app.id;
  const seen = [];
  f.actions.wait = async (selected) => { seen.push(selected); return { status: "Accepted" }; };
  await f.run({ resume: true });
  assert.equal(seen[0], id);
  assert.equal(f.calls.filter((call) => call === "submit").length, 2);
});

test("native rejected status never creates another submission", async (t) => {
  const f = await fixture(t);
  f.actions.wait = async () => ({ status: "Invalid" });
  await assert.rejects(f.run(), { code: "MACOS_NOTARIZATION_REJECTED" });
  await assert.rejects(f.run({ resume: true }), { code: "MACOS_NOTARIZATION_REJECTED" });
  assert.equal(f.calls.filter((call) => call === "submit").length, 1);
});

test("native retries an uncheckpointed local phase without adopting its partial output", async (t) => {
  const f = await fixture(t);
  const build = f.actions.build;
  let abandoned;
  f.actions.build = async (root) => { abandoned = await build(root); throw interrupted(); };
  await assert.rejects(f.run(), { code: "SYNTHETIC_INTERRUPTION" });
  assert.deepEqual((await readOperation(f.directory)).state.phases, {});
  f.actions.build = build;
  await f.run({ resume: true });
  const record = await readOperation(f.directory);
  assert.notEqual(join(f.directory, record.state.phases.build.path), abandoned);
  assert.equal(f.calls.filter((call) => call === "build").length, 2);
  assert.equal(f.calls.filter((call) => call === "submit").length, 2);
});

test("native malformed submission result preserves uncertain state and does not retry", async (t) => {
  const f = await fixture(t);
  f.actions.submit = async () => { f.calls.push("submit"); return { id: "not-a-submission-id" }; };
  await assert.rejects(f.run(), { code: "MACOS_NOTARY_SUBMISSION_UNCERTAIN" });
  await assert.rejects(f.run({ resume: true }), { code: "MACOS_NOTARY_SUBMISSION_UNCERTAIN" });
  assert.equal(f.calls.filter((call) => call === "submit").length, 1);
});

test("native rejects missing predecessor and malformed known ID before remote work", async (t) => {
  const f = await fixture(t);
  await f.run();
  const original = await readOperation(f.directory);
  await mutateJournal(f, (record) => { delete record.state.phases.build; });
  f.calls.length = 0;
  await assert.rejects(f.run({ resume: true }), { code: "RELEASE_PHASE_STATE_INVALID" });
  assert.deepEqual(f.calls, []);
  await writeFile(join(f.directory, "operation.json"), JSON.stringify(original));
  await mutateJournal(f, (record) => { record.state.notary.app.id = "invalid"; });
  await assert.rejects(f.run({ resume: true }), { code: "RELEASE_NOTARY_STATE_INVALID" });
  assert.deepEqual(f.calls, []);
});

test("notary adapters retain IDs only on success and suppress raw command failure details", () => {
  const id = "12345678-1234-1234-1234-123456789012";
  const calls = [];
  const commandRunner = (_command, args) => { calls.push(args); return { stdout: JSON.stringify({ id, status: "Accepted" }) }; };
  assert.deepEqual(submitAppleNotaryWithId("/synthetic/archive.zip", { notaryProfile: "synthetic-profile", commandRunner }), { id });
  assert.equal(calls[0].includes("--wait"), false);
  assert.deepEqual(waitForAppleNotary(id, { notaryProfile: "synthetic-profile", commandRunner }), { status: "Accepted" });
  assert.deepEqual(calls[1].slice(0, 3), ["notarytool", "wait", id]);
  for (const invoke of [
    (runner) => submitAppleNotaryWithId("/synthetic/archive.zip", { notaryProfile: "synthetic-profile", commandRunner: runner }),
    (runner) => waitForAppleNotary(id, { notaryProfile: "synthetic-profile", commandRunner: runner }),
  ]) {
    assert.throws(() => invoke(() => { throw new Error("synthetic-private-path synthetic-profile synthetic-submission-id"); }), (error) => {
      assert.equal(error.message.includes("synthetic-"), false);
      assert.match(error.code, /^MACOS_NOTARY_(?:SUBMISSION_UNCERTAIN|STATUS_UNKNOWN)$/u);
      return true;
    });
  }
});

for (const key of ["phases", "notary", "install"]) {
  test(`native rejects corrupted ${key} arrays before further actions`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.run({ progress() { throw interrupted(); } }), { code: "SYNTHETIC_INTERRUPTION" });
    await mutateJournal(f, (record) => { record.state[key] = []; });
    f.calls.length = 0;
    await assert.rejects(f.run({ resume: true }), { code: "RELEASE_PHASE_STATE_INVALID" });
    assert.deepEqual(f.calls, []);
  });
}

test("native refuses changed inputs, tampered artifacts and noncanonical output locks", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ progress(event) { if (event.state === "passed") throw interrupted(); } }), { code: "SYNTHETIC_INTERRUPTION" });
  await assert.rejects(f.run({ resume: true, binding: { ...f.binding, architecture: "x64" } }), { code: "RELEASE_OPERATION_INPUT_MISMATCH" });
  const record = await readOperation(f.directory);
  await writeFile(join(f.directory, record.state.phases.build.path), "tampered");
  await assert.rejects(f.run({ resume: true }), { code: "RELEASE_PHASE_OUTPUT_CHANGED" });
  await assert.rejects(f.run({ directory: join(f.root, "different-lock") }), { code: "RELEASE_OPERATION_OUTPUT_LOCK_REQUIRED" });
  assert.equal(f.calls.filter((call) => call === "submit").length, 0);
});

test("native refuses a phase parent replaced by a symlink", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ progress(event) { if (event.state === "passed") throw interrupted(); } }), { code: "SYNTHETIC_INTERRUPTION" });
  const record = await readOperation(f.directory);
  const parent = dirname(join(f.directory, record.state.phases.build.path));
  const moved = join(f.root, "moved-stage");
  await rename(parent, moved);
  await symlink(moved, parent);
  await assert.rejects(f.run({ resume: true }), { code: "RELEASE_ARTIFACT_PARENT_UNSAFE" });
});

test("native resumes final DMG installed before manifest installation", async (t) => {
  const f = await fixture(t);
  const manifest = f.actions.manifest;
  f.actions.manifest = async (...args) => { await mkdir(f.manifestPath); return manifest(...args); };
  await assert.rejects(f.run(), { code: "RELEASE_FINAL_FILE_UNSAFE" });
  const before = await readFile(f.output);
  assert.equal((await readOperation(f.directory)).state.install.status, "installing");
  await rm(f.manifestPath, { recursive: true });
  f.actions.manifest = manifest;
  await f.run({ resume: true });
  assert.deepEqual(await readFile(f.output), before);
  assert.equal(f.calls.filter((call) => call === "submit").length, 2);
});

for (const linked of [false, true]) {
  test(`native recovers ${linked ? "linked" : "readonly prepared"} final temporary`, async (t) => {
    const f = await fixture(t);
    await f.run();
    const record = await readOperation(f.directory);
    const temporary = `${f.output}.install-${record.id}`;
    await rename(f.output, temporary);
    if (linked) await link(temporary, f.output);
    await unlink(f.manifestPath);
    await mutateJournal(f, (current) => { current.state.install.status = "installing"; });
    await f.run({ resume: true });
    assert.equal((await lstat(f.output)).nlink, 1);
    assert.equal((await lstat(f.output)).mode & 0o777, 0o444);
    await assert.rejects(lstat(temporary), { code: "ENOENT" });
    assert.equal(f.calls.filter((call) => call === "submit").length, 2);
    for (const phase of PHASES) assert.equal(f.calls.filter((call) => call === phase).length, 1);
  });
}

test("native preserves an interrupted partial final copy and resumes without new submissions", async (t) => {
  const f = await fixture(t);
  await f.run();
  const record = await readOperation(f.directory);
  const temporary = `${f.output}.install-${record.id}`;
  await unlink(f.output);
  await unlink(f.manifestPath);
  await writeFile(temporary, "partial-copy", { mode: 0o600 });
  await mutateJournal(f, (current) => { current.state.install.status = "installing"; });
  await f.run({ resume: true });
  const abandoned = (await readdir(f.root)).filter((name) => name.includes(".incomplete-"));
  assert.equal(abandoned.length, 1);
  assert.equal(await readFile(join(f.root, abandoned[0]), "utf8"), "partial-copy");
  assert.equal(f.calls.filter((call) => call === "submit").length, 2);
  assert.equal((await lstat(f.output)).mode & 0o777, 0o444);
});

test("native refuses foreign final output and conflicting resumed bytes", async (t) => {
  const f = await fixture(t);
  await writeFile(f.output, "foreign");
  await assert.rejects(f.run(), { code: "RELEASE_FINAL_FILE_EXISTS" });
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(f.output, "utf8"), "foreign");
  await unlink(f.output);
  await f.run({ resume: true });
  await chmod(f.output, 0o644);
  await writeFile(f.output, "changed final artifact");
  await assert.rejects(f.run({ resume: true }), { code: "RELEASE_FINAL_FILE_CONFLICT" });
  assert.equal(await readFile(f.output, "utf8"), "changed final artifact");
});

test("artifact digest supports internal links, rejects escape links and hardlinks", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-release-digest-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  await writeFile(join(bundle, "binary"), "synthetic binary");
  await symlink("binary", join(bundle, "alias"));
  const digest = await artifactDigest(bundle, { durable: true });
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(await artifactDigest(bundle), digest);
  await writeFile(join(root, "foreign"), "outside");
  await symlink("../foreign", join(bundle, "escape"));
  await assert.rejects(artifactDigest(bundle), { code: "RELEASE_ARTIFACT_LINK_UNSAFE" });
  await unlink(join(bundle, "escape"));
  await link(join(bundle, "binary"), join(root, "hardlink"));
  await assert.rejects(artifactDigest(bundle), { code: "RELEASE_ARTIFACT_TYPE_UNSAFE" });
});
