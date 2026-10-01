#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import { GCP_FASTPATH_CONNECTION, validateTarget } from "./gcp-fastpath-connection.mjs";
import {
  defaultSuffix,
  planSeed,
  SEED_STAGES,
  seededSchemas,
} from "./gcp-fastpath-seed.mjs";

const COMMIT = "4".repeat(40);

/** Fake git: `present` paths exist at the commit, `dirty` paths differ in the checkout. */
function fakeGit({ present = [], dirty = [] } = {}) {
  return (command, args) => {
    assert.equal(command, "git");
    const [, , verb, ...rest] = args;
    if (verb === "cat-file") {
      const path = rest[1].slice(COMMIT.length + 1);
      return { status: present.includes(path) ? 0 : 1, stdout: "" };
    }
    if (verb === "diff") {
      const paths = rest.slice(rest.indexOf("--") + 1);
      return { status: paths.some((path) => dirty.includes(path)) ? 1 : 0, stdout: "" };
    }
    if (verb === "ls-files") return { status: 0, stdout: "" };
    throw new Error(`unexpected git ${verb}`);
  };
}

const T1 = SEED_STAGES.find(({ name }) => name === "identity").path;
const TYPED = SEED_STAGES.find(({ name }) => name === "typed-legacy").path;
const T2 = SEED_STAGES.find(({ name }) => name === "v12").path;

test("seed skips with its reason when the T-1 identity copy is absent at the commit", () => {
  const plan = planSeed(COMMIT, fakeGit({ present: [TYPED] }));
  assert.equal(plan.decision, "skip");
  assert.match(plan.reason, /T-1 identity\/authority copy/u);
  assert.match(plan.reason, /postgres-fastpath-identity-copy\.mjs/u);
  assert.deepEqual(plan.stages.map(({ name, status }) => [name, status]),
    [["identity", "absent"], ["typed-legacy", "present"], ["v12", "absent"]]);
  assert.equal(plan.unseeded.length, 2);
});

test("seed runs without the optional T-2 stage and refuses a checkout that differs from the commit", () => {
  const withoutV12 = planSeed(COMMIT, fakeGit({ present: [T1, TYPED] }));
  assert.equal(withoutV12.decision, "run");
  assert.equal(withoutV12.stages.find(({ name }) => name === "v12").status, "absent");
  const full = planSeed(COMMIT, fakeGit({ present: [T1, TYPED, T2] }));
  assert.equal(full.decision, "run");
  const mismatch = planSeed(COMMIT, fakeGit({ present: [T1, TYPED, T2], dirty: [T2] }));
  assert.equal(mismatch.decision, "refuse");
  assert.match(mismatch.reason, /run the seed from a checkout of the deployed commit/u);
  const migrations = planSeed(COMMIT, fakeGit({ present: [T1, TYPED], dirty: ["apps/worker/postgres/migrations"] }));
  assert.equal(migrations.decision, "refuse");
});

test("seeded schemas keep the importers' prefix guards and fit PostgreSQL identifiers", () => {
  const suffix = defaultSuffix("483245adcb02202539b5b3abb2d479e07f722e48", "98936d54208d964f".padEnd(64, "0"));
  assert.equal(suffix, "fp_483245ad_98936d54");
  const schemas = seededSchemas(suffix);
  assert.equal(schemas.target, "typed_legacy_transfer_rehearsal_target_fp_483245ad_98936d54");
  assert.equal(schemas.control, "typed_legacy_transfer_rehearsal_fp_483245ad_98936d54");
  assert.equal(schemas.target.length <= 63, true);
  for (const bad of ["short", "Upper_case_x", "fp-483245ad-98936d54", "x".repeat(25), "1fp_483245ad"]) {
    assert.throws(() => seededSchemas(bad), (error) => error?.code === "GCP_FASTPATH_SEED_SUFFIX_INVALID");
  }
});

test("the connection targets only the disposable fast-path database", () => {
  assert.equal(GCP_FASTPATH_CONNECTION.database, "tibotattle_fastpath");
  assert.notEqual(GCP_FASTPATH_CONNECTION.database, "tibotattle");
  assert.equal(validateTarget("gcp-fastpath"), "gcp-fastpath");
  for (const bad of ["local", "tibotattle", "gcp-test-app", undefined]) {
    assert.throws(() => validateTarget(bad), (error) => error?.code === "GCP_FASTPATH_CONNECTION_TARGET_INVALID");
  }
  assert.deepEqual(Object.keys(GCP_FASTPATH_CONNECTION.identities).sort(), ["migrator", "runtime"]);
});
