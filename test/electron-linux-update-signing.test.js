import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { signLinuxUpdateFeed } from "../scripts/sign-electron-linux-update.mjs";
import { createLinuxUpdateVerifier } from "../apps/electron/linux-update-authenticity.js";

test("explicit local producer signs exact final artifact and emits runtime-compatible feed", async t => {
  const root = await mkdtemp(join(tmpdir(), "linux-update-signing-")); t.after(() => rm(root, { recursive: true, force: true }));
  const artifactPath = join(root, "TiboTattle-0.1.20-linux-x86_64.AppImage"), bytes = Buffer.from("synthetic artifact, never executed");
  await writeFile(artifactPath, bytes, { mode: 0o600 });
  const hash = createHash("sha512").update(bytes).digest("base64"), version = "0.1.20";
  const feed = { version, files: [{ url: "TiboTattle-0.1.20-linux-x86_64.AppImage", size: bytes.length, sha512: hash }], path: "TiboTattle-0.1.20-linux-x86_64.AppImage", sha512: hash };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keys = [{ id: "synthetic", publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), minimumSequence: 1, maximumSequence: 100 }];
  let signatures = 0;
  const now = () => 1_900_000_000_000;
  const options = { artifactPath, feedBytes: Buffer.from(JSON.stringify(feed)), sequence: 10, expiresAt: now() + 60_000, keyId: "synthetic", keys, now,
    signer: value => { signatures += 1; return sign(null, value, privateKey); } };
  const produced = JSON.parse(await signLinuxUpdateFeed(options));
  const v = createLinuxUpdateVerifier({ keys, currentVersion: "0.1.18", now, backend: { load: async () => null, save: async () => {} } });
  await v.authorize(produced);
  assert.equal(signatures, 1);
  for (const alter of [{ sequence: 0 }, { expiresAt: now() }, { keyId: "unknown" }, { keys: [] },
    { feedBytes: Buffer.from(JSON.stringify({ ...feed, sha512: "attacker checksum" })) }]) {
    await assert.rejects(signLinuxUpdateFeed({ ...options, ...alter }));
  }
  assert.equal(signatures, 1, "invalid subjects rejected before signing");
  const wrong = generateKeyPairSync("ed25519").privateKey;
  await assert.rejects(signLinuxUpdateFeed({ ...options, signer: value => sign(null, value, wrong) }));
});

test("production signing CLI refuses missing roots before private-file access and never prints paths", () => {
  const result = spawnSync(process.execPath, ["scripts/sign-electron-linux-update.mjs", "--sign", "--artifact", "unused.AppImage",
    "--feed", "unused.yml", "--sequence", "1", "--expires-at", "1900000060000", "--key-id", "unprovisioned",
    "--private-key-file", "private-canary.pem", "--output", "unused-output.yml"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, ""); assert.equal(result.stderr.trim(), "LINUX_UPDATE_SIGNING_REFUSED");
});
