#!/usr/bin/env node
/**
 * Start (or stop) the disposable PostgreSQL 17 server that the hosted-backend
 * CI jobs test against, and print the two environment profiles the PostgreSQL
 * specs read.
 *
 * Image: the official postgres image pinned to the exact linux/amd64 child
 * manifest digest of 17.11-bookworm (multi-platform index
 * sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652,
 * source docker-library/postgres@2603e26e245e558218728ee14e0a42dcb020dc7f,
 * resolved 2026-09-26). Changing it is a reviewed supply-chain change.
 *
 * Boundary:
 * - The server runs as the caller's uid:gid with /etc/passwd mounted
 *   read-only, so the data and socket directories stay owned by the caller.
 * - The socket directory is /private/tmp/tibotattle-pg-ci/socket at mode 0700;
 *   the specs refuse any other shape. It is mounted at a container path the
 *   image entrypoint never touches: that entrypoint runs
 *   `chmod 03775 /var/run/postgresql`, which would loosen a mount there. The
 *   directory is stat'ed again after start and CI_SOCKET_DIR_MODE_CHANGED
 *   fails the job unless it is still a 0700, caller-owned, non-symlink
 *   directory.
 * - The server also listens in the image's own /var/run/postgresql, which is
 *   not mounted and so stays inside the container: the entrypoint's init step
 *   runs psql with PGHOST emptied, which only finds the default directory.
 * - Readiness waits for the entrypoint's init-complete marker and an
 *   in-container pg_isready, so the temporary init server is never mistaken
 *   for the final one. The host then connects over the socket with the Worker's
 *   pg package and requires server_version_num 17xxxx and
 *   inet_server_addr() IS NULL.
 * - Trust authentication is confined to this disposable container; TCP is
 *   published only on 127.0.0.1:55432. No password is set or printed.
 *
 * Fallback (not used): if the image ever refuses an arbitrary uid or loosens
 * the socket mode, install the PGDG postgresql-17 apt package pinned to an
 * exact version and run initdb/pg_ctl as the runner user over the same
 * directories. Record the switch in .github/workflows/hosted-backend.yml.
 *
 * Linux x86_64 with Docker only; other hosts fail CI_POSTGRES_PLATFORM_UNSUPPORTED
 * rather than produce partial proof. `/private/tmp` must already exist as a
 * root-owned sticky directory (the workflow creates it with sudo).
 *
 * Usage:
 *   node scripts/ci-postgres-container.mjs [--export-socket-profile]
 *   node scripts/ci-postgres-container.mjs --stop
 */

import { spawnSync } from "node:child_process";
import { appendFile, chmod, lstat, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export const POSTGRES_IMAGE =
  "postgres:17.11-bookworm@sha256:91eb910c44c7ed13f7f1a4ccadaa9ca72ef14cddc04cacb6e070e48eb44731a3";
export const POSTGRES_IMAGE_PLATFORM = "linux/amd64";
export const CONTAINER_NAME = "tibotattle-pg-ci";
export const PRIVATE_TMP_DIRECTORY = "/private/tmp";
export const CI_WORK_DIRECTORY = "/private/tmp/tibotattle-pg-ci";
export const CONTAINER_SOCKET_DIRECTORY = "/tibotattle-pg-socket";
// Container-internal only (never mounted); required by the entrypoint's init psql.
export const IMAGE_DEFAULT_SOCKET_DIRECTORY = "/var/run/postgresql";
export const CONTAINER_DATA_DIRECTORY = "/var/lib/postgresql/data";
export const POSTGRES_PORT = 5432;
export const LOOPBACK_PUBLISH = "127.0.0.1:55432:5432";
export const READINESS_TIMEOUT_MS = 60_000;
export const READINESS_POLL_MS = 500;
export const INIT_COMPLETE_MARKER = "PostgreSQL init process complete; ready for start up.";

export class CiPostgresError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CiPostgresError";
    this.code = code;
  }
}

