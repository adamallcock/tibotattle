import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";

const script = new URL("./collection-control.mjs", import.meta.url);
const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(workerDirectory, "node_modules", ".bin", "wrangler");

function run(root, action, extra = []) {
  return spawnSync(process.execPath, [
    script.pathname,
    "--persist-to", join(root, "state"),
    "--action", action,
    ...extra,
  ], {
    cwd: workerDirectory,
    encoding: "utf8",
  });
}

test("collection controls are local-only, independent, and explicitly restored", async () => {
  const root = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-collection-control-",
  ));
  try {
    const remote = spawnSync(process.execPath, [
      script.pathname,
      "--remote",
      "--action", "inspect",
    ], { cwd: workerDirectory, encoding: "utf8" });
    assert.equal(remote.status, 2);
    assert.equal(
      remote.stderr,
      "Remote collection control is deliberately unsupported\n",
    );

    const unconfirmed = run(root, "restore-all");
    assert.equal(unconfirmed.status, 2);
    assert.equal(
      unconfirmed.stderr,
      "Restoration requires --confirm RESTORE_COLLECTION\n",
    );

    const migrated = spawnSync(wrangler, [
      "d1", "migrations", "apply", "USAGE_MONITOR_DB",
      "--local",
      "--persist-to", join(root, "state"),
    ], {
      cwd: workerDirectory,
      encoding: "utf8",
    });
    assert.equal(migrated.status, 0);

    const initial = run(root, "inspect");
    assert.equal(initial.status, 0);
    assert.deepEqual(JSON.parse(initial.stdout), {
      schemaVersion: "collection-controls-v0.1",
      state: "operational",
      revision: 1,
      enrollment: true,
      uploadRegistration: true,
      processing: true,
      publication: true,
      target: "local",
    });

    const paused = run(root, "pause-processing");
    assert.equal(paused.status, 0);
    assert.deepEqual(JSON.parse(paused.stdout), {
      schemaVersion: "collection-controls-v0.1",
      state: "degraded",
      revision: 2,
      enrollment: true,
      uploadRegistration: true,
      processing: false,
      publication: true,
      target: "local",
    });

    const contained = run(root, "contain-all");
    assert.equal(contained.status, 0);
    assert.deepEqual(JSON.parse(contained.stdout), {
      schemaVersion: "collection-controls-v0.1",
      state: "contained",
      revision: 3,
      enrollment: false,
      uploadRegistration: false,
      processing: false,
      publication: false,
      target: "local",
    });

    const restored = run(root, "restore-all", [
      "--confirm", "RESTORE_COLLECTION",
    ]);
    assert.equal(restored.status, 0);
    assert.deepEqual(JSON.parse(restored.stdout), {
      schemaVersion: "collection-controls-v0.1",
      state: "operational",
      revision: 4,
      enrollment: true,
      uploadRegistration: true,
      processing: true,
      publication: true,
      target: "local",
    });
    assert.equal(
      `${initial.stdout}${paused.stdout}${contained.stdout}${restored.stdout}`
        .includes(root),
      false,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
