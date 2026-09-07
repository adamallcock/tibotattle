import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDesktopContributionCredentialBackend,
  createDesktopContributionCredentialLegacyProbe,
} from "../desktop-contribution-credential.js";

function cryptoFixture() {
  const key = randomBytes(32);
  let reencryptNextDecrypt = false;
  let encryptions = 0;
  return {
    requestReencrypt() { reencryptNextDecrypt = true; },
    get encryptions() { return encryptions; },
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    async encryptStringAsync(value) {
      encryptions += 1;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      const shouldReEncrypt = reencryptNextDecrypt;
      reencryptNextDecrypt = false;
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"), shouldReEncrypt };
    },
  };
}

test("legacy macOS ciphertext inspection never initializes or decrypts safeStorage", async () => {
  const calls = [];
  for (const [stored, expected] of [
    [null, "absent"],
    [{ schemaVersion: "accountless-encrypted-credential-v1", encrypted: "AAAA" }, "present"],
    [{ schemaVersion: "unexpected", encrypted: null }, "unavailable"],
  ]) {
    const probe = createDesktopContributionCredentialLegacyProbe({
      platform: "darwin",
      rootPath: "/synthetic/profile",
      storage: {
        load: async () => {
          calls.push("load");
          return stored;
        },
      },
    });
    assert.equal(await probe.inspect(), expected);
  }
  assert.deepEqual(calls, ["load", "load", "load"]);
});

test("installation credential persists encrypted and survives adapter restart", async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), "accountless-vault-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const safeStorage = cryptoFixture();
  const backend = createDesktopContributionCredentialBackend({ platform: "darwin", rootPath, safeStorage });
  const secret = randomBytes(32);
  assert.equal(await backend.read(), null);
  assert.equal(await backend.createIfMissing(secret), "created");
  const stored = await readFile(join(rootPath, "accountless-installation-credential-v1.json"), "utf8");
  assert.equal(stored.includes(secret.toString("base64url")), false);
  assert.equal(stored.includes(secret.toString("hex")), false);
  const restarted = createDesktopContributionCredentialBackend({ platform: "darwin", rootPath, safeStorage });
  assert.deepEqual(await restarted.read(), secret);
  assert.equal(await restarted.createIfMissing(randomBytes(32)), "existing");
  assert.equal(await restarted.deleteExact(randomBytes(32)), "mismatch");
  assert.deepEqual(await restarted.read(), secret);
  assert.equal(await restarted.deleteExact(secret), "deleted");
  assert.equal(await restarted.read(), null);
});
test("unavailable encryption, Linux basic_text, and failed decryption refuse secret access", async () => {
  let touched = 0;
  const storage = { load: async () => { touched++; return null; }, save: async () => { touched++; } };
  for (const safeStorage of [undefined, { ...cryptoFixture(), isAsyncEncryptionAvailable: async () => false },
    { ...cryptoFixture(), getSelectedStorageBackend: () => "basic_text" }]) {
    const backend = createDesktopContributionCredentialBackend({ platform: "linux", storage, safeStorage });
    await assert.rejects(backend.read(), { code: "contribution_device_credential_unavailable" });
    await assert.rejects(backend.createIfMissing(randomBytes(32)), { code: "contribution_device_credential_unavailable" });
  }
  assert.equal(touched, 0);
  const backend = createDesktopContributionCredentialBackend({ platform: "darwin", safeStorage: cryptoFixture(),
    storage: { load: async () => ({ schemaVersion: "accountless-encrypted-credential-v1", encrypted: "AAAA" }), save: async () => assert.fail("must not reset corrupt credentials") } });
  await assert.rejects(backend.read(), { code: "contribution_device_credential_unavailable" });
});

test("a rotated Electron key is atomically re-encrypted, verified, and survives restart", async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), "accountless-vault-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const safeStorage = cryptoFixture();
  const backend = createDesktopContributionCredentialBackend({ platform: "darwin", rootPath, safeStorage });
  const secret = randomBytes(32);
  assert.equal(await backend.createIfMissing(secret), "created");
  const before = JSON.parse(await readFile(join(rootPath, "accountless-installation-credential-v1.json"), "utf8"));
  safeStorage.requestReencrypt();
  assert.deepEqual(await backend.read(), secret);
  const after = JSON.parse(await readFile(join(rootPath, "accountless-installation-credential-v1.json"), "utf8"));
  assert.equal(safeStorage.encryptions, 2, "the rotated value is encrypted once with the current provider");
  assert.notEqual(after.encrypted, before.encrypted);
  assert.equal(after.encrypted.includes(secret.toString("base64url")), false);
  const restarted = createDesktopContributionCredentialBackend({ platform: "darwin", rootPath, safeStorage });
  assert.deepEqual(await restarted.read(), secret);
});

