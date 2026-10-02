// W2-SEAL harness: build the synthetic sources once, write the owner files
// (inventory, EP-8 receipts, barrier proof) and run the seal through the
// injected fake transport and fake Wrangler export. Test-only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  runCutoverSeal,
  sha256File,
  sha256Hex,
  writePrivateFileOnce,
} from "../../../scripts/cutover-source-seal.mjs";
import {
  SYNTHETIC_BOOKMARKS,
  SYNTHETIC_D1,
  SYNTHETIC_DATABASE_NAMES,
  writeBarrierProofFixture,
  writeFenceReceiptFixture,
  writeInventoryFixture,
} from "./fence-fixtures.mjs";
import {
  buildSyntheticDeletionLedgerD1,
  buildSyntheticIngestionD1,
  createFakeCutoverTransport,
  createFakeWranglerSpawn,
  privateDirectory,
  removePrivateDirectories,
  syntheticTombstoneDigests,
} from "./synthetic-sources.mjs";

export function headCommit(cwd) {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Synthetic sources plus the owner files every seal case shares. */
export async function prepareSealWorld({ commit, nowMs = Date.now(), ingestion = {}, ledgerDigests = null } = {}) {
  const work = await privateDirectory("w2-seal-work-");
  const sources = await buildSyntheticIngestionD1({ directory: work, commit, nowMs, ...ingestion });
  const digests = ledgerDigests ?? syntheticTombstoneDigests({ erasedParticipantId: sources.fixture?.ids.erasedParticipant ?? null });
  const ledger = await buildSyntheticDeletionLedgerD1({ directory: work, commit, digests, nowMs });
  const inventory = await writeInventoryFixture({ directory: work, commit });
  const fence = await writeFenceReceiptFixture({ directory: work });
  const proof = await writeBarrierProofFixture({ directory: work });
  return {
    work,
    commit,
    digests,
    ingestionPath: sources.path,
    ledgerPath: ledger.path,
    fixture: sources.fixture,
    inventory,
    fence,
    proof,
    remotePaths: { ingestion: sources.path, "deletion-ledger": ledger.path },
    exportPaths: {
      [SYNTHETIC_DATABASE_NAMES.ingestion]: sources.path,
      [SYNTHETIC_DATABASE_NAMES["deletion-ledger"]]: ledger.path,
    },
    async dispose() {
      await rm(work, { recursive: true, force: true });
      await removePrivateDirectories();
    },
  };
}

/** Run one seal into a fresh owner directory; options override any injected part. */
export async function sealWorld(world, {
  bookmarks = SYNTHETIC_BOOKMARKS, tamper = null, spawnOptions = {}, overrides = {}, calls = [], observations = [],
} = {}) {
  const out = await privateDirectory("w2-seal-out-");
  const transport = createFakeCutoverTransport({ sources: world.remotePaths, bookmarks, tamper, calls });
  const spawn = createFakeWranglerSpawn({ sources: world.exportPaths, observations, ...spawnOptions });
  const options = {
    inventoryPath: world.inventory.path,
    fenceReceiptPath: world.fence.path,
    fenceReceiptSha256: world.fence.sha256,
    barrierProofPath: world.proof.path,
    ownerDirectory: out,
    execute: true,
    remote: true,
    ownerReadOnly: true,
    transport,
    spawn,
    ...overrides,
  };
  return { out, calls, observations, transport, options, run: () => runCutoverSeal(options) };
}

export function outputPathsOf(out) {
  return {
    manifest: join(out, "seal-manifest.json"),
    ingestion: join(out, "ingestion.sealed.sqlite"),
    ledger: join(out, "deletion-ledger.sealed.sqlite"),
  };
}

/**
 * A variant seal for refusal cases: the sealed ingestion file copied,
 * mutated with SQL, re-sealed 0400 beside a manifest whose sealId covers the
 * new digest (the manifest's aggregates are not recomputed; only
 * verify-unchanged reads them).
 */
export async function forgeVariantSeal(seal, mutateSql) {
  const directory = await privateDirectory("w2-seal-variant-");
  const work = join(directory, "work.sqlite");
  const sealedPath = join(directory, "ingestion.sealed.sqlite");
  await copyFile(seal.sources.ingestion.path, work);
  await chmod(work, 0o600);
  const database = new DatabaseSync(work);
  try {
    database.exec(mutateSql);
    database.exec(`VACUUM INTO '${sealedPath}'`);
  } finally {
    database.close();
  }
  await rm(work, { force: true });
  await chmod(sealedPath, 0o400);
  await copyFile(seal.sources["deletion-ledger"].path, join(directory, "deletion-ledger.sealed.sqlite"));
  await chmod(join(directory, "deletion-ledger.sealed.sqlite"), 0o400);
  const { sealId: _previous, ...body } = seal.manifest;
  const sealedSha256 = await sha256File(sealedPath);
  const next = { ...body, sources: body.sources.map(source => (source.role === "ingestion" ? { ...source, sealedSha256 } : source)) };
  const sealId = sha256Hex(canonicalJson(next));
  const manifestPath = join(directory, "seal-manifest.json");
  await writePrivateFileOnce(manifestPath, `${canonicalJson({ ...next, sealId })}\n`, 0o400);
  return { directory, manifestPath, sealId, sealedAt: seal.manifest.createdAt };
}

/**
 * A synthetic stand-in for the pinned Wrangler package, enough for the query
 * launcher's CLI check (name wrangler, version 4.114.0, wrangler-dist/cli.js).
 * It is never executed: the injected spawn answers every call.
 */
export async function writeFakeWranglerCli(directory) {
  const root = join(directory, "wrangler");
  await mkdir(join(root, "wrangler-dist"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "wrangler", version: "4.114.0",
    main: "wrangler-dist/cli.js" }), { mode: 0o600 });
  const cliPath = join(root, "wrangler-dist", "cli.js");
  await writeFile(cliPath, "// synthetic stand-in; never executed\n", { mode: 0o600 });
  return cliPath;
}

