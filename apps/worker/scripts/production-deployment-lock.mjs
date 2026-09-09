import { spawnSync } from "node:child_process";
import { operationError } from "../../../scripts/lib/release-operation.mjs";

export const PRODUCTION_LOCK_REF = "refs/heads/codex/production-deployment-lock";
const SHA = /^[0-9a-f]{40}$/;
const REMOTES = new Set(["https://github.com/adamallcock/tibotattle.git", "https://github.com/adamallcock/tibotattle", "git@github.com:adamallcock/tibotattle.git"]);

// Fixed shared destination; no arbitrary remote/ref from a release receipt.
// No expiry/stealing: an uncertain old executor must be reconciled, not fenced
// by a timer that cannot stop its already-running Cloudflare request.
export function createProductionDeploymentLock({ repositoryRoot, spawn = spawnSync }) {
  const git = (args, input) => {
    const result = spawn("git", args, {
      cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024, timeout: 60_000,
      input, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
        GIT_AUTHOR_NAME: "Release coordinator", GIT_AUTHOR_EMAIL: "release@localhost",
        GIT_COMMITTER_NAME: "Release coordinator", GIT_COMMITTER_EMAIL: "release@localhost" },
    });
    if (result.error || result.status !== 0) throw operationError("PRODUCTION_COORDINATION_COMMAND_FAILED");
    return String(result.stdout ?? "").trim();
  };
  const remote = git(["remote", "get-url", "--push", "--all", "origin"]);
  if (!REMOTES.has(remote)) throw operationError("PRODUCTION_COORDINATION_REMOTE_INVALID");
  const status = () => {
    const result = git(["ls-remote", "--refs", remote, PRODUCTION_LOCK_REF]);
    if (result === "") return null;
    const parts = result.split(/\s+/);
    if (parts.length !== 2 || !SHA.test(parts[0]) || parts[1] !== PRODUCTION_LOCK_REF) throw operationError("PRODUCTION_COORDINATION_STATE_UNKNOWN");
    return parts[0];
  };
  const assertOwned = (owner) => {
    if (!SHA.test(owner) || status() !== owner) throw operationError("PRODUCTION_COORDINATION_NOT_OWNER");
  };
  return {
    status,
    createOwner({ id, sourceCommit, previousSourceCommit }) {
      if (!/^[a-f0-9-]{36}$/.test(id) || !SHA.test(sourceCommit) || !SHA.test(previousSourceCommit)) throw operationError("PRODUCTION_COORDINATION_INPUT_INVALID");
      const tree = git(["hash-object", "-t", "tree", "--stdin", "-w"], "");
      const owner = git(["-c", "commit.gpgSign=false", "commit-tree", tree], `${JSON.stringify({ schema: 1, id, sourceCommit, previousSourceCommit })}\n`);
      if (!SHA.test(owner)) throw operationError("PRODUCTION_COORDINATION_OWNER_INVALID");
      return owner;
    },
    isAncestor(previous, candidate) {
      if (!SHA.test(previous) || !SHA.test(candidate)) return false;
      try { git(["merge-base", "--is-ancestor", previous, candidate]); return true; } catch { return false; }
    },
    acquire(owner) {
      if (!SHA.test(owner)) throw operationError("PRODUCTION_COORDINATION_OWNER_INVALID");
      if (status() !== null) throw operationError("PRODUCTION_COORDINATION_BUSY");
      try {
        git(["-c", "push.followTags=false", "push", "--porcelain", `--force-with-lease=${PRODUCTION_LOCK_REF}:`, remote, `${owner}:${PRODUCTION_LOCK_REF}`]);
      } catch {
        // A lost response may still have created our exact ref. Do not retry.
        if (status() !== owner) throw operationError("PRODUCTION_COORDINATION_ACQUIRE_UNCERTAIN");
      }
      assertOwned(owner);
    },
    assertOwned,
    release(owner) {
      assertOwned(owner);
      try {
        git(["-c", "push.followTags=false", "push", "--porcelain", `--force-with-lease=${PRODUCTION_LOCK_REF}:${owner}`, remote, `:${PRODUCTION_LOCK_REF}`]);
      } catch {
        if (status() !== null) throw operationError("PRODUCTION_COORDINATION_RELEASE_UNCERTAIN");
      }
      if (status() !== null) throw operationError("PRODUCTION_COORDINATION_RELEASE_UNCERTAIN");
    },
  };
}
