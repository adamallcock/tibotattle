import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTelemetryAccountTrackId,
  isTelemetryAccountTrackId,
  TELEMETRY_ACCOUNT_TRACK_VERSION,
} from "../src/telemetry-account-track.js";

const ACCOUNT_A = `account:v1:${"00".repeat(32)}`;
const ACCOUNT_B = `account:v1:${"01".repeat(32)}`;
const PARTICIPANT_A = "participant:123e4567-e89b-42d3-a456-426614174000";
const PARTICIPANT_B = "participant:123e4567-e89b-42d3-a456-426614174001";

test("participant-scoped account-track derivation is stable and frozen", () => {
  assert.equal(TELEMETRY_ACCOUNT_TRACK_VERSION, "account-track-v1");
  const track = deriveTelemetryAccountTrackId(
    ACCOUNT_A,
    PARTICIPANT_A,
    "openai_codex",
  );
  assert.equal(
    track,
    "account-track:v1:4fe6a6df7e541509d6130f8f44e070a1e214fb688f4ed6be8ff7a1a0ca5d2f75",
  );
  assert.equal(
    deriveTelemetryAccountTrackId(ACCOUNT_A, PARTICIPANT_A, "openai_codex"),
    track,
  );
  assert.equal(isTelemetryAccountTrackId(track), true);
  assert.equal(track.includes(ACCOUNT_A), false);
  assert.equal(track.includes(PARTICIPANT_A), false);
});

test("account track is unlinkable across account, participant, and provider scopes", () => {
  const baseline = deriveTelemetryAccountTrackId(
    ACCOUNT_A,
    PARTICIPANT_A,
    "openai_codex",
  );
  const variants = [
    deriveTelemetryAccountTrackId(ACCOUNT_B, PARTICIPANT_A, "openai_codex"),
    deriveTelemetryAccountTrackId(ACCOUNT_A, PARTICIPANT_B, "openai_codex"),
    deriveTelemetryAccountTrackId(ACCOUNT_A, PARTICIPANT_A, "anthropic_claude_code"),
  ];
  assert.equal(new Set([baseline, ...variants]).size, 4);
});

test("unattributed remains explicit while other inputs are still validated", () => {
  assert.equal(
    deriveTelemetryAccountTrackId("unattributed", PARTICIPANT_A, "openai_codex"),
    "unattributed",
  );
  assert.equal(isTelemetryAccountTrackId("unattributed"), true);
  assert.equal(isTelemetryAccountTrackId(ACCOUNT_A), false);
  assert.throws(
    () => deriveTelemetryAccountTrackId("unattributed", "participant:not-a-uuid", "openai_codex"),
    /participant identifier/u,
  );
  assert.throws(
    () => deriveTelemetryAccountTrackId("unattributed", PARTICIPANT_A, "unknown"),
    /provider/u,
  );
});

test("malformed or direct local identifiers fail closed without being echoed", () => {
  const invalid = [
    null,
    "",
    "openai-account:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    `account:v1:${"A".repeat(64)}`,
    `account:v1:${"0".repeat(63)}`,
    "adam@example.com",
  ];
  for (const value of invalid) {
    assert.throws(
      () => deriveTelemetryAccountTrackId(value, PARTICIPANT_A, "openai_codex"),
      (error) => error instanceof TypeError
        && error.message === "Local account scope is invalid",
    );
  }
});
