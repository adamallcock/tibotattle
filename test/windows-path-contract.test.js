import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, win32 } from "node:path";
import test from "node:test";

import {
  defaultExportSecretFile,
  defaultExportStateDirectory,
} from "../src/platform/participant-identity.js";
import {
  inspectLocalOnboarding,
  prepareLocalInstallationRoots,
} from "../src/local-installation-diagnostics.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import { createLocalCodexLogScanner } from "../src/application/local-codex-log-scanner.js";
import { createLocalCodexLogPorts } from "../src/platform/local-codex-log-ports.js";

const UNIFIED_INDEX_CONTRACT = "usage-event-v0.2";
const NATIVE_WINDOWS = process.platform === "win32";

function rolloutRecords({ sessionId, timestamp, inputTokens }) {
  const total = {
    input_tokens: inputTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 2,
    total_tokens: inputTokens + 10,
  };
  return [
    {
      timestamp,
      type: "session_meta",
      payload: { id: sessionId, origin: "terminal" },
    },
    {
      timestamp,
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: total,
          last_token_usage: total,
        },
      },
    },
  ];
}

test("Windows application-state paths are deterministic on every host", () => {
  const home = "D:\\Profiles\\Ada Lovelace-测试";
  assert.equal(
    defaultExportStateDirectory({ platform: "win32", homeDirectory: home, environment: {} }),
    "D:\\Profiles\\Ada Lovelace-测试\\AppData\\Local\\app-usagemonitor",
  );
  assert.equal(
    defaultExportSecretFile({
      platform: "win32",
      homeDirectory: home,
      environment: { LOCALAPPDATA: "E:\\Local Data\\用户" },
    }),
    "E:\\Local Data\\用户\\app-usagemonitor\\export-participant-secret",
  );
  assert.equal(
    win32.relative("C:\\State Root", "c:\\state root\\private\\queue.sqlite3"),
    "private\\queue.sqlite3",
  );
});

test("Windows UNC and WSL path grammar is deterministic on every host", () => {
  const cases = [
    {
      path: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\ada\\工作\\.codex",
      root: "\\\\wsl.localhost\\Ubuntu-24.04\\",
      relative: "home\\ada\\工作\\.codex",
    },
    {
      path: "\\\\wsl$\\Ubuntu-24.04\\home\\ada\\工作\\.codex",
      root: "\\\\wsl$\\Ubuntu-24.04\\",
      relative: "home\\ada\\工作\\.codex",
    },
    {
      path: "\\\\fileserver\\Codex Profiles\\Ada 测试\\.codex",
      root: "\\\\fileserver\\Codex Profiles\\",
      relative: "Ada 测试\\.codex",
    },
  ];
  for (const fixture of cases) {
    assert.equal(win32.isAbsolute(fixture.path), true, fixture.path);
    assert.equal(win32.normalize(fixture.path), fixture.path, fixture.path);
    assert.equal(win32.parse(fixture.path).root, fixture.root, fixture.path);
    assert.equal(win32.basename(fixture.path), ".codex", fixture.path);
    assert.equal(
      win32.relative(fixture.root, fixture.path),
      fixture.relative,
      fixture.path,
    );
  }

  // This proves Windows path parsing without touching a network provider. A
  // real \\wsl.localhost filesystem qualification remains a separate native
  // Windows/WSL test because only Windows can distinguish a running distro,
  // a stopped distro, access denial, and an unavailable UNC server.
});

