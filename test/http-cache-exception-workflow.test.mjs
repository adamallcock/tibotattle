import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Executable shell proof for the Ubuntu OSV job. Platform-neutral exception
// contracts remain in http-cache-exception.test.js and the root test suite.
test("scanner shell retains download, checksum and direct scanner failure status", async () => {
  const workflow = await readFile(new URL("../.github/workflows/osv-scanner.yml", import.meta.url), "utf8");
  const match = workflow.match(/      - name: Run scanner\n        shell: bash\n        run: \|\n((?:          .*\n)+)/);
  assert.ok(match, "direct scanner run block must exist");
  const script = match[1].replace(/^ {10}/gm, "");
  const root = await mkdtemp(join(tmpdir(), "http-cache-scanner-shell-test-"));
  const trace = join(root, "trace");
  try {
    await writeFile(join(root, "curl"), `#!/bin/bash
printf 'download\\n' >> "$TRACE_FILE"
if [[ "$DOWNLOAD_RESULT" != 0 ]]; then exit "$DOWNLOAD_RESULT"; fi
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --output ]]; then target="$2"; break; fi
  shift
done
cat > "$target" <<'SCANNER'
#!/bin/bash
printf 'scan\\n' >> "$TRACE_FILE"
exit "$SCANNER_RESULT"
SCANNER
`, { mode: 0o700 });
    await writeFile(join(root, "sha256sum"), `#!/bin/bash
printf 'checksum\\n' >> "$TRACE_FILE"
cat >/dev/null
exit "$CHECKSUM_RESULT"
`, { mode: 0o700 });
    for (const [download, checksum, scanner, expected, events] of [
      [22, 0, 0, 22, "download\n"],
      [0, 1, 0, 1, "download\nchecksum\n"],
      ...[1, 127, 128, 130, 0].map(code => [0, 0, code, code, "download\nchecksum\nscan\n"]),
    ]) {
      await writeFile(trace, "");
      const result = spawnSync("/bin/bash", ["-c", script], {
        env: { PATH: `${root}:/usr/bin:/bin`, RUNNER_TEMP: root, TRACE_FILE: trace,
          DOWNLOAD_RESULT: String(download), CHECKSUM_RESULT: String(checksum), SCANNER_RESULT: String(scanner) },
        encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, `failure status must survive: ${download}/${checksum}/${scanner}`);
      assert.equal(await readFile(trace, "utf8"), events);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
