import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import {
  CANONICAL_PRODUCTION_DEPLOYMENT_PROOF,
  DEPLOYMENT_PROOF_SCHEMA_VERSION,
  PRODUCTION_CONTAINMENT_PROOF_OPERATION,
  PRODUCTION_OBSERVATION_CHANNEL,
  validateDeploymentProof,
} from "./deployment-proof.mjs";
import {
  PRODUCTION_DEPLOY_CONFIRMATION,
  createImmutableSourceSnapshot,
  runProductionDeployment,
  recheckProductionContainment,
  recheckProductionPublicSurface,
} from "./production-deploy.mjs";
import { stageProductionAssets } from "./stage-production-assets.mjs";

const NOW = Date.parse("2026-08-04T20:00:00.000Z");
const HEALTH_URL = `${DEPLOYMENT_ENDPOINTS.public.origin}/api/health`;
const PUBLIC_ROOT_URL = `${DEPLOYMENT_ENDPOINTS.public.origin}/`;

function git(root, arguments_) {
  return execFileSync("/usr/bin/git", ["-C", root, ...arguments_], {
    encoding: "utf8",
  });
}

async function immutableSnapshotFixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-production-snapshot-"));
  const workerDirectory = join(root, "apps", "worker");
  const sourceDirectory = join(
    root,
    ".release-build",
    "public-release-site",
  );
  await mkdir(join(workerDirectory, "node_modules"), { recursive: true });
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    join(root, ".gitignore"),
    ".release-build/\nnode_modules/\n",
  );
  await writeFile(join(workerDirectory, "wrangler.jsonc"), "{}\n");

  const generatedFiles = {
    "community.js": "console.log('snapshot community');\n",
    "index.html": '<script type="module" src="./community.js"></script>\n',
  };
  const manifest = {
    schemaVersion: "usage-monitor-release-site-manifest-v0.2",
    files: [],
  };
  for (const [path, contents] of Object.entries(generatedFiles)) {
    await writeFile(join(sourceDirectory, path), contents);
    const bytes = Buffer.from(contents);
    manifest.files.push({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(
    join(sourceDirectory, "release-site-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Production snapshot test"]);
  git(root, ["add", ".gitignore", "apps/worker/wrangler.jsonc"]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return {
    root,
    workerDirectory,
    sourceDirectory,
    generatedFiles,
    sourceCommit: git(root, ["rev-parse", "HEAD"]).trim(),
  };
}

function containedHealth() {
  return {
    status: "ok",
    enrollmentMode: "disabled",
    collectionControls: {
      state: "contained",
      enrollment: false,
      uploadRegistration: false,
      processing: false,
      publication: false,
    },
    contracts: {
      accountScopedContribution: {
        externalParticipantsAuthorized: false,
      },
    },
  };
}

function jsonHealthResponse(value = containedHealth(), status = 200) {
  return {
    url: HEALTH_URL,
    status,
    headers: {
      get(name) {
        return {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        }[name];
      },
    },
    text: async () => JSON.stringify(value),
  };
}

function textResponse(url, body, {
  status = 200,
  contentType = "text/html; charset=utf-8",
} = {}) {
  return {
    url,
    status,
    headers: {
      get(name) {
        return name === "content-type" ? contentType : undefined;
      },
    },
    text: async () => body,
  };
}

function proofCheck(overrides = {}) {
  const proof = {
    schemaVersion: DEPLOYMENT_PROOF_SCHEMA_VERSION,
    operation: PRODUCTION_CONTAINMENT_PROOF_OPERATION,
    environment: "production",
    channel: "stable",
    observationChannel: PRODUCTION_OBSERVATION_CHANNEL,
    status: "remote_containment_observed",
    observedAt: new Date(NOW - 1_000).toISOString(),
    target: {
      origin: CANONICAL_PRODUCTION_DEPLOYMENT_PROOF.manifest.publicOrigin,
      endpointManifest: {
        ...CANONICAL_PRODUCTION_DEPLOYMENT_PROOF.manifest,
        sha256: CANONICAL_PRODUCTION_DEPLOYMENT_PROOF.manifestSha256,
      },
    },
    worker: {
      revision: "production-revision-0001",
      sourceCommit: "c26823c",
      enrollmentMode: "disabled",
      collectionControls: "contained",
    },
    evidence: {
      ownerObservedRemoteRevision: true,
      ownerObservedDisabledMode: true,
      ownerObservedContainment: true,
      ownerObservedCanonicalTarget: true,
    },
    ...overrides,
  };
  return validateDeploymentProof({ proof, kind: "production", now: NOW });
}

function options(overrides = {}) {
  return {
    confirmation: PRODUCTION_DEPLOY_CONFIRMATION,
    receiptFile: "/owner-only/production-proof.json",
    now: NOW,
    wrangler: "/fake/wrangler",
    workerDirectory: "/worker",
    expectedSourceCommit: "c26823c",
    sourceCommitCheck: () => "c26823c",
    sourceTreeCleanCheck: () => true,
    createSourceSnapshot: async () => ({
      repositoryRoot: "/immutable/repository",
      workerDirectory: "/immutable/repository/apps/worker",
      cleanup: async () => {},
    }),
    releasePreflight: async () => ({
      state: "ready",
      blockers: [],
    }),
    fetchImpl: async (url) => {
      assert.equal(String(url), HEALTH_URL);
      return jsonHealthResponse();
    },
    publicSurfaceRecheck: async () => ({ ok: true, code: null }),
    ...overrides,
  };
}

test("production deployment creates a real top-level Git snapshot before staging generated assets", async (t) => {
  const fixture = await immutableSnapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const stageCalls = [];
  const stagedIndex = [];
  const healthTimeouts = [];
  let healthChecks = 0;
  const result = await runProductionDeployment(options({
    workerDirectory: fixture.workerDirectory,
    expectedSourceCommit: fixture.sourceCommit,
    sourceCommitCheck: (directory) => git(directory, ["rev-parse", "HEAD"]).trim(),
    sourceTreeCleanCheck: (directory) => git(
      directory,
      ["status", "--porcelain=v1", "--untracked-files=all"],
    ).trim() === "",
    proofCheck: proofCheck({
      worker: {
        ...proofCheck().proof.worker,
        sourceCommit: fixture.sourceCommit,
      },
    }),
    createSourceSnapshot: undefined,
    stageAssets: async (value) => {
      stageCalls.push(value);
      const staged = await stageProductionAssets(value);
      stagedIndex.push(await readFile(
        join(value.destinationDirectory, "index.html"),
        "utf8",
      ));
      assert.equal(
        realpathSync(git(
          value.repositoryRoot,
          ["rev-parse", "--show-toplevel"],
        ).trim()),
        realpathSync(value.repositoryRoot),
      );
      return staged;
    },
    healthRecheck: async ({ timeoutMs }) => {
      healthChecks += 1;
      healthTimeouts.push(timeoutMs);
      return { ok: true, code: null };
    },
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    releasePreflight: async () => ({ state: "ready", blockers: [] }),
    spawn: (_command, _args, spawnOptions) => {
      assert.match(spawnOptions.cwd, /\/repository\/apps\/worker$/u);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));

  assert.equal(result.ok, true);
  assert.equal(healthChecks, 2);
  assert.deepEqual(healthTimeouts, [10_000, 10_000]);
  assert.deepEqual(stageCalls[0].sourceDirectory, join(
    stageCalls[0].repositoryRoot,
    ".release-build",
    "public-release-site",
  ));
  assert.notEqual(stageCalls[0].repositoryRoot, join(fixture.root, "apps"));
  assert.equal(stagedIndex[0], fixture.generatedFiles["index.html"]);
  await assert.rejects(
    readFile(join(stageCalls[0].sourceDirectory, "index.html")),
    { code: "ENOENT" },
  );
});

test("production deployment fails closed when the snapshot dependency link is repointed before cleanup", async (t) => {
  const fixture = await immutableSnapshotFixture();
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });
  const dependencyMarker = join(
    fixture.workerDirectory,
    "node_modules",
    "must-survive-cleanup.txt",
  );
  await writeFile(dependencyMarker, "external dependency remains\n");

  let snapshot;
  let dependencyLink;
  let expectedTarget;
  let healthChecks = 0;
  let spawned = false;
  let cleaned = false;
  try {
    const result = await runProductionDeployment(options({
      workerDirectory: fixture.workerDirectory,
      expectedSourceCommit: fixture.sourceCommit,
      sourceCommitCheck: (directory) => git(
        directory,
        ["rev-parse", "HEAD"],
      ).trim(),
      sourceTreeCleanCheck: (directory) => git(
        directory,
        ["status", "--porcelain=v1", "--untracked-files=all"],
      ).trim() === "",
      proofCheck: proofCheck({
        worker: {
          ...proofCheck().proof.worker,
          sourceCommit: fixture.sourceCommit,
        },
      }),
      createSourceSnapshot: async (arguments_) => {
        snapshot = await createImmutableSourceSnapshot(arguments_);
        dependencyLink = join(snapshot.workerDirectory, "node_modules");
        expectedTarget = await readlink(dependencyLink);
        return snapshot;
      },
      releasePreflight: async () => ({ state: "ready", blockers: [] }),
      checkWorkspacePackages: async () => {},
      checkEndpoints: async () => {},
      stageAssets: async () => {},
      healthRecheck: async () => {
        healthChecks += 1;
        if (healthChecks === 2) {
          await rm(dependencyLink);
          await symlink(fixture.workerDirectory, dependencyLink, "dir");
        }
        return { ok: true, code: null };
      },
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: "deployed", stderr: "" };
      },
    }));

    assert.deepEqual(result, {
      ok: false,
      code: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED",
    });
    assert.equal(spawned, true);
    assert.equal(healthChecks, 2);
    assert.equal(
      await readFile(dependencyMarker, "utf8"),
      "external dependency remains\n",
    );
    assert.equal((await lstat(dependencyLink)).isSymbolicLink(), true);
    assert.equal(await readlink(dependencyLink), fixture.workerDirectory);
    assert.equal((await lstat(snapshot.repositoryRoot)).isDirectory(), true);
  } finally {
    if (snapshot && !cleaned) {
      try {
        await rm(dependencyLink);
        await symlink(expectedTarget, dependencyLink, "dir");
        await snapshot.cleanup();
        cleaned = true;
      } catch {
        // The test fixture cleanup below is the final bounded local cleanup.
      }
    }
  }
});

test("production deployment fails closed when generated release output is a symlink", async (t) => {
  const fixture = await immutableSnapshotFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const realSourceDirectory = join(fixture.root, "generated-source");
  await rename(fixture.sourceDirectory, realSourceDirectory);
  await symlink(realSourceDirectory, fixture.sourceDirectory, "dir");
  let spawned = false;
  const result = await runProductionDeployment(options({
    workerDirectory: fixture.workerDirectory,
    expectedSourceCommit: fixture.sourceCommit,
    sourceCommitCheck: (directory) => git(directory, ["rev-parse", "HEAD"]).trim(),
    sourceTreeCleanCheck: () => true,
    proofCheck: proofCheck({
      worker: {
        ...proofCheck().proof.worker,
        sourceCommit: fixture.sourceCommit,
      },
    }),
    createSourceSnapshot: undefined,
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    releasePreflight: async () => ({ state: "ready", blockers: [] }),
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE",
  });
  assert.equal(spawned, false);
});

test("production deployment requires scoped confirmation and a receipt before local gates or Wrangler", async () => {
  const calls = [];
  const result = await runProductionDeployment(options({
    confirmation: "DEPLOY_SOMETHING",
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  }));
  assert.deepEqual(result, { ok: false, code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(calls, []);

  const absent = await runProductionDeployment(options({
    receiptFile: null,
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  }));
  assert.deepEqual(absent, { ok: false, code: "DEPLOYMENT_PROOF_REQUIRED" });
  assert.deepEqual(calls, []);
});

test("production deployment fails closed when immutable source snapshot setup or cleanup fails", async () => {
  let spawned = false;
  const creationFailure = await runProductionDeployment(options({
    createSourceSnapshot: async () => {
      throw new Error("snapshot creation failed");
    },
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(creationFailure, {
    ok: false,
    code: "PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE",
  });
  assert.equal(spawned, false);

  const cleanupFailure = await runProductionDeployment(options({
    proofCheck: { ok: false, code: "DEPLOYMENT_PROOF_REQUIRED" },
    createSourceSnapshot: async () => ({
      repositoryRoot: "/immutable/repository",
      workerDirectory: "/immutable/repository/apps/worker",
      cleanup: async () => {
        throw new Error("snapshot cleanup failed");
      },
    }),
  }));
  assert.deepEqual(cleanupFailure, {
    ok: false,
    code: "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED",
  });
});

test("production deployment refuses invalid or stale proof before Wrangler", async () => {
  const calls = [];
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-production-proof-"));
  try {
    const valid = proofCheck().proof;
    const cases = [
      ["malformed", "not-json\n"],
      ["stale", JSON.stringify({
        ...valid,
        observedAt: new Date(
          NOW - 15 * 60 * 1000 - 1,
        ).toISOString(),
      })],
      ["mismatched", JSON.stringify({
        ...valid,
        target: {
          ...valid.target,
          origin: "https://wrong.example.test",
        },
      })],
    ];
    for (const [name, contents] of cases) {
      const receiptFile = join(root, `${name}.json`);
      await writeFile(receiptFile, contents, { mode: 0o600 });
      const result = await runProductionDeployment(options({
        receiptFile,
        checkWorkspacePackages: async () => calls.push("workspace"),
        checkEndpoints: async () => calls.push("endpoints"),
        stageAssets: async () => calls.push("assets"),
        spawn: () => calls.push("deploy"),
      }));
      assert.equal(result.ok, false, name);
      assert.equal(
        result.code,
        name === "mismatched"
          ? "PRODUCTION_CONTAINMENT_PROOF_MISMATCH"
          : "DEPLOYMENT_PROOF_MALFORMED",
        name,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  for (const code of [
    "DEPLOYMENT_PROOF_MALFORMED",
    "PRODUCTION_CONTAINMENT_PROOF_MISMATCH",
  ]) {
    const result = await runProductionDeployment(options({
      proofCheck: { ok: false, code },
      checkWorkspacePackages: async () => calls.push("workspace"),
      checkEndpoints: async () => calls.push("endpoints"),
      stageAssets: async () => calls.push("assets"),
      spawn: () => calls.push("deploy"),
    }));
    assert.deepEqual(result, { ok: false, code });
  }
  assert.deepEqual(calls, []);
});

test("valid production proof routes through local checks and then the exact production Wrangler deploy", async () => {
  const calls = [];
  const healthCalls = [];
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    releasePreflight: async () => {
      calls.push("preflight");
      return { state: "ready", blockers: [] };
    },
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    fetchImpl: async (url, request) => {
      healthCalls.push({ url: String(url), request });
      return jsonHealthResponse();
    },
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "preflight",
    "workspace",
    "endpoints",
    "assets",
    ["deploy", "--env", "production", "--strict"],
  ]);
  assert.equal(healthCalls.length, 2);
  assert.equal(healthCalls[0].url, HEALTH_URL);
  assert.equal(healthCalls[1].url, HEALTH_URL);
  assert.equal(healthCalls[0].request.method, "GET");
  assert.equal(healthCalls[0].request.credentials, "omit");
  assert.equal(healthCalls[0].request.redirect, "error");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.immediateHealthRecheck, "contained");
  assert.equal(result.postDeployHealthRecheck, "contained");
  assert.equal(result.postDeployPublicSurfaceRecheck, "public-only");
  assert.equal(result.containmentProof.workerRevision, "production-revision-0001");
});

test("production deployment does not report success when the post-deploy containment observation is ambiguous or open", async () => {
  for (const [name, postDeployFetch, expectedCode] of [
    [
      "unreachable",
      async () => {
        throw new Error("post-deploy network failure");
      },
      "PRODUCTION_POST_DEPLOY_HEALTH_RECHECK_UNREACHABLE",
    ],
    [
      "not-contained",
      async () => jsonHealthResponse({
        ...containedHealth(),
        enrollmentMode: "open",
      }),
      "PRODUCTION_POST_DEPLOY_HEALTH_RECHECK_NOT_CONTAINED",
    ],
  ]) {
    let fetchCount = 0;
    let spawned = false;
    const result = await runProductionDeployment(options({
      proofCheck: proofCheck(),
      checkWorkspacePackages: async () => {},
      checkEndpoints: async () => {},
      stageAssets: async () => {},
      fetchImpl: async (url, request) => {
        fetchCount += 1;
        assert.equal(String(url), HEALTH_URL, name);
        assert.equal(request.method, "GET", name);
        return fetchCount === 1
          ? jsonHealthResponse()
          : postDeployFetch();
      },
      spawn: () => {
        spawned = true;
        return { status: 0, stdout: "deployed", stderr: "" };
      },
    }));
    assert.equal(spawned, true, name);
    assert.equal(fetchCount, 2, name);
    assert.deepEqual(result, { ok: false, code: expectedCode }, name);
  }
});

test("production deployment treats release preflight as a hard gate", async () => {
  const calls = [];
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    releasePreflight: async () => ({
      state: "blocked",
      blockers: ["LOCAL_SCHEMA_INCOMPLETE"],
    }),
    checkWorkspacePackages: async () => calls.push("workspace"),
    checkEndpoints: async () => calls.push("endpoints"),
    stageAssets: async () => calls.push("assets"),
    spawn: () => calls.push("deploy"),
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "RELEASE_PREFLIGHT_BLOCKED",
    blockers: ["LOCAL_SCHEMA_INCOMPLETE"],
  });
  assert.deepEqual(calls, []);
});

test("production deployment does not spawn Wrangler when immediate health recheck fails", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error("network");
    },
    async () => jsonHealthResponse({
      ...containedHealth(),
      enrollmentMode: "open",
    }),
    async () => ({
      ...jsonHealthResponse(),
      url: "https://redirected.example.test/api/health",
    }),
    async () => ({
      ...jsonHealthResponse(),
      headers: {
        get(name) {
          return name === "cache-control" ? "public" : "nosniff";
        },
      },
    }),
  ]) {
    let spawned = false;
    const result = await runProductionDeployment(options({
      proofCheck: proofCheck(),
      fetchImpl,
      checkWorkspacePackages: async () => {},
      checkEndpoints: async () => {},
      stageAssets: async () => {},
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
    }));
    assert.equal(spawned, false);
    assert.equal(result.ok, false);
    assert.match(result.code, /^PRODUCTION_HEALTH_RECHECK_/u);
  }
});

test("production deployment stops before Wrangler on a proof source revision mismatch", async () => {
  let spawned = false;
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck({
      worker: { ...proofCheck().proof.worker, sourceCommit: "deadbee" },
    }),
    checkWorkspacePackages: async () => {
      throw new Error("must not run");
    },
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_CONTAINMENT_PROOF_MISMATCH",
  });
  assert.equal(spawned, false);
});

