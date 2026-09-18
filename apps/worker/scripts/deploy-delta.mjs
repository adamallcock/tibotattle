import { execFileSync } from "node:child_process";
import process from "node:process";

/**
 * What ELSE is riding along in a deploy.
 *
 * `verifySourceSnapshot` in `production-deploy.mjs` already answers "is the
 * tree clean and is HEAD the commit I named". That is necessary and it is not
 * sufficient, because it compares the tree against the operator's INTENT and
 * never against what is actually running. A deploy worktree moved forward to
 * pick up one commit silently carries every commit beneath it.
 *
 * That is not hypothetical. On 2026-09-18 an instrumentation-only commit was
 * deployed to the analytics worker; the commit beneath it had changed the
 * community allowance span floor from 40pp to 25pp, along with the published
 * `qualification` string. Every cached fit was invalidated, and hours later the
 * regenerated preview carried `spanFloorPp: 25`, which the separately deployed
 * main worker validates against 40 and refuses. The public allowance band
 * disappeared from the site. Both the diff and the intent were honest; the
 * delta against production was never looked at.
 *
 * So this answers the other question: given what is live, exactly which commits
 * does this deploy introduce, and does any of them touch a contract another
 * Worker validates independently?
 */

/** Symbols and paths that two separately deployed Workers must agree on.
 *
 * A change to any of these cannot ship to one Worker alone: the analytics
 * Worker writes them into the preview payload and the main Worker validates
 * them on read, so whichever moves first breaks the band in one direction or
 * the other. This list is deliberately about CROSS-WORKER agreement, not about
 * risk in general — a change can be dangerous without belonging here. */
export const CROSS_WORKER_CONTRACT_SYMBOLS = Object.freeze([
  "COMMUNITY_ALLOWANCE_QUALIFICATION",
  "COMMUNITY_ALLOWANCE_SPAN_FLOOR_PP",
  "COMMUNITY_ALLOWANCE_FIT_METHOD",
  "COMMUNITY_ALLOWANCE_BASIS",
  "COMMUNITY_ALLOWANCE_NORMALIZATION",
  "V1_FIT_CACHE_KEY",
  "communityAnalysisCacheVersion",
  "STORAGE_GRAPH_METHOD",
]);

const SHA = /^[0-9a-f]{7,40}$/u;

const git = (worktree, args) =>
  execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" }).trim();

/**
 * The pure rule, so it can be exercised without a repository.
 *
 * `commits` are those introduced by the deploy, oldest first. `accepted` are
 * the ones the operator named. `contractHits` maps a commit to the contract
 * symbols its diff touched.
 */
export function reviewDeployDelta({
  intended, deployed, headCommit, treeClean,
  commits = [], accepted = [], contractHits = new Map(),
  acceptContractChange = false,
}) {
  const refusals = [];
  if (!SHA.test(intended ?? "")) refusals.push("INTENDED_COMMIT_INVALID");
  if (!SHA.test(deployed ?? "")) refusals.push("DEPLOYED_COMMIT_INVALID");
  if (treeClean !== true) refusals.push("DEPLOY_TREE_DIRTY");
  // The tree must BE the commit named, not merely contain it.
  if (SHA.test(intended ?? "") && headCommit !== intended) {
    refusals.push("DEPLOY_TREE_NOT_AT_INTENDED_COMMIT");
  }
  const acceptedSet = new Set(accepted);
  const unacknowledged = commits.filter(commit =>
    commit.sha !== intended && !acceptedSet.has(commit.sha)
    && ![...acceptedSet].some(short => commit.sha.startsWith(short)));
  if (unacknowledged.length > 0) refusals.push("UNACKNOWLEDGED_COMMITS");
  const contractCommits = commits.filter(commit => (contractHits.get(commit.sha) ?? []).length > 0);
  if (contractCommits.length > 0 && !acceptContractChange) {
    refusals.push("CROSS_WORKER_CONTRACT_CHANGE");
  }
  return {
    ok: refusals.length === 0,
    refusals,
    introduced: commits,
    unacknowledged,
    contractCommits: contractCommits.map(commit => ({
      ...commit, symbols: contractHits.get(commit.sha) ?? [],
    })),
  };
}