test("native Windows roots combine drive-letter history invariantly and retain partial coverage", {
  skip: !NATIVE_WINDOWS,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "Tibo Tattle Windows 路径 "));
  const resourceRoot = join(root, "Program Files", "TiboTattle resources");
  const localAppData = join(root, "Local AppData 用户");
  const stateRoot = defaultExportStateDirectory({
    platform: "win32",
    homeDirectory: join(root, "Profile"),
    environment: { LOCALAPPDATA: localAppData },
  });
  const codexHomes = [
    join(root, "Custom Codex Home A", ".codex"),
    join(root, "Custom Codex Home 二", ".codex"),
  ];
  const configuredRoots = codexHomes.map((path, index) => ({
    path,
    id: `native-drive-root-${index}`,
  }));
  try {
    assert.match(root, /^[A-Za-z]:\\/u);
    await mkdir(resourceRoot, { recursive: true });
    for (const [index, codexHome] of codexHomes.entries()) {
      const sessions = join(codexHome, "sessions");
      await mkdir(sessions, { recursive: true });
      await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
      const records = rolloutRecords({
        sessionId: index === 0
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222",
        timestamp: `2026-08-23T12:0${index}:00.000Z`,
        inputTokens: 100 + index,
      });
      await writeFile(
        join(sessions, `rollout-2026-08-23T12-0${index}-00-root-${index}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
    }
    const installation = prepareLocalInstallationRoots({ resourceRoot, stateRoot });
    assert.equal(isAbsolute(installation.stateRoot), true);
    assert.equal(relative(stateRoot, installation.paths.collectorStateFile).startsWith(".."), false);
    assert.throws(
      () => prepareLocalInstallationRoots({
        resourceRoot,
        stateRoot: parse(stateRoot).root,
      }),
      { code: "USAGE_MONITOR_LOCAL_INSTALLATION_INVALID" },
    );
    const onboarding = await inspectLocalOnboarding({
      codexHome: codexHomes[0],
      stateRoot,
      customCodexHomeConfigured: true,
    });
    assert.equal(onboarding.capabilities.customCodexHomeConfigured, true);
    assert.equal(JSON.stringify(onboarding).includes(root), false);

    const ingest = (roots) => ingestLocalUnifiedIndexIncrement({
      codexHomes: roots,
      indexFile: installation.paths.unifiedIndexFile,
      secretFile: installation.paths.unifiedIndexSecretFile,
      contractVersion: UNIFIED_INDEX_CONTRACT,
    });
    const initial = await ingest(configuredRoots);
    assert.equal(initial.totalUsageEvents, 2);
    assert.deepEqual(initial.rootCoverage, {
      status: "ready",
      configuredRoots: 2,
      availableRoots: 2,
      emptyRoots: 0,
      unavailableRoots: 0,
      retainedHistory: false,
      unavailableOwnerSources: 0,
      ambiguousSources: 0,
    });

    const reversed = await ingest([...configuredRoots].reverse());
    assert.equal(reversed.unchanged, true);
    assert.equal(reversed.generation.id, initial.generation.id);
    assert.equal(reversed.totalUsageEvents, 2);
    assert.deepEqual(reversed.rootCoverage, initial.rootCoverage);

    const unavailableRoot = codexHomes[1];
    const parkedRoot = `${unavailableRoot}-temporarily-unavailable`;
    await rename(unavailableRoot, parkedRoot);
    const partial = await ingest([...configuredRoots].reverse());
    assert.equal(partial.totalUsageEvents, 2);
    assert.deepEqual(partial.rootCoverage, {
      status: "partial",
      configuredRoots: 2,
      availableRoots: 1,
      emptyRoots: 0,
      unavailableRoots: 1,
      retainedHistory: true,
      unavailableOwnerSources: 1,
      ambiguousSources: 0,
    });
    const serializedCoverage = JSON.stringify(partial.rootCoverage);
    assert.equal(serializedCoverage.includes(root), false);
    assert.equal(serializedCoverage.includes(unavailableRoot), false);
    assert.equal(serializedCoverage.includes("native-drive-root"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native Windows Codex discovery rejects a selected root junction", {
  skip: !NATIVE_WINDOWS,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "Tibo Tattle junction qualification "));
  const directRoot = join(root, "Direct Codex Home", ".codex");
  const aliasedRoot = join(root, "Selected Codex Home Alias");
  try {
    await mkdir(join(directRoot, "sessions"), { recursive: true });
    await symlink(directRoot, aliasedRoot, "junction");
    const scanner = createLocalCodexLogScanner(createLocalCodexLogPorts({
      environment: {},
      homeDirectory: root,
    }));
    const infos = await scanner.discoverCodexRolloutInfos({
      codexHomes: [{ path: aliasedRoot, id: "native-junction-root" }],
      startAt: "2026-08-22T00:00:00.000Z",
      endAt: "2026-08-24T00:00:00.000Z",
    });
    assert.deepEqual([...infos], []);
    assert.deepEqual(infos.rootCoverage, {
      status: "unavailable",
      configuredRoots: 1,
      availableRoots: 0,
      emptyRoots: 0,
      unavailableRoots: 1,
      retainedHistory: false,
      unavailableOwnerSources: 0,
      ambiguousSources: 0,
    });
    assert.equal(JSON.stringify(infos.rootCoverage).includes(aliasedRoot), false);
    assert.equal(JSON.stringify(infos.rootCoverage).includes("native-junction-root"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
