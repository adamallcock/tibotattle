// A synthetic, content-free golden that commits only its source dump's digest,
// as golden-dense does, and the small dump its manifest pins. The dump holds
// just the three single-row tables goldenSourceIdentity reads; every value is
// a fixed synthetic string.
//
// readSeedGolden accepts a golden only inside this checkout, so the golden
// directory is made under the ignored .release-build scratch parent (as
// test/local-review-build-policy.test.js does); the dump sits outside the
// checkout, as a real --dump does. Both are removed afterwards.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const DIGEST_ONLY_GOLDEN_NOW = "2026-10-01T12:00:00.000Z";
export const DIGEST_ONLY_GOLDEN_SOURCE = Object.freeze({
  sourceId: "synthetic-digest-only-source",
  sourceNamespace: "synthetic-digest-only-namespace",
});

/**
 * Runs `run({ golden, dump, dumpSha256 })` with `golden` a repository-relative
 * golden directory whose manifest pins `dumpSha256`, the sha256 of the file at
 * `dump`, and commits no dump of its own.
 */
export async function withDigestOnlyGolden(run) {
  const parent = join(REPOSITORY_ROOT, ".release-build");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "gcp-fastpath-digest-only-golden-"));
  const dumpDirectory = await mkdtemp(join(tmpdir(), "gcp-fastpath-digest-only-dump-"));
  try {
    const { sourceId, sourceNamespace } = DIGEST_ONLY_GOLDEN_SOURCE;
    const dumpBytes = `${JSON.stringify({ schema: [], tables: [
      { name: "storage_source_state", columns: ["singleton", "source_id"], rows: [[1, sourceId]] },
      { name: "typed_v1_admission_state", columns: ["id", "source_namespace"], rows: [[1, sourceNamespace]] },
      { name: "typed_v11_admission_state", columns: ["id", "source_namespace"], rows: [[1, sourceNamespace]] },
    ] })}\n`;
    const dumpSha256 = createHash("sha256").update(dumpBytes).digest("hex");
    const dump = join(dumpDirectory, "usage-monitor-db.json");
    await writeFile(dump, dumpBytes);
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
      now: DIGEST_ONLY_GOLDEN_NOW, owners: [], sourceDump: { jsonSha256: dumpSha256 },
    })}\n`);
    return await run({ golden: relative(REPOSITORY_ROOT, directory), dump, dumpSha256 });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(dumpDirectory, { recursive: true, force: true });
  }
}
