// The D1 Worker and the PostgreSQL origin both hash the v1.2 domain method
// version into the predecessor fingerprint, so a pass that starts on one and
// finishes on the other only verifies when both name the same method. The
// Workers test pool cannot read host files and the PostgreSQL constant is not
// exported, so this Node check compares the two declarations as source text,
// and requires each file's fingerprint to hash its constant with no other
// method-version literal in the file.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const V12_DOMAIN_METHOD_SOURCES = Object.freeze({
  d1: Object.freeze({ file: "src/telemetry-v12-domain.ts", identifier: "V12_DOMAIN_METHOD_VERSION", exported: true }),
  postgres: Object.freeze({ file: "src/postgres-typed-v12-domain.ts", identifier: "DOMAIN_METHOD_VERSION", exported: false }),
});
const METHOD_VALUE = /^v12-complete-domain-[1-9][0-9]*$/u;
const METHOD_LITERAL = /["'`]v12-complete-domain-[^"'`\n]*["'`]/gu;
const METHOD_KEY = /\bmethod\s*:\s*([^,\n}]+?)\s*(?=[,\n}])/gu;

function methodLiteral(source, { file, identifier, exported }) {
  const declarations = [...source.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\b`, "gu"))];
  assert.equal(declarations.length, 1, `${file} must declare ${identifier} exactly once`);
  const anchored = [...source.matchAll(new RegExp(`^${exported ? "export " : ""}const ${identifier} = "([^"\\n]*)";$`, "gmu"))];
  assert.equal(anchored.length, 1, `${file} must assign ${identifier} one string literal at top level`);
  const value = anchored[0][1];
  assert.match(value, METHOD_VALUE, `${file} ${identifier} is not a v1.2 domain method version`);
  // A second copy of the value would let a code path bypass the constant.
  assert.equal(source.split(`"${value}"`).length - 1, 1, `${file} repeats the ${value} literal outside ${identifier}`);
  // So would a literal naming any other method version.
  const methodLiterals = source.match(METHOD_LITERAL) ?? [];
  assert.equal(methodLiterals.length, 1,
    `${file} has ${methodLiterals.length} v1.2 domain method literals (${methodLiterals.join(", ")}); only ${identifier} may name one`);
  // The fingerprint must hash the constant, not an inline or derived value.
  const methodKeys = [...source.matchAll(METHOD_KEY)].map((match) => match[1]);
  assert.ok(methodKeys.length >= 1 && methodKeys.every((key) => key === identifier),
    `${file} fingerprint must hash method: ${identifier} (found ${methodKeys.map((key) => `method: ${key}`).join(", ") || "none"})`);
  return value;
}

/** Returns the shared method version, or throws naming the divergence. */
export async function assertV12DomainMethodParity(workerRoot = WORKER_ROOT) {
  const [d1, postgres] = await Promise.all(Object.values(V12_DOMAIN_METHOD_SOURCES).map(async (declaration) =>
    methodLiteral(await readFile(join(workerRoot, declaration.file), "utf8"), declaration)));
  assert.equal(postgres, d1, `PostgreSQL DOMAIN_METHOD_VERSION ${postgres} differs from D1 V12_DOMAIN_METHOD_VERSION ${d1}`);
  return d1;
}

async function doctoredCopy(t, file, edit) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-v12-method-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const declaration of Object.values(V12_DOMAIN_METHOD_SOURCES)) {
    await cp(join(WORKER_ROOT, declaration.file), join(root, declaration.file));
  }
  const path = join(root, file);
  const source = await readFile(path, "utf8");
  const edited = edit(source);
  assert.notEqual(edited, source, "the doctored copy must change the source");
  await writeFile(path, edited);
  return root;
}

test("D1 and PostgreSQL pin the same v1.2 domain method version", async () => {
  assert.match(await assertV12DomainMethodParity(), METHOD_VALUE);
});

test("a doctored copy with either literal edited fails", async (t) => {
  for (const declaration of Object.values(V12_DOMAIN_METHOD_SOURCES)) {
    const root = await doctoredCopy(t, declaration.file, (source) =>
      source.replace(new RegExp(`(const ${declaration.identifier} = ")v12-complete-domain-\\d+(";)`, "u"), "$1v12-complete-domain-99$2"));
    await assert.rejects(assertV12DomainMethodParity(root), /differs from D1 V12_DOMAIN_METHOD_VERSION/u);
  }
});

test("a doctored copy with a missing declaration fails", async (t) => {
  const { file, identifier } = V12_DOMAIN_METHOD_SOURCES.postgres;
  const root = await doctoredCopy(t, file, (source) =>
    source.replace(new RegExp(`\\bconst ${identifier}\\b`, "u"), `const RENAMED_${identifier}`));
  await assert.rejects(assertV12DomainMethodParity(root), /must declare DOMAIN_METHOD_VERSION exactly once/u);
});

test("a doctored copy with a duplicated declaration or literal fails", async (t) => {
  const { file, identifier } = V12_DOMAIN_METHOD_SOURCES.d1;
  const duplicated = await doctoredCopy(t, file, (source) => `${source}\nlet ${identifier} = "v12-complete-domain-2";\n`);
  await assert.rejects(assertV12DomainMethodParity(duplicated), /must declare V12_DOMAIN_METHOD_VERSION exactly once/u);
  const repeated = await doctoredCopy(t, file, (source) => {
    const value = /export const V12_DOMAIN_METHOD_VERSION = "([^"]+)";/u.exec(source)[1];
    return `${source}\nconst SHADOW_METHOD = "${value}";\n`;
  });
  await assert.rejects(assertV12DomainMethodParity(repeated), /repeats the v12-complete-domain-\d+ literal/u);
});

test("a doctored copy whose fingerprint hashes an inline method literal fails", async (t) => {
  for (const declaration of Object.values(V12_DOMAIN_METHOD_SOURCES)) {
    const root = await doctoredCopy(t, declaration.file, (source) =>
      source.replace(`method: ${declaration.identifier},`, 'method: "v12-complete-domain-1",'));
    await assert.rejects(assertV12DomainMethodParity(root),
      new RegExp(`${declaration.file.replaceAll(".", "\\.")} has 2 v1\\.2 domain method literals`, "u"));
  }
});

test("a doctored copy whose fingerprint no longer uses the declared constant fails", async (t) => {
  for (const declaration of Object.values(V12_DOMAIN_METHOD_SOURCES)) {
    const root = await doctoredCopy(t, declaration.file, (source) =>
      source.replace(`method: ${declaration.identifier},`, `method: LEGACY_${declaration.identifier},`));
    await assert.rejects(assertV12DomainMethodParity(root),
      new RegExp(`fingerprint must hash method: ${declaration.identifier} \\(found method: LEGACY_`, "u"));
  }
});
