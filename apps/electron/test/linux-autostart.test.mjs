import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LINUX_AUTOSTART_CONTRACT,
  LINUX_AUTOSTART_DESKTOP_FILE,
  LinuxAutostartError,
  buildLinuxAutostartDesktopEntry,
  createLinuxAutostartOwner,
} from "../linux-autostart.js";

async function fixture({ failpoint = async () => {} } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tibotattle-linux-autostart-")),
  );
  const configRoot = join(root, "config");
  const executablePath = join(root, "Tibo Tattle $` binary");
  await mkdir(configRoot, { mode: 0o700 });
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(executablePath, 0o700);
  const owner = createLinuxAutostartOwner({
    platform: "linux",
    configRoot,
    executablePath,
    failpoint,
  });
  return {
    root,
    configRoot,
    executablePath,
    autostartDirectory: join(configRoot, "autostart"),
    entryPath: join(configRoot, "autostart", LINUX_AUTOSTART_DESKTOP_FILE),
    owner,
  };
}

function autostartError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxAutostartError, true);
    assert.equal(error.code, `linux_autostart_${code}`);
    assert.equal(error.message, "Linux autostart operation failed");
    return true;
  };
}

test("Linux autostart is dormant and round-trips in an uncontended owner-only fixture", async () => {
  const value = await fixture();
  try {
    assert.deepEqual(await value.owner.status(), {
      contractVersion: LINUX_AUTOSTART_CONTRACT,
      status: "disabled",
      canSet: true,
    });
    assert.equal(await lstat(value.autostartDirectory).catch(() => null), null);

    assert.equal((await value.owner.enable()).status, "enabled");
    const entry = await readFile(value.entryPath, "utf8");
    assert.equal(value.owner.productionSafe, false);
    assert.equal(entry, buildLinuxAutostartDesktopEntry(value.executablePath));
    assert.match(entry, /^Exec=".*" --autostart$/mu);
    assert.doesNotMatch(entry, /(?:^|\s)(?:sh|bash)\s+-c(?:\s|$)/u);
    assert.match(entry, /\\\$\\`/u);
    const stats = await lstat(value.entryPath);
    assert.equal(stats.isFile(), true);
    assert.equal(stats.nlink, 1);
    assert.equal(stats.mode & 0o077, 0);
    assert.equal((await value.owner.status()).status, "enabled");
    assert.equal((await value.owner.enable()).status, "enabled");

    assert.equal((await value.owner.disable()).status, "disabled");
    assert.equal(await lstat(value.entryPath).catch(() => null), null);
    assert.equal((await value.owner.remove()).status, "disabled");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Linux autostart preserves a safe malformed entry without treating ownership as authority", async () => {
  const value = await fixture();
  try {
    await value.owner.enable();
    await writeFile(value.entryPath, "[Desktop Entry]\nExec=/tmp/other\n", {
      mode: 0o600,
    });
    assert.deepEqual(await value.owner.status(), {
      contractVersion: LINUX_AUTOSTART_CONTRACT,
      status: "malformed",
      canSet: false,
    });
    assert.equal(
      await readFile(value.entryPath, "utf8"),
      "[Desktop Entry]\nExec=/tmp/other\n",
    );
    await assert.rejects(value.owner.enable(), autostartError("entry_unsafe"));
    await assert.rejects(value.owner.disable(), autostartError("entry_unsafe"));
    assert.equal(
      await readFile(value.entryPath, "utf8"),
      "[Desktop Entry]\nExec=/tmp/other\n",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Linux autostart rejects symlink and hard-link entries without touching their targets", async () => {
  const value = await fixture();
  try {
    await mkdir(value.autostartDirectory, { mode: 0o700 });
    const sentinel = join(value.root, "sentinel");
    await writeFile(sentinel, "do-not-change", { mode: 0o600 });
    await symlink(sentinel, value.entryPath);
    assert.deepEqual(await value.owner.status(), {
      contractVersion: LINUX_AUTOSTART_CONTRACT,
      status: "unsafe",
      canSet: false,
    });
    await assert.rejects(value.owner.enable(), autostartError("entry_unsafe"));
    await assert.rejects(value.owner.disable(), autostartError("entry_unsafe"));
    assert.equal(await readFile(sentinel, "utf8"), "do-not-change");

    await rm(value.entryPath);
    await link(sentinel, value.entryPath);
    assert.equal((await value.owner.status()).status, "unsafe");
    await assert.rejects(value.owner.disable(), autostartError("entry_unsafe"));
    assert.equal(await readFile(sentinel, "utf8"), "do-not-change");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Linux autostart rejects unsafe executable replacement during publication", async () => {
  let value;
  value = await fixture({
    failpoint: async (stage) => {
      if (stage !== "before_publish") return;
      const parked = `${value.executablePath}.parked`;
      await rename(value.executablePath, parked);
      await writeFile(value.executablePath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      await chmod(value.executablePath, 0o700);
    },
  });
  try {
    await assert.rejects(
      value.owner.enable(),
      autostartError("executable_replaced"),
    );
    assert.equal(await lstat(value.entryPath).catch(() => null), null);
    const names = await import("node:fs/promises").then(({ readdir }) =>
      readdir(value.autostartDirectory));
    assert.deepEqual(names, []);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Linux autostart detects target replacement races and leaves attacker bytes untouched", async () => {
  let value;
  let attackerPath;
  value = await fixture({
    failpoint: async (stage) => {
      if (stage !== "before_publish") return;
      attackerPath = join(value.root, "attacker-entry");
      await writeFile(attackerPath, "attacker-bytes", { mode: 0o600 });
      await rename(attackerPath, value.entryPath);
    },
  });
  try {
    await mkdir(value.autostartDirectory, { mode: 0o700 });
    await assert.rejects(value.owner.enable(), autostartError("entry_replaced"));
    assert.equal(await readFile(value.entryPath, "utf8"), "attacker-bytes");
    const names = await import("node:fs/promises").then(({ readdir }) =>
      readdir(value.autostartDirectory));
    assert.deepEqual(names, [LINUX_AUTOSTART_DESKTOP_FILE]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Linux autostart rejects shell field codes, relative roots, and permissive directories", async () => {
  assert.throws(
    () => buildLinuxAutostartDesktopEntry("/opt/Tibo%U"),
    autostartError("executable_path_invalid"),
  );
  assert.throws(
    () => createLinuxAutostartOwner({
      platform: "linux",
      configRoot: "relative",
      executablePath: "/opt/TiboTattle",
    }),
    autostartError("config_root_invalid"),
  );

  const value = await fixture();
  try {
    await chmod(value.configRoot, 0o777);
    const status = await value.owner.status();
    assert.deepEqual(status, {
      contractVersion: LINUX_AUTOSTART_CONTRACT,
      status: "unsafe",
      canSet: false,
    });
    assert.equal(JSON.stringify(status).includes(value.configRoot), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Linux autostart requires writable owner-only roots and canonical executable ancestry", async () => {
  const readOnly = await fixture();
  try {
    await chmod(readOnly.configRoot, 0o500);
    assert.deepEqual(await readOnly.owner.status(), {
      contractVersion: LINUX_AUTOSTART_CONTRACT,
      status: "unsafe",
      canSet: false,
    });
  } finally {
    await chmod(readOnly.configRoot, 0o700).catch(() => {});
    await rm(readOnly.root, { recursive: true, force: true });
  }

  const aliased = await fixture();
  try {
    const realDirectory = join(aliased.root, "real-bin");
    const aliasDirectory = join(aliased.root, "alias-bin");
    const executable = join(realDirectory, "TiboTattle");
    await mkdir(realDirectory, { mode: 0o700 });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    await symlink(realDirectory, aliasDirectory);
    const owner = createLinuxAutostartOwner({
      platform: "linux",
      configRoot: aliased.configRoot,
      executablePath: join(aliasDirectory, "TiboTattle"),
    });
    assert.deepEqual(await owner.status(), {
      contractVersion: LINUX_AUTOSTART_CONTRACT,
      status: "unsafe",
      canSet: false,
    });
  } finally {
    await rm(aliased.root, { recursive: true, force: true });
  }

  const wrongExecuteBit = await fixture();
  try {
    await chmod(wrongExecuteBit.executablePath, 0o010);
    assert.deepEqual(await wrongExecuteBit.owner.status(), {
      contractVersion: LINUX_AUTOSTART_CONTRACT,
      status: "unsafe",
      canSet: false,
    });
  } finally {
    await chmod(wrongExecuteBit.executablePath, 0o700).catch(() => {});
    await rm(wrongExecuteBit.root, { recursive: true, force: true });
  }
});
