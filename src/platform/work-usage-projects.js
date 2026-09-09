import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, isAbsolute, normalize } from "node:path";
import { realpath, stat } from "node:fs/promises";
const run = promisify(execFile);
export function createWorkUsageProjectResolver({
  digest,
  maximum = 10_000,
} = {}) {
  const cache = new Map();
  return async function resolveProject(cwd) {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
    const location = normalize(cwd);
    if (cache.has(location)) return cache.get(location);
    if (cache.size >= maximum)
      throw Object.assign(new Error("work_usage_capacity_exceeded"), {
        code: "work_usage_capacity_exceeded",
      });
    const pending = (async () => {
      const key = (kind, value) => digest(kind, value);
      const safeName = (path) =>
        basename(path)
          .replace(/[\u0000-\u001f\u007f]/gu, "")
          .slice(0, 120) || null;
      const folder = {
        project: key("folder", location),
        worktree: key("workspace", location),
        projectName: safeName(location),
        worktreeName: safeName(location),
        method: "folder",
      };
      try {
        const actual = await realpath(location);
        if (!(await stat(actual)).isDirectory()) return null;
        const environment = Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith("GIT_"),
          ),
        );
        const { stdout } = await run(
          "git",
          [
            "-C",
            actual,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--show-toplevel",
          ],
          {
            timeout: 1500,
            maxBuffer: 16_384,
            env: {
              ...environment,
              GIT_OPTIONAL_LOCKS: "0",
              GIT_TERMINAL_PROMPT: "0",
            },
          },
        );
        const lines = stdout.trim().split("\n");
        if (lines.length !== 2 || !lines.every(isAbsolute)) return folder;
        const common = await realpath(lines[0]);
        const root = await realpath(lines[1]);
        const info = await stat(common);
        return {
          project: key(
            "repository",
            `${common}\0${info.dev}:${info.ino}:${info.birthtimeMs}`,
          ),
          worktree: key("workspace", root),
          projectName: safeName(
            common.endsWith("/.git") ? common.slice(0, -5) : common,
          ),
          worktreeName: safeName(root),
          method: "git_observation",
        };
      } catch {
        return folder;
      }
    })();
    cache.set(location, pending);
    return pending;
  };
}
