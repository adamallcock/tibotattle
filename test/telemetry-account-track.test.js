import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTelemetryAccountTrackId,
  deriveTelemetryAccountTrackIdV2,
  isTelemetryAccountTrackId,
  isTelemetryAccountTrackIdV2,
  TELEMETRY_ACCOUNT_TRACK_VERSION,
  TELEMETRY_ACCOUNT_TRACK_V2_VERSION,
} from "../src/telemetry-account-track.js";
import { deriveOpenAIAccountScope } from "../src/providers/codex/account.js";

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

function observedScope(bytes = 0, planType = "pro") {
  return {
    status: "available",
    reason: null,
    version: "openai-account-v1",
    scopeId: `openai-account:v1:${Buffer.alloc(32, bytes).toString("base64url")}`,
    planType,
  };
}

function v2Inputs(overrides = {}) {
  return {
    accountScope: observedScope(),
    accountObservationSecret: Buffer.alloc(32, 84),
    destinationOrigin: "https://community.example.test",
    enrollmentNamespace: "enrollment_fixture_a",
    ...overrides,
  };
}

test("V2 accepts the typed live scope and freezes a separate purpose/version vector", () => {
  const inputs = v2Inputs();
  const track = deriveTelemetryAccountTrackIdV2(inputs);
  assert.equal(TELEMETRY_ACCOUNT_TRACK_V2_VERSION, "account-track-v2");
  assert.equal(track, "account-track:v2:40905ffa27407c8cb55dda38f85f1fa6885f2d1a777bfdc73e4cbeceb979ac43");
  assert.equal(deriveTelemetryAccountTrackIdV2(inputs), track);
  assert.equal(isTelemetryAccountTrackIdV2(track), true);
  assert.equal(isTelemetryAccountTrackId(track), false, "V1 admission must not silently accept V2");
  assert.equal(isTelemetryAccountTrackIdV2(deriveTelemetryAccountTrackId(ACCOUNT_A, PARTICIPANT_A, "openai_codex")), false);
  assert.equal(track.includes(inputs.accountScope.scopeId), false);
  assert.equal(track.includes(inputs.enrollmentNamespace), false);
  assert.deepEqual(inputs.accountObservationSecret, Buffer.alloc(32, 84), "the caller retains ownership of its lease");
});

test("V2 separates destination, authenticated enrollment, account and local root but not plan or wire version", () => {
  const baseline = deriveTelemetryAccountTrackIdV2(v2Inputs());
  const variants = [
    v2Inputs({ destinationOrigin: "https://another.example.test" }),
    v2Inputs({ enrollmentNamespace: "enrollment_fixture_b" }),
    v2Inputs({ accountScope: observedScope(1) }),
    v2Inputs({ accountObservationSecret: Buffer.alloc(32, 85) }),
  ].map(deriveTelemetryAccountTrackIdV2);
  assert.equal(new Set([baseline, ...variants]).size, 5);
  assert.equal(deriveTelemetryAccountTrackIdV2(v2Inputs({ accountScope: observedScope(0, "plus") })), baseline);
  assert.equal(deriveTelemetryAccountTrackIdV2(v2Inputs({ accountScope: observedScope(0, null) })), baseline);
  // A wire upgrade does not enter the derivation API or alter its identity
  // version. Reuse the same authenticated observation binding at either wire.
  assert.equal(deriveTelemetryAccountTrackIdV2(v2Inputs()), baseline);
});

test("missing root or historical enrollment mapping remains unattributed, including after re-pair", () => {
  assert.equal(deriveTelemetryAccountTrackIdV2(), "unattributed");
  for (const key of ["accountScope", "accountObservationSecret", "destinationOrigin", "enrollmentNamespace"]) {
    assert.equal(deriveTelemetryAccountTrackIdV2(v2Inputs({ [key]: null })), "unattributed");
  }
  const unavailable = {
    status: "unavailable", reason: "credential_unavailable", version: "openai-account-v1", scopeId: null, planType: "pro",
  };
  assert.equal(deriveTelemetryAccountTrackIdV2(v2Inputs({ accountScope: unavailable })), "unattributed");
  assert.equal(isTelemetryAccountTrackIdV2("unattributed"), true);
  assert.notEqual(
    deriveTelemetryAccountTrackIdV2(v2Inputs()),
    deriveTelemetryAccountTrackIdV2(v2Inputs({ enrollmentNamespace: "enrollment_after_repair" })),
  );
});

test("a device-local account-observation root never promises cross-device account equality", () => {
  const account = { account: { email: "synthetic.owner@example.test", planType: "pro" } };
  const roots = [Buffer.alloc(32, 41), Buffer.alloc(32, 42)];
  const tracks = roots.map((root) => deriveTelemetryAccountTrackIdV2(v2Inputs({
    accountScope: deriveOpenAIAccountScope(account, { secret: root, planType: "pro" }),
    accountObservationSecret: root,
  })));
  assert.notEqual(tracks[0], tracks[1]);
  assert.equal(JSON.stringify(tracks).includes("synthetic.owner"), false);
});

test("V2 rejects malformed typed scopes and namespaces without echoing identifiers or roots", () => {
  for (const accountScope of [
    ACCOUNT_A,
    "private-account@example.test",
    { ...observedScope(), version: "account-v1" },
    { ...observedScope(), scopeId: "private-account@example.test" },
    { ...observedScope(), scopeId: `openai-account:v1:${"A".repeat(42)}B` },
    { ...observedScope(), rawAccountId: "DO-NOT-LEAK" },
    { ...observedScope(), status: "unavailable" },
  ]) {
    assert.throws(() => deriveTelemetryAccountTrackIdV2(v2Inputs({ accountScope })),
      (error) => error instanceof TypeError && error.message === "Observed account scope is invalid");
  }
  for (const destinationOrigin of [
    "https://community.example.test/", "https://community.example.test/private-path",
    "https://secret@community.example.test", "http://community.example.test", "not-an-origin", "",
  ]) {
    assert.throws(() => deriveTelemetryAccountTrackIdV2(v2Inputs({ destinationOrigin })),
      (error) => error instanceof TypeError && error.message === "Account-track destination is invalid");
  }
  for (const enrollmentNamespace of ["", "wire-v1", "device:private-device-id", "private.owner@example.test", "A".repeat(129)]) {
    assert.throws(() => deriveTelemetryAccountTrackIdV2(v2Inputs({ enrollmentNamespace })),
      (error) => error instanceof TypeError && error.message === "Account-track enrollment namespace is invalid");
  }
  for (const accountObservationSecret of [Buffer.alloc(31), Buffer.alloc(33), "DO-NOT-LEAK", new Uint8Array(32)]) {
    assert.throws(() => deriveTelemetryAccountTrackIdV2(v2Inputs({ accountObservationSecret })),
      (error) => error instanceof TypeError && error.message === "Account observation root is invalid");
  }
  assert.equal(isTelemetryAccountTrackIdV2(deriveTelemetryAccountTrackIdV2(v2Inputs({ destinationOrigin: "http://127.0.0.1:8123" }))), true);
});
