#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(
  new URL("./native-network-audit-interpose.c", import.meta.url),
);
const MAXIMUM_LIBRARY_BYTES = 4 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function parseArgs(argv) {
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      output = resolve(argv[++index] ?? "");
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (!output) fail("--output is required");
  return { output };
}

function compile(source, output, temporaryDirectory) {
  const result = spawnSync("/usr/bin/xcrun", [
    "clang",
    "-dynamiclib",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fno-ident",
    "-arch",
    "arm64",
    "-mmacosx-version-min=13.0",
    "-Wl,-install_name,@rpath/libusage_monitor_network_audit.dylib",
    "-Wl,-dead_strip",
    "-o",
    output,
    source,
  ], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: temporaryDirectory,
    },
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`Native network audit compilation failed: ${result.stderr || result.stdout}`);
  }
}

async function main(argv) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("Native network audit builds require macOS arm64");
  }
  const { output } = parseArgs(argv);
  const outputParent = dirname(output);
  await mkdir(outputParent, { recursive: true, mode: 0o700 });
  const requestedParentMetadata = lstatSync(outputParent);
  if (!requestedParentMetadata.isDirectory()
      || requestedParentMetadata.isSymbolicLink()) {
    fail("Native audit output parent must not be a symbolic link");
  }
  const realOutputParent = await realpath(outputParent);
  const parentMetadata = lstatSync(realOutputParent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    fail("Native audit output parent must be a real directory");
  }
  const source = await realpath(SOURCE);
  const temporaryDirectory = await mkdtemp(
    join(realOutputParent, ".usage-monitor-native-audit-build-"),
  );
  const temporaryOutput = join(temporaryDirectory, basename(output));
  try {
    compile(source, temporaryOutput, temporaryDirectory);
    const metadata = lstatSync(temporaryOutput);
    if (!metadata.isFile()
        || metadata.isSymbolicLink()
        || metadata.size <= 0
        || metadata.size > MAXIMUM_LIBRARY_BYTES) {
      fail("Compiled native network audit library was not a bounded regular file");
    }
    await chmod(temporaryOutput, 0o500);
    try {
      await link(temporaryOutput, output);
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail("Native network audit output already exists");
      }
      throw error;
    }
    const publishedMetadata = lstatSync(output);
    if (!publishedMetadata.isFile()
        || publishedMetadata.isSymbolicLink()
        || (publishedMetadata.mode & 0o077) !== 0
        || publishedMetadata.size !== metadata.size) {
      fail("Published native network audit library failed its final safety check");
    }
    console.log("Native network audit library: built");
    console.log(`Bytes: ${publishedMetadata.size}`);
    console.log(`SHA-256: ${await sha256File(output)}`);
    console.log("Coverage: macOS libc IP sockets and resolver entrypoints");
    console.log("Direct syscall instructions, QUIC frameworks, and child processes: not measured");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`build-native-network-audit: ${error.message}`);
  process.exitCode = 1;
});