export function ciPostgresProfiles(socketDirectory = join(CI_WORK_DIRECTORY, "socket")) {
  return Object.freeze({
    socket: Object.freeze({
      PG_TEST_SOCKET: socketDirectory,
      PG_TEST_PORT: String(POSTGRES_PORT),
    }),
    host: Object.freeze({
      PG_TEST_HOST: socketDirectory,
      PG_TEST_PORT: String(POSTGRES_PORT),
    }),
  });
}

export function dockerRunArguments({
  uid,
  gid,
  workDirectory = CI_WORK_DIRECTORY,
  image = POSTGRES_IMAGE,
}) {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new CiPostgresError("CI_POSTGRES_IDENTITY_INVALID", "uid and gid must be non-negative integers");
  }
  return Object.freeze([
    "run",
    "--detach",
    "--name", CONTAINER_NAME,
    "--platform", POSTGRES_IMAGE_PLATFORM,
    "--user", `${uid}:${gid}`,
    "--shm-size", "256m",
    "--volume", "/etc/passwd:/etc/passwd:ro",
    "--volume", `${join(workDirectory, "data")}:${CONTAINER_DATA_DIRECTORY}`,
    "--volume", `${join(workDirectory, "socket")}:${CONTAINER_SOCKET_DIRECTORY}`,
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    "--publish", LOOPBACK_PUBLISH,
    image,
    "-c", `unix_socket_directories=${CONTAINER_SOCKET_DIRECTORY},${IMAGE_DEFAULT_SOCKET_DIRECTORY}`,
    "-c", `port=${POSTGRES_PORT}`,
    "-c", "fsync=off",
  ]);
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return { status: 127, stdout: "", stderr: String(result.error.message) };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Require a real, caller-owned directory at exactly mode 0700. */
export async function verifyPrivateDirectory(path, { uid, code }) {
  const metadata = await lstatOrNull(path);
  if (metadata === null
      || metadata.isSymbolicLink()
      || !metadata.isDirectory()
      || metadata.uid !== uid
      || (metadata.mode & 0o7777) !== 0o700) {
    const mode = metadata === null ? "missing" : (metadata.mode & 0o7777).toString(8).padStart(4, "0");
    throw new CiPostgresError(code, `${path} must be a caller-owned 0700 directory (found ${mode})`);
  }
  return metadata;
}

export async function prepareCiWorkDirectory({
  workDirectory = CI_WORK_DIRECTORY,
  privateTmpDirectory = PRIVATE_TMP_DIRECTORY,
  privateTmpOwnerUid = 0,
  uid,
}) {
  if (dirname(workDirectory) !== privateTmpDirectory
      || !basename(workDirectory).startsWith("tibotattle-pg-")) {
    throw new CiPostgresError("CI_WORK_DIRECTORY_INVALID",
      "the work directory must be a tibotattle-pg-* child of the private tmp directory");
  }
  const tmp = await lstatOrNull(privateTmpDirectory);
  if (tmp === null) {
    throw new CiPostgresError("CI_PRIVATE_TMP_MISSING", `${privateTmpDirectory} does not exist`);
  }
  if (tmp.isSymbolicLink()
      || !tmp.isDirectory()
      || tmp.uid !== privateTmpOwnerUid
      || ((tmp.mode & 0o002) !== 0 && (tmp.mode & 0o1000) === 0)) {
    throw new CiPostgresError("CI_PRIVATE_TMP_UNSAFE",
      `${privateTmpDirectory} must be a root-owned directory that is sticky when world-writable`);
  }
  try {
    await mkdir(workDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new CiPostgresError("CI_WORK_DIRECTORY_EXISTS",
        `${workDirectory} already exists; remove the previous run's directory first`);
    }
    throw error;
  }
  const socketDirectory = join(workDirectory, "socket");
  const dataDirectory = join(workDirectory, "data");
  await mkdir(socketDirectory, { mode: 0o700 });
  await mkdir(dataDirectory, { mode: 0o700 });
  for (const directory of [workDirectory, socketDirectory, dataDirectory]) {
    await chmod(directory, 0o700);
    await verifyPrivateDirectory(directory, { uid, code: "CI_WORK_DIRECTORY_UNSAFE" });
  }
  return Object.freeze({ workDirectory, socketDirectory, dataDirectory });
}

