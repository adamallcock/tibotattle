import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./migrate-local.mjs", import.meta.url));

test("local migration applies one resolved state path to both D1 bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-migrate-check-"));
  try {
    const bin = join(root, "node_modules", ".bin");
    const calls = join(root, "calls.jsonl");
    await mkdir(bin, { recursive: true });
    const fakeWrangler = join(bin, "wrangler");
    await writeFile(
      fakeWrangler,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
      { mode: 0o700 },
    );
    await chmod(fakeWrangler, 0o700);

    const result = spawnSync(
      process.execPath,
      [script, "--persist-to", "isolated/state"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    const invocations = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const expectedState = resolve(await realpath(root), "isolated/state");
    assert.deepEqual(invocations, [
      [
        "d1", "migrations", "apply", "USAGE_MONITOR_DB", "--local",
        "--persist-to", expectedState,
      ],
      [
        "d1", "migrations", "apply", "DELETION_LEDGER", "--local",
        "--persist-to", expectedState,
      ],
    ]);

    const remote = spawnSync(
      process.execPath,
      [script, "--remote"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(remote.status, 2);
    assert.match(remote.stderr, /refuses --remote/u);
    assert.equal(
      (await readFile(calls, "utf8")).trim().split("\n").length,
      2,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