function roleOfConfig(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const databaseId = config.d1_databases?.[0]?.database_id;
  const role = Object.keys(SYNTHETIC_DATABASE_NAMES).find(candidate => SYNTHETIC_D1[candidate] === databaseId);
  if (role === undefined) throw new Error("W2_SEAL_FIXTURE_UNKNOWN_DATABASE");
  return role;
}

/**
 * The injected spawn behind the DEFAULT Wrangler transport and export (no
 * provider is contacted): `d1 time-travel info <name> --json --config <c>`
 * answers {bookmark} from `bookmarks` (a value, or a function of that role's
 * call number); the query launcher's `d1 execute` runs the frozen SQL file
 * (its sha256 checked as the preload does) on the role's synthetic file and
 * answers Wrangler's JSON envelope; `d1 export` is createFakeWranglerSpawn.
 * Each call records its kind, role and the pinned config's mode.
 */
export function createFakeWranglerProviderSpawn(world, { bookmarks = SYNTHETIC_BOOKMARKS, calls = [], observations = [] } = {}) {
  const exporter = createFakeWranglerSpawn({ sources: world.exportPaths, observations });
  const counts = {};
  return (command, args, options) => {
    if (args.includes("export")) {
      calls.push({ kind: "export" });
      return exporter(command, args, options);
    }
    const configPath = args[args.indexOf("--config") + 1];
    const role = roleOfConfig(configPath);
    const configMode = statSync(configPath).mode & 0o777;
    if (args.includes("time-travel")) {
      calls.push({ kind: "bookmark", role, configMode });
      counts[role] = (counts[role] ?? 0) + 1;
      const value = bookmarks[role];
      return { status: 0, signal: null, stdout: JSON.stringify({ bookmark: typeof value === "function" ? value(counts[role]) : value }),
        stderr: "" };
    }
    const flag = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const sql = readFileSync(flag("--tibo-query-path"), "utf8");
    if (!args.includes("execute") || createHash("sha256").update(sql).digest("hex") !== flag("--tibo-query-sha256")) {
      return { status: 1, signal: null, stdout: "", stderr: "" };
    }
    calls.push({ kind: "query", role, configMode });
    const database = new DatabaseSync(world.remotePaths[role], { readOnly: true });
    try {
      const results = database.prepare(sql).all().map(row => ({ ...row }));
      return { status: 0, signal: null, stdout: JSON.stringify([{ results, success: true, meta: {} }]), stderr: "" };
    } finally {
      database.close();
    }
  };
}
