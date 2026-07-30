import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertRuntimeIdentity,
  runtimeDetails,
  validateCompleteStaging,
} from "../scripts/regenerate-r7-release-evidence.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "regenerate-r7-release-evidence.js");
const EXACT_DRIVER = process.platform === "darwin"
  && process.arch === "arm64"
  && process.version === "v26.2.0";
const RUNTIME_SUFFIXES = ["node24.14.0-v0.1.json", "node26.2.0-v0.1.json"];
const PROFILES = [
  "decision",
  "materialized-boundaries",
  "real-local-history",
  "synthetic-pressure",
  "synthetic-semantics",
];
const EXPECTED = PROFILES.flatMap((profile) => (
  RUNTIME_SUFFIXES.map((suffix) => `r7-release-${profile}-${suffix}`)
)).sort();
const JOURNAL = ".r7-release-evidence-install-v1.json";
const JOURNAL_SCHEMA = "usage-monitor-r7-release-evidence-install-v1";
const JOURNAL_CREATION_PREFIX = `${JOURNAL}.creating-`;
const MARKER = ".r7-release-evidence-generation-v1.json";
const MARKER_SCHEMA = "usage-monitor-r7-release-evidence-generation-v1";
const GENERATION_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_IDENTITIES = Object.freeze({
  node24: Object.freeze({
    path: "/fixture/node24",
    dev: "1",
    ino: "24",
    size: "1",
    mode: 0o755,
    uid: String(process.getuid()),
    nlink: "1",
    sha256: "20a18709f0154d668f1bd6f6ea8c2a7ae001447b4b2c339732f22e57a8767a55",
    version: "24.14.0",
    platform: "darwin",
    arch: "arm64",
  }),
  node26: Object.freeze({
    path: "/fixture/node26",
    dev: "1",
    ino: "26",
    size: "1",
    mode: 0o755,
    uid: String(process.getuid()),
    nlink: "1",
    sha256: "b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440",
    version: "26.2.0",
    platform: "darwin",
    arch: "arm64",
  }),
});

function run(arguments_, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
    ...options,
  });
}

async function writeJournal(parent, value) {
  const path = join(parent, JOURNAL);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
  return path;
}

