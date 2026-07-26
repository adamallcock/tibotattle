import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/build-prospective-collector-transitions.js");

function run(input, output) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--input", input,
    "--output", output,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
}

test("prospective CLI writes an owner-only deterministic empty evidence artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-prospective-cli-"));
  try {
    const input = join(directory, "collector.jsonl");
    const firstOutput = join(directory, "first.json");
    const secondOutput = join(directory, "second.json");
    await writeFile(input, "", { mode: 0o600 });
    const first = run(input, firstOutput);
    const second = run(input, secondOutput);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(firstOutput, "utf8"), await readFile(secondOutput, "utf8"));
    assert.equal((await stat(firstOutput)).mode & 0o777, 0o600);
    assert.match(first.stdout, /^Built 0 account-partitioned prospective transitions/u);
    assert.equal(first.stdout.includes(input), false);
    assert.equal(first.stdout.includes(firstOutput), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prospective CLI refuses symlinked and non-owner-only sources without echoing paths", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode and symlink policy");
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-prospective-cli-"));
  try {
    const input = join(directory, "collector.jsonl");
    const linked = join(directory, "linked.jsonl");
    const output = join(directory, "output.json");
    await writeFile(input, "", { mode: 0o600 });
    await symlink(input, linked);
    const symbolic = run(linked, output);
    assert.equal(symbolic.status, 1);
    assert.equal(symbolic.stderr, "prospective source must be a single-link regular file\n");
    assert.equal(symbolic.stderr.includes(linked), false);

    await chmod(input, 0o644);
    const loose = run(input, output);
    assert.equal(loose.status, 1);
    assert.equal(loose.stderr, "prospective source must be owner-only\n");
    assert.equal(loose.stderr.includes(input), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
