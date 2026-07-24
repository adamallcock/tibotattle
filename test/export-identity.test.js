import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAccountScopeId,
  deriveEventId,
  deriveParticipantId,
  deriveSessionScopeId,
  defaultExportSecretFile,
  defaultExportStateDirectory,
  encodeParticipantSecret,
  loadOrCreateParticipantSecret,
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
