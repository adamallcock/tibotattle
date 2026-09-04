import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { init, parse } from "es-module-lexer";

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const NODE_AMD64_CHILD_DIGEST =
  "ba2f9edd0785ee291c1a5287764cb41fdb7922336f878993f9d58622613e67a8";
const REPOSITORY_ROOT = resolve(".");
const BUILD_HELPER = resolve("scripts/build-electron-linux-container.mjs");

async function writeExecutable(path, source) {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

async function withFakeBuildCommands({ gitSource, dockerSource }, callback) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "tibotattle-linux-build-helper-"));
  const binDirectory = join(fixtureRoot, "bin");
  await mkdir(binDirectory);
  try {
    await writeExecutable(join(binDirectory, "git"), gitSource);
    await writeExecutable(join(binDirectory, "docker"), dockerSource);
    return await callback({ fixtureRoot, binDirectory });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function runBuildHelper(binDirectory, fixtureRoot, ...args) {
  return spawnSync(process.execPath, [BUILD_HELPER, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      TIBOTATTLE_FAKE_DOCKER_LOG: join(fixtureRoot, "docker.log"),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function resolveLocalModule(importer, specifier) {
  if (typeof specifier !== "string"
      || (!specifier.startsWith("./") && !specifier.startsWith("../"))) {
    return null;
  }
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = extname(unresolved).length > 0
    ? [unresolved]
    : [
      unresolved,
      `${unresolved}.js`,
      `${unresolved}.mjs`,
      `${unresolved}.cjs`,
      join(unresolved, "index.js"),
      join(unresolved, "index.mjs"),
      join(unresolved, "index.cjs"),
    ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const canonical = await realpath(candidate);
      const repositoryRelative = relative(REPOSITORY_ROOT, canonical);
      if (repositoryRelative === ""
          || repositoryRelative === ".."
          || repositoryRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        return null;
      }
      return canonical;
    } catch {
      // Try the next exact Node source candidate.
    }
  }
  return null;
}

async function collectProductionDependencyGraph(entryPaths) {
  await init;
  const pending = entryPaths.map((path) => resolve(REPOSITORY_ROOT, path));
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const extension = extname(current);
    if (![".js", ".mjs", ".cjs"].includes(extension)) continue;
    const source = await readFile(current, "utf8");
    const [imports] = parse(source);
    const specifiers = new Set(imports.map((entry) => entry.n).filter(Boolean));
    for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/gu)) {
      specifiers.add(match[1]);
    }
    for (const specifier of specifiers) {
      const dependency = await resolveLocalModule(current, specifier);
      if (dependency !== null && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return visited;
}

test("Linux AMD64 image pins the reviewed native Node child, GUI, and Secret Service boundary", async () => {
  const dockerfile = await readFile(
    "containers/electron-linux-amd64/Dockerfile",
    "utf8",
  );
  const dockerignore = await readFile(
    "containers/electron-linux-amd64/Dockerfile.dockerignore",
    "utf8",
  );
  assert.match(
    dockerfile,
    new RegExp(`FROM node:26\\.2\\.0-bookworm-slim@sha256:${NODE_AMD64_CHILD_DIGEST}`, "u"),
  );
  assert.equal((dockerfile.match(/^FROM /gmu) ?? []).length, 1);
  assert.match(dockerfile, /exact amd64 child digest[\s\S]*reviewed/u);
  assert.match(dockerfile, /ARG TIBOTATTLE_QUALIFICATION_REVISION/u);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/u);
  assert.match(dockerfile, /TIBOTATTLE_IMAGE_SOURCE_REVISION/u);
  assert.match(dockerfile, /natively on a[\s\S]*x86_64 Linux runner/u);
  assert.match(dockerfile, /development smoke rather than a reproducible release artifact/u);
  assert.match(dockerfile, /pnpm install --frozen-lockfile/u);
  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(dockerfile, /node node_modules\/electron\/install\.js/u);
  assert.match(dockerfile, /ELECTRON_DISABLE_SANDBOX=0/u);
  assert.match(dockerfile, /chmod 4755[\s\S]*chrome-sandbox/u);
  assert.match(dockerfile, /USER node/u);
  assert.match(dockerfile, /xvfb-run/u);
  assert.match(dockerfile, /-nolisten tcp/u);
  assert.match(dockerfile, /dbus-daemon/u);
  assert.match(dockerfile, /gnome-keyring/u);
  assert.match(dockerfile, /libsecret-1-0/u);
  assert.match(dockerfile, /scripts\/qualify-linux-secret-service\.mjs/u);
  assert.match(dockerfile, /scripts\/run-linux-secret-service-qualification\.mjs/u);
  assert.match(dockerfile, /linux-secret-service-qualification-v1/u);
  assert.match(dockerfile, /chmod 0444[\s\S]*linux-secret-service-qualification-v1/u);
  assert.doesNotMatch(dockerfile, /chown -R|chmod -R/u);
  assert.doesNotMatch(dockerfile, /COPY --chown=node:node/u);
  assert.match(dockerfile, /reviewed keytar closure is root-owned/u);
  assert.doesNotMatch(dockerfile, /TARGETPLATFORM|BUILDPLATFORM/u);
  for (const required of [
    "!package.json",
    "!pnpm-lock.yaml",
    "!packages/**",
    "!apps/electron/**",
    "!apps/local/**",
    "!apps/web/public/**",
    "!src/**",
    "!scripts/smoke-electron-linux.mjs",
    "!scripts/qualify-linux-secret-service.mjs",
    "!scripts/run-linux-secret-service-qualification.mjs",
  ]) {
    assert.ok(dockerignore.split("\n").includes(required), `${required} is in the build context`);
  }
});

test("Linux portability workflow is immutable, native x86_64, and development-only", async () => {
  const workflow = await readFile(".github/workflows/linux-portability.yml", "utf8");
  assert.match(workflow, /^name: Linux portability development smoke$/mu);
  assert.match(workflow, /^on:\s*\n\s+workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s+(?:pull_request|push|schedule):/mu);
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /cache-mode:\s*\n\s*- warm\s*\n\s*- clean/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, new RegExp(`actions/checkout@${CHECKOUT_SHA}`, "u"));
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`, "u"));
  assert.match(workflow, new RegExp(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`, "u"));
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gmu)]
    .map((match) => match[1]);
  assert.ok(actions.length >= 3);
  for (const action of actions) {
    assert.match(action, /^[^@]+@[0-9a-f]{40}$/u, `${action} is immutable`);
  }

  assert.match(workflow, /EXPECTED_REVISION: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /git rev-parse HEAD/u);
  assert.match(workflow, /uname -m[\s\S]*x86_64/u);
  assert.match(workflow, /docker info --format '\{\{\.Architecture\}\}'[\s\S]*x86_64/u);
  assert.match(workflow, /docker image inspect --format '\{\{\.Os\}\}\/\{\{\.Architecture\}\}'/u);
  assert.match(workflow, /runtime[\s\S]*process\.platform \+ "\/" \+ process\.arch[\s\S]*linux\/x64/u);
  assert.doesNotMatch(workflow, /setup-qemu-action|qemu-user-static|binfmt/u);

  assert.match(workflow, /Prime the reviewed AMD64 image cache/u);
  assert.match(workflow, /Rebuild the reviewed AMD64 image from the warm cache/u);
  assert.match(workflow, /matrix\.cache-mode == 'warm'/u);
  assert.match(workflow, /matrix\.cache-mode == 'clean'/u);
  assert.match(workflow, /build-electron-linux-container\.mjs --architecture amd64 --no-cache/u);
  assert.equal(
    (workflow.match(/run: pnpm container:electron-linux:build:amd64/gmu) ?? []).length,
    2,
    "warm mode must prime and then rebuild from the same runner-local cache",
  );
  assert.match(workflow, /container:electron-linux:test:amd64/u);
  assert.match(workflow, /container:electron-linux:test:credentials:amd64/u);
  assert.match(workflow, /credential_status=0/u);
  assert.match(workflow, /container:electron-linux:test:credentials:amd64[^\n]*\n\s+\|\| credential_status=\$\?/u);
  assert.match(workflow, /docker ps --all --quiet --filter "ancestor=\$TIBOTATTLE_LINUX_IMAGE"/u);
  assert.match(workflow, /LINUX_PORTABILITY_SECRET_SERVICE_CONTAINER_SURVIVED/u);
  assert.match(workflow, /LINUX_PORTABILITY_CREDENTIAL_QUALIFICATION_FAILED/u);
  assert.ok(
    workflow.indexOf("LINUX_PORTABILITY_SECRET_SERVICE_CONTAINER_SURVIVED")
      < workflow.indexOf("LINUX_PORTABILITY_CREDENTIAL_QUALIFICATION_FAILED"),
    "container survival is checked even when credential qualification fails",
  );
  assert.match(workflow, /run: pnpm test:linux:foundation/u);
  assert.match(workflow, /networkBoundary: "network-none"/u);
  assert.match(workflow, /imagePlatform: "linux\/amd64"/u);
  assert.match(workflow, /runtimeArchitecture: "x64"/u);
  assert.match(workflow, /sourceRevision: process\.env\.TIBOTATTLE_QUALIFICATION_REVISION/u);
  assert.match(workflow, /qualification: "development-only"/u);
  assert.match(workflow, /execution: "native-x86_64"/u);
  assert.match(workflow, /tibotattle-linux-portability-development-v1/u);
  assert.match(workflow, /smokeReceiptSha256/u);
  assert.match(workflow, /credentialReceiptSha256/u);
  assert.match(workflow, /linux-credential-qualification-v1/u);
  assert.match(workflow, /subject: "pinned_native_binding"/u);
  assert.match(workflow, /round_trip_absence_confirmed/u);
  assert.match(workflow, /leaseCrossProcessSafe: false/u);
  assert.match(workflow, /crashRecoveryComplete: false/u);
  assert.match(workflow, /smokeKeys = new Set/u);
  assert.match(workflow, /Object\.keys\(smoke\.startupRefresh\)\.length !== 2/u);
  const degradedBlock = /const degradedCodes = new Set\(\[([\s\S]*?)\]\);/u.exec(workflow);
  assert.ok(degradedBlock);
  assert.deepEqual(
    [...degradedBlock[1].matchAll(/"([a-z0-9_]+)"/gu)].map((match) => match[1]),
    [
      "codex_rollout_compression_unsupported",
      "codex_rollout_filename_identity_mismatch",
      "codex_rollout_generation_ambiguous",
      "codex_rollout_lineage_invalid",
      "codex_rollout_content_invalid",
      "codex_rollout_tail_incomplete",
    ],
  );
  assert.match(workflow, /include-hidden-files: true/u);
  assert.match(workflow, /if-no-files-found: error/u);
});

