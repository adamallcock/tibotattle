import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  LINUX_SECRET_SERVICE_CAPABILITIES,
  createLinuxSecretServiceBackend,
} from "../src/platform/linux-secret-service.js";
import {
  LinuxSecretServiceQualificationError,
  runLinuxSecretServiceQualification,
  startLinuxSecretServiceDaemon,
} from "../scripts/qualify-linux-secret-service.mjs";

const ISOLATED_ENVIRONMENT = Object.freeze({
  TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED: "1",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/session-bus",
  HOME: "/synthetic/home",
  XDG_CACHE_HOME: "/synthetic/cache",
  XDG_CONFIG_HOME: "/synthetic/config",
  XDG_DATA_HOME: "/synthetic/data",
  XDG_RUNTIME_DIR: "/synthetic/runtime",
});

function qualificationError(code) {
  return (error) => {
    assert.equal(error instanceof LinuxSecretServiceQualificationError, true);
    assert.equal(error.code, `linux_secret_service_qualification_${code}`);
    assert.equal(error.message, "Linux Secret Service qualification failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

function key(service, account) {
  return `${service}\u0000${account}`;
}

function memoryBinding({
  corruptWrite = 0,
  failReadAt = 0,
  hangReadAt = 0,
  hangWriteAt = 0,
  retainDelete = false,
  entries = [],
} = {}) {
  const values = new Map(entries.map(([capability, value]) => [
    key(capability.service, capability.account),
    value,
  ]));
  const calls = [];
  let writes = 0;
  let reads = 0;
  return {
    calls,
    values,
    async getPassword(service, account) {
      reads += 1;
      calls.push(["getPassword", service, account]);
      if (reads === hangReadAt) return new Promise(() => {});
      if (reads === failReadAt) throw new Error("INJECTED-READ-FAILURE");
      return values.get(key(service, account)) ?? null;
    },
    async setPassword(service, account, value) {
      writes += 1;
      calls.push(["setPassword", service, account, value]);
      values.set(
        key(service, account),
        writes === corruptWrite ? Buffer.alloc(32, 249).toString("base64url") : value,
      );
      if (writes === hangWriteAt) return new Promise(() => {});
    },
    async deletePassword(service, account) {
      calls.push(["deletePassword", service, account]);
      if (retainDelete) return true;
      return values.delete(key(service, account));
    },
  };
}

function qualificationBackend(binding) {
  return createLinuxSecretServiceBackend({
    platform: "linux",
    architecture: "x64",
    binding,
    sessionProbe: () => "available",
  });
}

function deterministicRandomSource() {
  const outputs = [];
  let fill = 1;
  return {
    outputs,
    source(size) {
      assert.equal(size, 32);
      const value = Buffer.alloc(size, fill);
      fill += 1;
      outputs.push(value);
      return value;
    },
  };
}

function successDaemon() {
  return Object.freeze({ status: "started" });
}

function successIsolationProbe() {
  return Object.freeze({ status: "isolated" });
}

test("qualification starts gnome-keyring with fixed args, newline stdin, and suppressed output", () => {
  let captured;
  const outcome = startLinuxSecretServiceDaemon({
    environment: {
      ...ISOLATED_ENVIRONMENT,
      UNREVIEWED_SECRET: "must-not-be-inherited",
    },
    isolationProbe: successIsolationProbe,
    spawn(command, arguments_, options) {
      captured = {
        command,
        arguments_,
        input: Buffer.from(options.input),
        env: { ...options.env },
        shell: options.shell,
        stdio: options.stdio,
        timeout: options.timeout,
        killSignal: options.killSignal,
      };
      return { status: 0 };
    },
  });
  assert.deepEqual(outcome, { status: "started" });
  assert.equal(captured.command, "/usr/bin/gnome-keyring-daemon");
  assert.deepEqual(captured.arguments_, ["--components=secrets", "--unlock"]);
  assert.deepEqual(captured.input, Buffer.from("\n"));
  assert.equal(captured.shell, false);
  assert.deepEqual(captured.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(captured.timeout, 10_000);
  assert.equal(captured.killSignal, "SIGKILL");
  assert.equal(captured.env.DBUS_SESSION_BUS_ADDRESS, ISOLATED_ENVIRONMENT.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(Object.hasOwn(captured.env, "UNREVIEWED_SECRET"), false);
  assert.equal(Object.hasOwn(captured.env, "TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED"), false);
});

test("qualification daemon reports only fixed unavailable and failure codes", () => {
  assert.throws(
    () => startLinuxSecretServiceDaemon({
      environment: ISOLATED_ENVIRONMENT,
      isolationProbe: successIsolationProbe,
      spawn: () => ({ status: null, error: { code: "ENOENT", message: "PATH-CANARY" } }),
    }),
    qualificationError("daemon_unavailable"),
  );
  assert.throws(
    () => startLinuxSecretServiceDaemon({
      environment: ISOLATED_ENVIRONMENT,
      isolationProbe: successIsolationProbe,
      spawn: () => ({ status: 1, stderr: "DAEMON-CANARY" }),
    }),
    qualificationError("daemon_failed"),
  );
});

test("native qualification rejects a caller-controlled isolation marker", async () => {
  let spawnCalls = 0;
  assert.throws(
    () => startLinuxSecretServiceDaemon({
      environment: ISOLATED_ENVIRONMENT,
      spawn() {
        spawnCalls += 1;
        return { status: 0 };
      },
    }),
    qualificationError("isolation_required"),
  );
  assert.equal(spawnCalls, 0);

  let daemonCalls = 0;
  await assert.rejects(
    runLinuxSecretServiceQualification({
      platform: "linux",
      architecture: "x64",
      environment: ISOLATED_ENVIRONMENT,
      startDaemon() {
        daemonCalls += 1;
        return successDaemon();
      },
    }),
    qualificationError("isolation_required"),
  );
  assert.equal(daemonCalls, 0);
});

test("qualification bounds a native backend operation that never settles", async () => {
  const binding = memoryBinding({ hangReadAt: 1 });
  const started = Date.now();
  await assert.rejects(
    runLinuxSecretServiceQualification({
      platform: "linux",
      architecture: "x64",
      environment: ISOLATED_ENVIRONMENT,
      backend: qualificationBackend(binding),
      startDaemon: successDaemon,
      deadlineMs: 20,
    }),
    qualificationError("deadline_exceeded"),
  );
  assert.equal(Date.now() - started < 1_000, true);
});

test("qualification exercises all four lifecycles, confirms cleanup, and emits a closed receipt", async () => {
  const binding = memoryBinding();
  const random = deterministicRandomSource();
  let daemonCalls = 0;
  const receipt = await runLinuxSecretServiceQualification({
    platform: "linux",
    architecture: "x64",
    environment: ISOLATED_ENVIRONMENT,
    backend: qualificationBackend(binding),
    randomSource: random.source,
    startDaemon() {
      daemonCalls += 1;
      return successDaemon();
    },
  });

  assert.equal(daemonCalls, 1);
  assert.deepEqual(receipt, {
    schemaVersion: "linux-credential-qualification-v1",
    status: "passed",
    scope: "development_only",
    platform: "linux",
    architecture: "x64",
    subject: "injected_test",
    capabilities: 4,
    lifecycle: "round_trip_absence_confirmed",
    cleanup: "confirmed",
    leaseCrossProcessSafe: false,
    crashRecoveryComplete: false,
  });
  assert.equal(binding.values.size, 0);
  assert.equal(binding.calls.filter(([method]) => method === "setPassword").length, 8);
  assert.equal(binding.calls.filter(([method]) => method === "deletePassword").length, 4);
  assert.equal(random.outputs.length, 8);
  assert.equal(random.outputs.every((value) => value.equals(Buffer.alloc(32))), true);

  const rendered = JSON.stringify(receipt);
  for (const capability of Object.values(LINUX_SECRET_SERVICE_CAPABILITIES)) {
    assert.equal(rendered.includes(capability.service), false);
    assert.equal(rendered.includes(capability.account), false);
  }
  for (const forbiddenKey of ["service", "account", "path", "secret", "value", "error"]) {
    assert.equal(Object.hasOwn(receipt, forbiddenKey), false);
  }
});

test("qualification never deletes an unconfirmed value after a failed create readback", async () => {
  const binding = memoryBinding({ corruptWrite: 1 });
  const random = deterministicRandomSource();
  await assert.rejects(
    runLinuxSecretServiceQualification({
      platform: "linux",
      architecture: "x64",
      environment: ISOLATED_ENVIRONMENT,
      backend: qualificationBackend(binding),
      randomSource: random.source,
      startDaemon: successDaemon,
    }),
    qualificationError("cleanup_failed"),
  );
  assert.equal(binding.values.size, 1);
  assert.equal(binding.calls.some(([method]) => method === "deletePassword"), false);
  assert.equal(random.outputs.every((value) => value.equals(Buffer.alloc(32))), true);
});

test("qualification failure cleanup removes only the exact helper-owned value", async () => {
  const binding = memoryBinding({ failReadAt: 7 });
  const random = deterministicRandomSource();
  await assert.rejects(
    runLinuxSecretServiceQualification({
      platform: "linux",
      architecture: "x64",
      environment: ISOLATED_ENVIRONMENT,
      backend: qualificationBackend(binding),
      randomSource: random.source,
      startDaemon: successDaemon,
    }),
    qualificationError("lifecycle_failed"),
  );
  assert.equal(binding.values.size, 0);
  assert.equal(binding.calls.filter(([method]) => method === "deletePassword").length, 1);
  assert.equal(random.outputs.every((value) => value.equals(Buffer.alloc(32))), true);
});

test("qualification refuses a preexisting real-looking value without deleting it", async () => {
  const preexisting = Buffer.alloc(32, 201).toString("base64url");
  const capability = LINUX_SECRET_SERVICE_CAPABILITIES.exportIdentity;
  const binding = memoryBinding({ entries: [[capability, preexisting]] });
  let randomCalls = 0;
  await assert.rejects(
    runLinuxSecretServiceQualification({
      platform: "linux",
      architecture: "x64",
      environment: ISOLATED_ENVIRONMENT,
      backend: qualificationBackend(binding),
      randomSource() {
        randomCalls += 1;
        return Buffer.alloc(32, 1);
      },
      startDaemon: successDaemon,
    }),
    qualificationError("store_not_empty"),
  );
  assert.equal(randomCalls, 0);
  assert.equal(binding.values.get(key(capability.service, capability.account)), preexisting);
  assert.equal(binding.calls.some(([method]) => method === "deletePassword"), false);
});

test("qualification gives cleanup failure precedence when exact deletion cannot be confirmed", async () => {
  const binding = memoryBinding({ retainDelete: true });
  await assert.rejects(
    runLinuxSecretServiceQualification({
      platform: "linux",
      architecture: "x64",
      environment: ISOLATED_ENVIRONMENT,
      backend: qualificationBackend(binding),
      randomSource: deterministicRandomSource().source,
      startDaemon: successDaemon,
    }),
    qualificationError("cleanup_failed"),
  );
  assert.equal(binding.values.size > 0, true);
});

test("qualification rejects host, isolation, and bus failures before daemon startup", async () => {
  let daemonCalls = 0;
  const startDaemon = () => {
    daemonCalls += 1;
    return successDaemon();
  };
  for (const [options, code] of [
    [{ platform: "darwin", architecture: "arm64", environment: ISOLATED_ENVIRONMENT }, "unsupported_platform"],
    [{ platform: "linux", architecture: "arm64", environment: ISOLATED_ENVIRONMENT }, "unsupported_architecture"],
    [{ platform: "linux", architecture: "x64", environment: {} }, "isolation_required"],
    [{
      platform: "linux",
      architecture: "x64",
      environment: { TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED: "1" },
    }, "session_bus_required"],
  ]) {
    await assert.rejects(
      runLinuxSecretServiceQualification({ ...options, startDaemon }),
      qualificationError(code),
    );
  }
  assert.equal(daemonCalls, 0);
});

test("qualification rejects hostile random sources and still proves all capabilities absent", async () => {
  const binding = memoryBinding();
  const backend = qualificationBackend(binding);
  await assert.rejects(
    runLinuxSecretServiceQualification({
      platform: "linux",
      architecture: "x64",
      environment: ISOLATED_ENVIRONMENT,
      backend,
      randomSource: () => Buffer.alloc(31),
      startDaemon: successDaemon,
    }),
    qualificationError("random_source_failed"),
  );
  assert.equal(binding.values.size, 0);
});

test("CLI failures contain exactly one fixed code and no stack or native output", () => {
  const result = spawnSync(process.execPath, ["scripts/qualify-linux-secret-service.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {},
  });
  const expected = process.platform !== "linux"
    ? "LINUX_SECRET_SERVICE_QUALIFICATION_UNSUPPORTED_PLATFORM"
    : process.arch !== "x64"
      ? "LINUX_SECRET_SERVICE_QUALIFICATION_UNSUPPORTED_ARCHITECTURE"
      : "LINUX_SECRET_SERVICE_QUALIFICATION_ISOLATION_REQUIRED";
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${expected}\n`);
});

// Run this last: an uncancellable timed-out mutation deliberately leaves its
// in-process capability lease poisoned, matching the fail-closed production
// seam until the disposable process exits.
test("post-mutation deadline reports cleanup as unproven", async () => {
  const binding = memoryBinding({ hangWriteAt: 1 });
  await assert.rejects(
    runLinuxSecretServiceQualification({
      platform: "linux",
      architecture: "x64",
      environment: ISOLATED_ENVIRONMENT,
      backend: qualificationBackend(binding),
      startDaemon: successDaemon,
      deadlineMs: 20,
    }),
    qualificationError("deadline_cleanup_unproven"),
  );
  assert.equal(binding.values.size, 1);
});
