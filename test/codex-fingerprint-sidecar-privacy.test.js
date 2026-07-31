import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  buildCacheValidationSidecar,
  selectCacheValidationBaseline,
  validateLocalHistoryCacheProvenance,
} from "../src/cli.js";
import { codexLogSourceFingerprint } from "../src/codex-log-scan.js";
import { writeJsonOwnerOnlyAtomic } from "../src/storage.js";

const START_AT = "2026-07-01T00:00:00.000Z";
const END_AT = "2026-08-01T00:00:00.000Z";
const VERIFIED_AT = "2026-07-30T13:45:00.000Z";
const SESSION_ID = "raw-session-id-canary-0d92773c";
const PARENT_ID = "raw-parent-id-canary-9be77821";
const TITLE = "private-title-canary-203fa637";
const PROMPT = "private-prompt-canary-91185157";
const PRIVATE_CWD = "/private/cwd-canary-6ceba04a";

function collectStrings(value, strings = []) {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      strings.push(key);
      collectStrings(item, strings);
    }
  }
  return strings;
}

test("pathful Codex source provenance is stripped before a cache-validation sidecar is persisted", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "usage-monitor-sidecar-privacy-"));
  const codexHome = join(fixtureRoot, "codex-home-absolute-path-canary");
  const archiveDirectory = join(codexHome, "archived_sessions");
  const rolloutPath = join(
    archiveDirectory,
    "rollout-2026-07-30T12-00-00-fingerprint-basename-canary-7b834861.jsonl",
  );
  const outputPath = join(fixtureRoot, "cache-validation-sidecar.json");
  const rolloutBasename = basename(rolloutPath);

  try {
    await mkdir(archiveDirectory, { recursive: true });
    const records = [
      {
        timestamp: "2026-07-30T12:00:00.000Z",
        type: "session_meta",
        payload: {
          id: SESSION_ID,
          forked_from_id: PARENT_ID,
          cwd: PRIVATE_CWD,
          title: TITLE,
        },
      },
      {
        timestamp: "2026-07-30T12:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: PROMPT,
        },
      },
    ];
    await writeFile(
      rolloutPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const cachedProvenance = await codexLogSourceFingerprint({
      codexHome,
      startAt: START_AT,
      endAt: END_AT,
    });
    const pathfulCurrent = await codexLogSourceFingerprint({
      codexHome,
      startAt: START_AT,
      endAt: END_AT,
      includeSourcePaths: true,
    });
    const sourceKeyHash = pathfulCurrent.files[0].keyHash;

    // Prove this test exercises genuinely pathful local-only provenance.
    assert.deepEqual(pathfulCurrent.sourcePathByKeyHash, {
      [sourceKeyHash]: rolloutPath,
    });

    const cached = { sourceProvenance: cachedProvenance };
    const sidecar = buildCacheValidationSidecar(cached, pathfulCurrent, {
      startAt: START_AT,
      endAt: END_AT,
      verifiedAt: VERIFIED_AT,
    });
    await writeJsonOwnerOnlyAtomic(outputPath, sidecar);
    const persisted = JSON.parse(await readFile(outputPath, "utf8"));

    assert.deepEqual(Object.keys(persisted).sort(), [
      "cacheFingerprint",
      "endAt",
      "schemaVersion",
      "startAt",
      "verifiedAt",
      "verifiedProvenance",
    ]);
    assert.equal(persisted.schemaVersion, "local-history-cache-validation-v1");
    assert.equal(persisted.cacheFingerprint, cachedProvenance.fingerprint);
    assert.equal(persisted.startAt, START_AT);
    assert.equal(persisted.endAt, END_AT);
    assert.equal(persisted.verifiedAt, VERIFIED_AT);
    assert.deepEqual(persisted.verifiedProvenance, cachedProvenance);
    assert.equal(persisted.verifiedProvenance.schemaVersion, "codex-rollout-source-fingerprint-v1");
    assert.equal(persisted.verifiedProvenance.fileCount, 1);
    assert.match(persisted.verifiedProvenance.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(persisted.verifiedProvenance.files[0]).sort(), [
      "birthtimeMs",
      "ino",
      "keyHash",
      "mtimeMs",
      "size",
    ]);
    assert.equal(
      validateLocalHistoryCacheProvenance(
        { sourceProvenance: persisted.verifiedProvenance },
        pathfulCurrent,
      ).status,
      "current",
    );
    assert.deepEqual(
      selectCacheValidationBaseline(cached, persisted, {
        startAt: START_AT,
        endAt: END_AT,
      }),
      persisted.verifiedProvenance,
    );

    const serialized = JSON.stringify(persisted);
    for (const canary of [
      codexHome,
      rolloutPath,
      rolloutBasename,
      SESSION_ID,
      PARENT_ID,
      TITLE,
      PROMPT,
      PRIVATE_CWD,
      "sourcePathByKeyHash",
    ]) {
      assert.equal(
        serialized.includes(canary),
        false,
        `persisted cache-validation sidecar exposed prohibited canary: ${canary}`,
      );
    }
    assert.deepEqual(
      collectStrings(persisted).filter((value) => isAbsolute(value)),
      [],
      "persisted cache-validation sidecar must not contain any absolute path",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
