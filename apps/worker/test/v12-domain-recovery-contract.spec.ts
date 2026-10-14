import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import {
  parseV12DomainRecoveryRequest,
  parseV12DomainRecoveryResult,
  V12_DOMAIN_RECOVERY_METHOD,
  V12_DOMAIN_RECOVERY_OUTCOMES,
} from "../src/v12-domain-recovery";

const emptyOutcomes = () => Object.fromEntries(V12_DOMAIN_RECOVERY_OUTCOMES.map((outcome) => [outcome, 0]));
const v12Cursor = "v12r1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA";
const result = (overrides: Record<string, unknown> = {}) => ({
  task: "v12_domain_recovery",
  method: V12_DOMAIN_RECOVERY_METHOD,
  dryRun: true,
  examined: 0,
  outcomes: emptyOutcomes(),
  refusals: {},
  daysCovered: 0,
  nextAfterParticipantId: null,
  ...overrides,
});

describe("v12 owner domain recovery contract", () => {
  it("parses only the closed maintenance request and applies bounded defaults", () => {
    expect(parseV12DomainRecoveryRequest({
      action: "run_maintenance",
      v12DomainRecovery: { dryRun: true },
    })).toEqual({ dryRun: true, maxDevices: 10, afterParticipantId: null });
    expect(parseV12DomainRecoveryRequest({
      action: "run_maintenance",
      v12DomainRecovery: { dryRun: false, maxDevices: 25, afterParticipantId: v12Cursor },
    })).toEqual({ dryRun: false, maxDevices: 25, afterParticipantId: v12Cursor });
  });

  it("rejects unknown keys, invalid bounds, and malformed cursors", () => {
    for (const input of [
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true, extra: 1 } },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true }, anotherTask: {} },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: 1 } },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: null } },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: 0 } },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true, maxDevices: 26 } },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true, afterParticipantId: "participant id" } },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true, afterParticipantId: "participant-123" } },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true, afterParticipantId: "pg1.synthetic.cursor" } },
      { action: "run_maintenance", v12DomainRecovery: { dryRun: true, afterParticipantId: "v12r2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA" } },
    ]) {
      expect(() => parseV12DomainRecoveryRequest(input)).toThrow(ApiError);
    }
  });

  it("validates a closed result and count reconciliation without exposing identities", () => {
    const parsed = parseV12DomainRecoveryResult(result({
      dryRun: false,
      examined: 2,
      outcomes: { ...emptyOutcomes(), activated: 1, refused: 1 },
      refusals: { TELEMETRY_MANIFEST_INCOMPLETE: 1 },
      daysCovered: 3,
      nextAfterParticipantId: v12Cursor,
    }));
    expect(parsed.examined).toBe(2);
    expect(parsed.outcomes.activated).toBe(1);
    expect(parsed.refusals).toEqual({ TELEMETRY_MANIFEST_INCOMPLETE: 1 });
    expect(Object.keys(parsed).sort()).toEqual([
      "daysCovered", "dryRun", "examined", "method", "nextAfterParticipantId", "outcomes", "refusals", "task",
    ]);
  });

  it("rejects unknown outcomes/refusal codes, unbalanced counts, and malformed cursor values", () => {
    const base = result({ examined: 1, outcomes: { ...emptyOutcomes(), refused: 1 },
      refusals: { TELEMETRY_MANIFEST_INCOMPLETE: 1 } });
    for (const invalid of [
      { ...base, unexpected: "secret" },
      { ...base, outcomes: { ...base.outcomes, participantId: 1 } },
      { ...base, refusals: { PRIVATE_ERROR_TEXT: 1 } },
      { ...base, nextAfterParticipantId: "cursor with whitespace" },
      { ...base, nextAfterParticipantId: "participant-123" },
      { ...base, nextAfterParticipantId: "pg1.synthetic.cursor" },
      { ...base, nextAfterParticipantId: "v12r2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA" },
      { ...base, outcomes: { ...base.outcomes, refused: 0 } },
      { ...base, examined: 2 },
      { ...base, refusals: {} },
    ]) {
      expect(() => parseV12DomainRecoveryResult(invalid)).toThrow(TypeError);
    }
  });

  it("rejects impossible page, mode, day-span, and overflowing aggregate counts", () => {
    const twoExamined = result({ examined: 2, outcomes: { ...emptyOutcomes(), eligible: 2 } });
    const overflow = result({ examined: 2, outcomes: {
      ...emptyOutcomes(), activated: Number.MAX_SAFE_INTEGER, eligible: 1,
    } });
    for (const invalid of [
      { ...result({ examined: 26, outcomes: { ...emptyOutcomes(), eligible: 26 } }) },
      { ...result({ examined: 1, outcomes: { ...emptyOutcomes(), eligible: 1 } }), daysCovered: 4097 },
      { ...result({ examined: 1, outcomes: { ...emptyOutcomes(), activated: 1 }, dryRun: true }) },
      { ...result({ examined: 1, outcomes: { ...emptyOutcomes(), eligible: 1 }, dryRun: false }) },
      overflow,
    ]) {
      expect(() => parseV12DomainRecoveryResult(invalid)).toThrow(TypeError);
    }
    expect(() => parseV12DomainRecoveryResult(twoExamined, { dryRun: true, maxDevices: 1 })).toThrow(TypeError);
    expect(() => parseV12DomainRecoveryResult(
      result({ dryRun: false }), { dryRun: true, maxDevices: 10 },
    )).toThrow(TypeError);
  });

  it("only allows the fixed five operational outcomes", () => {
    expect(V12_DOMAIN_RECOVERY_OUTCOMES).toEqual([
      "activated", "eligible", "already_active", "authority_unavailable", "refused",
    ]);
  });
});