/** Gather the facts from a real worktree, then apply the rule above. */
export function inspectDeployDelta({
  worktree, intended, deployed, accepted = [], acceptContractChange = false,
  symbols = CROSS_WORKER_CONTRACT_SYMBOLS, run = git,
}) {
  let headCommit = null;
  let treeClean = null;
  let commits = [];
  const contractHits = new Map();
  try { headCommit = run(worktree, ["rev-parse", "HEAD"]); } catch { headCommit = null; }
  try { treeClean = run(worktree, ["status", "--porcelain"]) === ""; } catch { treeClean = null; }
  if (SHA.test(intended ?? "") && SHA.test(deployed ?? "")) {
    try {
      const log = run(worktree, ["log", "--format=%H%x00%s", `${deployed}..${intended}`]);
      commits = log === "" ? [] : log.split("\n").map(line => {
        const [sha, subject] = line.split("\0");
        return { sha, subject };
      }).reverse();
    } catch { commits = []; }
    for (const commit of commits) {
      let diff = "";
      try { diff = run(worktree, ["show", "--format=", "--unified=0", commit.sha]); } catch { diff = ""; }
      // Only ADDED or REMOVED lines count: a symbol that merely appears in
      // surrounding context was not changed by this commit.
      const touched = diff.split("\n")
        .filter(line => (line.startsWith("+") || line.startsWith("-"))
          && !line.startsWith("+++") && !line.startsWith("---"));
      const hits = symbols.filter(symbol => touched.some(line => line.includes(symbol)));
      if (hits.length > 0) contractHits.set(commit.sha, hits);
    }
  }
  return reviewDeployDelta({
    intended, deployed, headCommit, treeClean, commits,
    accepted, contractHits, acceptContractChange,
  });
}

function parseArguments(argv) {
  const options = { accepted: [], acceptContractChange: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--worktree") { options.worktree = value; index += 1; }
    else if (flag === "--intended") { options.intended = value; index += 1; }
    else if (flag === "--deployed") { options.deployed = value; index += 1; }
    else if (flag === "--accept") { options.accepted.push(value); index += 1; }
    else if (flag === "--accept-contract-change") options.acceptContractChange = true;
    else return null;
  }
  return options.worktree && options.intended && options.deployed ? options : null;
}

const USAGE = `Usage:
  node apps/worker/scripts/deploy-delta.mjs \\
    --worktree /absolute/path/to/the/deploy/worktree \\
    --intended <commit you mean to deploy> \\
    --deployed <commit currently live, from the worker's DEPLOYMENT_SOURCE_COMMIT> \\
    [--accept <sha>]... [--accept-contract-change]

Refuses unless the worktree is clean, sits exactly at --intended, and every
commit between --deployed and --intended is named with --accept. A commit that
changes a contract another Worker validates independently additionally requires
--accept-contract-change, because it cannot ship to one Worker alone.`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArguments(process.argv.slice(2));
  if (!options) { process.stderr.write(`${USAGE}\n`); process.exit(2); }
  const review = inspectDeployDelta(options);
  for (const commit of review.introduced) {
    const symbols = review.contractCommits.find(entry => entry.sha === commit.sha)?.symbols;
    process.stdout.write(`${commit.sha.slice(0, 12)}  ${commit.subject}`
      + (symbols ? `\n              CONTRACT: ${symbols.join(", ")}` : "") + "\n");
  }
  if (review.ok) { process.stdout.write("deploy delta accepted\n"); process.exit(0); }
  process.stderr.write(`REFUSED: ${review.refusals.join(", ")}\n`);
  for (const commit of review.unacknowledged) {
    process.stderr.write(`  unacknowledged: ${commit.sha.slice(0, 12)}  ${commit.subject}\n`);
  }
  process.exit(1);
}
