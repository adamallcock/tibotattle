import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContributionDeviceRenewalError,
  DEFAULT_RENEWAL_LEAD_MILLISECONDS,
  contributionDeviceCredentialRenewalDue,
  readContributionDeviceRenewalState,
  renewContributionDeviceCredentialIfDue,
  writeContributionDeviceRenewalState,
} from "../src/contribution-device-renewal.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const DAY = 24 * 60 * 60 * 1_000;
const EXPIRES_AT = "2026-09-10T00:00:00.000Z";
const EXPIRES_EPOCH = Date.parse(EXPIRES_AT);

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-device-renewal-"));
  try {
    await run({ root, stateFile: join(root, "renewal.json") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("renewal is due only inside the lead window and never for an unknown expiry", () => {
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_EPOCH - DEFAULT_RENEWAL_LEAD_MILLISECONDS,
    }),
    true,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_EPOCH - DEFAULT_RENEWAL_LEAD_MILLISECONDS - 1,
    }),
    false,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      expiresAt: EXPIRES_AT,
      now: EXPIRES_EPOCH + DAY,
    }),
    true,
  );
  for (const expiresAt of [null, undefined, "not-a-date", 123]) {
    assert.equal(
      contributionDeviceCredentialRenewalDue({ expiresAt, now: EXPIRES_EPOCH }),
      false,
    );
  }
  assert.equal(
    contributionDeviceCredentialRenewalDue({ expiresAt: EXPIRES_AT, now: Number.NaN }),
    false,
  );
});

test("renewal state round-trips as an owner-only file and tolerates corruption", async () => {
  await fixture(async ({ stateFile }) => {
    await writeContributionDeviceRenewalState(stateFile, {
      deviceId: DEVICE_ID,
      expiresAt: EXPIRES_AT,
    });
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readContributionDeviceRenewalState(stateFile), {
      deviceId: DEVICE_ID,
      expiresAt: EXPIRES_AT,
    });

    await writeFile(stateFile, "{ not json", "utf8");
    assert.equal(await readContributionDeviceRenewalState(stateFile), null);

    await writeFile(
      stateFile,
      JSON.stringify({ schemaVersion: "wrong", deviceId: DEVICE_ID, expiresAt: EXPIRES_AT }),
      "utf8",
    );
    assert.equal(await readContributionDeviceRenewalState(stateFile), null);
  });
  assert.equal(await readContributionDeviceRenewalState("/does/not/exist.json"), null);
  await assert.rejects(
    writeContributionDeviceRenewalState("/x.json", { deviceId: "nope", expiresAt: EXPIRES_AT }),
    (error) => error instanceof ContributionDeviceRenewalError
      && error.code === "contribution_device_renewal_invalid_configuration",
  );
});

test("an unseeded tracker never renews a fresh credential", async () => {
  let renewed = false;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/ignored.json",
    now: EXPIRES_EPOCH,
    readState: async () => null,
    writeState: async () => { throw new Error("must not write"); },
    renew: async () => { renewed = true; return null; },
  });
  assert.deepEqual(outcome, { status: "unseeded" });
  assert.equal(renewed, false);
});

test("a credential outside its window is left alone", async () => {
  let renewed = false;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/ignored.json",
    now: EXPIRES_EPOCH - 20 * DAY,
    readState: async () => ({ deviceId: DEVICE_ID, expiresAt: EXPIRES_AT }),
    writeState: async () => { throw new Error("must not write"); },
    renew: async () => { renewed = true; return null; },
  });
  assert.deepEqual(outcome, { status: "not_due", expiresAt: EXPIRES_AT });
  assert.equal(renewed, false);
});

test("a due credential is renewed and the new expiry is recorded", async () => {
  const writes = [];
  const renewCalls = [];
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/renewal.json",
    now: EXPIRES_EPOCH - DAY,
    readState: async () => ({ deviceId: OTHER_DEVICE_ID, expiresAt: EXPIRES_AT }),
    renew: async (options) => {
      renewCalls.push(options);
      return {
        status: "renewed",
        origin: "https://usage.example",
        deviceId: DEVICE_ID,
        expiresAt: "2026-10-10T00:00:00.000Z",
      };
    },
    writeState: async (file, value) => { writes.push({ file, value }); },
  });
  assert.deepEqual(outcome, { status: "renewed", expiresAt: "2026-10-10T00:00:00.000Z" });
  assert.equal(renewCalls.length, 1);
  assert.equal(renewCalls[0].origin, "https://usage.example");
  // The tracker is rewritten from the id the service returned, correcting any
  // drift left by a re-pair.
  assert.deepEqual(writes, [{
    file: "/tmp/renewal.json",
    value: { deviceId: DEVICE_ID, expiresAt: "2026-10-10T00:00:00.000Z" },
  }]);
});

test("a renewal failure is non-fatal and never rewrites the tracker", async () => {
  let wrote = false;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/renewal.json",
    now: EXPIRES_EPOCH,
    readState: async () => ({ deviceId: DEVICE_ID, expiresAt: EXPIRES_AT }),
    renew: async () => { throw new Error("service_unavailable"); },
    writeState: async () => { wrote = true; },
  });
  assert.deepEqual(outcome, { status: "renewal_failed" });
  assert.equal(wrote, false);
});
