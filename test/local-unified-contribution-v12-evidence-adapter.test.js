import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_TELEMETRY_V12_EVIDENCE_LIMITS,
  createTelemetryV12LocalEvidenceAdapter,
  isTelemetryV12BoundaryParserVersion,
} from "../src/local-unified-contribution-attribution.js";

const DAY = "2026-09-20";
const SESSION_LOCAL = "a".repeat(64);
const SOURCE_LOCAL = "b".repeat(64);
const OTHER_SOURCE_LOCAL = "c".repeat(64);
const PARSER = "unified-rollout-typed-v17";
const SESSION = "session-fixture-1";

function boundary(flags, {
  parserVersion = PARSER,
  sessionLocal = SESSION_LOCAL,
  compactedAtMs = (flags & 2) === 2 ? Date.parse(`${DAY}T11:59:59.000Z`) : null,
} = {}) {
  return {
    parserVersion,
    sessionLocal,
    turnContextBefore: flags & 1 ? 1 : 0,
    compactionBefore: flags & 2 ? 1 : 0,
    compactedAtMs,
  };
}

function row(id, {
  eventTime = `${DAY}T12:00:00.000Z`,
  sessionUuid = SESSION,
  sessionLocal = SESSION_LOCAL,
  sourceLocal = SOURCE_LOCAL,
  sourceOffset = 100 + id.length,
  sourceOrdinal = 7,
  parserVersion = PARSER,
  boundary: boundaryValue = null,
} = {}) {
  return {
    eventId: `event:v12:${id}`,
    eventTime,
    sessionUuid,
    sessionLocal,
    sourceLocal,
    sourceOffset,
    sourceOrdinal,
    parserVersion,
    boundary: boundaryValue,
  };
}

function evidence(adapter, value) {
  return adapter.continuityForRecord("usage", {
    eventId: value.eventId,
    eventTime: value.eventTime,
    sessionUuid: value.sessionUuid,
  });
}

function complete(rows, options = {}) {
  return createTelemetryV12LocalEvidenceAdapter({
    rows,
    boundaryLookupComplete: true,
    ...options,
  });
}

test("local evidence maps reviewed boundary rows to the four masks", () => {
  const rows = [
    row("none"),
    row("turn", { sourceOffset: 101, boundary: boundary(1) }),
    row("compaction", { sourceOffset: 102, boundary: boundary(2) }),
    row("both", { sourceOffset: 103, boundary: boundary(3) }),
  ];
  const adapter = complete(rows);
  assert.deepEqual(rows.map((value) => evidence(adapter, value)), [
    { boundaryFlags: 0, tieOrder: 3 },
    { boundaryFlags: 1, tieOrder: 0 },
    { boundaryFlags: 2, tieOrder: 1 },
    { boundaryFlags: 3, tieOrder: 2 },
  ]);
  assert.equal(adapter.rowCount, rows.length);
  assert.equal(isTelemetryV12BoundaryParserVersion(PARSER), true);
  assert.equal(isTelemetryV12BoundaryParserVersion("unified-rollout-typed-v14"), false);
});

test("local evidence accepts retained variants but withholds unknown provenance", () => {
  const rows = [
    row("v15", {
      parserVersion: "unified-rollout-typed-v15-parent-model-partial",
      boundary: boundary(1, {
        parserVersion: "unified-rollout-typed-v15-parent-model-partial",
      }),
    }),
    row("unknown", {
      eventTime: `${DAY}T12:01:00.000Z`,
      sourceOffset: 200,
      parserVersion: "unified-rollout-typed-v19",
      boundary: boundary(1),
    }),
    row("bad-boundary", {
      eventTime: `${DAY}T12:02:00.000Z`,
      sourceOffset: 201,
      boundary: boundary(1, { parserVersion: "unified-rollout-typed-v14" }),
    }),
  ];
  const adapter = complete(rows);
  assert.deepEqual(evidence(adapter, rows[0]), { boundaryFlags: 1, tieOrder: 0 });
  let touched = 0;
  const accessorRecord = {
    eventTime: rows[0].eventTime,
    sessionUuid: rows[0].sessionUuid,
  };
  Object.defineProperty(accessorRecord, "eventId", {
    enumerable: true,
    get() {
      touched += 1;
      return rows[0].eventId;
    },
  });
  assert.equal(adapter.continuityForRecord("usage", accessorRecord), null);
  assert.equal(touched, 0);
  assert.deepEqual(evidence(adapter, rows[1]), { boundaryFlags: null, tieOrder: null });
  assert.deepEqual(evidence(adapter, rows[2]), { boundaryFlags: null, tieOrder: 0 });
});

test("tie ranks are deterministic only for one coherent source", () => {
  const first = row("first", { sourceOffset: 300 });
  const second = row("second", { sourceOffset: 100 });
  const third = row("third", { sourceOffset: 200 });
  const adapter = createTelemetryV12LocalEvidenceAdapter({ rows: [first, second, third] });
  assert.deepEqual([first, second, third].map((value) => evidence(adapter, value).tieOrder), [2, 0, 1]);

  const rotated = createTelemetryV12LocalEvidenceAdapter({ rows: [
    row("left", { sourceOffset: 100, sourceLocal: SOURCE_LOCAL }),
    row("right", { sourceOffset: 101, sourceLocal: OTHER_SOURCE_LOCAL, sourceOrdinal: 8 }),
  ] });
  assert.equal(evidence(rotated, row("left", { sourceOffset: 100 })).tieOrder, null);
  assert.equal(evidence(rotated, row("right", {
    sourceOffset: 101, sourceLocal: OTHER_SOURCE_LOCAL, sourceOrdinal: 8,
  })).tieOrder, null);
});

