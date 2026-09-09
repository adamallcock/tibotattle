import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionDeploymentLock, PRODUCTION_LOCK_REF } from "./production-deployment-lock.mjs";

const APPROVED_REMOTE = "https://github.com/adamallcock/tibotattle.git";
const SOURCE = "a".repeat(40);
const PREVIOUS = "b".repeat(40);

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(t) {
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
    const lock = createProductionDeploymentLock({ repositoryRoot: directory, spawn: intercept });
    const owner = lock.createOwner({ id: randomUUID(), sourceCommit: SOURCE, previousSourceCommit: PREVIOUS });
    return { directory, lock, owner };
  };
  return { remote, calls, spawn, create };
}

test("cross-checkout lock creates and deletes using exact Git CAS without publishing source history", async (t) => {
  const f = await fixture(t);
  const first = await f.create("first");
  const second = await f.create("second");
  assert.equal(first.lock.status(), null);
  assert.equal(git(first.directory, ["rev-list", "--parents", "-n", "1", first.owner]), first.owner);
  assert.equal(git(first.directory, ["ls-tree", first.owner]), "");
  first.lock.acquire(first.owner);
  assert.equal(second.lock.status(), first.owner);
  assert.throws(() => second.lock.acquire(second.owner), { code: "PRODUCTION_COORDINATION_BUSY" });
  assert.throws(() => second.lock.release(second.owner), { code: "PRODUCTION_COORDINATION_NOT_OWNER" });
  assert.equal(first.lock.status(), first.owner);
  first.lock.release(first.owner);
  assert.equal(second.lock.status(), null);
  second.lock.acquire(second.owner);
  second.lock.release(second.owner);
  const pushes = f.calls.filter((args) => args.includes("push"));
  assert.equal(pushes.length, 4);
  assert.equal(pushes[0].includes(`--force-with-lease=${PRODUCTION_LOCK_REF}:`), true);
  assert.equal(pushes[1].includes(`--force-with-lease=${PRODUCTION_LOCK_REF}:${first.owner}`), true);
  assert.equal(pushes[1].at(-1), `:${PRODUCTION_LOCK_REF}`);
  assert.equal(pushes.some((args) => args.includes("--force") || args.includes("--force-with-lease")), false);
});

test("lost acquire and release acknowledgments reconcile exact remote state without repeating pushes", async (t) => {
  const f = await fixture(t);
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

test("CAS refuses an acquisition race without overwriting the other checkout", async (t) => {
  const f = await fixture(t);
  const winner = await f.create("winner");
  let raced = false;
  const loser = await f.create("loser", (command, args, options) => {
    if (args.includes("push") && !raced) {
      raced = true;
      winner.lock.acquire(winner.owner);
    }
    return f.spawn(command, args, options);
  });
  assert.throws(() => loser.lock.acquire(loser.owner), { code: "PRODUCTION_COORDINATION_ACQUIRE_UNCERTAIN" });
  assert.equal(winner.lock.status(), winner.owner);
  winner.lock.release(winner.owner);
});

test("rejected deletion retains ownership and reports uncertainty rather than unlocking", async (t) => {
  const f = await fixture(t);
  const instance = await f.create("denied-delete", (command, args, options) => {
    if (args.includes("push") && args.at(-1) === `:${PRODUCTION_LOCK_REF}`) {
      return { status: 1, stdout: "", stderr: "protected branch" };
    }
    return f.spawn(command, args, options);
  });
  instance.lock.acquire(instance.owner);
  assert.throws(() => instance.lock.release(instance.owner), { code: "PRODUCTION_COORDINATION_RELEASE_UNCERTAIN" });
  assert.equal(instance.lock.status(), instance.owner);
});

test("unapproved or multiple push URLs are refused before any transport", () => {
  for (const remote of ["https://attacker.invalid/repository.git", `${APPROVED_REMOTE}\n${APPROVED_REMOTE}`, ""]) {
    let calls = 0;
    assert.throws(() => createProductionDeploymentLock({ repositoryRoot: "/unused", spawn: (_command, args) => {
      calls += 1;
      assert.deepEqual(args, ["remote", "get-url", "--push", "--all", "origin"]);
      return { status: 0, stdout: remote };
    } }), { code: "PRODUCTION_COORDINATION_REMOTE_INVALID" });
    assert.equal(calls, 1);
  }
});

test("unreadable or malformed remote state never appears unlocked", () => {
  for (const response of [{ status: 1 }, { status: 0, stdout: "garbage" },
    { status: 0, stdout: `${SOURCE}\trefs/heads/wrong` },
    { status: 0, stdout: `${SOURCE}\t${PRODUCTION_LOCK_REF}\n${PREVIOUS}\t${PRODUCTION_LOCK_REF}` }]) {
    const lock = createProductionDeploymentLock({ repositoryRoot: "/unused", spawn: (_command, args) =>
      args[0] === "remote" ? { status: 0, stdout: APPROVED_REMOTE } : response });
    assert.throws(() => lock.status(), { code: response.status === 1
      ? "PRODUCTION_COORDINATION_COMMAND_FAILED" : "PRODUCTION_COORDINATION_STATE_UNKNOWN" });
  }
});
