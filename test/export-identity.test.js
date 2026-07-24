import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAccountScopeId,
  deriveEventId,
  deriveEventOccurrenceId,
  deriveMarkerId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotId,
  deriveSnapshotObservationId,
  defaultExportSecretFile,
  defaultExportStateDirectory,
  encodeParticipantSecret,
  inspectParticipantSecret,
  loadOrCreateParticipantSecret,
  participantSecretLegacyRetirementFile,
  rotateParticipantSecret,
  withParticipantSecretLease,
} from "../src/export-identity.js";

test("export identity is stable, domain-separated, and does not reveal its subject", () => {
  const secret = Buffer.alloc(32, 7);
  const raw = "adam@example.com/private/session";
  const participant = deriveParticipantId(secret);
  const session = deriveSessionScopeId(secret, raw);
  const event = deriveEventId(secret, raw);
  const account = deriveAccountScopeId(secret, raw);
  assert.match(participant, /^participant:v1:[A-Za-z0-9_-]{43}$/);
  assert.match(session, /^session:v1:[A-Za-z0-9_-]{43}$/);
  assert.notEqual(session.split(":").at(-1), event.split(":").at(-1));
  assert.notEqual(session.split(":").at(-1), account.split(":").at(-1));
  assert.equal(session.includes(raw), false);
  assert.equal(deriveSessionScopeId(secret, raw), session);
  assert.equal(deriveAccountScopeId(secret, "unattributed"), "unattributed");
});

test("export identity uses stable platform application-state paths", () => {
  assert.equal(
    defaultExportStateDirectory({ platform: "darwin", homeDirectory: "/Users/example", environment: {} }),
    "/Users/example/Library/Application Support/app-usagemonitor",
  );
  assert.equal(
    defaultExportStateDirectory({ platform: "linux", homeDirectory: "/home/example", environment: {} }),
    "/home/example/.local/state/app-usagemonitor",
  );
  assert.equal(
    defaultExportStateDirectory({ platform: "linux", homeDirectory: "/home/example", environment: { XDG_STATE_HOME: "/state" } }),
    "/state/app-usagemonitor",
  );
  assert.equal(
    defaultExportSecretFile({ platform: "win32", homeDirectory: "C:\\Users\\example", environment: { LOCALAPPDATA: "C:\\Local" } }),
    "C:\\Local/app-usagemonitor/export-participant-secret",
  );
});

