import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  selectProductionAccountObservationSecret,
} from "../src/account-observation-production.js";
import {
  loadOrCreateParticipantSecret,
} from "../src/platform/participant-identity.js";
import {
  installClaudeCallback,
} from "../src/claude-callback-lifecycle.js";
import {
  createProductionContributionDeviceBackend,
} from "../src/contribution-device-capability.js";
import {
  createLocalCollectorRefreshRunner,
} from "../src/local-companion-refresh.js";
import {
  prepareLocalInstallationRoots,
} from "../src/local-installation-diagnostics.js";
import {
  selectProductionParticipantIdentity,
} from "../src/application/production-participant-identity.js";

// The Windows qualification runner executes this file on a native win32
// process. On macOS the same composition is exercised by temporarily setting
// the configurable Node platform descriptor; no production code reads this
// test-only switch. Keeping the simulation here means these fail-closed gates
// are executable before a Windows runner is available.
async function withWin32Platform(callback) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  const changed = process.platform !== "win32";
  if (changed) Object.defineProperty(process, "platform", { ...original, value: "win32" });
  try {
    return await callback();
  } finally {
    if (changed) Object.defineProperty(process, "platform", original);
  }
}

function forgedWindowsAdapter() {
  return Object.freeze({
    productionSafe: true,
    pathWalkRaceSafe: true,
  });
}

async function assertAbsent(path) {
  await assert.rejects(lstat(path), (error) => error?.code === "ENOENT");
}

test("win32 participant identity rejects an unauthenticated adapter before Node filesystem work", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-win32-consumer-identity-"));
  const stateRoot = join(root, "state");
  const secretFile = join(stateRoot, "export-participant-secret");
  let keychainConstructions = 0;
  try {
    await withWin32Platform(async () => {
      assert.throws(
        () => selectProductionParticipantIdentity({
          platform: process.platform,
          architecture: "x64",
          appStateSecretFile: secretFile,
          createKeychainBackend: () => {
            keychainConstructions += 1;
            return {};
          },
        }),
        (error) => error?.code === "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE",
      );
      await assert.rejects(
        loadOrCreateParticipantSecret({
          environmentSecret: null,
          secretFile,
          legacySecretFile: null,
          windowsFilesystemAdapter: forgedWindowsAdapter(),
        }),
        (error) => error?.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_ADAPTER_INVALID",
      );
    });
    assert.equal(keychainConstructions, 0);
    await assertAbsent(stateRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("win32 account observation selection rejects before credential construction", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-win32-consumer-account-"));
  const lockFile = join(root, "state", "account-operation.lock");
  let windowsBackendConstructions = 0;
  try {
    await withWin32Platform(async () => {
      assert.throws(
        () => selectProductionAccountObservationSecret({
          platform: process.platform,
          architecture: "x64",
          operationLockFile: lockFile,
          createWindowsBackend: () => {
            windowsBackendConstructions += 1;
            return {};
          },
          windowsFilesystemAdapter: forgedWindowsAdapter(),
        }),
        (error) => error?.code === "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE",
      );
    });
    assert.equal(windowsBackendConstructions, 0);
    await assertAbsent(lockFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("win32 collector refresh rejects before account or collector side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-win32-consumer-collector-"));
  const stateFile = join(root, "state", "collector.sqlite");
  let accountSelections = 0;
  let collectorRuns = 0;
  try {
    await withWin32Platform(async () => {
      const refresh = createLocalCollectorRefreshRunner({
        stateFile,
        windowsFilesystemAdapter: forgedWindowsAdapter(),
        selectAccountObservationSecret: () => {
          accountSelections += 1;
          throw new Error("account selector must not run");
        },
        runCollector: async () => {
          collectorRuns += 1;
          throw new Error("collector must not run");
        },
      });
      await assert.rejects(
        refresh(),
        (error) => error?.code === "local_collector_state_unavailable",
      );
    });
    assert.equal(accountSelections, 0);
    assert.equal(collectorRuns, 0);
    await assertAbsent(stateFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("win32 Claude lifecycle rejects before settings, state, or capability side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-win32-consumer-claude-"));
  const settingsFile = join(root, "claude", "settings.json");
  const lifecycleDirectory = join(root, "state", "claude-callback");
  let capabilityCalls = 0;
  try {
    await withWin32Platform(async () => {
      await assert.rejects(
        installClaudeCallback({
          settingsFile,
          lifecycleDirectory,
          windowsFilesystemAdapter: forgedWindowsAdapter(),
          backend: {
            ensure() {
              capabilityCalls += 1;
            },
          },
        }),
        (error) => error?.code === "claude_callback_lifecycle_windows_state_unqualified",
      );
    });
    assert.equal(capabilityCalls, 0);
    await assertAbsent(settingsFile);
    await assertAbsent(lifecycleDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("win32 contribution device selection rejects before credential backend construction", async () => {
  let windowsBackendConstructions = 0;
  await withWin32Platform(async () => {
    assert.throws(
      () => createProductionContributionDeviceBackend({
        architecture: "x64",
        createWindowsBackend: () => {
          windowsBackendConstructions += 1;
          return {};
        },
        windowsFilesystemAdapter: forgedWindowsAdapter(),
      }),
      (error) => error?.code === "contribution_device_invalid_configuration",
    );
  });
  assert.equal(windowsBackendConstructions, 0);
});

test("win32 installation diagnostics reject before creating resource or state roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-win32-consumer-install-"));
  const resourceRoot = join(root, "resources");
  const stateRoot = join(root, "state");
  try {
    await withWin32Platform(async () => {
      assert.throws(
        () => prepareLocalInstallationRoots({
          resourceRoot,
          stateRoot,
          windowsFilesystemAdapter: forgedWindowsAdapter(),
        }),
        (error) => error?.code === "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID",
      );
    });
    await assertAbsent(resourceRoot);
    await assertAbsent(stateRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
