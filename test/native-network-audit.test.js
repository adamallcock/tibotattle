import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const builder = fileURLToPath(
  new URL("../scripts/build-native-network-audit.js", import.meta.url),
);
const supported = process.platform === "darwin" && process.arch === "arm64";

function runBuilder(output) {
  return spawnSync(process.execPath, [builder, "--output", output], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    timeout: 60_000,
  });
}

function auditedProcess(library, receipt, source) {
  return spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      DYLD_INSERT_LIBRARIES: library,
      USAGE_MONITOR_NATIVE_NETWORK_AUDIT_FILE: receipt,
    },
    timeout: 10_000,
  });
}

function sandboxedAuditedProcess(library, receipt, source) {
  return spawnSync("/usr/bin/sandbox-exec", [
    "-p",
    "(version 1) (allow default) (deny network*)",
    "/usr/bin/env",
    `DYLD_INSERT_LIBRARIES=${library}`,
    `USAGE_MONITOR_NATIVE_NETWORK_AUDIT_FILE=${receipt}`,
    process.execPath,
    "-e",
    source,
  ], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    timeout: 10_000,
  });
}

async function buildFixture(root, name = "native-audit.dylib") {
  const library = join(root, name);
  const result = runBuilder(library);
  assert.equal(result.status, 0, result.stderr);
  return library;
}

test("native audit build is deterministic, bounded, owner-only, and no-clobber", {
  skip: !supported,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-native-audit-test-"));
  try {
    const firstDirectory = join(root, "first");
    const secondDirectory = join(root, "second");
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);
    const first = await buildFixture(firstDirectory);
    const second = await buildFixture(secondDirectory);
    assert.deepEqual(await readFile(first), await readFile(second));
    const metadata = await stat(first);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.size > 0, true);
    assert.equal(metadata.size <= 4 * 1024 * 1024, true);
    assert.equal(metadata.mode & 0o077, 0);

    const existing = runBuilder(first);
    assert.notEqual(existing.status, 0);
    assert.match(existing.stderr, /output already exists/u);
    assert.deepEqual(await readFile(first), await readFile(second));

    const linkedDirectory = join(root, "linked");
    await symlink(firstDirectory, linkedDirectory);
    const linked = runBuilder(join(linkedDirectory, "linked.dylib"));
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /output parent must not be a symbolic link/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native audit writes a fixed content-free zero-attempt receipt", {
  skip: !supported,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-native-audit-test-"));
  try {
    const library = await buildFixture(root);
    const receipt = join(root, "receipt.json");
    const result = auditedProcess(library, receipt, "void 0;");
    assert.equal(result.status, 0, result.stderr);
    const serialized = await readFile(receipt, "utf8");
    const value = JSON.parse(serialized);
    assert.equal(
      value.schemaVersion,
      "usage-monitor-native-network-attempt-process-v0.1",
    );
    assert.equal(
      value.instrumentation,
      "macos-dyld-libc-interposition-v0.1",
    );
    assert.equal(value.totalAttempts, 0);
    assert.equal(
      Object.values(value.byCategory).every((count) => count === 0),
      true,
    );
    assert.deepEqual(value.coverage, {
      ipSocketLibc: true,
      dnsLibc: true,
      directSyscallInstruction: false,
      quicFramework: false,
      nonNodeChildProcesses: false,
    });
    const metadata = await stat(receipt);
    assert.equal(metadata.mode & 0o077, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native audit detects loopback TCP and local resolver attempts without retaining targets", {
  skip: !supported,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-native-audit-test-"));
  try {
    const library = await buildFixture(root);
    const receipt = join(root, "receipt.json");
    const result = auditedProcess(library, receipt, `
      const dns = require("node:dns");
      const net = require("node:net");
      const tcp = new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port: 9 });
        socket.once("connect", () => socket.end(resolve));
        socket.once("error", resolve);
      });
      const lookup = new Promise((resolve) => {
        dns.lookup("localhost", () => resolve());
      });
      Promise.all([tcp, lookup]).then(() => {});
    `);
    assert.equal(result.status, 0, result.stderr);
    const serialized = await readFile(receipt, "utf8");
    const value = JSON.parse(serialized);
    assert.equal(value.totalAttempts >= 3, true);
    assert.equal(
      value.byCategory.socketInet + value.byCategory.socketInet6 >= 1,
      true,
    );
    assert.equal(value.byCategory.connect >= 1, true);
    assert.equal(value.byCategory.getaddrinfo >= 1, true);
    for (const canary of [
      "127.0.0.1",
      "localhost",
      String(process.pid),
      process.cwd(),
      receipt,
      library,
    ]) {
      assert.equal(serialized.includes(canary), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native audit loads inside deny-network sandbox without weakening enforcement", {
  skip: !supported,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-native-audit-test-"));
  try {
    const library = await buildFixture(root);
    const receipt = join(root, "receipt.json");
    const result = sandboxedAuditedProcess(library, receipt, "void 0;");
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(await readFile(receipt, "utf8"));
    assert.equal(value.totalAttempts, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native audit never overwrites a caller-owned receipt", {
  skip: !supported,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-native-audit-test-"));
  try {
    const library = await buildFixture(root);
    const receipt = join(root, "receipt.json");
    await writeFile(receipt, "belongs to the caller\n", { mode: 0o600 });
    const result = auditedProcess(library, receipt, "void 0;");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(receipt, "utf8"), "belongs to the caller\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
