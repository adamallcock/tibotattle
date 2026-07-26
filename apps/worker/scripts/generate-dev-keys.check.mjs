import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateEnvelopeKeys } from "./generate-dev-keys.mjs";

test("key generation writes one owner-only pair and never overwrites it", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-keygen-"));
  const destination = join(root, ".dev.vars.staging");
  try {
    assert.deepEqual(generateEnvelopeKeys(destination), { ok: true });
    const metadata = await stat(destination);
    assert.equal(metadata.mode & 0o777, 0o600);
    const contents = await readFile(destination, "utf8");
    const lines = contents.trim().split("\n");
    assert.equal(lines.length, 2);
    const privateJwk = JSON.parse(
      /^ENVELOPE_PRIVATE_JWK='(.+)'$/u.exec(lines[0])?.[1] ?? "null",
    );
    const publicJwk = JSON.parse(
      /^ENVELOPE_PUBLIC_JWK='(.+)'$/u.exec(lines[1])?.[1] ?? "null",
    );
    assert.equal(privateJwk.kty, "RSA");
    assert.equal(publicJwk.kty, "RSA");
    assert.equal(privateJwk.kid, publicJwk.kid);
    assert.equal(privateJwk.n, publicJwk.n);
    assert.equal(typeof privateJwk.d, "string");
    assert.equal(Object.hasOwn(publicJwk, "d"), false);
    assert.deepEqual(generateEnvelopeKeys(destination), {
      ok: false,
      code: "DESTINATION_EXISTS",
    });
    assert.equal(await readFile(destination, "utf8"), contents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
