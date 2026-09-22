import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalUnifiedTelemetryV12EvidenceSelector,
} from "../src/local-unified-contribution-attribution.js";

const DAY = "2026-09-20";
const SESSION_LOCAL = "a".repeat(64);
const SOURCE_LOCAL = "b".repeat(64);
const OTHER_SOURCE_LOCAL = "c".repeat(64);
const SESSION = "session-selector-1";
const PARSER = "unified-rollout-typed-v17";

function record(id, {
  eventTime = `${DAY}T12:00:00.000Z`,
  sessionUuid = SESSION,
  prompt = undefined,
} = {}) {
  return {
    schemaVersion: "usage-event-v1.1",
    eventId: `event:v12:selector:${id}`,
    eventTime,
    sessionUuid,
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    prompt,
  };
}

function fact(value, {
  sessionLocal = SESSION_LOCAL,
  sourceLocal = SOURCE_LOCAL,
  sourceOffset = 10,
  sourceOrdinal = 2,
  parserVersion = PARSER,
  boundary = null,
} = {}) {
  return {
    eventId: value.eventId,
    sessionLocal,
    sourceLocal,
    sourceOffset,
    sourceOrdinal,
    parserVersion,
    boundary,
  };
}

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

function evidence(selector, value) {
  return selector.continuityForRecord("usage", value);
}

test("selector joins emitted identities to complete event-key evidence", () => {
  const first = record("first");
  const second = record("second");
  const selector = createLocalUnifiedTelemetryV12EvidenceSelector({
    records: [first, second],
    facts: [
      fact(first, { sourceOffset: 20, boundary: boundary(1) }),
      fact(second, { sourceOffset: 10 }),
    ],
    boundaryLookupComplete: true,
  });
  assert.equal(selector.boundaryLookupComplete, true);
  assert.deepEqual(evidence(selector, first), { boundaryFlags: 1, tieOrder: 1 });
  assert.deepEqual(evidence(selector, second), { boundaryFlags: 0, tieOrder: 0 });
  assert.equal(selector.rowCount, 2);
  assert.equal(selector.indexFactCount, 2);
});

test("absent facts and unavailable source history remain explicit nulls", () => {
  const missing = record("missing");
  const unavailable = record("unavailable", { eventTime: `${DAY}T12:01:00.000Z` });
  const selector = createLocalUnifiedTelemetryV12EvidenceSelector({
    records: [missing, unavailable],
    facts: [fact(unavailable, {
      sessionLocal: null,
      sourceLocal: null,
      sourceOffset: null,
      sourceOrdinal: null,
      parserVersion: null,
    })],
    boundaryLookupComplete: true,
  });
  assert.equal(selector.boundaryLookupComplete, false);
  assert.deepEqual(evidence(selector, missing), { boundaryFlags: null, tieOrder: null });
  assert.deepEqual(evidence(selector, unavailable), { boundaryFlags: null, tieOrder: null });
});

test("duplicate facts and rotated source coordinates never invent tie order", () => {
  const duplicate = record("duplicate");
  const left = record("left");
  const right = record("right");
  const selector = createLocalUnifiedTelemetryV12EvidenceSelector({
    records: [duplicate, left, right],
    facts: [
      fact(duplicate, { sourceOffset: 1 }),
      fact(duplicate, { sourceOffset: 2 }),
      fact(left, { sourceOffset: 3, sourceLocal: SOURCE_LOCAL }),
      fact(right, { sourceOffset: 4, sourceLocal: OTHER_SOURCE_LOCAL, sourceOrdinal: 3 }),
    ],
    boundaryLookupComplete: true,
  });
  assert.equal(evidence(selector, duplicate), null);
  assert.equal(evidence(selector, left).tieOrder, null);
  assert.equal(evidence(selector, right).tieOrder, null);
});

test("selector ranks final emitted identities and ignores non-emitted index facts", () => {
  const first = record("emitted-first");
  const second = record("emitted-second");
  const excluded = record("excluded-candidate");
  const selector = createLocalUnifiedTelemetryV12EvidenceSelector({
    // The selector contract is the post-exclusion emitted stream. A raw fact
    // for a candidate that was excluded must not consume an emitted rank.
    records: [first, second],
    facts: [
      fact(excluded, { sourceOffset: 1 }),
      fact(first, { sourceOffset: 20 }),
      fact(second, { sourceOffset: 30 }),
    ],
    boundaryLookupComplete: true,
  });
  assert.equal(evidence(selector, first).tieOrder, 0);
  assert.equal(evidence(selector, second).tieOrder, 1);
  assert.equal(evidence(selector, excluded), null);
});

test("selector rejects private/accessor facts and bounded incomplete pages", () => {
  const value = record("private");
  const privateFact = fact(value);
  privateFact.path = "/private/synthetic/rollout.jsonl";
  assert.throws(() => createLocalUnifiedTelemetryV12EvidenceSelector({
    records: [value], facts: [privateFact], boundaryLookupComplete: true,
  }));

  const accessorFact = fact(value);
  Object.defineProperty(accessorFact, "sourceOffset", {
    enumerable: true,
    get() { throw new Error("must not execute"); },
  });
  assert.throws(() => createLocalUnifiedTelemetryV12EvidenceSelector({
    records: [value], facts: [accessorFact], boundaryLookupComplete: true,
  }));

  assert.throws(() => createLocalUnifiedTelemetryV12EvidenceSelector({
    records: [value], facts: [], maxRows: 0,
  }));
  assert.throws(() => createLocalUnifiedTelemetryV12EvidenceSelector({
    records: [value, record("second")], facts: [], maxRows: 1,
  }));
});