function containerExists(run) {
  const result = run("docker", [
    "ps", "--all", "--quiet", "--filter", `name=^/${CONTAINER_NAME}$`,
  ]);
  if (result.status !== 0) {
    throw new CiPostgresError("CI_DOCKER_UNAVAILABLE", "docker ps failed");
  }
  return result.stdout.trim() !== "";
}

export async function waitForReady({
  run,
  sleep = delay,
  now = Date.now,
  timeoutMs = READINESS_TIMEOUT_MS,
  pollMs = READINESS_POLL_MS,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = run("docker", ["inspect", "--format", "{{.State.Status}}", CONTAINER_NAME]);
    const status = state.stdout.trim();
    if (state.status !== 0 || (status !== "running" && status !== "created")) {
      throw new CiPostgresError("CI_POSTGRES_CONTAINER_EXITED",
        `container state is ${status || "unknown"}`);
    }
    const logs = run("docker", ["logs", CONTAINER_NAME]);
    const initialized = `${logs.stdout}\n${logs.stderr}`.includes(INIT_COMPLETE_MARKER);
    if (initialized) {
      const ready = run("docker", [
        "exec", CONTAINER_NAME,
        "pg_isready", "--host", CONTAINER_SOCKET_DIRECTORY, "--port", String(POSTGRES_PORT), "--quiet",
      ]);
      if (ready.status === 0) return;
    }
    if (now() >= deadline) {
      throw new CiPostgresError("CI_POSTGRES_READINESS_TIMEOUT",
        `PostgreSQL was not ready within ${timeoutMs} ms`);
    }
    await sleep(pollMs);
  }
}

function defaultCreateClient(config) {
  return new pg.Client(config);
}

