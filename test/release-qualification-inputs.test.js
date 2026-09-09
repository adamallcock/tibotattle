import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { computeQualificationInputs, QUALIFICATION_TEST_FILES } from "../scripts/lib/release-qualification-inputs.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qualification-inputs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["src", "packages", "contracts", "schemas", "generated", "config"]) await mkdir(join(root, directory));
  const files = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "scripts/qualify-release.mjs", "scripts/lib/release-qualification-cache.mjs",
    "scripts/lib/release-qualification-inputs.mjs", "scripts/lib/release-operation.mjs",
    "scripts/lib/esm-imports.mjs", "scripts/r7-materialized-boundary-worker.js",
    "scripts/r7-resource-benchmark-worker.js", ...QUALIFICATION_TEST_FILES];
  for (const path of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path.endsWith(".json") ? "{}" : "");
  }
  await writeFile(join(root, "src/main.js"), "export const value = 1;\n");
  await writeFile(join(root, "schemas/value.json"), "{}");
  const profilePath = join(root, "config/release-admission-profile.json");
  const profile = { schema: 1, profile: "release-synthetic-admission-inputs-v1", reviewedExecutableDigest: "0".repeat(64) };
  await writeFile(profilePath, JSON.stringify(profile));
  const inspect = (options = {}) => computeQualificationInputs({ repositoryRoot: root, ...options });
  const review = async () => {
    await writeFile(profilePath, JSON.stringify({ ...profile, reviewedExecutableDigest: (await inspect()).executableDigest }));
  };
  await review();
  return { root, inspect, review };
}

test("admission fingerprint is deterministic, content-free and independent of hosted/docs edits", async (t) => {
  const { root, inspect } = await fixture(t);
  const environment = { LANG: "C", TZ: "UTC" };
  const first = await inspect({ environment });
  assert.equal(first.reusable, true);
  assert.equal(first.unknownDependencyCount, 0);
  assert.match(first.digest, /^[a-f0-9]{64}$/u);
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "apps/worker"), { recursive: true });
  await writeFile(join(root, "docs/private.md"), "PRIVATE-CANARY-docs");
  await writeFile(join(root, "apps/worker/private.js"), "PRIVATE-CANARY-hosted");
  assert.deepEqual(await inspect({ environment }), first);
  const output = JSON.stringify(first);
  assert.equal(output.includes(root), false);
  assert.equal(output.includes("PRIVATE-CANARY"), false);
  assert.notEqual((await inspect({ environment: { ...environment, TZ: "Pacific/Auckland" } })).digest, first.digest);
});

test("source, new file, schema, selected test and validator changes each invalidate admission", async (t) => {
  const { root, inspect } = await fixture(t);
  for (const name of ["src/main.js", "schemas/value.json", QUALIFICATION_TEST_FILES[0],
    "scripts/lib/release-qualification-cache.mjs", "scripts/qualify-release.mjs",
    "scripts/r7-resource-benchmark-worker.js", "src/local-unified-index-worker.js"]) {
    const before = await inspect();
    await appendFile(join(root, name), name.endsWith(".json") ? " " : "// changed\n");
    assert.notEqual((await inspect()).digest, before.digest, name);
  }
});

test("unreviewed filesystem and subprocess behavior cannot mint reusable proof without any ESM edge", async (t) => {
  const { root, inspect, review } = await fixture(t);
  for (const source of [
    "process.getBuiltinModule('fs').readFileSync('/unkeyed-input');",
    "process.getBuiltinModule('child_process').execSync('unreviewed-command');",
  ]) {
    await writeFile(join(root, "src/main.js"), source);
    const unreviewed = await inspect();
    assert.equal(unreviewed.unknownDependencyCount, 0);
    assert.equal(unreviewed.executableReviewed, false);
    assert.equal(unreviewed.reusable, false);
    await review();
    const reviewed = await inspect();
    assert.equal(reviewed.executableReviewed, true);
    assert.equal(reviewed.reusable, true);
    assert.equal(reviewed.executableDigest, unreviewed.executableDigest);
    assert.notEqual(reviewed.digest, unreviewed.digest, "review manifest itself remains in the ordinary cache key");
  }
});

test("schema and data changes require fresh tests but do not invalidate executable review", async (t) => {
  const { root, inspect } = await fixture(t);
  const before = await inspect();
  await writeFile(join(root, "schemas/value.json"), '{"changed":true}');
  await writeFile(join(root, "generated/synthetic-data.json"), '{"value":2}');
  const after = await inspect();
  assert.notEqual(after.digest, before.digest);
  assert.equal(after.executableDigest, before.executableDigest);
  assert.equal(after.executableReviewed, true);
  assert.equal(after.reusable, true);
});