test("Linux AMD64 package scripts preserve native image and network boundaries", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const buildHelper = await readFile("scripts/build-electron-linux-container.mjs", "utf8");
  const build = packageJson.scripts["container:electron-linux:build:amd64"];
  const smoke = packageJson.scripts["container:electron-linux:test:amd64"];
  const credentials = packageJson.scripts[
    "container:electron-linux:test:credentials:amd64"
  ];
  assert.equal(
    build,
    "node ./scripts/build-electron-linux-container.mjs --architecture amd64",
  );
  assert.match(buildHelper, /git[\s\S]*status[\s\S]*--porcelain=v1/u);
  assert.match(buildHelper, /LINUX_CONTAINER_BUILD_REQUIRES_CLEAN_SOURCE/u);
  assert.match(buildHelper, /TIBOTATTLE_QUALIFICATION_REVISION=\$\{revision\}/u);
  assert.match(buildHelper, /org\.opencontainers\.image\.revision/u);
  assert.match(buildHelper, /platform: "linux\/amd64"/u);
  assert.match(buildHelper, /dockerfile: "containers\/electron-linux-amd64\/Dockerfile"/u);
  assert.match(buildHelper, /tag: "tibotattle-electron-linux-amd64:test"/u);
  assert.match(smoke, /docker run --rm --init --platform=linux\/amd64/u);
  assert.match(smoke, /--network none/u);
  assert.match(smoke, /USAGE_MONITOR_LINUX_IMAGE_PLATFORM=linux\/amd64/u);
  assert.match(smoke, /USAGE_MONITOR_LINUX_NETWORK_BOUNDARY=network-none/u);
  assert.match(smoke, /tibotattle-electron-linux-amd64:test$/u);
  assert.match(credentials, /docker run --rm --init --platform=linux\/amd64/u);
  assert.match(credentials, /--network none/u);
  assert.match(credentials, /--tmpfs \/home\/node:[^ ]*mode=0700/u);
  assert.match(credentials, /--tmpfs \/run\/user\/1000:[^ ]*mode=0700/u);
  assert.match(credentials, /TMPDIR=\/run\/user\/1000/u);
  assert.match(credentials, /XDG_CONFIG_HOME=\/home\/node\/\.config/u);
  assert.match(credentials, /XDG_CACHE_HOME=\/home\/node\/\.cache/u);
  assert.match(credentials, /XDG_DATA_HOME=\/home\/node\/\.local\/share/u);
  assert.match(credentials, /TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED=1/u);
  assert.match(credentials, /--entrypoint node/u);
  assert.match(credentials, /\.\/scripts\/run-linux-secret-service-qualification\.mjs$/u);
  assert.equal(
    packageJson.scripts["test:linux:credentials"],
    "node ./scripts/qualify-linux-secret-service.mjs",
  );
  const foundation = packageJson.scripts["test:linux:foundation"];
  for (const required of [
    "test/electron-linux-smoke-contract.test.js",
    "test/linux-credential-mutation-lease.test.js",
    "test/linux-portability-workflow.test.js",
    "test/linux-secret-service-binding.test.js",
    "test/linux-secret-service-qualification.test.js",
    "test/linux-secret-service-supervisor.test.js",
    "test/linux-secret-service.test.js",
    "test/linux-state-composition.test.js",
    "test/linux-xdg-paths.test.js",
    "apps/electron/test/linux-autostart.test.mjs",
    "apps/electron/test/linux-desktop-capabilities.test.mjs",
    "apps/electron/test/linux-qualification.test.mjs",
  ]) {
    assert.match(foundation, new RegExp(required.replaceAll(".", "\\."), "u"));
  }
});

