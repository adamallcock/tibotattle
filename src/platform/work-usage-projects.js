import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
const run = promisify(execFile);

// An identity only: this URL is never requested or included in report output.
export function normalizeWorkUsageRepositoryOrigin(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const scp = /^([\w.-]+)@([^/:]+):(.+)$/u.exec(value);
    const url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : value);
    if (!["https:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return null;
    const parts = url.pathname.replace(/\/+$/u, "").split("/").slice(1).map(decodeURIComponent);
    if (parts.length < 2 || parts.some(part => !part || part === "." || part === ".." || /[\u0000-\u0020\u007f/\\]/u.test(part))) return null;
    parts[parts.length - 1] = parts.at(-1).replace(/\.git$/u, "");
    if (!parts.at(-1)) return null;
    const defaultPort = (url.protocol === "ssh:" && url.port === "22") || (url.protocol === "git:" && url.port === "9418");
    const port = url.port && !defaultPort ? `:${url.port}` : "";
    return `https://${url.hostname.toLowerCase()}${port}/${parts.map(encodeURIComponent).join("/")}`;
  } catch { return null; }
}

export function createWorkUsageProjectResolver({
  digest,
  maximum = 10_000,
  repositoryOrigins = new Map(),
} = {}) {
  const cache = new Map();
  const originCache = new Map();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const gitOptions = {
    timeout: 1500,
    maxBuffer: 16_384,
    env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  };
  const safeName = (path) => basename(path).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 120) || null;
  const originIdentity = (origin) => ({
    project: digest("repository-origin", origin),
    projectName: safeName(decodeURIComponent(new URL(origin).pathname)),
  });
  return async function resolveProject(cwd) {
    if (typeof cwd !== "string" || !isAbsolute(cwd) || /[\u0000-\u001f\u007f]/u.test(cwd)) return null;
    const location = resolve(cwd);
    if (cache.has(location)) return cache.get(location);
    if (cache.size >= maximum)
      throw Object.assign(new Error("work_usage_capacity_exceeded"), {
        code: "work_usage_capacity_exceeded",
      });
    const pending = (async () => {
      const nonProject = {
        project: "non-project",
        worktree: digest("workspace", location),
        projectName: "Non-project tasks",
        worktreeName: safeName(location),
        method: "non_project",
      };
      let actual;
      try {
        actual = await realpath(location);
        if (!(await stat(actual)).isDirectory()) return null;
      } catch (error) {
        const retained = error.code === "ENOENT"
          ? normalizeWorkUsageRepositoryOrigin(repositoryOrigins.get(location)) : null;
        return retained ? { ...nonProject, ...originIdentity(retained), method: "retained_git_origin" } : nonProject;
      }
      try {
        const { stdout } = await run("git", [
          "-C", actual, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel",
        ], gitOptions);
        const lines = stdout.trim().split("\n");
        if (lines.length !== 2 || !lines.every(isAbsolute)) return nonProject;
        const common = await realpath(lines[0]);
        const root = await realpath(lines[1]);
        const info = await stat(common);
        if (!originCache.has(common)) {
          originCache.set(common, run("git", ["-C", root, "config", "--get", "remote.origin.url"], gitOptions)
            .then(({ stdout: origin }) => normalizeWorkUsageRepositoryOrigin(origin.trim()), () => null));
        }
        const origin = await originCache.get(common);
        return {
          ...(origin ? originIdentity(origin) : {
            project: digest("repository", `${common}\0${info.dev}:${info.ino}:${info.birthtimeMs}`),
            projectName: safeName(common.endsWith("/.git") ? common.slice(0, -5) : common),
          }),
          worktree: digest("workspace", root),
          worktreeName: safeName(root),
          method: "git_observation",
        };
      } catch { return nonProject; }
    })();
    cache.set(location, pending);
    return pending;
  };
}
