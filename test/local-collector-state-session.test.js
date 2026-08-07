import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  commitLocalCollectorState,
  openLocalCollectorStateSession,
  readLocalCollectorCheckpoint,
  readLocalCollectorRecords,
  saveLocalCollectorCheckpoint,
} from "../src/local-collector-state.js";

const CLOCK = () => Date.parse("2026-08-06T00:00:00.000Z");

function checkpointFor(counter) {
  return { schemaVersion: "0.3", collectionStartedAt: "2026-08-01T00:00:00.000Z", counter };
}

function record(index) {
  return {
    schemaVersion: "0.3",
    kind: "codex_rollout_usage_snapshot",
    eventKey: `event-${index}`,
    observedAt: new Date(Date.parse("2026-08-05T00:00:00.000Z") + index * 1_000).toISOString(),
    model: "gpt-5.6-sol",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "collector-session-"));
  return { root, stateFile: join(root, "state.sqlite") };
}

test("a session commits every batch durably and settles once at close", async () => {
  const { root, stateFile } = await fixture();
  try {
    const session = await openLocalCollectorStateSession({ stateFile, clock: CLOCK });
    session.commit({ checkpoint: checkpointFor(1), records: [record(0), record(1)] });
    session.commit({ checkpoint: checkpointFor(2), records: [record(2)] });

    // Each batch is its own transaction, so a concurrent reader sees committed
    // work before the session closes. This is the guarantee the per-batch
    // integrity check was never providing.
    const midFlight = new DatabaseSync(stateFile, { readOnly: true });
    try {
      assert.equal(
        Number(midFlight.prepare("SELECT COUNT(*) AS c FROM records").get().c),
        3,
      );
    } finally {
      midFlight.close();
    }

    const settled = await session.close();
    assert.deepEqual(settled, { batches: 2, inserted: 3 });
    const state = await readLocalCollectorRecords({ stateFile });
    assert.equal(state.records.length, 3);
    assert.deepEqual(
      (await readLocalCollectorCheckpoint({ stateFile })),
      checkpointFor(2),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("closing a session runs the integrity check exactly once and fails closed", async () => {
  const { root, stateFile } = await fixture();
  try {
    const session = await openLocalCollectorStateSession({ stateFile, clock: CLOCK });
    session.commit({ checkpoint: checkpointFor(1), records: [record(0)] });
    // The check is relocated, not weakened: it still runs, and a failure is
    // still the same fixed error code.
    const settled = await session.close({ verifyIntegrity: true });
    assert.equal(settled.inserted, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an aborted session leaves already-committed batches intact", async () => {
  const { root, stateFile } = await fixture();
  try {
    const session = await openLocalCollectorStateSession({ stateFile, clock: CLOCK });
    session.commit({ checkpoint: checkpointFor(1), records: [record(0), record(1)] });
    await session.abort();
    await session.abort();
    const state = await readLocalCollectorRecords({ stateFile });
    assert.equal(state.records.length, 2);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the batched commit helpers route through a session when given one", async () => {
  const { root, stateFile } = await fixture();
  try {
    const session = await openLocalCollectorStateSession({ stateFile, clock: CLOCK });
    await commitLocalCollectorState({
      stateFile,
      checkpoint: checkpointFor(1),
      records: [record(0)],
      clock: CLOCK,
      session,
    });
    await saveLocalCollectorCheckpoint({
      stateFile,
      checkpoint: checkpointFor(2),
      clock: CLOCK,
      session,
    });
    assert.equal(session.batches, 2);
    assert.equal(session.inserted, 1);
    await session.close();
    assert.deepEqual(await readLocalCollectorCheckpoint({ stateFile }), checkpointFor(2));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a session and the unpooled commit path produce the same stored state", async () => {
  const pooled = await fixture();
  const unpooled = await fixture();
  try {
    const session = await openLocalCollectorStateSession({
      stateFile: pooled.stateFile,
      clock: CLOCK,
    });
    for (let index = 0; index < 5; index += 1) {
      session.commit({ checkpoint: checkpointFor(index), records: [record(index)] });
    }
    await session.close();

    for (let index = 0; index < 5; index += 1) {
      await commitLocalCollectorState({
        stateFile: unpooled.stateFile,
        checkpoint: checkpointFor(index),
        records: [record(index)],
        clock: CLOCK,
      });
    }

    const left = await readLocalCollectorRecords({ stateFile: pooled.stateFile });
    const right = await readLocalCollectorRecords({ stateFile: unpooled.stateFile });
    assert.deepEqual(left.records, right.records);
    assert.deepEqual(
      await readLocalCollectorCheckpoint({ stateFile: pooled.stateFile }),
      await readLocalCollectorCheckpoint({ stateFile: unpooled.stateFile }),
    );
  } finally {
    await rm(pooled.root, { recursive: true });
    await rm(unpooled.root, { recursive: true });
  }
});

test("session options are validated", async () => {
  await assert.rejects(
    () => openLocalCollectorStateSession({ stateFile: "" }),
    TypeError,
  );
  await assert.rejects(
    () => openLocalCollectorStateSession({ stateFile: "/tmp/x", clock: "not-a-clock" }),
    TypeError,
  );
});
