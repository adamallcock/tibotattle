import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as identityCore from "@app-usagemonitor/identity-core";
import * as participantIdentity from
  "../src/platform/participant-identity.js";

const IDENTITY_CORE_EXPORTS = Object.freeze([
  "deriveExportPseudonym",
  "deriveExportPseudonymV2",
]);

test("identity core exposes one exact typed workspace package root", async () => {
  const [manifest, rootManifest, lockfile, declarations] = await Promise.all([
    readFile(
      new URL("../packages/identity-core/package.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(new URL("../package.json", import.meta.url), "utf8")
      .then(JSON.parse),
    readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"),
    readFile(
      new URL("../packages/identity-core/index.d.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.equal(manifest.name, "@app-usagemonitor/identity-core");
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert.deepEqual(manifest.exports["."], {
    types: "./index.d.ts",
    import: "./index.js",
    default: "./index.js",
  });
  assert.deepEqual(manifest.files, ["index.d.ts", "index.js", "src"]);
  assert.equal(Object.hasOwn(manifest, "dependencies"), false);
  assert.deepEqual(Object.keys(identityCore).sort(), IDENTITY_CORE_EXPORTS);
  assert.equal(
    rootManifest.dependencies["@app-usagemonitor/identity-core"],
    "workspace:*",
  );
  assert.match(
    lockfile,
    /\n  packages\/identity-core: \{\}/u,
  );
  for (const name of IDENTITY_CORE_EXPORTS) {
    assert.match(
      declarations,
      new RegExp(`export function ${name}\\(`, "u"),
    );
    assert.strictEqual(participantIdentity[name], identityCore[name], name);
  }
});

test("identity core preserves frozen v1 and v2 derivation vectors", () => {
  const zeroSecret = Buffer.alloc(32);
  const before = Buffer.from(zeroSecret);
  assert.equal(
    identityCore.deriveExportPseudonym(
      zeroSecret,
      "participant",
      "self",
    ),
    "participant:v1:18a0babfe92f99d0737d96bd43ed18e494e8930e216eeb12d620742284df3f7c",
  );
  assert.equal(
    identityCore.deriveExportPseudonymV2(
      zeroSecret,
      "event",
      "subject",
    ),
    "event:v2:c413a9f98331858a2aa742cb0f6c6472c77b8f97b8acd01cff210b4813f03257",
  );
  assert.deepEqual(zeroSecret, before, "the caller-owned secret is not mutated");
  assert.equal(
    identityCore.deriveExportPseudonym(
      zeroSecret.toString("base64url"),
      "participant",
      "self",
    ),
    identityCore.deriveExportPseudonym(
      new Uint8Array(zeroSecret),
      "participant",
      "self",
    ),
  );
});

test("identity core preserves validation order and content-free errors", () => {
  const secret = Buffer.alloc(32);
  let hostilePrefixAccesses = 0;
  const hostilePrefix = new Proxy({}, {
    get() {
      hostilePrefixAccesses += 1;
      throw new Error("prefix coercion must not run");
    },
  });
  for (const [invoke, message] of [
    [
      () => identityCore.deriveExportPseudonym(secret, hostilePrefix, "self"),
      "Pseudonym prefix is invalid",
    ],
    [
      () => identityCore.deriveExportPseudonym(secret, null, "self"),
      "Pseudonym prefix is invalid",
    ],
    [
      () => identityCore.deriveExportPseudonym(secret, 1, "self"),
      "Pseudonym prefix is invalid",
    ],
    [
      () => identityCore.deriveExportPseudonym(secret, "Invalid", "self"),
      "Pseudonym prefix is invalid",
    ],
    [
      () => identityCore.deriveExportPseudonym(secret, "event", ""),
      "Pseudonym subject must be a bounded non-empty string",
    ],
    [
      () => identityCore.deriveExportPseudonym(
        secret,
        "event",
        "x".repeat(4097),
      ),
      "Pseudonym subject must be a bounded non-empty string",
    ],
    [
      () => identityCore.deriveExportPseudonym(Buffer.alloc(31), "event", "x"),
      "Participant secret must contain exactly 32 bytes",
    ],
    [
      () => identityCore.deriveExportPseudonym("not-a-secret", "event", "x"),
      "Participant secret must be a 32-byte base64url value",
    ],
  ]) {
    assert.throws(invoke, (error) => (
      error instanceof Error && error.message === message
    ));
  }
  assert.equal(hostilePrefixAccesses, 0, "prefix validation must not coerce");
  assert.throws(
    () => identityCore.deriveExportPseudonym(
      Buffer.alloc(31),
      "Invalid",
      "",
    ),
    (error) => error?.message === "Pseudonym prefix is invalid",
  );
});

test("identity core consumers use only the reviewed package root", async () => {
  const [platformSource, contributionSource, implementationSource] =
    await Promise.all([
      readFile(
        new URL(
          "../src/platform/participant-identity.js",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../src/contribution/account-track.js", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../packages/identity-core/src/pseudonym.js",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
  for (const source of [platformSource, contributionSource]) {
    assert.match(source, /from "@app-usagemonitor\/identity-core"/u);
    assert.doesNotMatch(source, /@app-usagemonitor\/identity-core\//u);
  }
  assert.doesNotMatch(platformSource, /\b(?:createHmac|hkdfSync)\b/u);
  assert.match(
    implementationSource,
    /^import \{ createHmac, hkdfSync \} from "node:crypto";/u,
  );
  assert.doesNotMatch(implementationSource, /(?:src\/|apps\/|tools\/|scripts\/)/u);
});
