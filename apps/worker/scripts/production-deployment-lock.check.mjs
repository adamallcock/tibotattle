import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEnvironmentDeploymentLock,
  createImmutableArtifactPublicationLock,
  createProductionDeploymentLock,
  createStagingDeploymentLock,
  DEPLOYMENT_LOCK_REFS,
  deploymentLockRef,
  IMMUTABLE_ARTIFACT_LOCK_REF,
  PRODUCTION_LOCK_REF,
  STAGING_LOCK_REF,
} from "./production-deployment-lock.mjs";

const APPROVED_REMOTE = "https://github.com/adamallcock/tibotattle.git";
const SOURCE = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const PLAN_SHA256 = "c".repeat(64);
const LANES = [
  { name: "production", createLock: createProductionDeploymentLock, ref: PRODUCTION_LOCK_REF,
    prefix: "PRODUCTION_COORDINATION", fields: { sourceCommit: SOURCE, previousSourceCommit: PREVIOUS } },
  { name: "staging", createLock: createStagingDeploymentLock, ref: STAGING_LOCK_REF,
    prefix: "STAGING_COORDINATION", fields: { sourceCommit: SOURCE, previousSourceCommit: PREVIOUS } },
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

// ---------------------------------------------------------------------------
// STG-LOCK: the closed OPS-10 environment-to-ref mapping (owner decision
// 2026-10-02, round 9). Staging takes only its own ref; production is unchanged.

test("the OPS-10 lock mapping is closed: production and staging each have exactly one distinct ref", () => {
  assert.equal(STAGING_LOCK_REF, "refs/heads/codex/staging-deployment-lock");
  assert.equal(PRODUCTION_LOCK_REF, "refs/heads/codex/production-deployment-lock");
  assert.deepEqual(Object.entries(DEPLOYMENT_LOCK_REFS), [["production", PRODUCTION_LOCK_REF], ["staging", STAGING_LOCK_REF]]);
  assert.equal(Object.isFrozen(DEPLOYMENT_LOCK_REFS), true);
  assert.equal(deploymentLockRef("production"), PRODUCTION_LOCK_REF);
  assert.equal(deploymentLockRef("staging"), STAGING_LOCK_REF);
  for (const environment of ["test", "Production", "STAGING", "staging ", "", "__proto__", "constructor", "toString",
    "hasOwnProperty", null, undefined, 1, {}, ["staging"]]) {
    assert.throws(() => deploymentLockRef(environment), { code: "DEPLOYMENT_COORDINATION_ENVIRONMENT_INVALID" },
      String(environment));
  }
});

test("staging refuses the production ref, production refuses the staging ref, and an unknown environment is refused, before Git access", () => {
  const spawn = () => assert.fail("a refused environment or ref reached Git");
  const refused = [
    [{ environment: "staging", ref: PRODUCTION_LOCK_REF }, "DEPLOYMENT_COORDINATION_REF_MISMATCH"],
    [{ environment: "production", ref: STAGING_LOCK_REF }, "DEPLOYMENT_COORDINATION_REF_MISMATCH"],
    [{ environment: "staging", ref: IMMUTABLE_ARTIFACT_LOCK_REF }, "DEPLOYMENT_COORDINATION_REF_MISMATCH"],
    [{ environment: "production", ref: IMMUTABLE_ARTIFACT_LOCK_REF }, "DEPLOYMENT_COORDINATION_REF_MISMATCH"],
    [{ environment: "staging", ref: "codex/staging-deployment-lock" }, "DEPLOYMENT_COORDINATION_REF_MISMATCH"],
    [{ environment: "staging", ref: `${STAGING_LOCK_REF}-2` }, "DEPLOYMENT_COORDINATION_REF_MISMATCH"],
    [{ environment: "staging" }, "DEPLOYMENT_COORDINATION_REF_MISMATCH"],
    [{ environment: "test", ref: STAGING_LOCK_REF }, "DEPLOYMENT_COORDINATION_ENVIRONMENT_INVALID"],
    [{ environment: "preview", ref: PRODUCTION_LOCK_REF }, "DEPLOYMENT_COORDINATION_ENVIRONMENT_INVALID"],
    [{ environment: "__proto__", ref: PRODUCTION_LOCK_REF }, "DEPLOYMENT_COORDINATION_ENVIRONMENT_INVALID"],
    [{ ref: PRODUCTION_LOCK_REF }, "DEPLOYMENT_COORDINATION_ENVIRONMENT_INVALID"],
    ...["remote", "schema", "prefix", "expiresAt"].map(key =>
      [{ environment: "staging", ref: STAGING_LOCK_REF, [key]: "override" }, "DEPLOYMENT_COORDINATION_INPUT_INVALID"]),
    [{ environment: "staging", ref: STAGING_LOCK_REF, repositoryRoot: "" }, "DEPLOYMENT_COORDINATION_INPUT_INVALID"],
    [{ environment: "staging", ref: STAGING_LOCK_REF, repositoryRoot: "/unused", spawn: null }, "DEPLOYMENT_COORDINATION_INPUT_INVALID"],
  ];
  for (const [options, code] of refused) {
    assert.throws(() => createEnvironmentDeploymentLock({ repositoryRoot: "/unused", spawn, ...options }), { code },
      JSON.stringify(options));
  }
  for (const options of [null, [], "staging"]) {
    assert.throws(() => createEnvironmentDeploymentLock(options), { code: "DEPLOYMENT_COORDINATION_INPUT_INVALID" });
  }
});

test("a staging lock and the production lock are independent: staging never reads, takes or releases the production ref", async (t) => {
  const f = await fixture(t);
  const production = await f.create("production");
  production.lock.acquire(production.owner);
  const callStart = f.calls.length;
  const directory = await f.checkout("staging");
  const staging = createEnvironmentDeploymentLock({ environment: "staging", ref: STAGING_LOCK_REF, repositoryRoot: directory, spawn: f.spawn });
  assert.equal(staging.ref, STAGING_LOCK_REF);
  const input = { id: randomUUID(), sourceCommit: SOURCE, previousSourceCommit: PREVIOUS };
  const owner = staging.createOwner(input);
  assert.deepEqual(JSON.parse(git(directory, ["show", "-s", "--format=%B", owner])), { schema: "staging-deployment-lock-v1", ...input });
  assert.equal(staging.status(), null, "a held production lock does not make staging busy");
  staging.acquire(owner);
  assert.throws(() => staging.release(production.owner), { code: "STAGING_COORDINATION_NOT_OWNER" });
  staging.release(owner);
  const stagingCalls = f.calls.slice(callStart);
  assert.throws(() => production.lock.release(owner), { code: "PRODUCTION_COORDINATION_NOT_OWNER" },
    "a staging owner never releases the production lock");
  assert.equal(stagingCalls.some(args => args.some(arg => arg.includes("production-deployment-lock"))), false);
  assert.equal(stagingCalls.filter(args => args.includes("push")).every(args =>
    args.at(-1) === `${owner}:${STAGING_LOCK_REF}` || args.at(-1) === `:${STAGING_LOCK_REF}`), true);
  assert.equal(stagingCalls.filter(args => args.includes("ls-remote")).every(args => args.at(-1) === STAGING_LOCK_REF), true);
  assert.equal(production.lock.status(), production.owner, "the production lock is untouched");
  production.lock.release(production.owner);
  assert.equal(staging.status(), null);
});

test("the production lock through the environment factory issues byte-identical Git commands to createProductionDeploymentLock", async (t) => {
  const run = async (name, makeLock) => {
    const f = await fixture(t);
    const directory = await f.checkout(name);
    const seen = [];
    const spawn = (command, args, options) => {
      const { env, ...rest } = options;
      seen.push({ command, args: [...args], options: rest, env: { ...env } });
      return f.spawn(command, args, options);
    };
    const lock = makeLock(directory, spawn);
    const owner = lock.createOwner({ id: "00000000-0000-4000-8000-000000000001", sourceCommit: SOURCE, previousSourceCommit: PREVIOUS });
    const record = JSON.parse(git(directory, ["show", "-s", "--format=%B", owner]));
    lock.acquire(owner);
    lock.assertOwned(owner);
    lock.release(owner);
    // Owner commits carry their commit time; everything else must match exactly.
    const normalize = value => value.replaceAll(directory, "<checkout>").replace(/[0-9a-f]{40}/g, "<sha>");
    return { ref: lock.ref, record, calls: seen.map(call => JSON.parse(normalize(JSON.stringify(call)))) };
  };
  const direct = await run("direct", (repositoryRoot, spawn) => createProductionDeploymentLock({ repositoryRoot, spawn }));
  const mapped = await run("mapped", (repositoryRoot, spawn) =>
    createEnvironmentDeploymentLock({ environment: "production", ref: PRODUCTION_LOCK_REF, repositoryRoot, spawn }));
  assert.deepEqual(mapped, direct);
  assert.equal(direct.ref, PRODUCTION_LOCK_REF);
  assert.deepEqual(direct.record, { schema: 1, id: "00000000-0000-4000-8000-000000000001", sourceCommit: SOURCE, previousSourceCommit: PREVIOUS });
  assert.equal(direct.calls.some(call => call.args.some(arg => arg.includes("staging-deployment-lock"))), false);
  assert.equal(direct.calls.filter(call => call.args.includes("push")).length, 2);
});