test("duplicates, replay coordinates, and partial provenance stay unknown", () => {
  const duplicate = row("duplicate", { sourceOffset: 400 });
  const replay = { ...duplicate };
  const coordinateA = row("coordinate-a", { sourceOffset: 401 });
  const coordinateB = row("coordinate-b", { sourceOffset: 401 });
  const missingOffset = row("missing-offset", { sourceOffset: null });
  const adapter = complete([duplicate, replay, coordinateA, coordinateB, missingOffset]);
  assert.equal(evidence(adapter, duplicate), null);
  assert.equal(evidence(adapter, replay), null);
  assert.equal(evidence(adapter, coordinateA), null);
  assert.equal(evidence(adapter, coordinateB), null);
  assert.deepEqual(evidence(adapter, missingOffset), { boundaryFlags: 0, tieOrder: null });
  const missingOffsetValue = row("missing-offset-value");
  missingOffsetValue.sourceOffset = undefined;
  assert.throws(() => createTelemetryV12LocalEvidenceAdapter({ rows: [missingOffsetValue] }));
  const missingOrdinalValue = row("missing-ordinal-value");
  missingOrdinalValue.sourceOrdinal = undefined;
  assert.throws(() => createTelemetryV12LocalEvidenceAdapter({ rows: [missingOrdinalValue] }));

  const sourceConflict = complete([
    row("conflict-a", { sourceOffset: 500, sourceOrdinal: 1 }),
    row("conflict-b", { sourceOffset: 501, sourceOrdinal: 2 }),
  ]);
  assert.equal(evidence(sourceConflict, row("conflict-a", {
    sourceOffset: 500, sourceOrdinal: 1,
  })), null);
  assert.equal(evidence(sourceConflict, row("conflict-b", {
    sourceOffset: 501, sourceOrdinal: 2,
  })), null);
});

test("boundary facts require matching parser/session proof and immutable safe input", () => {
  const rows = [row("mismatch", {
    boundary: boundary(3, {
      parserVersion: "unified-rollout-typed-v15",
      sessionLocal: OTHER_SOURCE_LOCAL,
    }),
  })];
  const adapter = createTelemetryV12LocalEvidenceAdapter({ rows });
  assert.deepEqual(evidence(adapter, rows[0]), { boundaryFlags: null, tieOrder: 0 });

  const hidden = row("hidden");
  Object.defineProperty(hidden, "prompt", {
    value: "private-synthetic-canary", enumerable: false,
  });
  assert.throws(() => createTelemetryV12LocalEvidenceAdapter({ rows: [hidden] }));
  assert.throws(() => createTelemetryV12LocalEvidenceAdapter({
    rows: [row("bad-bound", { boundary: { ...boundary(1), prompt: "private" } })],
  }));
  assert.throws(() => createTelemetryV12LocalEvidenceAdapter({
    rows: [row("bad-count")], maxRows: LOCAL_TELEMETRY_V12_EVIDENCE_LIMITS.rows + 1,
  }));
});

test("an incomplete boundary join keeps missing relations unknown", () => {
  const value = row("unavailable");
  const adapter = createTelemetryV12LocalEvidenceAdapter({ rows: [value] });
  assert.deepEqual(evidence(adapter, value), { boundaryFlags: null, tieOrder: 0 });
  assert.deepEqual(evidence(complete([value]), value), { boundaryFlags: 0, tieOrder: 0 });
  assert.throws(() => createTelemetryV12LocalEvidenceAdapter({
    rows: [value], boundaryLookupComplete: "yes",
  }));
});


test("v18 boundary evidence keeps reviewed v17/v18 provenance coherent without relabeling rows", () => {
  for (const version of [17, 18]) {
    for (const suffix of ["", "-partial", "-parent-model", "-parent-model-partial"]) {
      for (const assumption of ["", "-cache-write-zero"]) {
        const parserVersion = `unified-rollout-typed-v${version}${suffix}${assumption}`;
        const value = row(`v${version}-qualified`, { parserVersion,
          boundary: boundary(3, { parserVersion }) });
        assert.deepEqual(evidence(complete([value]), value),
          { boundaryFlags: 3, tieOrder: 0 }, parserVersion);
        assert.equal(value.parserVersion, parserVersion);
      }
    }
  }
  const previous = row("previous", { sourceOffset: 100,
    parserVersion: "unified-rollout-typed-v17",
    boundary: boundary(1, { parserVersion: "unified-rollout-typed-v17" }) });
  const current = row("current", { sourceOffset: 101,
    parserVersion: "unified-rollout-typed-v18",
    boundary: boundary(2, { parserVersion: "unified-rollout-typed-v18" }) });
  const adapter = complete([current, previous]);
  assert.deepEqual(evidence(adapter, previous), { boundaryFlags: 1, tieOrder: 0 });
  assert.deepEqual(evidence(adapter, current), { boundaryFlags: 2, tieOrder: 1 });
});