/** Host-side proof: PostgreSQL 17 reached over the Unix socket, not TCP. */
export async function verifyServer({
  socketDirectory,
  port = POSTGRES_PORT,
  createClient = defaultCreateClient,
}) {
  const client = createClient({
    host: socketDirectory,
    port,
    user: "postgres",
    database: "postgres",
    ssl: false,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  let row;
  try {
    const result = await client.query(
      "SELECT current_setting('server_version_num') AS server_version_num, inet_server_addr() IS NULL AS unix_socket",
    );
    row = result.rows[0];
  } finally {
    await client.end();
  }
  const version = String(row?.server_version_num ?? "");
  if (!/^17[0-9]{4}$/u.test(version)) {
    throw new CiPostgresError("CI_POSTGRES_VERSION_UNEXPECTED",
      `server_version_num ${JSON.stringify(version)} is not PostgreSQL 17`);
  }
  if (row.unix_socket !== true) {
    throw new CiPostgresError("CI_POSTGRES_NOT_UNIX_SOCKET",
      "inet_server_addr() must be NULL over the private socket");
  }
  return Object.freeze({ serverVersionNum: version });
}

export async function startCiPostgres({
  platform = process.platform,
  arch = process.arch,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
  workDirectory = CI_WORK_DIRECTORY,
  privateTmpDirectory = PRIVATE_TMP_DIRECTORY,
  privateTmpOwnerUid = 0,
  run = defaultRun,
  createClient = defaultCreateClient,
  sleep = delay,
  now = Date.now,
  timeoutMs = READINESS_TIMEOUT_MS,
} = {}) {
  if (platform !== "linux" || arch !== "x64") {
    throw new CiPostgresError("CI_POSTGRES_PLATFORM_UNSUPPORTED",
      `the CI PostgreSQL container requires Linux x86_64 with Docker (found ${platform}/${arch})`);
  }
  if (containerExists(run)) {
    throw new CiPostgresError("CI_POSTGRES_CONTAINER_EXISTS",
      `a ${CONTAINER_NAME} container already exists; run --stop first`);
  }
  const { socketDirectory } = await prepareCiWorkDirectory({
    workDirectory, privateTmpDirectory, privateTmpOwnerUid, uid,
  });
  const pull = run("docker", ["pull", "--platform", POSTGRES_IMAGE_PLATFORM, POSTGRES_IMAGE]);
  if (pull.status !== 0) {
    throw new CiPostgresError("CI_POSTGRES_IMAGE_PULL_FAILED", "docker pull of the pinned image failed");
  }
  const started = run("docker", dockerRunArguments({ uid, gid, workDirectory }));
  if (started.status !== 0) {
    throw new CiPostgresError("CI_POSTGRES_CONTAINER_START_FAILED", "docker run failed");
  }
  await waitForReady({ run, sleep, now, timeoutMs });
  await verifyPrivateDirectory(socketDirectory, { uid, code: "CI_SOCKET_DIR_MODE_CHANGED" });
  const server = await verifyServer({ socketDirectory, createClient });
  await verifyPrivateDirectory(socketDirectory, { uid, code: "CI_SOCKET_DIR_MODE_CHANGED" });
  return Object.freeze({
    status: "ready",
    image: POSTGRES_IMAGE,
    container: CONTAINER_NAME,
    serverVersionNum: server.serverVersionNum,
    socketDirectory,
    profiles: ciPostgresProfiles(socketDirectory),
  });
}

/** Remove the container only; the work directory is left for inspection. */
export function stopCiPostgres({ run = defaultRun } = {}) {
  if (!containerExists(run)) return Object.freeze({ status: "absent", container: CONTAINER_NAME });
  const removed = run("docker", ["rm", "--force", CONTAINER_NAME]);
  if (removed.status !== 0) {
    throw new CiPostgresError("CI_POSTGRES_STOP_FAILED", "docker rm failed");
  }
  return Object.freeze({ status: "stopped", container: CONTAINER_NAME });
}

/** Append only the SOCKET profile to a GitHub Actions environment file. */
export async function exportSocketProfile(profiles, githubEnvironmentFile) {
  if (typeof githubEnvironmentFile !== "string" || !isAbsolute(githubEnvironmentFile)) {
    throw new CiPostgresError("CI_GITHUB_ENV_UNAVAILABLE", "GITHUB_ENV must name an absolute file");
  }
  const lines = Object.entries(profiles.socket).map(([key, value]) => {
    if (/[\r\n]/u.test(value)) {
      throw new CiPostgresError("CI_POSTGRES_PROFILE_INVALID", `${key} contains a line break`);
    }
    return `${key}=${value}\n`;
  });
  await appendFile(githubEnvironmentFile, lines.join(""), "utf8");
}

async function main(argv, { run = defaultRun } = {}) {
  const known = new Set(["--stop", "--export-socket-profile"]);
  const unknown = argv.find((argument) => !known.has(argument));
  if (unknown !== undefined) {
    throw new CiPostgresError("CI_POSTGRES_USAGE", `unknown argument ${unknown}`);
  }
  if (argv.includes("--stop")) {
    if (argv.length !== 1) throw new CiPostgresError("CI_POSTGRES_USAGE", "--stop takes no other flags");
    process.stdout.write(`${JSON.stringify(stopCiPostgres({ run }))}\n`);
    return;
  }
  let result;
  try {
    result = await startCiPostgres({ run });
  } catch (error) {
    if (error instanceof CiPostgresError && error.code !== "CI_POSTGRES_CONTAINER_EXISTS") {
      const logs = run("docker", ["logs", "--tail", "200", CONTAINER_NAME]);
      if (logs.status === 0) {
        process.stderr.write(`--- ${CONTAINER_NAME} logs ---\n${logs.stdout}${logs.stderr}\n`);
      }
    }
    throw error;
  }
  if (argv.includes("--export-socket-profile")) {
    await exportSocketProfile(result.profiles, process.env.GITHUB_ENV);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof CiPostgresError ? error.code : "CI_POSTGRES_FAILED";
    const message = error instanceof CiPostgresError ? error.message : String(error?.message ?? error);
    process.stderr.write(`${JSON.stringify({ status: "error", code, message })}\n`);
    process.exitCode = 1;
  }
}