test("a failed rotation rewrite withholds the secret and preserves the prior ciphertext", async () => {
  const safeStorage = cryptoFixture();
  let stored = null;
  let saves = 0;
  const backend = createDesktopContributionCredentialBackend({
    platform: "darwin",
    safeStorage,
    storage: {
      load: async () => stored,
      save: async (next) => {
        saves += 1;
        if (saves > 1) throw new Error("synthetic rotation write failure");
        stored = structuredClone(next);
      },
    },
  });
  const secret = randomBytes(32);
  assert.equal(await backend.createIfMissing(secret), "created");
  const before = structuredClone(stored);
  safeStorage.requestReencrypt();
  await assert.rejects(backend.read(), (error) => error?.code === "contribution_device_credential_unavailable"
    && error.retryable === false);
  assert.deepEqual(stored, before, "a rejected atomic save cannot replace the prior ciphertext");
  assert.deepEqual(await backend.read(), secret, "the prior encrypted credential remains usable");
});

test("a mismatched rotated ciphertext is rejected before it can replace the prior credential", async (t) => {
  const rootPath = await mkdtemp(join(tmpdir(), "accountless-vault-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const safeStorage = cryptoFixture();
  const encrypt = safeStorage.encryptStringAsync.bind(safeStorage);
  const replacement = randomBytes(32);
  let corruptCandidate = false;
  safeStorage.encryptStringAsync = async (value) => encrypt(corruptCandidate
    ? replacement.toString("base64url") : value);
  const backend = createDesktopContributionCredentialBackend({ platform: "darwin", rootPath, safeStorage });
  const secret = randomBytes(32);
  assert.equal(await backend.createIfMissing(secret), "created");
  const credentialPath = join(rootPath, "accountless-installation-credential-v1.json");
  const before = await readFile(credentialPath, "utf8");
  corruptCandidate = true;
  safeStorage.requestReencrypt();
  await assert.rejects(backend.read(), (error) => error?.code === "contribution_device_credential_unavailable"
    && error.retryable === false);
  assert.equal(await readFile(credentialPath, "utf8"), before);
  corruptCandidate = false;
  assert.deepEqual(await backend.read(), secret);
  replacement.fill(0);
});

test("only explicit temporary protected-storage availability is retryable", async () => {
  const unavailable = createDesktopContributionCredentialBackend({
    platform: "darwin",
    safeStorage: { ...cryptoFixture(), isAsyncEncryptionAvailable: async () => false },
    storage: { load: async () => assert.fail("unavailable provider must not read storage"), save: async () => {} },
  });
  await assert.rejects(unavailable.read(), (error) => error?.code === "contribution_device_credential_unavailable"
    && error.retryable === true);

  const temporarilyUnavailable = createDesktopContributionCredentialBackend({
    platform: "darwin",
    safeStorage: {
      ...cryptoFixture(),
      decryptStringAsync: async () => {
        throw new Error("safeStorage.decryptStringAsync is temporarily unavailable. Please try again.");
      },
    },
    storage: { load: async () => ({ schemaVersion: "accountless-encrypted-credential-v1", encrypted: "AAAA" }), save: async () => {} },
  });
  await assert.rejects(temporarilyUnavailable.read(), (error) => error?.code === "contribution_device_credential_unavailable"
    && error.retryable === true);

  const malformed = createDesktopContributionCredentialBackend({
    platform: "darwin",
    safeStorage: cryptoFixture(),
    storage: { load: async () => ({ schemaVersion: "accountless-encrypted-credential-v1", encrypted: "###" }), save: async () => {} },
  });
  await assert.rejects(malformed.read(), (error) => error?.code === "contribution_device_credential_unavailable"
    && error.retryable === false);
});

test("concurrent create attempts retain exactly one installation secret", async () => {
  let value = null;
  const backend = createDesktopContributionCredentialBackend({ platform: "darwin", safeStorage: cryptoFixture(),
    storage: { load: async () => value, save: async (next) => { value = next; } } });
  const first = randomBytes(32);
  assert.deepEqual(await Promise.all([backend.createIfMissing(first), backend.createIfMissing(randomBytes(32))]), ["created", "existing"]);
  assert.deepEqual(await backend.read(), first);
});