test("Linux container build helper rejects a dirty source before invoking Docker", async () => {
  await withFakeBuildCommands({
    gitSource: `#!/bin/sh
if [ "$1" = "status" ]; then
  printf '%s\n' '?? untracked-fixture'
  exit 0
fi
exit 91
`,
    dockerSource: `#!/bin/sh
printf '%s\n' "$*" >> "$TIBOTATTLE_FAKE_DOCKER_LOG"
exit 0
`,
  }, async ({ fixtureRoot, binDirectory }) => {
    const result = runBuildHelper(
      binDirectory,
      fixtureRoot,
      "--architecture",
      "amd64",
    );
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "LINUX_CONTAINER_BUILD_REQUIRES_CLEAN_SOURCE\n");
    await assert.rejects(access(join(fixtureRoot, "docker.log")));
  });
});

test("Linux container build helper rejects an OCI revision label mismatch", async () => {
  const sourceRevision = "0123456789abcdef0123456789abcdef01234567";
  const embeddedRevision = "89abcdef0123456789abcdef0123456789abcdef";
  await withFakeBuildCommands({
    gitSource: `#!/bin/sh
if [ "$1" = "status" ]; then
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  printf '%s\n' '${sourceRevision}'
  exit 0
fi
exit 91
`,
    dockerSource: `#!/bin/sh
printf '%s\n' "$*" >> "$TIBOTATTLE_FAKE_DOCKER_LOG"
if [ "$1" = "build" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  printf '%s\n' '${embeddedRevision}'
  exit 0
fi
exit 92
`,
  }, async ({ fixtureRoot, binDirectory }) => {
    const result = runBuildHelper(
      binDirectory,
      fixtureRoot,
      "--architecture",
      "amd64",
      "--no-cache",
    );
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "LINUX_CONTAINER_BUILD_REVISION_MISMATCH\n");
    const dockerLog = await readFile(join(fixtureRoot, "docker.log"), "utf8");
    const dockerCalls = dockerLog.trim().split("\n");
    assert.equal(dockerCalls.length, 2);
    assert.match(
      dockerCalls[0],
      new RegExp(`^build --platform=linux/amd64 .*--build-arg TIBOTATTLE_QUALIFICATION_REVISION=${sourceRevision} --no-cache \\.$`, "u"),
    );
    assert.equal(
      dockerCalls[1],
      "image inspect --format {{ index .Config.Labels \"org.opencontainers.image.revision\" }} tibotattle-electron-linux-amd64:test",
    );
  });
});

