import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertRetiredDeletionHealth,
  createLocalOwnerEraser,
  localErasureOrigin,
  readLocalOwnerAccess,
  validateOwnerErasureReceipt,
} from "./local-owner-erasure.mjs";

const origin = "http://127.0.0.1:8792";
const ownerId = "participant:10000000-0000-4000-8000-000000000001";
const targetId = "participant:20000000-0000-4000-8000-000000000002";
const owner = {
  schemaVersion: "local-backend-owner-access-v0.1", origin, participantId: ownerId,
  sessionCookie: `__Host-usage_monitor_session=um_session_10000000-0000-4000-8000-000000000003.${"a".repeat(43)}`,
  csrfToken: `um_csrf_${"b".repeat(43)}`, expiresAt: "2099-01-01T00:00:00.000Z",
};
const target = () => ({
  participantId: targetId, deleted: false,
  cookie: `__Host-usage_monitor_session=um_session_20000000-0000-4000-8000-000000000004.${"c".repeat(43)}`,
  csrfToken: `um_csrf_${"d".repeat(43)}`,
});
const erasureReceipt = (overrides = {}) => ({
  schemaVersion: "admin-action-v0.1", action: "run_maintenance",
  result: {
    task: "participant_erasure", operationId: "30000000-0000-4000-8000-000000000005",
    deleted: true, alreadyDeleted: false, contributionsDeleted: 1, ...overrides,
  },
});
const hasCode = (code) => (error) => error.code === code;