test("review manifest rejects malformed, extra and mismatched profile fields", async (t) => {
  const { root, inspect } = await fixture(t);
  for (const manifest of [[], { schema: 1 }, { schema: 1, profile: "wrong", reviewedExecutableDigest: "0".repeat(64) },
    { schema: 1, profile: "release-synthetic-admission-inputs-v1", reviewedExecutableDigest: "0".repeat(64), approved: true }]) {
    await writeFile(join(root, "config/release-admission-profile.json"), JSON.stringify(manifest));
    await assert.rejects(inspect(), { code: "QUALIFICATION_REVIEW_INVALID" });
  }
});

test("installed package bytes and transitive package bytes invalidate despite unchanged lockfiles", async (t) => {
  const { root, inspect, review } = await fixture(t);
  for (const [name, dependencies] of [["fixture-one", { "fixture-two": "1.0.0" }], ["fixture-two", {}]]) {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", dependencies }));
    await writeFile(join(directory, "index.js"), "module.exports = 1;\n");
  }
  await writeFile(join(root, "src/main.js"), "import value from 'fixture-one';\nexport {value};\n");
  await review();
  const first = await inspect();
  assert.equal(first.reusable, true);
  assert.equal(first.dependencyCount, 2);
  for (const name of ["fixture-one", "fixture-two"]) {
    const before = await inspect();
    await appendFile(join(root, "node_modules", name, "index.js"), "// installed mutation\n");
    assert.notEqual((await inspect()).digest, before.digest);
  }
});

test("package-manager root links resolve canonically and their changed target bytes invalidate", async (t) => {
  const { root, inspect, review } = await fixture(t);
  const target = join(root, "node_modules/.store/fixture-linked");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), JSON.stringify({ name: "fixture-linked", version: "1.0.0" }));
  await writeFile(join(target, "index.js"), "module.exports = 1;\n");
  await symlink(target, join(root, "node_modules/fixture-linked"));
  await writeFile(join(root, "src/main.js"), "import value from 'fixture-linked';\n");
  await review();
  const first = await inspect();
  assert.equal(first.reusable, true);
  await appendFile(join(target, "index.js"), "// changed\n");
  assert.notEqual((await inspect()).digest, first.digest);
});

test("unknown imports and out-of-profile source cannot produce reusable proof", async (t) => {
  const { root, inspect } = await fixture(t);
  for (const source of ["import('fixture-' + process.platform);", "import value from 'fixture-missing';",
    "import '../apps/worker/handler.js';"]) {
    await writeFile(join(root, "src/main.js"), source);
    const result = await inspect();
    assert.equal(result.reusable, false);
    assert.ok(result.unknownDependencyCount > 0);
  }
});

test("environment is closed and rejected diagnostics never echo supplied values", async (t) => {
  const { inspect } = await fixture(t);
  await assert.rejects(inspect({ environment: { NODE_OPTIONS: "PRIVATE-CANARY-secret" } }), (error) =>
    error.code === "QUALIFICATION_ENVIRONMENT_INVALID" && !error.message.includes("PRIVATE-CANARY"));
  await assert.rejects(inspect({ environment: { TZ: { nested: true } } }), { code: "QUALIFICATION_ENVIRONMENT_INVALID" });
});

test("adding a newly declared missing peer dependency prevents reusable proof", async (t) => {
  const { root, inspect, review } = await fixture(t);
  const directory = join(root, "node_modules/fixture-peer-user");
  await mkdir(directory, { recursive: true });
  const manifest = { name: "fixture-peer-user", version: "1.0.0" };
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(join(root, "src/main.js"), "import value from 'fixture-peer-user';\n");
  await review();
  const before = await inspect();
  assert.equal(before.reusable, true);
  await writeFile(join(directory, "package.json"), JSON.stringify({ ...manifest, peerDependencies: { "fixture-missing-peer": "1" } }));
  const after = await inspect();
  assert.equal(after.reusable, false);
  assert.notEqual(after.digest, before.digest);
});

test("another runtime cannot be paired with the current process version metadata", async (t) => {
  const { root, inspect } = await fixture(t);
  const fakeRuntime = join(root, "fake-node");
  await writeFile(fakeRuntime, "not-the-running-executable");
  await assert.rejects(inspect({ runtimePath: fakeRuntime }), { code: "QUALIFICATION_RUNTIME_MISMATCH" });
  const current = await inspect();
  assert.equal(current.runtime.versions.node, process.versions.node);
  assert.match(current.runtime.executableSha256, /^[a-f0-9]{64}$/u);
});

test("missing input and source links fail closed without exposing private paths", async (t) => {
  const { root, inspect } = await fixture(t);
  const file = join(root, "src/main.js");
  const bytes = await readFile(file);
  await rm(file);
  await symlink(join(root, "schemas/value.json"), file);
  await assert.rejects(inspect(), (error) => error.code === "QUALIFICATION_INPUT_UNSAFE" && !error.message.includes(root));
  await rm(file);
  await writeFile(file, bytes);
  await rm(join(root, QUALIFICATION_TEST_FILES[0]));
  await assert.rejects(inspect(), { code: "QUALIFICATION_INPUTS_UNAVAILABLE" });
});