test("Linux foundation modules remain unreachable from production composition", async () => {
  const productionCompositionRoots = [
    "apps/electron/main.js",
    "apps/electron/desktop-runtime.js",
    "apps/electron/desktop-lifecycle.js",
    "apps/electron/desktop-platform-services.js",
    "apps/local/server.js",
    "src/cli.js",
    "src/platform/index.js",
    "src/export-identity-production.js",
    "src/account-observation-production.js",
    "src/claude-callback-capability.js",
    "src/contribution-device-capability.js",
    "scripts/build-electron-app.mjs",
    "scripts/build-electron-runtime.mjs",
    "apps/electron/electron-builder.config.cjs",
  ];
  const forbiddenPaths = new Set([
    "apps/electron/linux-autostart.js",
    "apps/electron/linux-desktop-capabilities.js",
    "apps/electron/linux-qualification.js",
    "apps/electron/linux-tray-assets.js",
    "src/platform/linux-credential-mutation-lease.js",
    "src/platform/linux-secret-service-binding.js",
    "src/platform/linux-secret-service.js",
    "src/platform/linux-state-composition.js",
    "src/platform/linux-xdg-paths.js",
  ]);
  const forbiddenSpecifier = /(?:linux-(?:autostart|desktop-capabilities|qualification|tray-assets)|platform\/linux-(?:credential-mutation-lease|secret-service(?:-binding)?|state-composition|xdg-paths))/u;
  const graph = await collectProductionDependencyGraph(productionCompositionRoots);
  const relativeGraph = new Set([...graph].map((path) => relative(REPOSITORY_ROOT, path)));
  assert.ok(
    relativeGraph.has("apps/electron/companion-supervisor.js"),
    "the dormancy guard must traverse indirect production imports",
  );
  for (const forbiddenPath of forbiddenPaths) {
    assert.equal(
      relativeGraph.has(forbiddenPath),
      false,
      `${forbiddenPath} remains unreachable from every production composition root`,
    );
  }
  for (const path of graph) {
    if (![".js", ".mjs", ".cjs"].includes(extname(path))) continue;
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(
      source,
      forbiddenSpecifier,
      `${relative(REPOSITORY_ROOT, path)} has no unresolved Linux foundation specifier`,
    );
  }
});
