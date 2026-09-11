import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LinuxXdgError,
  assertValidatedLinuxXdgRoots,
  revalidateLinuxXdgRoots,
  resolveLinuxXdgRoots,
  validateLinuxXdgRoots,
} from "../src/platform/linux-xdg-paths.js";

function xdgError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxXdgError, true);
    assert.equal(error.code, `linux_xdg_${code}`);
    assert.equal(error.message, "Linux XDG platform boundary is unavailable");
    return true;
  };
}

async function fixture({ runtime = true } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tibotattle-linux-xdg-")),
  );
  const bases = {
    config: join(root, "config"),
    state: join(root, "state"),
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
  };
  for (const base of Object.values(bases)) {
    await mkdir(join(base, "app-usagemonitor"), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(base, 0o700);
    await chmod(join(base, "app-usagemonitor"), 0o700);
  }
  const environment = {
    XDG_CONFIG_HOME: bases.config,
    XDG_STATE_HOME: bases.state,
    XDG_CACHE_HOME: bases.cache,
    ...(runtime ? { XDG_RUNTIME_DIR: bases.runtime } : {}),
  };
  const roots = resolveLinuxXdgRoots({
    platform: "linux",
    homeDirectory: root,
    environment,
  });
  return { root, bases, roots };
}

test("Linux XDG resolution is deterministic and never invents a runtime root", () => {
  const roots = resolveLinuxXdgRoots({
    platform: "linux",
    homeDirectory: "/home/ada",
    environment: {},
  });
  assert.deepEqual(roots.bases, {
    config: "/home/ada/.config",
    state: "/home/ada/.local/state",
    cache: "/home/ada/.cache",
    runtime: null,
  });
  assert.deepEqual(roots.application, {
    config: "/home/ada/.config/app-usagemonitor",
    state: "/home/ada/.local/state/app-usagemonitor",
    cache: "/home/ada/.cache/app-usagemonitor",
    runtime: null,
  });
  assert.equal(roots.autostartDirectory, "/home/ada/.config/autostart");

  assert.throws(
    () => resolveLinuxXdgRoots({
      platform: "linux",
      homeDirectory: "/home/ada",
      environment: { XDG_STATE_HOME: "relative/state" },
    }),
    xdgError("state_root_invalid"),
  );
  assert.throws(
    () => resolveLinuxXdgRoots({
      platform: "darwin",
      homeDirectory: "/home/ada",
      environment: {},
    }),
    xdgError("platform_invalid"),
  );
});

test("Linux XDG configuration rejects accessors and proxies without evaluating them", () => {
  let getterCalls = 0;
  const environment = {};
  Object.defineProperty(environment, "XDG_STATE_HOME", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "/private/state";
    },
  });
  assert.throws(
    () => resolveLinuxXdgRoots({
      platform: "linux",
      homeDirectory: "/home/ada",
      environment,
    }),
    xdgError("configuration_invalid"),
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => resolveLinuxXdgRoots({
      platform: "linux",
      homeDirectory: "/home/ada",
      environment: new Proxy({}, {}),
    }),
    xdgError("configuration_invalid"),
  );
});

test("validated Linux XDG application roots are owner-only opened identities", async () => {
  const value = await fixture();
  try {
    const validation = await validateLinuxXdgRoots(value.roots, {
      platform: "linux",
    });
    assert.equal(validation.runtimeAvailable, true);
    for (const identity of Object.values(validation.identities)) {
      assert.equal(identity.mode & 0o077, 0);
      assert.equal(Number.isInteger(identity.inode), true);
    }
    assert.equal(assertValidatedLinuxXdgRoots(validation), validation);
    assert.equal(await revalidateLinuxXdgRoots(validation), validation);
    await assert.rejects(
      validateLinuxXdgRoots({ ...value.roots }, { platform: "linux" }),
      xdgError("roots_untrusted"),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Linux XDG validation rejects permissive and symlinked application roots", async () => {
  const value = await fixture();
  try {
    await chmod(value.roots.application.state, 0o755);
    await assert.rejects(
      validateLinuxXdgRoots(value.roots, { platform: "linux" }),
      xdgError("directory_mode"),
    );
    await chmod(value.roots.application.state, 0o700);

    const target = join(value.root, "alternate-config");
    await mkdir(target, { mode: 0o700 });
    await rm(value.roots.application.config, { recursive: true });
    await symlink(target, value.roots.application.config, "dir");
    await assert.rejects(
      validateLinuxXdgRoots(value.roots, { platform: "linux" }),
      xdgError("directory_type"),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Linux XDG runtime remains explicitly absent when the session omits it", async () => {
  const value = await fixture({ runtime: false });
  try {
    const validation = await validateLinuxXdgRoots(value.roots, {
      platform: "linux",
    });
    assert.equal(validation.runtimeAvailable, false);
    assert.equal(validation.identities.runtime, null);
    assert.equal(validation.roots.application.runtime, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
