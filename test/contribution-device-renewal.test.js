import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContributionDeviceRenewalError,
  DEFAULT_RENEWAL_ELAPSED_FRACTION,
  DEVICE_CREDENTIAL_TTL_MILLISECONDS,
  MINIMUM_RENEWAL_SPACING_MILLISECONDS,
  contributionDeviceCredentialRenewalDue,
  readContributionDeviceRenewalState,
  renewContributionDeviceCredentialIfDue,
  writeContributionDeviceRenewalState,
} from "../src/contribution-device-renewal.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const DAY = 24 * 60 * 60 * 1_000;
const ISSUED_AT = "2026-06-12T00:00:00.000Z";
const ISSUED_EPOCH = Date.parse(ISSUED_AT);
const EXPIRES_AT = "2026-09-10T00:00:00.000Z";
const EXPIRES_EPOCH = Date.parse(EXPIRES_AT);
const LIFETIME = EXPIRES_EPOCH - ISSUED_EPOCH;
const HALFWAY_EPOCH = ISSUED_EPOCH + LIFETIME * DEFAULT_RENEWAL_ELAPSED_FRACTION;

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-device-renewal-"));
  try {
    await run({ root, stateFile: join(root, "renewal.json") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("renewal is due at the halfway point of the credential's own lifetime", () => {
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      now: HALFWAY_EPOCH,
    }),
    true,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      now: HALFWAY_EPOCH - 1,
    }),
    false,
  );
  // A Mac opened once a fortnight always lands inside the window; under the
  // superseded fixed five-day lead it would have missed it entirely.
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      now: ISSUED_EPOCH + 60 * DAY,
    }),
    true,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      now: EXPIRES_EPOCH + DAY,
    }),
    true,
  );
  for (const expiresAt of [null, undefined, "not-a-date", 123]) {
    assert.equal(
      contributionDeviceCredentialRenewalDue({
        issuedAt: ISSUED_AT,
        expiresAt,
        now: EXPIRES_EPOCH,
      }),
      false,
    );
  }
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      now: Number.NaN,
    }),
    false,
  );
  for (const elapsedFraction of [0, 1, -0.5, 1.5, Number.NaN, "0.5"]) {
    assert.equal(
      contributionDeviceCredentialRenewalDue({
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        now: EXPIRES_EPOCH,
        elapsedFraction,
      }),
      false,
    );
  }
});

test("a just-issued credential is never due, whatever lifetime the service granted", () => {
  // The anti-thrash property: the window opens relative to issuance, so no
  // credential the service hands back can immediately re-trigger its own
  // renewal — including one far shorter than the companion's mirrored TTL,
  // which is exactly the shape a companion running ahead of the deployed
  // service sees.
  for (const lifetime of [DAY, 7 * DAY, 30 * DAY, DEVICE_CREDENTIAL_TTL_MILLISECONDS,
    4 * DEVICE_CREDENTIAL_TTL_MILLISECONDS]) {
    const issuedEpoch = Date.parse("2026-06-12T00:00:00.000Z");
    assert.equal(
      contributionDeviceCredentialRenewalDue({
        issuedAt: new Date(issuedEpoch).toISOString(),
        expiresAt: new Date(issuedEpoch + lifetime).toISOString(),
        now: issuedEpoch,
      }),
      false,
      `a ${lifetime}ms credential must not be due at issuance`,
    );
  }
});

test("no credential is renewed twice inside the minimum spacing", () => {
  // Approaching the social-recheck deadline the service caps each expiry, so
  // half of the remaining life shrinks towards nothing; the floor stops that
  // becoming a rotation loop.
  const issuedEpoch = Date.parse("2026-06-12T00:00:00.000Z");
  const shortLifetime = MINIMUM_RENEWAL_SPACING_MILLISECONDS / 4;
  const state = {
    issuedAt: new Date(issuedEpoch).toISOString(),
    expiresAt: new Date(issuedEpoch + shortLifetime).toISOString(),
  };
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      ...state,
      now: issuedEpoch + shortLifetime / 2,
    }),
    false,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      ...state,
      now: issuedEpoch + MINIMUM_RENEWAL_SPACING_MILLISECONDS - 1,
    }),
    false,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      ...state,
      now: issuedEpoch + MINIMUM_RENEWAL_SPACING_MILLISECONDS,
    }),
    true,
  );
});