test("production deployment stops if the checked-out source revision changes before Wrangler", async () => {
  let spawned = false;
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    sourceCommitCheck: () => "deadbee",
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_SOURCE_REVISION_CHANGED",
  });
  assert.equal(spawned, false);
});

test("production deployment rejects source revision movement across the Wrangler boundary", async () => {
  let spawned = false;
  let sourceMoved = false;
  const spawnCwds = [];
  const result = await runProductionDeployment(options({
    proofCheck: proofCheck(),
    sourceCommitCheck: () => sourceMoved ? "deadbee" : "c26823c",
    checkWorkspacePackages: async () => {},
    checkEndpoints: async () => {},
    stageAssets: async () => {},
    spawn: (_command, _args, spawnOptions) => {
      spawned = true;
      sourceMoved = true;
      spawnCwds.push(spawnOptions.cwd);
      return { status: 0, stdout: "deployed", stderr: "" };
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_SOURCE_REVISION_CHANGED",
  });
  assert.equal(spawned, true);
  assert.deepEqual(spawnCwds, ["/immutable/repository/apps/worker"]);
});

test("production health recheck requires the canonical URL and security headers", async () => {
  const calls = [];
  const result = await recheckProductionContainment({
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return jsonHealthResponse();
    },
  });
  assert.deepEqual(result, { ok: true, code: null });
  assert.deepEqual(calls.map((call) => call.url), [HEALTH_URL]);
  assert.equal(calls[0].request.headers.accept, "application/json");
});

test("production public-surface recheck requires a public root and real 404s for private assets", async () => {
  const calls = [];
  const result = await recheckProductionPublicSurface({
    fetchImpl: async (url, request) => {
      calls.push({ url: String(url), request });
      if (String(url) === PUBLIC_ROOT_URL) {
        return textResponse(String(url), "<!doctype html><title>TiboTattle</title>");
      }
      return textResponse(String(url), "not found", {
        status: 404,
        contentType: "text/plain; charset=utf-8",
      });
    },
  });
  assert.deepEqual(result, { ok: true, code: null });
  assert.equal(calls[0].url, PUBLIC_ROOT_URL);
  assert.equal(calls[0].request.headers.accept, "text/html");
  assert.equal(calls.length, 9);
});

test("production public-surface recheck rejects dashboard markers at the root", async () => {
  const result = await recheckProductionPublicSurface({
    fetchImpl: async (url) => textResponse(
      String(url),
      '<main id="share-panel"><script src="./app.js"></script></main>',
    ),
  });
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_PUBLIC_SURFACE_PRIVATE_ROOT_EXPOSED",
  });
});

test("production public-surface recheck rejects any publicly served private asset", async () => {
  const result = await recheckProductionPublicSurface({
    fetchImpl: async (url) => String(url) === PUBLIC_ROOT_URL
      ? textResponse(String(url), "<!doctype html><title>TiboTattle</title>")
      : textResponse(String(url), "private source", {
        status: 200,
        contentType: "text/javascript; charset=utf-8",
      }),
  });
  assert.deepEqual(result, {
    ok: false,
    code: "PRODUCTION_PUBLIC_SURFACE_PRIVATE_ASSET_EXPOSED",
  });
});
