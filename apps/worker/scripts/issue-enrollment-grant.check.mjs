import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const script = new URL("./issue-enrollment-grant.mjs", import.meta.url);

test("grant issuance is local-only, no-clobber, and removes a reserved file after D1 failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-grant-test-"));
  const output = join(root, "invite.secret");
  try {
    const remote = spawnSync(process.execPath, [script.pathname, "--remote"], {
      encoding: "utf8",
    });
    assert.equal(remote.status, 2);
    assert.equal(remote.stderr, "Remote grant issuance is deliberately unsupported\n");

    const failed = spawnSync(process.execPath, [
      script.pathname,
      "--persist-to", join(root, "unmigrated-state"),
      "--output-file", output,
    ], {
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stderr, "Grant issuance failed.\n");
    await assert.rejects(access(output));

    await writeFile(output, "owner-value\n", { encoding: "utf8", mode: 0o600 });
    const noClobber = spawnSync(process.execPath, [
      script.pathname,
      "--persist-to", join(root, "unmigrated-state"),
      "--output-file", output,
    ], {
      encoding: "utf8",
    });
    assert.equal(noClobber.status, 1);
    assert.equal(
      noClobber.stderr,
      "The owner-only invitation output file could not be reserved\n",
    );
    assert.equal(await readFile(output, "utf8"), "owner-value\n");
  } finally {
    await rm(root, { recursive: true });
  }
});
