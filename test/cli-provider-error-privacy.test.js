import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CodexAppServerError } from "../src/providers/codex/account.js";
import { formatCliError } from "../src/cli.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("CLI error formatting uses fixed messages for app-server failures", () => {
  const canary = "synthetic provider prompt and /private/session/path token-canary";
  const error = new CodexAppServerError("request_failed", canary, {
    cause: new Error(canary),
  });
  assert.equal(formatCliError(error), "Codex app-server request failed");
  assert.equal(
    formatCliError(new CodexAppServerError("future-provider-code", canary)),
    "Codex app-server operation failed",
  );
  assert.equal(formatCliError({ message: canary }), "Unknown error");
});

test("doctor CLI never prints provider error text or terminal controls", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-provider-error-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const fakeProvider = join(directory, "fake-provider.mjs");
  const spawnRedirect = join(directory, "spawn-redirect.mjs");
  const responseFile = join(directory, "rpc-error.json");
  await writeFile(fakeProvider, `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") process.exitCode = 2;
else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    const response = request.method === "initialize"
      ? { id: request.id, result: {} }
      : { id: request.id, error: JSON.parse(readFileSync(process.env.CODEX_FAKE_RESPONSE_FILE, "utf8")) };
    process.stdout.write(JSON.stringify(response) + "\\n");
  });
}
`);
  await writeFile(spawnRedirect, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const originalSpawn = childProcess.spawn;
childProcess.spawn = function redirectSyntheticCodex(file, args, options) {
  if (file === process.execPath && Array.isArray(args)
      && args.length === 1 && args[0] === "app-server"
      && typeof process.env.CODEX_FAKE_PROVIDER_SCRIPT === "string") {
    return originalSpawn.call(this, file, [process.env.CODEX_FAKE_PROVIDER_SCRIPT, ...args], options);
  }
  return originalSpawn.call(this, file, args, options);
};
syncBuiltinESMExports();
`);

  const promptCanary = "PROMPT-SYNTH-CANARY";
  const pathCanary = "/Users/synthetic-private/project/session.jsonl";
  const tokenCanary = "sk-test-SYNTHETIC-CANARY";
  const controlCanary = `\r\n\u001b[31m${promptCanary}\u001b[0m\u001b]0;${pathCanary}\u0007`;
  const payloads = [
    { code: -32000, message: `${promptCanary} ${pathCanary} ${tokenCanary} ${controlCanary}` },
    { code: -32000, message: { prompt: promptCanary, path: pathCanary, token: tokenCanary } },
    { code: -32000, message: null },
    { code: 9_007_199_254_740_992, message: tokenCanary },
    { code: -32000, message: `${"x".repeat(96 * 1024)}${promptCanary}` },
  ];

  for (const payload of payloads) {
    await writeFile(responseFile, JSON.stringify(payload));
    const env = {
      PATH: process.env.PATH ?? process.env.Path ?? "",
      HOME: directory,
      TMPDIR: directory,
      TEMP: directory,
      TMP: directory,
      CODEX_BIN: process.execPath,
      CODEX_FAKE_PROVIDER_SCRIPT: fakeProvider,
      CODEX_FAKE_RESPONSE_FILE: responseFile,
    };
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot) env.SystemRoot = systemRoot;
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(spawnRedirect).href, CLI_PATH, "doctor"], {
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.equal(result.error, undefined, "synthetic CLI process failed to run");
    assert.equal(result.status, 1, "doctor should report the synthetic provider failure");
    assert.equal(result.stderr.trim(), "usage-monitor: Codex app-server request failed");
    assert.equal(output.includes(promptCanary), false, "prompt text escaped to CLI output");
    assert.equal(output.includes(pathCanary), false, "private path escaped to CLI output");
    assert.equal(output.includes(tokenCanary), false, "token text escaped to CLI output");
    assert.equal(output.includes("\u001b"), false, "terminal controls escaped to CLI output");
    assert.equal(Buffer.byteLength(output) < 2_048, true, "provider output caused oversized CLI output");
  }

  const fakeProviderSource = await readFile(fakeProvider, "utf8");
  assert.equal(fakeProviderSource.includes(promptCanary), false, "test helper unexpectedly contains a canary");
});
