import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function generateEnvelopeKeys(destination) {
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
    writeFileSync(destination, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { ok: true };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error
        && error.code === "EEXIST") {
      return { ok: false, code: "DESTINATION_EXISTS" };
    }
    throw error;
  }
}

function main() {
  const environment = process.argv.length === 2
    ? "local"
    : process.argv.length === 4 && process.argv[2] === "--environment"
      ? process.argv[3]
      : null;
  if (!["local", "staging"].includes(environment)) {
    process.stderr.write(
      "Usage: generate-dev-keys.mjs [--environment local|staging]\n",
    );
    process.exit(2);
  }
  const filename = environment === "staging"
    ? ".dev.vars.staging"
    : ".dev.vars";
  const result = generateEnvelopeKeys(resolve(filename));
  if (!result.ok) {
    process.stderr.write(
      `${filename} already exists; refusing to overwrite it.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Generated isolated ${environment} RSA-OAEP keys in ${filename}\n`,
  );
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
