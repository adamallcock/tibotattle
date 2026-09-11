import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { createLocalOwnerFixture, localOwnerFixtureMaterial, localOwnerWorkerConfig } from "./local-owner-fixture.mjs";
import { readLocalOwnerAccess } from "./local-owner-erasure.mjs";

const workerDirectory = fileURLToPath(new URL("..", import.meta.url));
const baseConfig = parse(readFileSync(join(workerDirectory, "wrangler.jsonc"), "utf8"));
const origin = "http://127.0.0.1:8792";

function migratedDatabase(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const filename of readdirSync(join(workerDirectory, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(workerDirectory, "migrations", filename), "utf8"));
  }
  return db;
}

test("fresh local owner uses the existing hashed-session format and a separate identity", (t) => {
  const db = migratedDatabase(t);
  const material = localOwnerFixtureMaterial(origin);
  db.exec(material.sql);
  assert.match(material.access.participantId, /^participant:[0-9a-f-]{36}$/u);
  const participant = db.prepare("SELECT id, identity_link_key, consent_version FROM participants").get();
  assert.equal(participant.id, material.access.participantId);
  assert.equal(participant.identity_link_key, material.identityKey);
  assert.equal(participant.consent_version, "synthetic-preview-v0.1");
  const session = db.prepare("SELECT id, secret_hash, csrf_hash, state, scope FROM web_sessions").get();
  const secret = material.access.sessionCookie.split(".").at(-1);
  const hash = (kind, value) => createHash("sha256").update(`app-usagemonitor/${kind}/v1\0${session.id}\0${value}`).digest();
  assert.equal(session.state, "active");
  assert.equal(session.scope, "personal");
  assert.deepEqual(Buffer.from(session.secret_hash), hash("session", secret));
  assert.equal(material.access.csrfToken, `um_csrf_${hash("csrf", secret).toString("base64url")}`);
  assert.deepEqual(Buffer.from(session.csrf_hash), hash("csrf-binding", material.access.csrfToken));
  assert.equal(material.sql.includes(secret), false);
  assert.equal(material.sql.includes(material.access.csrfToken), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM participant_community_eligibility").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_credentials").get().n, 0);
  assert.notEqual(localOwnerFixtureMaterial(origin).identityKey, material.identityKey);
});

test("fixture SQL never promotes or replaces an existing participant", (t) => {
  const db = migratedDatabase(t);
  const first = localOwnerFixtureMaterial(origin);
  db.exec(first.sql);
  const before = db.prepare("SELECT * FROM participants").all();
  const second = localOwnerFixtureMaterial(origin);
  db.exec(second.sql);
  assert.deepEqual(db.prepare("SELECT * FROM participants").all(), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM web_sessions").get().n, 1);
});

test("owner Worker config is local, one-owner-only and excludes hosted environments", () => {
  const key = "a".repeat(64);
  const config = localOwnerWorkerConfig(baseConfig, { identityKey: key });
  assert.equal(config.vars.ADMIN_IDENTITY_LINK_KEY, key);
  assert.equal(config.vars.ENVIRONMENT, "local-development");
  assert.equal(config.vars.ENROLLMENT_MODE, "local_open");
  assert.equal(Object.hasOwn(config, "env"), false);
  assert.equal(config.main, join(workerDirectory, "src/index.ts"));
  assert.equal(config.d1_databases[0].migrations_dir, join(workerDirectory, "migrations"));
  for (const config of [
    { ...baseConfig, name: "production" },
    { ...baseConfig, vars: { ENVIRONMENT: "production" } },
    { ...baseConfig, d1_databases: [{ ...baseConfig.d1_databases[0], database_id: "real-resource" }] },
    { ...baseConfig, r2_buckets: [{ ...baseConfig.r2_buckets[0], remote: true }] },
    { ...baseConfig, services: [{ binding: "REMOTE" }] },
  ]) assert.throws(() => localOwnerWorkerConfig(config, { identityKey: key }));
  assert.equal(Object.hasOwn(baseConfig.vars, "ADMIN_IDENTITY_LINK_KEY"), false);
});

test("local owner assets use source files without changing guarded hosted asset configuration", () => {
  const before = structuredClone(baseConfig);
  const config = localOwnerWorkerConfig(baseConfig, { identityKey: "a".repeat(64) });
  const sourceAssets = resolve(workerDirectory, "..", "web", "public");
  assert.deepEqual(config.assets, { ...baseConfig.assets, directory: sourceAssets });
  assert.equal(statSync(join(sourceAssets, "index.html")).isFile(), true);
  assert.deepEqual(baseConfig, before);
  assert.equal(baseConfig.assets.directory, "../../.release-build/worker-assets");
  assert.equal(baseConfig.env.production.assets.directory, "../../.release-build/public-release-site");
  assert.equal(baseConfig.env.production.assets.not_found_handling, "404-page");
  assert.equal(baseConfig.env.staging.assets.directory, "../../.release-build/worker-assets");
});

test("fixture creation uses local D1 only, bounded receipts and exclusive owner-only files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "local-owner-fixture-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const fixture = join(root, "fixture");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(baseConfig));
  const db = migratedDatabase(t);
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    assert.equal(args.includes("--local"), true);
    assert.equal(args.includes("--remote"), false);
    assert.equal(args[args.indexOf("--env") + 1], "");
    assert.equal(args[2], "USAGE_MONITOR_DB");
    if (args.includes("--command")) {
      assert.equal(args.at(-1), "SELECT COUNT(*) AS participants FROM participants;");
      return { status: 0, stdout: JSON.stringify([{ results: [db.prepare(args.at(-1)).get()] }]) };
    }
    assert.equal(args.includes("--file"), true);
    db.exec(readFileSync(args.at(-1), "utf8"));
    return { status: 0, stdout: JSON.stringify([{ results: [{ owner_fixture_sessions: 1 }] }]) };
  };
  const files = createLocalOwnerFixture({ origin, persistTo: state, directory: fixture, workerDirectory: root, spawn });
  assert.equal(calls.length, 2);
  const access = await readLocalOwnerAccess(files.accessFile, origin);
  const config = JSON.parse(readFileSync(files.configFile, "utf8"));
  assert.equal(config.vars.ADMIN_IDENTITY_LINK_KEY, db.prepare("SELECT identity_link_key FROM participants WHERE id = ?").get(access.participantId).identity_link_key);
  assert.match(readFileSync(files.varsFile, "utf8"), /ENVELOPE_PRIVATE_JWK=/u);
  for (const file of [...Object.values(files), join(fixture, "owner-fixture.sql")]) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  const before = readFileSync(files.accessFile, "utf8");
  assert.throws(() => createLocalOwnerFixture({ origin, persistTo: state, directory: fixture, workerDirectory: root, spawn }), /nonempty/u);
  assert.equal(readFileSync(files.accessFile, "utf8"), before);
});

test("missing migrations or a failed D1 seed cannot publish an owner capability", (t) => {
  const root = mkdtempSync(join(tmpdir(), "local-owner-fixture-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(baseConfig));
  for (const seedFailure of [false, true]) {
    const directory = join(root, String(seedFailure));
    assert.throws(() => createLocalOwnerFixture({
      origin, persistTo: state, directory, workerDirectory: root,
      spawn: (_command, args) => seedFailure && args.includes("--command")
        ? { status: 0, stdout: JSON.stringify([{ results: [{ participants: 0 }] }]) }
        : { status: 1, stderr: "private diagnostic must not escape" },
    }), /setup failed/u);
    assert.throws(() => statSync(join(directory, "owner-access.json")), { code: "ENOENT" });
  }
});
