import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageProductionAssets } from "./stage-production-assets.mjs";

function git(root, arguments_) {
  return execFileSync("/usr/bin/git", ["-C", root, ...arguments_], {
    encoding: "utf8",
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-worker-assets-"));
  const source = join(root, "apps", "web", "public");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.html"), "tracked release asset\n");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Worker asset test"]);
  git(root, ["add", "apps/web/public/index.html"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return { root, source, destination: join(root, ".release-build", "worker-assets") };
}

test("stages only committed public assets", async () => {
  const { root, source, destination } = await fixture();
  await writeFile(join(source, "untracked.html"), "must not deploy\n");
  await assert.rejects(
    stageProductionAssets({
      repositoryRoot: root,
      sourceDirectory: source,
      destinationDirectory: destination,
    }),
    /clean, committed release tree/u,
  );
  // A clean checkout produces the tracked file tree and no recursive working
  // directory upload can include an untracked sibling.
  git(root, ["clean", "-f", "--", "apps/web/public/untracked.html"]);
  const result = await stageProductionAssets({
    repositoryRoot: root,
    sourceDirectory: source,
    destinationDirectory: destination,
  });
  assert.equal(result.files, 1);
  assert.equal(
    await readFile(join(destination, "index.html"), "utf8"),
    "tracked release asset\n",
  );
  await assert.rejects(readFile(join(destination, "untracked.html"), "utf8"));
});