test("participant secret file is owner-only and reused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-"));
  const secretFile = join(directory, "private", "export-secret");
  try {
    const first = await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile });
    const second = await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(first.secret, second.secret);
    assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
    assert.equal((await readFile(secretFile, "utf8")).trim(), encodeParticipantSecret(first.secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("participant secret rejects symlinks, hardlinks, and loose permissions without modifying targets", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX link and mode policy");
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-policy-"));
  const encoded = `${encodeParticipantSecret(Buffer.alloc(32, 3))}\n`;
  try {
    const target = join(directory, "target");
    await writeFile(target, encoded, { mode: 0o600 });
    const symbolic = join(directory, "symbolic");
    await symlink(target, symbolic);
    await assert.rejects(
      loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: symbolic, legacySecretFile: null }),
    );
    assert.equal((await stat(target)).mode & 0o777, 0o600);

    const hard = join(directory, "hard");
    await link(target, hard);
    await assert.rejects(
      loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: hard, legacySecretFile: null }),
      /hard-linked/,
    );

    await rm(hard);
    await chmod(target, 0o644);
    await assert.rejects(
      loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: target, legacySecretFile: null }),
      /owner-only/,
    );
    assert.equal((await stat(target)).mode & 0o777, 0o644);

    const unsafeDirectory = join(directory, "unsafe");
    await mkdir(unsafeDirectory, { mode: 0o777 });
    await chmod(unsafeDirectory, 0o777);
    await assert.rejects(
      loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: join(unsafeDirectory, "new"), legacySecretFile: null }),
      /group- or world-writable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy working-directory identity migrates without changing the secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-migrate-"));
  const legacy = join(directory, "legacy", "secret");
  const canonical = join(directory, "canonical", "secret");
  const secret = Buffer.alloc(32, 5);
  try {
    await mkdir(join(directory, "legacy"), { mode: 0o700 });
    await writeFile(legacy, `${encodeParticipantSecret(secret)}\n`, { mode: 0o600 });
    const result = await loadOrCreateParticipantSecret({
      environmentSecret: null,
      secretFile: canonical,
      legacySecretFile: legacy,
    });
    assert.equal(result.migrated, true);
    assert.equal(result.created, false);
    assert.deepEqual(result.secret, secret);
    assert.equal(await readFile(legacy, "utf8"), await readFile(canonical, "utf8"));
    assert.match(await readFile(participantSecretLegacyRetirementFile(canonical), "utf8"), /retired v1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspection is non-creating and reports missing, legacy, canonical, and environment states", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-inspect-"));
  const legacy = join(directory, "legacy", "secret");
  const canonical = join(directory, "canonical", "secret");
  const secret = Buffer.alloc(32, 9);
  try {
    const missing = await inspectParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy });
    assert.equal(missing.status, "missing");
    assert.equal(missing.wouldCreate, true);
    assert.equal(Object.hasOwn(missing, "secret"), false);
    assert.equal(Object.hasOwn(missing, "path"), false);
    assert.deepEqual(await readdir(directory), []);

    await mkdir(join(directory, "legacy"), { mode: 0o700 });
    await writeFile(legacy, `${encodeParticipantSecret(secret)}\n`, { mode: 0o600 });
    const legacyOnly = await inspectParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy });
    assert.equal(legacyOnly.source, "legacy_owner_only_file");
    assert.equal(legacyOnly.wouldMigrate, true);
    assert.equal((await readdir(directory)).includes("canonical"), false);

    const environment = await inspectParticipantSecret({ environmentSecret: encodeParticipantSecret(secret), secretFile: canonical, legacySecretFile: legacy });
    assert.equal(environment.source, "environment");
    assert.equal(environment.rotatable, false);
    assert.equal((await readdir(directory)).includes("canonical"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("equal canonical and legacy secrets are accepted and different secrets fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-conflict-"));
  const legacy = join(directory, "legacy", "secret");
  const canonical = join(directory, "canonical", "secret");
  try {
    await mkdir(join(directory, "legacy"), { mode: 0o700 });
    await mkdir(join(directory, "canonical"), { mode: 0o700 });
    await writeFile(legacy, `${encodeParticipantSecret(Buffer.alloc(32, 4))}\n`, { mode: 0o600 });
    await writeFile(canonical, `${encodeParticipantSecret(Buffer.alloc(32, 4))}\n`, { mode: 0o600 });
    const equal = await inspectParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy });
    assert.equal(equal.status, "ready");
    assert.equal(equal.conflict, false);

    await writeFile(legacy, `${encodeParticipantSecret(Buffer.alloc(32, 6))}\n`, { mode: 0o600 });
    const conflict = await inspectParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy });
    assert.equal(conflict.status, "conflict");
    assert.equal(Object.hasOwn(conflict, "secret"), false);
    await assert.rejects(
      loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy }),
      (error) => error.code === "EXPORT_IDENTITY_CONFLICT",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent legacy migration converges on one canonical secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-migration-race-"));
  const legacy = join(directory, "legacy", "secret");
  const canonical = join(directory, "canonical", "secret");
  const secret = Buffer.alloc(32, 10);
  try {
    await mkdir(join(directory, "legacy"), { mode: 0o700 });
    await writeFile(legacy, `${encodeParticipantSecret(secret)}\n`, { mode: 0o600 });
    const results = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateParticipantSecret({
      environmentSecret: null,
      secretFile: canonical,
      legacySecretFile: legacy,
    })));
    results.forEach((result) => assert.deepEqual(result.secret, secret));
    assert.deepEqual((await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy })).secret, secret);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotation requires confirmation, refuses environment identity, and changes every derived identifier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-rotate-"));
  const canonical = join(directory, "canonical", "secret");
  try {
    const before = await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null });
    await assert.rejects(
      rotateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null }),
      /confirmRotation: true/,
    );
    await assert.rejects(
      rotateParticipantSecret({ confirmRotation: true, environmentSecret: encodeParticipantSecret(before.secret), secretFile: canonical }),
      (error) => error.code === "EXPORT_IDENTITY_ENVIRONMENT_ROTATION_REFUSED",
    );

    const identifiers = (secret) => [
      deriveParticipantId(secret),
      deriveSessionScopeId(secret, "session"),
      deriveEventId(secret, "event"),
      deriveEventOccurrenceId(secret, "event-source"),
      deriveSnapshotId(secret, "snapshot"),
      deriveSnapshotObservationId(secret, "snapshot-source"),
      deriveQuotaStateId(secret, "quota"),
      deriveMarkerId(secret, "marker"),
      deriveMarkerOccurrenceId(secret, "marker-source"),
      deriveAccountScopeId(secret, "account"),
      deriveModelFingerprint(secret, "model"),
    ];
    const beforeIds = identifiers(before.secret);
    const beforeInode = (await stat(canonical)).ino;
    const rotated = await rotateParticipantSecret({ confirmRotation: true, environmentSecret: null, secretFile: canonical, legacySecretFile: null });
    assert.equal(rotated.secureErasure, false);
    assert.notEqual((await stat(canonical)).ino, beforeInode);
    identifiers(rotated.secret).forEach((identifier, index) => assert.notEqual(identifier, beforeIds[index]));
    assert.deepEqual((await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null })).secret, rotated.secret);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotation retires legacy identity so deleting canonical cannot resurrect it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-retire-"));
  const legacy = join(directory, "legacy", "secret");
  const canonical = join(directory, "canonical", "secret");
  const original = Buffer.alloc(32, 12);
  try {
    await mkdir(join(directory, "legacy"), { mode: 0o700 });
    await writeFile(legacy, `${encodeParticipantSecret(original)}\n`, { mode: 0o600 });
    await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy });
    const rotated = await rotateParticipantSecret({ confirmRotation: true, environmentSecret: null, secretFile: canonical, legacySecretFile: legacy });
    assert.equal(rotated.legacyRetired, true);
    await rm(canonical);

    const inspection = await inspectParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy });
    assert.equal(inspection.status, "missing");
    assert.equal(inspection.legacyState, "retired");
    const recreated = await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: legacy });
    assert.equal(recreated.created, true);
    assert.equal(recreated.migrated, false);
    assert.notDeepEqual(recreated.secret, original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotation is serialized and failpoints leave a complete old or new strict file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-atomic-"));
  const canonical = join(directory, "canonical", "secret");
  try {
    const original = await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null });
    await assert.rejects(
      rotateParticipantSecret({
        confirmRotation: true,
        environmentSecret: null,
        secretFile: canonical,
        legacySecretFile: null,
        failpoint: "after-stage-sync",
      }),
      (error) => error.code === "EXPORT_IDENTITY_ROTATION_FAILPOINT",
    );
    assert.deepEqual((await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null })).secret, original.secret);
    assert.deepEqual((await readdir(join(directory, "canonical"))).sort(), ["secret"]);

    const externalReplacement = Buffer.alloc(32, 14);
    await assert.rejects(
      rotateParticipantSecret({
        confirmRotation: true,
        environmentSecret: null,
        secretFile: canonical,
        legacySecretFile: null,
        rotationHook: async (point) => {
          if (point !== "after-stage-sync") return;
          const replacementPath = join(directory, "canonical", "external-replacement");
          await writeFile(replacementPath, `${encodeParticipantSecret(externalReplacement)}\n`, { mode: 0o600 });
          await rename(replacementPath, canonical);
        },
      }),
      (error) => error.code === "EXPORT_IDENTITY_ROTATION_RACE",
    );
    assert.deepEqual((await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null })).secret, externalReplacement);
    assert.deepEqual((await readdir(join(directory, "canonical"))).sort(), ["secret"]);

    let releaseFirst;
    let firstHasLock;
    const hasLock = new Promise((resolve) => { firstHasLock = resolve; });
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    const first = rotateParticipantSecret({
      confirmRotation: true,
      environmentSecret: null,
      secretFile: canonical,
      legacySecretFile: null,
      rotationHook: async (point) => {
        if (point === "after-stage-sync") {
          firstHasLock();
          await release;
        }
      },
    });
    await hasLock;
    await assert.rejects(
      rotateParticipantSecret({ confirmRotation: true, environmentSecret: null, secretFile: canonical, legacySecretFile: null }),
      (error) => error.code === "EXPORT_IDENTITY_ROTATION_LOCKED",
    );
    releaseFirst();
    const concurrentWinner = await first;

    await assert.rejects(
      rotateParticipantSecret({
        confirmRotation: true,
        environmentSecret: null,
        secretFile: canonical,
        legacySecretFile: null,
        failpoint: "after-rename",
      }),
      (error) => error.code === "EXPORT_IDENTITY_ROTATION_FAILPOINT",
    );
    const afterRename = await inspectParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null });
    const afterRenameSecret = await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null });
    assert.equal(afterRename.status, "ready");
    assert.notDeepEqual(afterRenameSecret.secret, concurrentWinner.secret);
    assert.equal((await stat(canonical)).size, 44);
    assert.equal((await stat(canonical)).nlink, 1);
    assert.equal((await stat(canonical)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(join(directory, "canonical"))).sort(), ["secret"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotation CLI preflight is non-mutating and confirmed output is content-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-cli-"));
  const canonical = join(directory, "canonical", "private-secret-name");
  const childEnvironment = { ...process.env };
  delete childEnvironment.APP_USAGEMONITOR_EXPORT_SECRET;
  try {
    const before = await loadOrCreateParticipantSecret({ environmentSecret: null, secretFile: canonical, legacySecretFile: null });
    const beforeEncoded = encodeParticipantSecret(before.secret);
    const preflight = spawnSync(process.execPath, ["./src/cli.js", "rotate-local-identity", "--secret-file", canonical], {
      cwd: new URL("..", import.meta.url),
      env: childEnvironment,
      encoding: "utf8",
    });
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.match(preflight.stdout, /preflight: ready/);
    assert.equal(preflight.stdout.includes(canonical), false);
    assert.equal(preflight.stdout.includes(beforeEncoded), false);
    assert.equal(await readFile(canonical, "utf8"), `${beforeEncoded}\n`);

    const confirmed = spawnSync(process.execPath, ["./src/cli.js", "rotate-local-identity", "--secret-file", canonical, "--confirm"], {
      cwd: new URL("..", import.meta.url),
      env: childEnvironment,
      encoding: "utf8",
    });
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(confirmed.stdout, /rotation: completed/);
    assert.match(confirmed.stdout, /Network activity: none/);
    assert.equal(confirmed.stdout.includes(canonical), false);
    assert.equal(confirmed.stdout.includes(beforeEncoded), false);
    assert.notEqual((await readFile(canonical, "utf8")).trim(), beforeEncoded);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an export identity lease prevents rotation until publication work finishes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-secret-lease-"));
  const canonical = join(directory, "canonical", "secret");
  let finishLease;
  let leaseStarted;
  const started = new Promise((resolve) => { leaseStarted = resolve; });
  const finish = new Promise((resolve) => { finishLease = resolve; });
  try {
    const leased = withParticipantSecretLease({
      environmentSecret: null,
      secretFile: canonical,
      legacySecretFile: null,
    }, async (identity) => {
      leaseStarted(identity.secret);
      await finish;
      return "published";
    });
    const leasedSecret = await started;
    await assert.rejects(
      rotateParticipantSecret({
        confirmRotation: true,
        environmentSecret: null,
        secretFile: canonical,
        legacySecretFile: null,
      }),
      (error) => error.code === "EXPORT_IDENTITY_ROTATION_LOCKED",
    );
    finishLease();
    assert.equal(await leased, "published");
    const rotated = await rotateParticipantSecret({
      confirmRotation: true,
      environmentSecret: null,
      secretFile: canonical,
      legacySecretFile: null,
    });
    assert.notDeepEqual(rotated.secret, leasedSecret);
  } finally {
    finishLease?.();
    await rm(directory, { recursive: true, force: true });
  }
});