async function createOwnedDirectory(path, role, generationId = GENERATION_ID) {
  await mkdir(path, { mode: 0o700 });
  await writeFile(join(path, MARKER), `${JSON.stringify({
    schemaVersion: MARKER_SCHEMA,
    generationId,
    role,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(join(path, MARKER), 0o600);
  const stats = await lstat(path);
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    generationId,
    role,
  };
}

function journalFixture({
  phase,
  destination,
  staging,
  stagingIdentity,
  backup = null,
  backupIdentity = null,
  creationDraft = null,
}) {
  return {
    schemaVersion: JOURNAL_SCHEMA,
    phase,
    generationId: GENERATION_ID,
    destination,
    staging,
    stagingIdentity,
    backup,
    backupIdentity,
    creationDraft,
    expected: EXPECTED,
    runtimeIdentities: RUNTIME_IDENTITIES,
  };
}

test("R7 regeneration fails closed before private work for incomplete invocation", {
  skip: !EXACT_DRIVER,
}, () => {
  const missingReplace = run([
    "--node24", "/missing-node24",
    "--node26", "/missing-node26",
    "--start-at", "2026-06-24T09:00:00.000Z",
    "--end-at", "2026-07-25T09:00:00.000Z",
  ]);
  assert.equal(missingReplace.status, 1);
  assert.match(
    missingReplace.stderr,
    /retained evidence replacement requires --replace/u,
  );

  const wrongInterval = run([
    "--node24", "/missing-node24",
    "--node26", "/missing-node26",
    "--start-at", "2026-06-24T09:00:00.000Z",
    "--end-at", "2026-07-25T08:59:59.000Z",
    "--replace",
  ]);
  assert.equal(wrongInterval.status, 1);
  assert.match(wrongInterval.stderr, /requires exactly 31 days/u);

  const unregisteredInterval = run([
    "--node24", "/missing-node24",
    "--node26", "/missing-node26",
    "--start-at", "2026-06-25T09:00:00.000Z",
    "--end-at", "2026-07-26T09:00:00.000Z",
    "--replace",
  ]);
  assert.equal(unregisteredInterval.status, 1);
  assert.match(
    unregisteredInterval.stderr,
    /requires the preregistered frozen interval/u,
  );

  const directChild = run([
    "--decision-child",
    "--staging", "/private/tmp/missing",
    "--runtime-key", "node26",
  ]);
  assert.equal(directChild.status, 1);
  assert.match(
    directChild.stderr,
    /decision child is internal to complete regeneration/u,
  );
});

test("journal recovery restores the complete prior R7 matrix after an interrupted install", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-recovery-test-"));
  const destination = join(parent, "generated");
  const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
  const backup = join(parent, `.r7-release-evidence-backup-${GENERATION_ID}`);
  try {
    await mkdir(destination, { mode: 0o700 });
    const stagingIdentity = await createOwnedDirectory(staging, "staging");
    const backupIdentity = await createOwnedDirectory(backup, "backup");
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `old:${name}\n`, {
        mode: 0o600,
      });
      await writeFile(join(staging, name), `new:${name}\n`, {
        mode: 0o600,
      });
    }
    const interruptedName = EXPECTED[0];
    await rename(
      join(destination, interruptedName),
      join(backup, interruptedName),
    );
    await rename(
      join(staging, interruptedName),
      join(destination, interruptedName),
    );
    const journal = await writeJournal(parent, journalFixture({
      phase: "installing",
      destination,
      staging,
      stagingIdentity,
      backup,
      backupIdentity,
    }));

    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(
      recovered.stdout,
      "R7 release evidence recovery: rolled_back\n",
    );
    for (const name of EXPECTED) {
      assert.equal(await readFile(join(destination, name), "utf8"), `old:${name}\n`);
    }
    await assert.rejects(lstat(journal), { code: "ENOENT" });
    await assert.rejects(lstat(staging), { code: "ENOENT" });
    await assert.rejects(lstat(backup), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("journal recovery discards a crash-interrupted staged generation", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-generation-test-"));
  const destination = join(parent, "generated");
  const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
  try {
    await mkdir(destination, { mode: 0o700 });
    const stagingIdentity = await createOwnedDirectory(staging, "staging");
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `old:${name}\n`, {
        mode: 0o600,
      });
    }
    await writeFile(join(staging, EXPECTED[0]), "{}\n", { mode: 0o600 });
    const journal = await writeJournal(parent, journalFixture({
      phase: "generating",
      destination,
      staging,
      stagingIdentity,
      backup: null,
    }));

    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(
      recovered.stdout,
      "R7 release evidence recovery: discarded_incomplete_generation\n",
    );
    await assert.rejects(lstat(journal), { code: "ENOENT" });
    await assert.rejects(lstat(staging), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("journal recovery finalizes a post-validation installed R7 matrix", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-installed-test-"));
  const destination = join(parent, "generated");
  const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
  const backup = join(parent, `.r7-release-evidence-backup-${GENERATION_ID}`);
  try {
    await mkdir(destination, { mode: 0o700 });
    const stagingIdentity = await createOwnedDirectory(staging, "staging");
    const backupIdentity = await createOwnedDirectory(backup, "backup");
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `new:${name}\n`, {
        mode: 0o600,
      });
      await writeFile(join(backup, name), `old:${name}\n`, {
        mode: 0o600,
      });
    }
    const journal = await writeJournal(parent, journalFixture({
      phase: "installed",
      destination,
      staging,
      stagingIdentity,
      backup,
      backupIdentity,
    }));

    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(
      recovered.stdout,
      "R7 release evidence recovery: completed\n",
    );
    for (const name of EXPECTED) {
      assert.equal(await readFile(join(destination, name), "utf8"), `new:${name}\n`);
    }
    await assert.rejects(lstat(journal), { code: "ENOENT" });
    await assert.rejects(lstat(staging), { code: "ENOENT" });
    await assert.rejects(lstat(backup), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("recovery removes a crash-partial journal draft without touching receipts", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-partial-journal-test-"));
  const destination = join(parent, "generated");
  const draft = join(parent, `${JOURNAL_CREATION_PREFIX}${GENERATION_ID}`);
  try {
    await mkdir(destination, { mode: 0o700 });
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `old:${name}\n`, {
        mode: 0o600,
      });
    }
    await writeFile(draft, "{\"schemaVersion\":", { mode: 0o600 });
    await chmod(draft, 0o600);

    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(
      recovered.stdout,
      "R7 release evidence recovery: discarded_partial_journal_creation\n",
    );
    await assert.rejects(lstat(draft), { code: "ENOENT" });
    for (const name of EXPECTED) {
      assert.equal(await readFile(join(destination, name), "utf8"), `old:${name}\n`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("recovery completes a crash-interrupted atomic journal publication", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-linked-journal-test-"));
  const destination = join(parent, "generated");
  const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
  const draft = join(parent, `${JOURNAL_CREATION_PREFIX}${GENERATION_ID}`);
  const journal = join(parent, JOURNAL);
  try {
    await mkdir(destination, { mode: 0o700 });
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `old:${name}\n`, {
        mode: 0o600,
      });
    }
    await writeFile(draft, `${JSON.stringify(journalFixture({
      phase: "creating",
      destination,
      staging,
      stagingIdentity: null,
      creationDraft: draft,
    }), null, 2)}\n`, { mode: 0o600 });
    await chmod(draft, 0o600);
    await link(draft, journal);

    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(
      recovered.stdout,
      "R7 release evidence recovery: discarded_partial_creation\n",
    );
    await assert.rejects(lstat(draft), { code: "ENOENT" });
    await assert.rejects(lstat(journal), { code: "ENOENT" });
    for (const name of EXPECTED) {
      assert.equal(await readFile(join(destination, name), "utf8"), `old:${name}\n`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("recovery refuses a replaced staging pathname instead of deleting it", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-replaced-stage-test-"));
  const destination = join(parent, "generated");
  const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
  const displaced = `${staging}.displaced`;
  try {
    await mkdir(destination, { mode: 0o700 });
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `old:${name}\n`, {
        mode: 0o600,
      });
    }
    const stagingIdentity = await createOwnedDirectory(staging, "staging");
    await writeFile(join(staging, EXPECTED[0]), "{}\n", { mode: 0o600 });
    await writeJournal(parent, journalFixture({
      phase: "generating",
      destination,
      staging,
      stagingIdentity,
    }));
    await rename(staging, displaced);
    await createOwnedDirectory(staging, "staging");

    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 1);
    assert.match(recovered.stderr, /staging directory identity changed/u);
    assert.equal((await lstat(staging)).isDirectory(), true);
    assert.equal((await lstat(displaced)).isDirectory(), true);
    assert.equal((await lstat(join(parent, JOURNAL))).isFile(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("staging validation and recovery reject non-receipts, directories, and links", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-inventory-test-"));
  const destination = join(parent, "generated");
  const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
  try {
    await mkdir(destination, { mode: 0o700 });
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `old:${name}\n`, {
        mode: 0o600,
      });
    }
    const stagingIdentity = await createOwnedDirectory(staging, "staging");
    for (const name of EXPECTED) {
      await writeFile(join(staging, name), "{}\n", { mode: 0o600 });
    }
    await writeFile(join(staging, "unexpected.txt"), "unexpected\n", {
      mode: 0o600,
    });
    await mkdir(join(staging, "unexpected-directory"), { mode: 0o700 });
    await symlink(EXPECTED[0], join(staging, "unexpected-link"));
    await writeJournal(parent, journalFixture({
      phase: "generating",
      destination,
      staging,
      stagingIdentity,
    }));

    await assert.rejects(
      validateCompleteStaging(staging, stagingIdentity),
      /staging directory inventory is not exact/u,
    );
    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 1);
    assert.match(recovered.stderr, /inventory contains unexpected entries/u);
    assert.equal((await lstat(staging)).isDirectory(), true);
    assert.equal((await lstat(join(parent, JOURNAL))).isFile(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("generation recovery discards a strict atomic-write SIGKILL temp", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-write-temp-test-"));
  const destination = join(parent, "generated");
  const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
  const atomicTemp = join(staging, `${EXPECTED[1]}.4242.tmp`);
  try {
    await mkdir(destination, { mode: 0o700 });
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `old:${name}\n`, {
        mode: 0o600,
      });
    }
    const stagingIdentity = await createOwnedDirectory(staging, "staging");
    await writeFile(join(staging, EXPECTED[0]), "{}\n", { mode: 0o600 });
    await writeFile(atomicTemp, "{\"partial\":", { mode: 0o600 });
    await writeJournal(parent, journalFixture({
      phase: "generating",
      destination,
      staging,
      stagingIdentity,
    }));

    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(
      recovered.stdout,
      "R7 release evidence recovery: discarded_incomplete_generation\n",
    );
    await assert.rejects(lstat(staging), { code: "ENOENT" });
    await assert.rejects(lstat(join(parent, JOURNAL)), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("owned-directory deletion resumes from an exact partial quarantine", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-delete-resume-test-"));
  const destination = join(parent, "generated");
  const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
  const quarantine = `${staging}.removing-${GENERATION_ID}`;
  try {
    await mkdir(destination, { mode: 0o700 });
    for (const name of EXPECTED) {
      await writeFile(join(destination, name), `old:${name}\n`, {
        mode: 0o600,
      });
    }
    const stagingIdentity = await createOwnedDirectory(staging, "staging");
    await writeFile(join(staging, EXPECTED[0]), "{}\n", { mode: 0o600 });
    await writeFile(join(staging, EXPECTED[1]), "{}\n", { mode: 0o600 });
    await writeJournal(parent, journalFixture({
      phase: "generating",
      destination,
      staging,
      stagingIdentity,
    }));
    await rename(staging, quarantine);
    await rm(join(quarantine, EXPECTED[0]));

    const recovered = run(["--destination", destination, "--recover"]);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(
      recovered.stdout,
      "R7 release evidence recovery: discarded_incomplete_generation\n",
    );
    await assert.rejects(lstat(quarantine), { code: "ENOENT" });
    await assert.rejects(lstat(join(parent, JOURNAL)), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("partial-quarantine deletion refuses replacement and unexpected injection", {
  skip: !EXACT_DRIVER,
}, async (context) => {
  await context.test("replacement", async () => {
    const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-delete-swap-test-"));
    const destination = join(parent, "generated");
    const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
    const quarantine = `${staging}.removing-${GENERATION_ID}`;
    const displaced = `${quarantine}.displaced`;
    try {
      await mkdir(destination, { mode: 0o700 });
      for (const name of EXPECTED) {
        await writeFile(join(destination, name), `old:${name}\n`, {
          mode: 0o600,
        });
      }
      const stagingIdentity = await createOwnedDirectory(staging, "staging");
      await writeFile(join(staging, EXPECTED[0]), "{}\n", { mode: 0o600 });
      await writeJournal(parent, journalFixture({
        phase: "generating",
        destination,
        staging,
        stagingIdentity,
      }));
      await rename(staging, quarantine);
      await rename(quarantine, displaced);
      await createOwnedDirectory(quarantine, "staging");

      const recovered = run(["--destination", destination, "--recover"]);
      assert.equal(recovered.status, 1);
      assert.match(recovered.stderr, /staging directory identity changed/u);
      assert.equal((await lstat(quarantine)).isDirectory(), true);
      assert.equal((await lstat(displaced)).isDirectory(), true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  await context.test("unexpected injection", async () => {
    const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-delete-inject-test-"));
    const destination = join(parent, "generated");
    const staging = join(parent, `.r7-release-evidence-staging-${GENERATION_ID}`);
    const quarantine = `${staging}.removing-${GENERATION_ID}`;
    try {
      await mkdir(destination, { mode: 0o700 });
      for (const name of EXPECTED) {
        await writeFile(join(destination, name), `old:${name}\n`, {
          mode: 0o600,
        });
      }
      const stagingIdentity = await createOwnedDirectory(staging, "staging");
      await writeFile(join(staging, EXPECTED[0]), "{}\n", { mode: 0o600 });
      await writeJournal(parent, journalFixture({
        phase: "generating",
        destination,
        staging,
        stagingIdentity,
      }));
      await rename(staging, quarantine);
      await writeFile(join(quarantine, "injected.txt"), "do not delete\n", {
        mode: 0o600,
      });

      const recovered = run(["--destination", destination, "--recover"]);
      assert.equal(recovered.status, 1);
      assert.match(recovered.stderr, /inventory contains unexpected entries/u);
      assert.equal(await readFile(join(quarantine, "injected.txt"), "utf8"), "do not delete\n");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

test("runtime qualification rejects wrappers and detects a path swap", {
  skip: !EXACT_DRIVER,
}, async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "usage-monitor-r7-runtime-test-")),
  );
  const wrapper = join(parent, "node-wrapper");
  const copiedRuntime = join(parent, "node26");
  const displacedRuntime = join(parent, "node26-old");
  try {
    await writeFile(
      wrapper,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} \"$@\"\n`,
      { mode: 0o755 },
    );
    await chmod(wrapper, 0o755);
    await assert.rejects(
      runtimeDetails(wrapper, "node26"),
      /does not match the approved immutable digest/u,
    );

    await copyFile(process.execPath, copiedRuntime);
    await chmod(copiedRuntime, 0o755);
    const identity = await runtimeDetails(copiedRuntime, "node26");
    await rename(copiedRuntime, displacedRuntime);
    await copyFile(process.execPath, copiedRuntime);
    await chmod(copiedRuntime, 0o755);
    await assert.rejects(
      assertRuntimeIdentity(identity),
      /runtime executable identity changed/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
