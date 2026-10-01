import { spawnSync } from "node:child_process";
import { operationError } from "../../../scripts/lib/release-operation.mjs";

export const PRODUCTION_LOCK_REF = "refs/heads/codex/production-deployment-lock";
export const IMMUTABLE_ARTIFACT_LOCK_REF = "refs/heads/codex/immutable-release-artifact-lock";
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-f0-9-]{36}$/;
const REMOTES = new Set(["https://github.com/adamallcock/tibotattle.git", "https://github.com/adamallcock/tibotattle", "git@github.com:adamallcock/tibotattle.git"]);

// Fixed shared destination; no arbitrary remote/ref from a release receipt.
export function createProductionDeploymentLock({ repositoryRoot, spawn = spawnSync }) {
  return createCoordinationLock({ repositoryRoot, spawn }, PRODUCTION_LOCK_REF, "PRODUCTION_COORDINATION", ({ id, sourceCommit, previousSourceCommit }) => {
    if (!ID.test(id) || !SHA.test(sourceCommit) || !SHA.test(previousSourceCommit)) throw operationError("PRODUCTION_COORDINATION_INPUT_INVALID");
    return { schema: 1, id, sourceCommit, previousSourceCommit };
  });
}

// Only for separately reviewed immutable artifact publication. The writer binds
// the complete object set and any explicit GitHub draft-to-immutable/latest
// transition to planSha256, and refuses existing drift.
// This factory never reads or changes production ownership. Stable discovery
// feeds, deployment, migration and website operations keep the production lock.
export function createImmutableArtifactPublicationLock(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some(key => !["repositoryRoot", "spawn"].includes(key))) {
    throw operationError("IMMUTABLE_ARTIFACT_COORDINATION_INPUT_INVALID");
  }
  const { repositoryRoot, spawn = spawnSync } = options;
  if (typeof repositoryRoot !== "string" || !repositoryRoot || repositoryRoot.length > 4096
      || /[\0\r\n]/.test(repositoryRoot) || typeof spawn !== "function") {
    throw operationError("IMMUTABLE_ARTIFACT_COORDINATION_INPUT_INVALID");
  }
  return createCoordinationLock({ repositoryRoot, spawn }, IMMUTABLE_ARTIFACT_LOCK_REF, "IMMUTABLE_ARTIFACT_COORDINATION", (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).sort().join() !== "id,planSha256,sourceCommit"
        || typeof input.id !== "string" || !ID.test(input.id)
        || typeof input.sourceCommit !== "string" || !SHA.test(input.sourceCommit)
        || typeof input.planSha256 !== "string" || !SHA256.test(input.planSha256)) {
      throw operationError("IMMUTABLE_ARTIFACT_COORDINATION_INPUT_INVALID");
    }
    return { schema: "immutable-release-artifact-lock-v1", id: input.id, sourceCommit: input.sourceCommit, planSha256: input.planSha256 };
  });
}

// No expiry/stealing: an uncertain old executor must be reconciled, not fenced
// by a timer that cannot stop its already-running Cloudflare request.
// Ref and owner format come only from the two fixed factories above.
function createCoordinationLock({ repositoryRoot, spawn }, ref, errorPrefix, ownerRecord) {
  const fail = suffix => { throw operationError(`${errorPrefix}_${suffix}`); };
  const git = (args, input) => {
    const result = spawn("git", args, {
      cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024, timeout: 60_000,
      input, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
        GIT_AUTHOR_NAME: "Release coordinator", GIT_AUTHOR_EMAIL: "release@localhost",
        GIT_COMMITTER_NAME: "Release coordinator", GIT_COMMITTER_EMAIL: "release@localhost" },
    });
    if (result.error || result.status !== 0) fail("COMMAND_FAILED");
    return String(result.stdout ?? "").trim();
  };
  const remote = git(["remote", "get-url", "--push", "--all", "origin"]);
  if (!REMOTES.has(remote)) fail("REMOTE_INVALID");
  const status = () => {
    const result = git(["ls-remote", "--refs", remote, ref]);
    if (result === "") return null;
    const parts = result.split(/\s+/);
    if (parts.length !== 2 || !SHA.test(parts[0]) || parts[1] !== ref) fail("STATE_UNKNOWN");
    return parts[0];
  };
  const assertOwned = (owner) => {
    if (!SHA.test(owner) || status() !== owner) fail("NOT_OWNER");
  };
  return {
    status,
    createOwner(input) {
      const record = ownerRecord(input);
      const tree = git(["hash-object", "-t", "tree", "--stdin", "-w"], "");
      const owner = git(["-c", "commit.gpgSign=false", "commit-tree", tree], `${JSON.stringify(record)}\n`);
      if (!SHA.test(owner)) fail("OWNER_INVALID");
      return owner;
    },
    isAncestor(previous, candidate) {
      if (!SHA.test(previous) || !SHA.test(candidate)) return false;
      try { git(["merge-base", "--is-ancestor", previous, candidate]); return true; } catch { return false; }
    },
    acquire(owner) {
      if (!SHA.test(owner)) fail("OWNER_INVALID");
      if (status() !== null) fail("BUSY");
      try {
        git(["-c", "push.followTags=false", "push", "--porcelain", `--force-with-lease=${ref}:`, remote, `${owner}:${ref}`]);
      } catch {
        // A lost response may still have created our exact ref. Do not retry.
        if (status() !== owner) fail("ACQUIRE_UNCERTAIN");
      }
      assertOwned(owner);
    },
    assertOwned,
    release(owner) {
      assertOwned(owner);
      try {
        git(["-c", "push.followTags=false", "push", "--porcelain", `--force-with-lease=${ref}:${owner}`, remote, `:${ref}`]);
      } catch {
        if (status() !== null) fail("RELEASE_UNCERTAIN");
      }
      if (status() !== null) fail("RELEASE_UNCERTAIN");
    },
  };
}
