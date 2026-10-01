import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionDeploymentLock, PRODUCTION_LOCK_REF, createImmutableArtifactPublicationLock, IMMUTABLE_ARTIFACT_LOCK_REF } from "./production-deployment-lock.mjs";

const APPROVED_REMOTE = "https://github.com/adamallcock/tibotattle.git";
const SOURCE = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const PLAN_SHA256 = "c".repeat(64);
const LANES = [
  { name: "production", createLock: createProductionDeploymentLock, ref: PRODUCTION_LOCK_REF,
    prefix: "PRODUCTION_COORDINATION", fields: { sourceCommit: SOURCE, previousSourceCommit: PREVIOUS } },
  { name: "immutable artifact", createLock: createImmutableArtifactPublicationLock, ref: IMMUTABLE_ARTIFACT_LOCK_REF,
    prefix: "IMMUTABLE_ARTIFACT_COORDINATION", fields: { sourceCommit: SOURCE, planSha256: PLAN_SHA256 } },
];

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(t, lane = LANES[0]) {
  const root = await mkdtemp(join(tmpdir(), "production-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  await mkdir(remote);
  git(remote, ["init", "--bare", "--quiet"]);
  const calls = [];
  const checkout = async (name) => {
    const directory = join(root, name);
    await mkdir(directory);
    git(directory, ["init", "--quiet"]);
    git(directory, ["remote", "add", "origin", APPROVED_REMOTE]);
    return directory;
  };
  const spawn = (command, args, options) => {
    assert.equal(command, "git");
    calls.push([...args]);
    // The implementation still validates its canonical URL. Every transport
    // argument is replaced before executing Git, so fixtures never use network.
    const localArgs = args.map((value) => value === APPROVED_REMOTE ? remote : value);
    assert.equal(localArgs.some((value) => /^https?:\/\//.test(value)), false);
    return spawnSync(command, localArgs, options);
  };
  const create = async (name, intercept = spawn) => {
    const directory = await checkout(name);
    const lock = lane.createLock({ repositoryRoot: directory, spawn: intercept });
    const owner = lock.createOwner({ id: randomUUID(), ...lane.fields });
    return { directory, lock, owner };
  };
  return { remote, calls, spawn, create, checkout };
}

for (const lane of LANES) {
  const { name, createLock, ref, prefix } = lane;
  test(`${name}: cross-checkout lock creates and deletes using exact Git CAS without publishing source history`, async (t) => {
    const f = await fixture(t, lane);
    const first = await f.create("first");
    const second = await f.create("second");
    assert.equal(first.lock.status(), null);
    assert.equal(git(first.directory, ["rev-list", "--parents", "-n", "1", first.owner]), first.owner);
    assert.equal(git(first.directory, ["ls-tree", first.owner]), "");
    first.lock.acquire(first.owner);
    assert.equal(second.lock.status(), first.owner);
    assert.throws(() => second.lock.acquire(second.owner), { code: `${prefix}_BUSY` });
    assert.throws(() => second.lock.release(second.owner), { code: `${prefix}_NOT_OWNER` });
    assert.equal(first.lock.status(), first.owner);
    first.lock.release(first.owner);
    assert.equal(second.lock.status(), null);
    second.lock.acquire(second.owner);
    second.lock.release(second.owner);
    const pushes = f.calls.filter((args) => args.includes("push"));
    assert.equal(pushes.length, 4);
    assert.equal(pushes[0].includes(`--force-with-lease=${ref}:`), true);
    assert.equal(pushes[1].includes(`--force-with-lease=${ref}:${first.owner}`), true);
    assert.equal(pushes[1].at(-1), `:${ref}`);
    assert.equal(pushes.some((args) => args.includes("--force") || args.includes("--force-with-lease")), false);
  });

  test(`${name}: lost acquire and release acknowledgments reconcile exact remote state without repeating pushes`, async (t) => {
    const f = await fixture(t, lane);
    let pushes = 0;
    const instance = await f.create("lost-response", (command, args, options) => {
      const result = f.spawn(command, args, options);
      if (args.includes("push")) {
        pushes += 1;
        assert.equal(result.status, 0);
        return { status: null, error: new Error("response lost"), stdout: "", stderr: "" };
      }
      return result;
    });
    instance.lock.acquire(instance.owner);
    assert.equal(instance.lock.status(), instance.owner);
    assert.equal(pushes, 1);
    instance.lock.release(instance.owner);
    assert.equal(instance.lock.status(), null);
    assert.equal(pushes, 2);
  });

  test(`${name}: CAS refuses an acquisition race without overwriting the other checkout`, async (t) => {
    const f = await fixture(t, lane);
    const winner = await f.create("winner");
    let raced = false;
    const loser = await f.create("loser", (command, args, options) => {
      if (args.includes("push") && !raced) {
        raced = true;
        winner.lock.acquire(winner.owner);
      }
      return f.spawn(command, args, options);
    });
    assert.throws(() => loser.lock.acquire(loser.owner), { code: `${prefix}_ACQUIRE_UNCERTAIN` });
    assert.equal(winner.lock.status(), winner.owner);
    winner.lock.release(winner.owner);
  });

  test(`${name}: rejected deletion retains ownership and reports uncertainty rather than unlocking`, async (t) => {
    const f = await fixture(t, lane);
    const instance = await f.create("denied-delete", (command, args, options) => {
      if (args.includes("push") && args.at(-1) === `:${ref}`) {
        return { status: 1, stdout: "", stderr: "protected branch" };
      }
      return f.spawn(command, args, options);
    });
    instance.lock.acquire(instance.owner);
    assert.throws(() => instance.lock.release(instance.owner), { code: `${prefix}_RELEASE_UNCERTAIN` });
    assert.equal(instance.lock.status(), instance.owner);
  });

  test(`${name}: unapproved or multiple push URLs are refused before any transport`, () => {
    for (const remote of ["https://attacker.invalid/repository.git", `${APPROVED_REMOTE}\n${APPROVED_REMOTE}`, ""]) {
      let calls = 0;
      assert.throws(() => createLock({ repositoryRoot: "/unused", spawn: (_command, args) => {
        calls += 1;
        assert.deepEqual(args, ["remote", "get-url", "--push", "--all", "origin"]);
        return { status: 0, stdout: remote };
      } }), { code: `${prefix}_REMOTE_INVALID` });
      assert.equal(calls, 1);
    }
  });

  test(`${name}: unreadable or malformed remote state never appears unlocked`, () => {
    for (const response of [{ status: 1 }, { status: 0, stdout: "garbage" },
      { status: 0, stdout: `${SOURCE}\trefs/heads/wrong` },
      { status: 0, stdout: `${SOURCE}\t${ref}\n${PREVIOUS}\t${ref}` }]) {
      const lock = createLock({ repositoryRoot: "/unused", spawn: (_command, args) =>
        args[0] === "remote" ? { status: 0, stdout: APPROVED_REMOTE } : response });
      assert.throws(() => lock.status(), { code: response.status === 1
        ? `${prefix}_COMMAND_FAILED` : `${prefix}_STATE_UNKNOWN` });
    }
  });
}

test("immutable artifact ownership binds only the exact source and plan while production ownership stays unchanged", async (t) => {
  const f = await fixture(t);
  const production = await f.create("production");
  const productionRecord = JSON.parse(git(production.directory, ["show", "-s", "--format=%B", production.owner]));
  assert.deepEqual(productionRecord, { schema: 1, id: productionRecord.id, sourceCommit: SOURCE, previousSourceCommit: PREVIOUS });
  production.lock.acquire(production.owner);
  const callStart = f.calls.length;
  const directory = await f.checkout("artifacts");
  const artifacts = createImmutableArtifactPublicationLock({ repositoryRoot: directory, spawn: f.spawn });
  const input = { id: randomUUID(), sourceCommit: SOURCE, planSha256: PLAN_SHA256 };
  const owner = artifacts.createOwner(input);
  assert.deepEqual(JSON.parse(git(directory, ["show", "-s", "--format=%B", owner])), { schema: "immutable-release-artifact-lock-v1", ...input });
  for (const changed of [{ ...input, sourceCommit: PREVIOUS }, { ...input, planSha256: "d".repeat(64) }]) {
    assert.notEqual(artifacts.createOwner(changed), owner);
  }
  artifacts.acquire(owner);
  assert.throws(() => artifacts.release(production.owner), { code: "IMMUTABLE_ARTIFACT_COORDINATION_NOT_OWNER" });
  artifacts.release(owner);
  assert.equal(artifacts.status(), null);
  const artifactCalls = f.calls.slice(callStart);
  assert.equal(artifactCalls.some(args => args.some(arg => arg.includes(PRODUCTION_LOCK_REF))), false);
  assert.equal(production.lock.status(), production.owner);
  production.lock.release(production.owner);
});

test("immutable artifact factory refuses configurable coordination or malformed options before Git access", () => {
  const spawn = () => assert.fail("invalid factory options reached Git");
  for (const options of [null, [], {}, { repositoryRoot: "" }, { repositoryRoot: "/unused", spawn: null },
    ...["ref", "schema", "remote", "expiresAt"].map(key => ({ repositoryRoot: "/unused", spawn, [key]: "override" }))]) {
    assert.throws(() => createImmutableArtifactPublicationLock(options), { code: "IMMUTABLE_ARTIFACT_COORDINATION_INPUT_INVALID" });
  }
});

test("immutable owner rejects missing, malformed or extra fields before creating local Git objects", () => {
  let calls = 0;
  const lock = createImmutableArtifactPublicationLock({ repositoryRoot: "/unused", spawn: (_command, args) => {
    calls += 1;
    assert.deepEqual(args, ["remote", "get-url", "--push", "--all", "origin"]);
    return { status: 0, stdout: APPROVED_REMOTE };
  } });
  const valid = { id: randomUUID(), sourceCommit: SOURCE, planSha256: PLAN_SHA256 };
  for (const input of [null, [], {}, { ...valid, id: "invalid" }, { ...valid, sourceCommit: "a".repeat(39) },
    { ...valid, planSha256: "C".repeat(64) }, { ...valid, planSha256: "c".repeat(63) },
    { ...valid, sourceCommit: { toString: () => SOURCE } },
    ...["id", "sourceCommit", "planSha256"].map(key => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))),
    ...["previousSourceCommit", "ref", "schema", "expiresAt", "scope"].map(key => ({ ...valid, [key]: "extra" }))]) {
    assert.throws(() => lock.createOwner(input), { code: "IMMUTABLE_ARTIFACT_COORDINATION_INPUT_INVALID" });
  }
  assert.equal(calls, 1);
});