test("a v1 record without an issuance instant is dated from the mirrored TTL", () => {
  // Read, not discarded: discarding would report a paired Mac as unseeded and
  // stop renewing it. A mirror matching the service dates it exactly.
  const issuedEpoch = EXPIRES_EPOCH - DEVICE_CREDENTIAL_TTL_MILLISECONDS;
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      issuedAt: null,
      expiresAt: EXPIRES_AT,
      now: issuedEpoch
        + DEVICE_CREDENTIAL_TTL_MILLISECONDS * DEFAULT_RENEWAL_ELAPSED_FRACTION - 1,
    }),
    false,
  );
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      issuedAt: null,
      expiresAt: EXPIRES_AT,
      now: issuedEpoch
        + DEVICE_CREDENTIAL_TTL_MILLISECONDS * DEFAULT_RENEWAL_ELAPSED_FRACTION,
    }),
    true,
  );
  // An issuance the service could never have stated is ignored the same way.
  assert.equal(
    contributionDeviceCredentialRenewalDue({
      issuedAt: EXPIRES_AT,
      expiresAt: EXPIRES_AT,
      now: issuedEpoch
        + DEVICE_CREDENTIAL_TTL_MILLISECONDS * DEFAULT_RENEWAL_ELAPSED_FRACTION,
    }),
    true,
  );
});

