#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TARGETS = Object.freeze({
  arm64: Object.freeze({
    dockerfile: "containers/electron-linux/Dockerfile",
    platform: "linux/arm64",
    tag: "tibotattle-electron-linux:test",
  }),
  amd64: Object.freeze({
    dockerfile: "containers/electron-linux-amd64/Dockerfile",
    platform: "linux/amd64",
    tag: "tibotattle-electron-linux-amd64:test",
  }),
});

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: capture ? "utf8" : undefined,
    shell: false,
    stdio: capture ? ["ignore", "pipe", "ignore"] : "inherit",
  });
  if (result.error || result.status !== 0 || result.signal !== null) return null;
  return capture ? result.stdout : true;
}

function parseArguments(args) {
  let architecture = null;
  let noCache = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--architecture" && architecture === null) {
      architecture = args[index + 1] ?? null;
      index += 1;
    } else if (args[index] === "--no-cache" && noCache === false) {
      noCache = true;
    } else {
      return null;
    }
  }
  if (!Object.hasOwn(TARGETS, architecture)) return null;
  return Object.freeze({ architecture, noCache });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) return fail("LINUX_CONTAINER_BUILD_ARGUMENTS_INVALID");
  const status = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { capture: true },
  );
  if (status === null) return fail("LINUX_CONTAINER_BUILD_SOURCE_STATUS_UNAVAILABLE");
  if (status.length !== 0) return fail("LINUX_CONTAINER_BUILD_REQUIRES_CLEAN_SOURCE");
  const revisionOutput = run("git", ["rev-parse", "HEAD"], { capture: true });
  const revision = revisionOutput?.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(revision ?? "")) {
    return fail("LINUX_CONTAINER_BUILD_REVISION_INVALID");
  }
  const target = TARGETS[options.architecture];
  const buildArguments = [
    "build",
    `--platform=${target.platform}`,
    "--file",
    target.dockerfile,
    "--tag",
    target.tag,
    "--build-arg",
    `TIBOTATTLE_QUALIFICATION_REVISION=${revision}`,
  ];
  if (options.noCache) buildArguments.push("--no-cache");
  buildArguments.push(".");
  if (run("docker", buildArguments) === null) {
    return fail("LINUX_CONTAINER_BUILD_FAILED");
  }
  const embeddedRevision = run("docker", [
    "image",
    "inspect",
    "--format",
    "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}",
    target.tag,
  ], { capture: true })?.trim().toLowerCase();
  if (embeddedRevision !== revision) {
    return fail("LINUX_CONTAINER_BUILD_REVISION_MISMATCH");
  }
  return undefined;
}

main();
