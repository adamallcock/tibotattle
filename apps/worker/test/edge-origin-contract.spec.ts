import { describe, expect, it } from "vitest";

import * as contract from "../src/edge-origin-contract";
import { EDGE_ORIGIN_CONTRACT_CHECKS, type ContractAssert } from "./edge-origin-contract-vectors";

// The same checks run under Node in cloud-run/edge-origin-contract.check.mjs,
// which also compares the callback-query rule with the Cloud Run boundary.
const assert: ContractAssert = {
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  deepEqual(actual, expected, message) {
    expect(actual, message).toStrictEqual(expected);
  },
  ok(value, message) {
    expect(value, message).toBeTruthy();
  },
};

describe("edge/origin transport contract (workerd)", () => {
  it("registers the shared contract checks", () => {
    expect(EDGE_ORIGIN_CONTRACT_CHECKS.length).toBeGreaterThanOrEqual(13);
    expect(new Set(EDGE_ORIGIN_CONTRACT_CHECKS.map(({ name }) => name)).size)
      .toBe(EDGE_ORIGIN_CONTRACT_CHECKS.length);
  });

  for (const check of EDGE_ORIGIN_CONTRACT_CHECKS) {
    it(check.name, () => {
      check.run(contract, assert);
    });
  }

  it("never writes rejected input to the console", () => {
    const calls: unknown[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => { calls.push(args); };
    console.warn = console.log;
    console.error = console.log;
    try {
      contract.parseCloudRunInvokerClaims("Bearer a.b.c", 0);
      contract.parseEdgeOriginConfiguration(() => {
        throw new Error("SYNTHETIC_GETTER_FAILURE");
      });
      contract.decodeEdgeAdmission("v2;enrollment;allowed");
    } finally {
      Object.assign(console, original);
    }
    expect(calls).toEqual([]);
  });
});