test("renewal state round-trips as an owner-only file and tolerates corruption", async () => {
  await fixture(async ({ stateFile }) => {
    await writeContributionDeviceRenewalState(stateFile, {
      deviceId: DEVICE_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    });
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readContributionDeviceRenewalState(stateFile), {
      deviceId: DEVICE_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    });

    // A v1 record from before issuance tracking still reads, with no instant.
    await writeFile(
      stateFile,
      JSON.stringify({
        schemaVersion: "contribution-device-renewal-v1",
        deviceId: DEVICE_ID,
        expiresAt: EXPIRES_AT,
      }),
      "utf8",
    );
    assert.deepEqual(await readContributionDeviceRenewalState(stateFile), {
      deviceId: DEVICE_ID,
      issuedAt: null,
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

    // A v2 key set carrying the v1 version, or an unparseable instant, is not
    // a record this companion wrote.
    await writeFile(
      stateFile,
      JSON.stringify({
        schemaVersion: "contribution-device-renewal-v1",
        deviceId: DEVICE_ID,
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      }),
      "utf8",
    );
    assert.equal(await readContributionDeviceRenewalState(stateFile), null);
    await writeFile(
      stateFile,
      JSON.stringify({
        schemaVersion: "contribution-device-renewal-v2",
        deviceId: DEVICE_ID,
        issuedAt: "not-a-date",
        expiresAt: EXPIRES_AT,
      }),
      "utf8",
    );
    assert.equal(await readContributionDeviceRenewalState(stateFile), null);
  });
  assert.equal(await readContributionDeviceRenewalState("/does/not/exist.json"), null);
  for (const value of [
    { deviceId: "nope", issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT },
    { deviceId: DEVICE_ID, expiresAt: EXPIRES_AT },
    { deviceId: DEVICE_ID, issuedAt: "not-a-date", expiresAt: EXPIRES_AT },
  ]) {
    await assert.rejects(
      writeContributionDeviceRenewalState("/x.json", value),
      (error) => error instanceof ContributionDeviceRenewalError
        && error.code === "contribution_device_renewal_invalid_configuration",
    );
  }
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

test("a credential in the first half of its life is left alone", async () => {
  let renewed = false;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/ignored.json",
    now: HALFWAY_EPOCH - DAY,
    readState: async () => ({
      deviceId: DEVICE_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    }),
    writeState: async () => { throw new Error("must not write"); },
    renew: async () => { renewed = true; return null; },
  });
  assert.deepEqual(outcome, { status: "not_due", expiresAt: EXPIRES_AT });
  assert.equal(renewed, false);
});

test("a due credential is renewed and the new lifetime is recorded", async () => {
  const writes = [];
  const renewCalls = [];
  const now = HALFWAY_EPOCH + DAY;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/renewal.json",
    now,
    readState: async () => ({
      deviceId: OTHER_DEVICE_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    }),
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
  // drift left by a re-pair, and stamped with the instant this pass observed
  // the handover so the next window is measured from the new credential.
  assert.deepEqual(writes, [{
    file: "/tmp/renewal.json",
    value: {
      deviceId: DEVICE_ID,
      issuedAt: new Date(now).toISOString(),
      expiresAt: "2026-10-10T00:00:00.000Z",
    },
  }]);
});

test("a renewal never re-triggers on the pass that follows it", async () => {
  // End to end over the real state file: renew, then run again a moment later
  // and confirm the freshly recorded credential reads as not due.
  await fixture(async ({ stateFile }) => {
    const now = HALFWAY_EPOCH + DAY;
    const renewedExpiry = new Date(now + 30 * DAY).toISOString();
    await writeContributionDeviceRenewalState(stateFile, {
      deviceId: DEVICE_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    });
    let renewals = 0;
    const run = (at) => renewContributionDeviceCredentialIfDue({
      origin: "https://usage.example",
      renewalStateFile: stateFile,
      now: at,
      renew: async () => {
        renewals += 1;
        return { deviceId: DEVICE_ID, expiresAt: renewedExpiry };
      },
    });
    assert.deepEqual(await run(now), { status: "renewed", expiresAt: renewedExpiry });
    assert.equal(renewals, 1);
    for (const at of [now, now + 1_000, now + 10 * DAY]) {
      assert.deepEqual(
        await run(at),
        { status: "not_due", expiresAt: renewedExpiry },
      );
    }
    assert.equal(renewals, 1);
  });
});

test("a v1 tracker renews once and is rewritten with a real issuance instant", async () => {
  await fixture(async ({ stateFile }) => {
    await writeFile(
      stateFile,
      JSON.stringify({
        schemaVersion: "contribution-device-renewal-v1",
        deviceId: DEVICE_ID,
        expiresAt: EXPIRES_AT,
      }),
      "utf8",
    );
    let renewals = 0;
    const now = EXPIRES_EPOCH - DAY;
    const renewedExpiry = new Date(now + 30 * DAY).toISOString();
    const run = (at) => renewContributionDeviceCredentialIfDue({
      origin: "https://usage.example",
      renewalStateFile: stateFile,
      now: at,
      renew: async () => {
        renewals += 1;
        return { deviceId: DEVICE_ID, expiresAt: renewedExpiry };
      },
    });
    assert.deepEqual(await run(now), { status: "renewed", expiresAt: renewedExpiry });
    assert.deepEqual(await readContributionDeviceRenewalState(stateFile), {
      deviceId: DEVICE_ID,
      issuedAt: new Date(now).toISOString(),
      expiresAt: renewedExpiry,
    });
    assert.deepEqual(
      await run(now + DAY),
      { status: "not_due", expiresAt: renewedExpiry },
    );
    assert.equal(renewals, 1);
  });
});

test("a renewal failure is non-fatal and never rewrites the tracker", async () => {
  let wrote = false;
  const outcome = await renewContributionDeviceCredentialIfDue({
    origin: "https://usage.example",
    renewalStateFile: "/tmp/renewal.json",
    now: EXPIRES_EPOCH,
    readState: async () => ({
      deviceId: DEVICE_ID,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    }),
    renew: async () => { throw new Error("service_unavailable"); },
    writeState: async () => { wrote = true; },
  });
  assert.deepEqual(outcome, { status: "renewal_failed" });
  assert.equal(wrote, false);
});

test("a misconfigured renewal fraction is refused rather than guessed", async () => {
  for (const elapsedFraction of [0, 1, -1, Number.NaN]) {
    await assert.rejects(
      renewContributionDeviceCredentialIfDue({
        origin: "https://usage.example",
        renewalStateFile: "/tmp/renewal.json",
        now: EXPIRES_EPOCH,
        elapsedFraction,
        readState: async () => null,
      }),
      (error) => error instanceof ContributionDeviceRenewalError
        && error.code === "contribution_device_renewal_invalid_configuration",
    );
  }
});
