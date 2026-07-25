import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const destination = resolve(".dev.vars");
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 0x10001,
});
const keyId = `key:${randomUUID()}`;
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: keyId,
};
const privateJwk = {
  ...privateKey.export({ format: "jwk" }),
  kid: keyId,
};
const contents = [
  `ENVELOPE_PRIVATE_JWK='${JSON.stringify(privateJwk)}'`,
  `ENVELOPE_PUBLIC_JWK='${JSON.stringify(publicJwk)}'`,
  "",
].join("\n");

try {
  writeFileSync(destination, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`Generated local-only RSA-OAEP keys in ${destination}\n`);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
    process.stderr.write(`${destination} already exists; refusing to overwrite it.\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
