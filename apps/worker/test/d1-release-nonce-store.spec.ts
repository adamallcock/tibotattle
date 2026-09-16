import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  configuredD1ReleaseNonceStore,
  createD1ReleaseNonceStore,
  type D1ReleaseNonceDatabase,
} from "../src/d1-release-nonce-store";
import { ReleaseNonceStorageUnavailableError } from "../src/release-nonce-store";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = (): TestBindings => env as TestBindings;
const database = () => bindings().USAGE_MONITOR_DB;
const NOW_SECONDS = 1_800_000_000;
const EXPIRY_SECONDS = NOW_SECONDS + 301;

async function nonceRow(nonce: string): Promise<{
  nonce: string;
  expires_at: number;
} | null> {
  return database().prepare(
    "SELECT nonce, expires_at FROM sparkle_appcast_guard_nonces WHERE nonce = ?",
  ).bind(nonce).first();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(database(), bindings().TEST_MIGRATIONS);
});

describe("D1 release nonce adapter", () => {
  it("consumes a nonce once and reports a live duplicate as replay", async () => {
    const store = createD1ReleaseNonceStore(database());

    await expect(store.consume("nonce-consume-0001", {
      nowSeconds: NOW_SECONDS,
      expiresAtSeconds: EXPIRY_SECONDS,
    })).resolves.toBe("consumed");
    await expect(store.consume("nonce-consume-0001", {
      nowSeconds: NOW_SECONDS,
      expiresAtSeconds: EXPIRY_SECONDS,
    })).resolves.toBe("replay");
    await expect(nonceRow("nonce-consume-0001")).resolves.toEqual({
      nonce: "nonce-consume-0001",
      expires_at: EXPIRY_SECONDS,
    });
  });

  it("keeps a single winner when concurrent requests claim the same nonce", async () => {
    const store = createD1ReleaseNonceStore(database());
    const options = {
      nowSeconds: NOW_SECONDS,
      expiresAtSeconds: EXPIRY_SECONDS,
    } as const;

    const outcomes = await Promise.all([
      store.consume("nonce-race-0001", options),
      store.consume("nonce-race-0001", options),
    ]);

    expect([...outcomes].sort()).toEqual(["consumed", "replay"]);
    await expect(database().prepare(
      "SELECT COUNT(*) AS count FROM sparkle_appcast_guard_nonces WHERE nonce = ?",
    ).bind("nonce-race-0001").first()).resolves.toEqual({ count: 1 });
  });

  it("accepts a nonce exactly at its expiry boundary and stores the new expiry", async () => {
    const store = createD1ReleaseNonceStore(database());
    const firstExpiry = NOW_SECONDS + 10;
    await expect(store.consume("nonce-expiry-0001", {
      nowSeconds: NOW_SECONDS,
      expiresAtSeconds: firstExpiry,
    })).resolves.toBe("consumed");

    await expect(store.consume("nonce-expiry-0001", {
      nowSeconds: firstExpiry,
      expiresAtSeconds: firstExpiry + 10,
    })).resolves.toBe("consumed");
    await expect(nonceRow("nonce-expiry-0001")).resolves.toEqual({
      nonce: "nonce-expiry-0001",
      expires_at: firstExpiry + 10,
    });
  });

  it("prunes expired rows while retaining live rows during a claim", async () => {
    const expired = "nonce-prune-expired-01";
    const live = "nonce-prune-live-0001";
    await database().prepare(
      "INSERT INTO sparkle_appcast_guard_nonces (nonce, expires_at) VALUES (?, ?)",
    ).bind(expired, NOW_SECONDS).run();
    await database().prepare(
      "INSERT INTO sparkle_appcast_guard_nonces (nonce, expires_at) VALUES (?, ?)",
    ).bind(live, NOW_SECONDS + 1).run();

    const store = createD1ReleaseNonceStore(database());
    await expect(store.consume("nonce-prune-new-0001", {
      nowSeconds: NOW_SECONDS,
      expiresAtSeconds: EXPIRY_SECONDS,
    })).resolves.toBe("consumed");

    await expect(nonceRow(expired)).resolves.toBeNull();
    await expect(nonceRow(live)).resolves.toEqual({
      nonce: live,
      expires_at: NOW_SECONDS + 1,
    });
    await expect(nonceRow("nonce-prune-new-0001")).resolves.toEqual({
      nonce: "nonce-prune-new-0001",
      expires_at: EXPIRY_SECONDS,
    });
  });

  it("sanitizes D1 transport failures without exposing provider details", async () => {
    let prepared = 0;
    const failingDatabase = {
      prepare: () => {
        prepared += 1;
        return { bind: () => ({}) };
      },
      batch: async () => {
        throw new Error("provider-account-or-query-detail");
      },
    } as unknown as D1ReleaseNonceDatabase;
    const store = createD1ReleaseNonceStore(failingDatabase);

    const failure = await store.consume("nonce-transport-0001", {
      nowSeconds: NOW_SECONDS,
      expiresAtSeconds: EXPIRY_SECONDS,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReleaseNonceStorageUnavailableError);
    expect(failure).toMatchObject({
      name: "ReleaseNonceStorageUnavailableError",
      message: "RELEASE_NONCE_STORAGE_UNAVAILABLE",
    });
    expect(String(failure)).not.toContain("provider-account-or-query-detail");
    expect(prepared).toBe(2);
  });

  it("fails closed for malformed D1 batch results", async () => {
    const malformedResults: unknown[] = [
      [{ success: true, meta: { changes: 0 } }],
      [
        { success: true, meta: { changes: 0 } },
        { success: true, meta: { changes: 1 } },
        { success: true, meta: { changes: 0 } },
      ],
      [
        { success: false, meta: { changes: 0 } },
        { success: true, meta: { changes: 1 } },
      ],
      [
        { success: true, meta: { changes: 0 } },
        { success: false, meta: { changes: 1 } },
      ],
    ];
    for (const results of malformedResults) {
      const malformedDatabase = {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => results,
      } as unknown as D1ReleaseNonceDatabase;
      const store = createD1ReleaseNonceStore(malformedDatabase);

      await expect(store.consume("nonce-malformed-result", {
        nowSeconds: NOW_SECONDS,
        expiresAtSeconds: EXPIRY_SECONDS,
      })).rejects.toBeInstanceOf(ReleaseNonceStorageUnavailableError);
    }
  });

  it("rejects malformed windows before calling D1", async () => {
    let calls = 0;
    const databaseWithCallCounter = {
      prepare: () => {
        calls += 1;
        return { bind: () => ({}) };
      },
      batch: async () => {
        calls += 1;
        return [];
      },
    } as unknown as D1ReleaseNonceDatabase;
    const store = createD1ReleaseNonceStore(databaseWithCallCounter);

    await expect(store.consume("nonce-invalid-window", {
      nowSeconds: NOW_SECONDS,
      expiresAtSeconds: NOW_SECONDS,
    })).rejects.toBeInstanceOf(ReleaseNonceStorageUnavailableError);
    await expect(store.consume("", {
      nowSeconds: NOW_SECONDS,
      expiresAtSeconds: EXPIRY_SECONDS,
    })).rejects.toBeInstanceOf(ReleaseNonceStorageUnavailableError);
    expect(calls).toBe(0);
  });

  it("fails closed for malformed optional D1 bindings", () => {
    const malformed = [
      null,
      undefined,
      {},
      { prepare: () => {}, batch: "not-a-function" },
      { prepare: "not-a-function", batch: () => {} },
    ];
    for (const value of malformed) {
      expect(configuredD1ReleaseNonceStore(value)).toBeNull();
    }
    expect(configuredD1ReleaseNonceStore(database())).not.toBeNull();
  });
});
