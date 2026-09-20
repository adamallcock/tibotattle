import assert from "node:assert/strict";
import test from "node:test";
import {
  CROSS_WORKER_CONTRACT_SYMBOLS,
  inspectDeployDelta,
  reviewDeployDelta,
} from "./deploy-delta.mjs";

const INTENDED = "ab85ce9ac9e52e122b72f6b2497096b3c938b8da";
const DEPLOYED = "13d8e74324195da25ab45c0b972545fde5a3dac7";
const SPAN_FLOOR = "c8287609ffffffffffffffffffffffffffffffff";
const LEXER = "0ad1a8a8ffffffffffffffffffffffffffffffff";

const clean = {
  intended: INTENDED, deployed: DEPLOYED, headCommit: INTENDED, treeClean: true,
};

test("a deploy of exactly the named commit is accepted", () => {
  const review = reviewDeployDelta({ ...clean, commits: [{ sha: INTENDED, subject: "instrumentation" }] });
  assert.equal(review.ok, true);
  assert.deepEqual(review.refusals, []);
});

test("it refuses the commits that ride along underneath", () => {
  // THE 2026-09-18 OUTAGE, as a test. The operator meant to deploy the
  // instrumentation commit and the tree was clean and exactly at it, so every
  // check that existed at the time passed. Two other commits came with it.
  const review = reviewDeployDelta({
    ...clean,
    commits: [
      { sha: SPAN_FLOOR, subject: "repair quota evidence and lower the span floor" },
      { sha: LEXER, subject: "let the ESM lexer parse two worker specs" },
      { sha: INTENDED, subject: "attribute the retirement-sweep spend" },
    ],
  });
  assert.equal(review.ok, false);
  assert.ok(review.refusals.includes("UNACKNOWLEDGED_COMMITS"));
  assert.deepEqual(review.unacknowledged.map(commit => commit.sha), [SPAN_FLOOR, LEXER]);
});

test("naming them is not enough when one changes a cross-worker contract", () => {
  // Acknowledging the commit is necessary and still insufficient: the span
  // floor is written by one Worker and validated by another, so shipping it to
  // one alone breaks the published band whichever moves first.
  const contractHits = new Map([[SPAN_FLOOR, ["COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP"]]]);
  const commits = [
    { sha: SPAN_FLOOR, subject: "lower the span floor" },
    { sha: INTENDED, subject: "instrumentation" },
  ];
  const named = reviewDeployDelta({ ...clean, commits, accepted: [SPAN_FLOOR], contractHits });
  assert.equal(named.ok, false);
  assert.ok(named.refusals.includes("CROSS_WORKER_CONTRACT_CHANGE"));
  assert.deepEqual(named.contractCommits[0].symbols, ["COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP"]);

  const acknowledged = reviewDeployDelta({
    ...clean, commits, accepted: [SPAN_FLOOR], contractHits, acceptContractChange: true,
  });
  assert.equal(acknowledged.ok, true);
});

test("a short sha accepts its commit", () => {
  const review = reviewDeployDelta({
    ...clean,
    commits: [{ sha: LEXER, subject: "lexer" }, { sha: INTENDED, subject: "instrumentation" }],
    accepted: ["0ad1a8a8"],
  });
  assert.equal(review.ok, true);
});

test("it refuses a tree that is dirty or not at the named commit", () => {
  assert.ok(reviewDeployDelta({ ...clean, treeClean: false }).refusals
    .includes("DEPLOY_TREE_DIRTY"));
  assert.ok(reviewDeployDelta({ ...clean, headCommit: DEPLOYED }).refusals
    .includes("DEPLOY_TREE_NOT_AT_INTENDED_COMMIT"));
  // An unreadable worktree reports neither clean nor a head, and must refuse
  // rather than treat "unknown" as "fine".
  assert.equal(reviewDeployDelta({ ...clean, headCommit: null, treeClean: null }).ok, false);
});

test("it refuses malformed revisions instead of comparing them", () => {
  assert.ok(reviewDeployDelta({ ...clean, intended: "HEAD" }).refusals
    .includes("INTENDED_COMMIT_INVALID"));
  assert.ok(reviewDeployDelta({ ...clean, deployed: "" }).refusals
    .includes("DEPLOYED_COMMIT_INVALID"));
});

test("only added and removed lines count as touching a contract", () => {
  // A symbol in surrounding context was not changed by the commit. Counting it
  // would make the gate fire on every neighbouring edit until operators learned
  // to pass --accept-contract-change reflexively, which is worse than no gate.
  const run = (_worktree, args) => {
    if (args[0] === "rev-parse") return INTENDED;
    if (args[0] === "status") return "";
    if (args[0] === "log") return `${INTENDED}\u0000instrumentation`;
    return [
      "@@ -1 +1 @@",
      " const floor = COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP;",
      "-const sweep = 0;",
      "+const sweep = 1;",
    ].join("\n");
  };
  const review = inspectDeployDelta({
    worktree: "/nonexistent", intended: INTENDED, deployed: DEPLOYED, run,
  });
  assert.equal(review.ok, true);
  assert.deepEqual(review.contractCommits, []);
});

test("a changed contract symbol is detected from the diff", () => {
  const run = (_worktree, args) => {
    if (args[0] === "rev-parse") return INTENDED;
    if (args[0] === "status") return "";
    if (args[0] === "log") return `${INTENDED}\u0000lower the span floor`;
    return "-export const COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP = 40;\n"
      + "+export const COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP = 25;";
  };
  const review = inspectDeployDelta({
    worktree: "/nonexistent", intended: INTENDED, deployed: DEPLOYED, run,
  });
  assert.equal(review.ok, false);
  assert.ok(review.refusals.includes("CROSS_WORKER_CONTRACT_CHANGE"));
});

test("the contract list names both sides of the published band", () => {
  for (const symbol of ["COMMUNITY_ALLOWANCE_QUALIFICATION",
    "COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP", "STORAGE_GRAPH_METHOD"]) {
    assert.ok(CROSS_WORKER_CONTRACT_SYMBOLS.includes(symbol), symbol);
  }
});
