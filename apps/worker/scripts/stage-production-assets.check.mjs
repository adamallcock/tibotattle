import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
  const source = join(root, ".release-build", "public-release-site");
  await mkdir(source, { recursive: true });
  await writeFile(join(root, ".gitignore"), ".release-build/\n");
  const generatedFiles = {
    "community.js": "console.log('community');\n",
    "index.html": '<!doctype html><script type="module" src="./community.js"></script>\n',
    "styles.css": "body { color: green; }\n",
    "tibotattle-icon.png": Buffer.from("reviewed public brand asset\n"),
  };
  const manifest = {
    schemaVersion: "usage-monitor-release-site-manifest-v0.2",
    files: [],
  };
  for (const [path, contents] of Object.entries(generatedFiles)) {
    await writeFile(join(source, path), contents);
    const bytes = Buffer.from(contents);
    manifest.files.push({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(
    join(source, "release-site-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Worker asset test"]);
  git(root, ["add", ".gitignore"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return {
    root,
    source,
    destination: join(root, ".release-build", "worker-assets"),
    generatedFiles,
  };
}

async function updateManifestRow(source, path) {
  const manifestPath = join(source, "release-site-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const contents = await readFile(join(source, path));
  const row = manifest.files.find((entry) => entry.path === path);
  row.bytes = contents.length;
  row.sha256 = createHash("sha256").update(contents).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("stages only verified generated public assets and maps the community entry to the site index", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));

  await writeFile(join(value.source, "admin.js"), "must not deploy\n");
  await assert.rejects(
    stageProductionAssets({
      repositoryRoot: value.root,
      sourceDirectory: value.source,
      destinationDirectory: value.destination,
    }),
    /local-only asset/u,
  );
  await rm(join(value.source, "admin.js"));

  await writeFile(join(value.source, "data-client.js"), "local client surface\n");
  await assert.rejects(
    stageProductionAssets({
      repositoryRoot: value.root,
      sourceDirectory: value.source,
      destinationDirectory: value.destination,
    }),
    /local-only asset/u,
  );
  await rm(join(value.source, "data-client.js"));

  const indexPath = join(value.source, "index.html");
  const originalIndex = await readFile(indexPath, "utf8");
  await writeFile(indexPath, `${originalIndex}\n${[
    "/app.js",
    "/data-client.js",
    "/navigation.js",
    "/admin/",
    "/app-open/",
    "/sign-in/",
    "/contribution/",
    'id="contribution-submit"',
  ].join("\n")}\n`);
  await updateManifestRow(value.source, "index.html");
  await assert.rejects(
    stageProductionAssets({
      repositoryRoot: value.root,
      sourceDirectory: value.source,
      destinationDirectory: value.destination,
    }),
    /local-only route or control/u,
  );
  await writeFile(indexPath, originalIndex);
  await updateManifestRow(value.source, "index.html");

  await writeFile(join(value.root, "working-change.txt"), "must block staging\n");
  await assert.rejects(
    stageProductionAssets({
      repositoryRoot: value.root,
      sourceDirectory: value.source,
      destinationDirectory: value.destination,
    }),
    /clean, committed release tree/u,
  );
  await rm(join(value.root, "working-change.txt"));

  const result = await stageProductionAssets({
    repositoryRoot: value.root,
    sourceDirectory: value.source,
    destinationDirectory: value.destination,
  });
  assert.equal(result.files, 5);
  assert.equal(
    await readFile(join(value.destination, "index.html"), "utf8"),
    value.generatedFiles["index.html"],
  );
  assert.equal(
    await readFile(join(value.destination, "release-site-manifest.json"), "utf8"),
    await readFile(join(value.source, "release-site-manifest.json"), "utf8"),
  );
  assert.deepEqual(
    await readFile(join(value.destination, "tibotattle-icon.png")),
    value.generatedFiles["tibotattle-icon.png"],
  );
  for (const withheld of [
    "admin.js",
    "app.js",
    "community.html",
    "data-client.js",
    "install-cta.js",
    "navigation.js",
  ]) {
    await assert.rejects(
      readFile(join(value.destination, withheld), "utf8"),
      { code: "ENOENT" },
      withheld,
    );
  }
});
