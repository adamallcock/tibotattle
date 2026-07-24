import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveAccountScopeId,
  deriveEventId,
  deriveParticipantId,
  deriveSessionScopeId,
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