async function accessFile(t, value = owner) {
  const root = await mkdtemp(join(tmpdir(), "local-owner-erasure-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "owner.json");
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}

function service({ intercept, environment = "local-development", deniedOwner = false } = {}) {
  let erased = false;
  let mutation = null;
  let generation = 0;
  const calls = [];
  const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const error = (status, code) => json({ error: { code } }, status);
  const fetchImpl = async (url, options) => {
    const path = url.pathname;
    const method = options.method;
    const isOwner = options.headers.Cookie === owner.sessionCookie;
    const call = { path, ...options, isOwner };
    calls.push(call);
    assert.equal(url.origin, origin);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    const intercepted = intercept?.(call, { json, error, mutate: (value) => { mutation = value; } });
    if (intercepted) return intercepted;
    if (path === "/api/v1/session") {
      if (!isOwner && erased) return error(401, "AUTH_INVALID");
      return json({ participantId: isOwner ? ownerId : targetId,
        csrfToken: isOwner ? owner.csrfToken : target().csrfToken,
        expiresAt: owner.expiresAt, createdAt: "2026-08-30T00:00:00.000Z", consentVersion: "privacy-safe-telemetry-v0.1" });
    }
    if (path === "/api/v1/admin/overview") {
      if (deniedOwner) return error(403, "ADMIN_REQUIRED");
      return json({ schemaVersion: "admin-overview-v0.3", service: { environment } });
    }
    if (path === "/api/v1/me/export") {
      if (erased) return error(401, "AUTH_INVALID");
      return json({ schemaVersion: "participant-export-v0.2", syntheticOnly: false,
        participant: { participantId: targetId },
        contributions: [{ contributionId: "contribution:synthetic", records: [{ value: mutation ?? "unchanged" }] }],
        generatedAt: String(generation++),
      });
    }
    if (path === "/api/v1/me/devices") return json({ devices: [{ deviceId: "synthetic", state: "active" }] });
    if (path === "/api/v1/me" && method === "DELETE") return error(404, "NOT_FOUND");
    if (path === "/api/v1/admin/action") {
      if (!isOwner) return error(403, "ADMIN_REQUIRED");
      if (options.headers.Origin !== origin || options.headers["X-Usage-Monitor-CSRF"] !== owner.csrfToken) {
        return error(403, "CSRF_INVALID");
      }
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { action: "run_maintenance",
        participantErasure: { participantId: targetId, confirmation: "erase_hosted_participant" } });
      const response = erasureReceipt({ alreadyDeleted: erased, contributionsDeleted: erased ? null : 1 });
      erased = true;
      return json(response);
    }
    throw new Error("Unexpected test request");
  };
  return { calls, fetchImpl };
}

test("local erasure rejects remote, credentialed, and non-origin URLs", () => {
  assert.equal(localErasureOrigin(`${origin}/`), origin);
  for (const value of ["https://127.0.0.1", "http://192.168.1.1", "https://production.invalid", "http://user:secret@localhost", `${origin}/api`, `${origin}?next=secret`, `${origin}#secret`, "not a URL"]) {
    assert.throws(() => localErasureOrigin(value), hasCode("LOCAL_ERASURE_ORIGIN_INVALID"));
  }
});

test("retirement health distinguishes unavailable deletion from deletion-safe restore", () => {
  assert.doesNotThrow(() => assertRetiredDeletionHealth({ capabilities: { participantDeletion: false, deletionSafeRestoreReplay: true } }));
  for (const capabilities of [{}, { participantDeletion: true, deletionSafeRestoreReplay: true }, { participantDeletion: false, deletionSafeRestoreReplay: false }]) {
    assert.throws(() => assertRetiredDeletionHealth({ capabilities }), hasCode("LOCAL_RETIREMENT_CONTRACT_INVALID"));
  }
});

test("missing owner access fails before any HTTP request", async () => {
  let requests = 0;
  await assert.rejects(createLocalOwnerEraser({ origin, fetchImpl: () => { requests += 1; } }), hasCode("LOCAL_OWNER_ACCESS_REQUIRED"));
  assert.equal(requests, 0);
});

test("owner file is exact-origin, owner-only, unexpired and closed-schema", async (t) => {
  const file = await accessFile(t);
  assert.deepEqual(await readLocalOwnerAccess(file, origin), owner);
  await assert.rejects(readLocalOwnerAccess(file, "http://localhost:8792"), hasCode("LOCAL_OWNER_ACCESS_INVALID"));
  for (const value of [
    { ...owner, participantId: ownerId.slice("participant:".length) },
    { ...owner, sessionCookie: `${owner.sessionCookie}; other=secret` },
    { ...owner, expiresAt: "2000-01-01T00:00:00.000Z" },
    { ...owner, extra: "private" },
  ]) {
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(readLocalOwnerAccess(file, origin), hasCode("LOCAL_OWNER_ACCESS_INVALID"));
  }
  await writeFile(file, "sensitive-invalid-json");
  await assert.rejects(readLocalOwnerAccess(file, origin), (error) => error.code === "LOCAL_OWNER_ACCESS_INVALID" && !error.message.includes("sensitive"));
  await writeFile(file, JSON.stringify(owner));
  await link(file, `${file}.hardlink`);
  await assert.rejects(readLocalOwnerAccess(file, origin), hasCode("LOCAL_OWNER_ACCESS_INVALID"));
  await rm(`${file}.hardlink`);
  if (process.platform !== "win32") {
    await symlink(file, `${file}.symlink`);
    await assert.rejects(readLocalOwnerAccess(`${file}.symlink`, origin), hasCode("LOCAL_OWNER_ACCESS_INVALID"));
    await chmod(file, 0o644);
    await assert.rejects(readLocalOwnerAccess(file, origin), hasCode("LOCAL_OWNER_ACCESS_INVALID"));
  }
});

test("owner authorization and local environment are preflighted read-only", async (t) => {
  const ownerAccessFile = await accessFile(t);
  for (const [options, code] of [[{ deniedOwner: true }, "LOCAL_OWNER_NOT_AUTHORIZED"], [{ environment: "production" }, "LOCAL_OWNER_ENVIRONMENT_INVALID"]]) {
    const backend = service(options);
    await assert.rejects(createLocalOwnerEraser({ origin, ownerAccessFile, fetchImpl: backend.fetchImpl }), hasCode(code));
    assert.deepEqual(backend.calls.map(({ method }) => method), ["GET", "GET"]);
  }
});

test("participant requests are refused without changing export/session/devices; only owner erases", async (t) => {
  const backend = service();
  const eraser = await createLocalOwnerEraser({ origin, ownerAccessFile: await accessFile(t), fetchImpl: backend.fetchImpl });
  const session = target();
  assert.throws(() => eraser.trackParticipant({ ...session, participantId: ownerId }), hasCode("LOCAL_ERASURE_TARGET_INVALID"));
  await assert.rejects(eraser.eraseParticipant(session), hasCode("LOCAL_ERASURE_TARGET_INVALID"));
  eraser.trackParticipant(session);
  assert.deepEqual(await eraser.verifyParticipantRefusal(session), {
    selfServiceDeletionRefused: true, participantStateUnchanged: true, ownerAuthAndCsrfRequired: true,
  });
  assert.equal(session.deleted, false);
  assert.equal(backend.calls.filter(({ method }) => method === "DELETE").length, 4);
  const receipt = await eraser.eraseParticipant(session, { expectedContributions: 1 });
  assert.equal(receipt.contributionsDeleted, 1);
  assert.equal(session.deleted, true);
  const replay = await eraser.eraseParticipant(session, { retry: true });
  assert.equal(replay.alreadyDeleted, true);
  assert.equal(replay.contributionsDeleted, null);
});

test("404 is never an owner-cleanup receipt", async (t) => {
  const backend = service({ intercept: (call, { error }) => call.path === "/api/v1/admin/action" && call.isOwner ? error(404, "NOT_FOUND") : null });
  const eraser = await createLocalOwnerEraser({ origin, ownerAccessFile: await accessFile(t), fetchImpl: backend.fetchImpl });
  const session = target();
  eraser.trackParticipant(session);
  await assert.rejects(eraser.eraseParticipant(session, { retry: true }), hasCode("LOCAL_ERASURE_RECEIPT_INVALID"));
  assert.equal(session.deleted, false);
});

test("refused DELETE that changes participant content fails the smoke", async (t) => {
  const backend = service({ intercept: (call, { mutate }) => {
    if (call.method === "DELETE") mutate("unexpected mutation");
  } });
  const eraser = await createLocalOwnerEraser({ origin, ownerAccessFile: await accessFile(t), fetchImpl: backend.fetchImpl });
  const session = target();
  eraser.trackParticipant(session);
  await assert.rejects(eraser.verifyParticipantRefusal(session), hasCode("LOCAL_RETIREMENT_STATE_CHANGED"));
  assert.equal(session.deleted, false);
});

test("refusal probes cannot turn a legacy 200 or CSRF bypass into success", async (t) => {
  for (const probe of ["DELETE", "OWNER_POST"]) {
    const backend = service({ intercept: (call, { json }) => {
      if ((probe === "DELETE" && call.method === "DELETE")
          || (probe === "OWNER_POST" && call.path === "/api/v1/admin/action" && call.isOwner)) return json({ deleted: true });
    } });
    const eraser = await createLocalOwnerEraser({ origin, ownerAccessFile: await accessFile(t), fetchImpl: backend.fetchImpl });
    const session = target();
    eraser.trackParticipant(session);
    await assert.rejects(eraser.verifyParticipantRefusal(session), hasCode("LOCAL_RETIREMENT_REFUSAL_INVALID"));
  }
});

test("erasure receipts validate action, task, operation, counts, and ledger replay", () => {
  assert.equal(validateOwnerErasureReceipt(erasureReceipt(), { expectedContributions: 1 }).deleted, true);
  for (const result of [
    { task: "maintenance" }, { operationId: "unproven" }, { deleted: false },
    { contributionsDeleted: null }, { contributionsDeleted: -1 }, { contributionsDeleted: 0.5 },
    { alreadyDeleted: true, contributionsDeleted: 0 }, { privateContent: "forbidden" },
  ]) assert.throws(() => validateOwnerErasureReceipt(erasureReceipt(result), { retry: true }), hasCode("LOCAL_ERASURE_RECEIPT_INVALID"));
  assert.throws(() => validateOwnerErasureReceipt(erasureReceipt(), { expectedContributions: 2 }), hasCode("LOCAL_ERASURE_RECEIPT_INVALID"));
  assert.throws(() => validateOwnerErasureReceipt({ ...erasureReceipt(), action: "delete_me" }), hasCode("LOCAL_ERASURE_RECEIPT_INVALID"));
  assert.throws(() => validateOwnerErasureReceipt(erasureReceipt({ alreadyDeleted: true, contributionsDeleted: null })), hasCode("LOCAL_ERASURE_RECEIPT_INVALID"));
});

test("owner success without revoked participant access fails cleanup", async (t) => {
  const backend = service({ intercept: (call, { json }) => call.path === "/api/v1/admin/action" ? json(erasureReceipt()) : null });
  const eraser = await createLocalOwnerEraser({ origin, ownerAccessFile: await accessFile(t), fetchImpl: backend.fetchImpl });
  const session = target();
  eraser.trackParticipant(session);
  await assert.rejects(eraser.eraseParticipant(session), hasCode("LOCAL_ERASURE_SESSION_NOT_REVOKED"));
  assert.equal(session.deleted, false);
});

test("smoke CLIs stop for missing owner configuration before reaching the server", () => {
  for (const [file, args] of [
    ["smoke-http-backend.mjs", ["--generated-content-free-fixture"]],
    ["smoke-account-scoped-http.mjs", []],
    ["smoke-sync-queue-http.mjs", ["--file", "/nonexistent-synthetic-fixture"]],
    ["smoke-incident-containment-http.mjs", ["--file", "/nonexistent-synthetic-fixture", "--persist-to", "/nonexistent-state"]],
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, `${file}: ${result.stderr}`);
    assert.match(result.stderr, /--owner-access-file is required before enrollment/u);
    assert.equal(result.stdout, "");
  }
});
