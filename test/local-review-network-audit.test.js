import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const preload = fileURLToPath(
  new URL("../scripts/local-review-network-audit-preload.cjs", import.meta.url),
);

function auditedProcess(receipt, source) {
  return spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      USAGE_MONITOR_NETWORK_AUDIT_FILE: receipt,
    },
    timeout: 10_000,
  });
}

async function readReceipt(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("audit receipt records a content-free zero-attempt process", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-network-audit-test-"));
  try {
    const receipt = join(root, "receipt.json");
    const result = auditedProcess(receipt, "void 0;");
    assert.equal(result.status, 0, result.stderr);
    const value = await readReceipt(receipt);
    assert.equal(
      value.schemaVersion,
      "usage-monitor-local-review-network-attempt-process-v0.1",
    );
    assert.equal(value.instrumentation, "node-api-interposition-v0.1");
    assert.equal(value.totalAttempts, 0);
    assert.deepEqual(value.byCategory, {});
    assert.equal(value.truncated, false);
    assert.equal(value.coverage.nativeSyscalls, false);
    assert.equal(value.coverage.nonNodeChildProcesses, false);
    assert.equal(value.coverage.quic, false);
    const metadata = await stat(receipt);
    if (process.platform !== "win32") {
      assert.equal(metadata.mode & 0o077, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global fetch attempts are counted and blocked before transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-network-audit-test-"));
  try {
    const receipt = join(root, "receipt.json");
    const result = auditedProcess(receipt, `
      try {
        fetch("https://PRIVATE_HOST_CANARY.invalid/private-path");
      } catch (error) {
        if (error.code !== "USAGE_MONITOR_NETWORK_ATTEMPT_BLOCKED") process.exitCode = 2;
      }
    `);
    assert.equal(result.status, 0, result.stderr);
    const serialized = await readFile(receipt, "utf8");
    const value = JSON.parse(serialized);
    assert.equal(value.totalAttempts, 1);
    assert.deepEqual(value.byCategory, { "global.fetch": 1 });
    for (const canary of [
      "PRIVATE_HOST_CANARY",
      "private-path",
      process.cwd(),
      String(process.pid),
      receipt,
    ]) {
      assert.equal(serialized.includes(canary), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TCP and DNS attempts are independently counted and blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-network-audit-test-"));
  try {
    const receipt = join(root, "receipt.json");
    const result = auditedProcess(receipt, `
      const net = require("node:net");
      const dns = require("node:dns");
      for (const attempt of [
        () => net.connect({ host: "PRIVATE_TCP_CANARY.invalid", port: 443 }),
        () => dns.lookup("PRIVATE_DNS_CANARY.invalid", () => {}),
      ]) {
        try {
          attempt();
        } catch (error) {
          if (error.code !== "USAGE_MONITOR_NETWORK_ATTEMPT_BLOCKED") process.exitCode = 2;
        }
      }
    `);
    assert.equal(result.status, 0, result.stderr);
    const serialized = await readFile(receipt, "utf8");
    const value = JSON.parse(serialized);
    assert.equal(value.totalAttempts, 2);
    assert.deepEqual(value.byCategory, {
      "dns.lookup": 1,
      "net.connect": 1,
    });
    assert.equal(serialized.includes("PRIVATE_TCP_CANARY"), false);
    assert.equal(serialized.includes("PRIVATE_DNS_CANARY"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit requires an absolute receipt path and never overwrites a receipt", async () => {
  const relative = spawnSync(process.execPath, ["-e", "void 0;"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      USAGE_MONITOR_NETWORK_AUDIT_FILE: "relative-receipt.json",
    },
    timeout: 10_000,
  });
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /requires an absolute receipt path/);

  const root = await mkdtemp(join(tmpdir(), "usage-monitor-network-audit-test-"));
  try {
    const receipt = join(root, "receipt.json");
    await writeFile(receipt, "belongs to the caller\n", { mode: 0o600 });
    const result = auditedProcess(receipt, "void 0;");
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(receipt, "utf8"), "belongs to the caller\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
