// Catalog manifest contract (KM-1/KM-2): the baseline projection, its
// byte-identical pricing, the wire-grammar name guard, the closed schema, the
// append-only successor rules and the signed envelope. Keys are synthetic
// Ed25519 keys generated per test; fixtures are synthetic.
import { describe, expect, it } from "vitest";
import {
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
  priceUsageEvent,
  type PriceCard as AccountingPriceCard,
} from "@app-usagemonitor/accounting";
import * as vendoredRegistry from "../vendor/analytics-d43c8f92/packages/accounting/index.js";
import committedBaseline from "../catalog/manifest-0001.json";
import {
  CATALOG_BASELINE_DIGEST,
  CATALOG_BASELINE_RELEASE,
  CATALOG_COMPILED_SPEEDS,
  CatalogManifestError,
  activeCatalogPriceCards,
  assertCatalogCompiledAssertions,
  assertCatalogManifestSuccessor,
  canonicalCatalogPayloadText,
  guardCatalogToken,
  isCatalogToken,
  parseCanonicalCatalogPayload,
  parseCatalogEnvelope,
  signCatalogPayload,
  validateCatalogManifest,
  validateCatalogManifestPayload,
  verifyCatalogEnvelope,
  webCryptoSha256Hex,
  type CatalogManifest,
  type PriceCard,
} from "../src/catalog-manifest";
import { catalogTrustedKeys } from "../src/catalog-manifest-keys";
import {
  COMPILED_CATALOG_INPUTS,
  compiledBaselineCatalogManifest,
  compiledBaselineDigest,
} from "../src/postgres-catalog-store";
import { priceTelemetryUsageEvent } from "../src/server-pricing";
import type { TelemetryUsageEvent } from "../src/telemetry-validation";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function codeOf(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogManifestError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

async function syntheticSigner() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  const keyId = "catalog-test-km-core";
  return {
    keyId,
    trustedKeys: [{ keyId, publicKey: btoa(String.fromCharCode(...raw)) }],
    sign: (manifest: CatalogManifest) => signCatalogPayload({
      payloadText: canonicalCatalogPayloadText(manifest), keyId, privateKeyPkcs8: pkcs8,
    }),
  };
}

async function successorOf(held: CatalogManifest, edit: (next: CatalogManifest) => void = () => {}) {
  const next = clone(held);
  next.version = held.version + 1;
  next.previousVersion = held.version;
  next.previousDigest = await webCryptoSha256Hex(canonicalCatalogPayloadText(held));
  next.projectedFromCommit = null;
  edit(next);
  next.compat.registrySha256 = await webCryptoSha256Hex(JSON.stringify(activeCatalogPriceCards(next)));
  return next;
}

/** A synthetic card for a model no compiled catalog knows. */
function syntheticCard(model = "synthetic-unseen-model-km1"): PriceCard {
  const card = clone(APP_OFFICIAL_PRICE_CARDS.find((entry) => entry.provider === "openai"
    && entry.metadata?.total_input_context_band == null && entry.aliases === undefined
    && entry.service_tier === "standard")!) as unknown as Record<string, unknown>;
  card.id = `openai:${model}:standard:current:synthetic-km-core`;
  card.model = model;
  card.effective = { from: "2026-10-01" };
  return card as unknown as PriceCard;
}

describe("baseline projection (manifest version 1)", () => {
  it("projects the Worker packages and the vendored d43c8f92 modules to the committed data file", async () => {
    const fromPackages = compiledBaselineCatalogManifest();
    expect(canonicalCatalogPayloadText(fromPackages)).toBe(JSON.stringify(committedBaseline));
    expect(JSON.stringify(vendoredRegistry.APP_OFFICIAL_PRICE_CARDS)).toBe(JSON.stringify(APP_OFFICIAL_PRICE_CARDS));
    expect(vendoredRegistry.APP_PRICE_REGISTRY_MANIFEST.sha256).toBe(APP_PRICE_REGISTRY_MANIFEST.sha256);
    expect(fromPackages.version).toBe(CATALOG_BASELINE_RELEASE.version);
    expect(fromPackages.projectedFromCommit).toBe("d43c8f92a059d9c577776f7eca8a331eb305b8a6");
    // The pinned version-1 digest is this build's compiled projection; if the
    // compiled registry moves, this fails rather than mislabel the fallback.
    expect(await compiledBaselineDigest()).toBe(CATALOG_BASELINE_DIGEST);
    expect(await webCryptoSha256Hex(JSON.stringify(committedBaseline))).toBe(CATALOG_BASELINE_DIGEST);
  });

  it("reproduces the compiled registry SHA from the manifest cards", async () => {
    const manifest = await validateCatalogManifest(clone(committedBaseline), webCryptoSha256Hex);
    expect(manifest.compat.registrySha256).toBe(APP_PRICE_REGISTRY_MANIFEST.sha256);
    expect(await webCryptoSha256Hex(JSON.stringify(activeCatalogPriceCards(manifest))))
      .toBe(APP_PRICE_REGISTRY_MANIFEST.sha256);
    expect(manifest.compat.registryVersion).toBe(APP_PRICE_REGISTRY_MANIFEST.version);
    assertCatalogCompiledAssertions(manifest, COMPILED_CATALOG_INPUTS);
  });

  it("prices byte-identically to the compiled registry through a signed round trip", async () => {
    const signer = await syntheticSigner();
    const { envelopeText } = await signer.sign(compiledBaselineCatalogManifest());
    const verified = await verifyCatalogEnvelope(envelopeText, { trustedKeys: signer.trustedKeys });
    const manifestCards = activeCatalogPriceCards(verified.manifest) as unknown as readonly AccountingPriceCard[];
    expect(manifestCards).not.toBe(APP_OFFICIAL_PRICE_CARDS);
    expect(JSON.stringify(manifestCards)).toBe(JSON.stringify(APP_OFFICIAL_PRICE_CARDS));

    const context = { priceEpochBasis: "event_time_when_registry_has_effective_evidence" } as const;
    let events = 0;
    let priced = 0;
    const days = (card: PriceCard) => {
      const effective = card.effective as { from?: string; to?: string };
      return [...new Set([effective.from, effective.to, "2026-03-01", "2026-08-01", "2026-09-15", "2026-10-02"]
        .filter((day): day is string => day !== undefined))];
    };
    for (const card of [...APP_OFFICIAL_PRICE_CARDS, syntheticCard()] as PriceCard[]) {
      const metadata = card.metadata as Record<string, unknown>;
      const band = metadata.total_input_context_band ?? null;
      const conditions = (card.components as { conditions?: Record<string, string> }[])[0]?.conditions ?? {};
      const contexts = band === "short" ? [conditions.max_total_input_tokens, "1000"]
        : band === "long" ? [conditions.min_total_input_tokens, "400000"] : ["1000", "300000"];
      for (const name of [card.model, ...((card.aliases ?? []) as string[])]) {
        for (const day of days(card)) {
          for (const totalInputContextTokens of contexts) {
            const event = {
              provider: card.provider,
              model: name,
              apiTier: card.service_tier,
              pricedAt: `${day}T12:00:00.000Z`,
              totalInputContextTokens,
              components: card.provider === "openai"
                ? { inputUncachedTokens: 1234, inputCacheReadTokens: 5678, inputCacheWriteTokens: 91,
                  outputTextTokens: 2345, outputReasoningTokens: 678 }
                : { inputUncachedTokens: 1234, inputCacheReadTokens: 5678, inputCacheWrite5mTokens: 91,
                  inputCacheWrite1hTokens: 17, outputCombinedTokens: 3023 },
              billableToolUnits: [{ name: "web_search_units", quantity: "3", unit: "search",
                provider: card.provider, billingSource: "provider" }],
            };
            const compiled = priceUsageEvent(event, { priceCards: APP_OFFICIAL_PRICE_CARDS, pricingContext: context });
            const fromManifest = priceUsageEvent(event, { priceCards: manifestCards, pricingContext: context });
            expect(JSON.stringify(fromManifest)).toBe(JSON.stringify(compiled));
            events += 1;
            if (compiled.coverageStatus !== "unpriced") priced += 1;
          }
        }
      }
    }
    expect(events).toBeGreaterThan(1500);
    expect(priced).toBeGreaterThan(1000);
  });

  it("states the compiled speed rules exactly as server pricing applies them", () => {
    const base: TelemetryUsageEvent = {
      schemaVersion: "usage-event-v0.1", eventTime: "2026-08-01T13:47:00.000Z", provider: "openai_codex",
      modelId: "gpt-5.6-sol", modelRecognition: "recognized", modelFingerprint: null,
      billingSurface: "chatgpt_subscription", speedMode: "standard", apiServiceTier: "unknown",
      reasoningEffort: "high",
      components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: null, inputCacheWrite1hTokens: null, outputTextTokens: 50,
        outputReasoningTokens: 25, outputCombinedTokens: null },
      totalInputContextTokens: 1000, surface: "local_interactive_unclassified", agentScope: "root",
      lineageDisposition: "standalone",
      toolClassCounts: { webSearch: 0, fileSearch: 0, codeInterpreter: 0, hostedShell: 0, computerUse: 0, mcp: 0,
        applyPatch: 0, localShell: 0, subagent: 0, toolGateway: 0, other: 0, unknown: 0 },
      outcome: "completed", eventId: `event:v2:${"b".repeat(64)}`,
      accounting: { estimatedApiCostUsd: "0", pricingCoveragePercent: 0, unknownBillableUnits: 0,
        priceBasis: "current_api_prices" },
    } as TelemetryUsageEvent;
    for (const speed of CATALOG_COMPILED_SPEEDS) {
      const event = {
        ...base,
        billingSurface: speed.billingSurface,
        speedMode: speed.token,
        ...(speed.billingSurface === "claude_subscription"
          ? { provider: "anthropic_claude_code", modelId: "claude-sonnet-5" } : {}),
      } as TelemetryUsageEvent;
      const result = priceTelemetryUsageEvent(event);
      expect(result.tierBasis, `${speed.billingSurface}/${speed.token}`).toBe(speed.rule === "priority_ratio"
        ? "subscription_speed_priority_price_ratio" : "subscription_standard_counterfactual");
    }
  });
});

describe("catalog-token-guard-v1 is exactly the wire grammar", () => {
  it("passes plain text inside [A-Za-z0-9._:-]{1,64}, case preserved, and nothing else is refused", () => {
    for (const value of ["gpt-6-sol", "Claude-Opus-5", "claude-haiku-4-5-20251001", "self_serve_business_prolite",
      "anthropic.claude-v2:1", "arn:aws:bedrock:us-east-1:123456789012:inference-profile",
      "123456789012", "x".repeat(64), "a"]) {
      expect(guardCatalogToken(value)).toEqual({ status: "token", token: value });
    }
  });

  it("classifies out-of-grammar values as unrecognized and absent values as missing", () => {
    for (const value of ["arn:aws:bedrock:us-east-1:123456789012:foundation-model/anthropic.claude",
      "x".repeat(65), "gpt 5", "gpt/5", "gpt@5", "gpt-5\n", "gpt-é", "\u0000", 5, {}, []]) {
      expect(guardCatalogToken(value)).toEqual({ status: "unrecognized" });
      expect(isCatalogToken(value)).toBe(false);
    }
    for (const value of [null, undefined, ""]) expect(guardCatalogToken(value)).toEqual({ status: "missing" });
  });

  it("refuses an out-of-grammar token anywhere in a manifest", async () => {
    const edits: ((manifest: CatalogManifest) => void)[] = [
      (manifest) => { manifest.models[0]!.id = "arn:aws:bedrock:us-east-1:123456789012:foundation-model/x"; },
      (manifest) => { manifest.speeds[0]!.token = "ultra fast"; },
      (manifest) => { manifest.tiers[0]!.token = "t".repeat(65); },
      (manifest) => { manifest.plans[0]!.id = "plan/unknown"; },
      (manifest) => { (manifest.priceCards[0] as Record<string, unknown>).model = "gpt 5"; },
    ];
    for (const edit of edits) {
      const manifest = clone(committedBaseline) as unknown as CatalogManifest;
      edit(manifest);
      expect(await codeOf(() => validateCatalogManifestPayload(manifest))).toBe("CATALOG_TOKEN_OUT_OF_GRAMMAR");
    }
  });
});

describe("closed schema", () => {
  it("refuses extra, missing and reordered keys, bad instants and version links", async () => {
    const cases: [string, (manifest: Record<string, unknown>) => void][] = [
      ["CATALOG_SCHEMA_INVALID", (manifest) => { manifest.extra = true; }],
      ["CATALOG_SCHEMA_INVALID", (manifest) => { delete manifest.plans; }],
      ["CATALOG_SCHEMA_INVALID", (manifest) => { manifest.version = 0; }],
      ["CATALOG_SCHEMA_INVALID", (manifest) => { manifest.version = 2; }],
      ["CATALOG_SCHEMA_INVALID", (manifest) => { manifest.publishedAt = "2026-09-23T14:52:10.000Z"; }],
      ["CATALOG_SCHEMA_INVALID", (manifest) => { manifest.activateAt = "2026-09-01T00:00:00Z"; }],
      ["CATALOG_SCHEMA_INVALID", (manifest) => { (manifest.models as Record<string, unknown>[])[0]!.color = "red"; }],
      ["CATALOG_SCHEMA_INVALID", (manifest) => { (manifest.normalization as Record<string, unknown>).currency = "EUR"; }],
      ["CATALOG_PRICE_CARDS_INVALID", (manifest) => {
        ((manifest.priceCards as Record<string, unknown>[])[0]!).note = "free text";
      }],
      ["CATALOG_PRICE_CARDS_INVALID", (manifest) => {
        const card = (manifest.priceCards as Record<string, unknown>[])[0]!;
        ((card.source as Record<string, unknown>)).url = "http://insecure.example/pricing";
      }],
      ["CATALOG_PRICE_CARDS_INVALID", (manifest) => {
        // Two unbanded cards in one context and window overlap.
        const cards = manifest.priceCards as Record<string, unknown>[];
        const card = clone(cards.find((entry) => entry.provider === "anthropic")!);
        card.id = `${String(card.id)}:duplicate`;
        cards.push(card);
      }],
      ["CATALOG_PRICE_CARDS_INVALID", (manifest) => {
        // A long band that does not start exactly after its short band.
        const card = (manifest.priceCards as Record<string, unknown>[]).find((entry) =>
          (entry.metadata as Record<string, unknown>).total_input_context_band === "long")!;
        for (const component of card.components as { conditions: Record<string, string> }[]) {
          component.conditions.min_total_input_tokens = "300000";
        }
      }],
    ];
    for (const [code, edit] of cases) {
      const manifest = clone(committedBaseline) as unknown as Record<string, unknown>;
      edit(manifest);
      expect(await codeOf(() => validateCatalogManifestPayload(manifest))).toBe(code);
    }
  });

  it("requires canonical payload bytes", async () => {
    const text = JSON.stringify(committedBaseline);
    expect(await codeOf(() => parseCanonicalCatalogPayload(text))).toBe("NO_ERROR");
    expect(await codeOf(() => parseCanonicalCatalogPayload(JSON.stringify(committedBaseline, null, 1))))
      .toBe("CATALOG_PAYLOAD_NOT_CANONICAL");
    expect(await codeOf(() => parseCanonicalCatalogPayload(text.replace('"version":1,', '"version":1,"version":1,'))))
      .toBe("CATALOG_PAYLOAD_NOT_CANONICAL");
  });

  it("refuses a manifest whose registry SHA does not match its active cards", async () => {
    const manifest = clone(committedBaseline) as unknown as CatalogManifest;
    manifest.compat.registrySha256 = "0".repeat(64);
    expect(await codeOf(() => validateCatalogManifest(manifest, webCryptoSha256Hex)))
      .toBe("CATALOG_REGISTRY_SHA_MISMATCH");
  });

  it("refuses a plan the compiled roster lacks", () => {
    const manifest = compiledBaselineCatalogManifest();
    manifest.plans.push({ id: "promax", label: "Pro Max" });
    expect(() => assertCatalogCompiledAssertions(manifest, COMPILED_CATALOG_INPUTS)).toThrow(CatalogManifestError);
  });
});

describe("append-only successors", () => {
  it("accepts a new model, a new card, a relabel and a retraction", async () => {
    const held = compiledBaselineCatalogManifest();
    const retracted = held.priceCards.find((card) => card.provider === "anthropic")!;
    const next = await successorOf(held, (manifest) => {
      manifest.priceCards.push(syntheticCard());
      manifest.models.push({ id: "synthetic-unseen-model-km1", label: "Synthetic unseen model",
        provider: "openai_codex", allowanceTrack: "primary", pricingStatus: "published",
        priceModelId: "synthetic-unseen-model-km1", hidden: false });
      manifest.models[0]!.label = "Relabelled";
      manifest.retractions.push({ cardId: retracted.id, inVersion: 2, reason: "withdrawn", supersededBy: [] });
    });
    await validateCatalogManifest(next, webCryptoSha256Hex);
    await assertCatalogManifestSuccessor({
      held, heldDigest: next.previousDigest!, next, digest: webCryptoSha256Hex,
    });
    expect(activeCatalogPriceCards(next).some((card) => card.id === retracted.id)).toBe(false);
  });

  it("refuses edits, removals, regressions, gaps and broken chains", async () => {
    const held = compiledBaselineCatalogManifest();
    const heldDigest = await webCryptoSha256Hex(canonicalCatalogPayloadText(held));
    const check = (next: CatalogManifest, digest = heldDigest) => codeOf(() => assertCatalogManifestSuccessor({
      held, heldDigest: digest, next, digest: webCryptoSha256Hex,
    }));
    expect(await check(await successorOf(held, (manifest) => {
      (manifest.priceCards[0]!.components as { price: { amount: string } }[])[0]!.price.amount = "0.01";
    }))).toBe("CATALOG_NOT_APPEND_ONLY");
    expect(await check(await successorOf(held, (manifest) => { manifest.priceCards.pop(); })))
      .toBe("CATALOG_NOT_APPEND_ONLY");
    expect(await check(await successorOf(held, (manifest) => { manifest.models[0]!.priceModelId = "gpt-5"; })))
      .toBe("CATALOG_NOT_APPEND_ONLY");
    expect(await check(await successorOf(held, (manifest) => { manifest.plans.pop(); })))
      .toBe("CATALOG_NOT_APPEND_ONLY");
    expect(await check(await successorOf(held, (manifest) => { manifest.speeds[1]!.rule = "unpriced"; })))
      .toBe("CATALOG_NOT_APPEND_ONLY");
    expect(await check(clone(held))).toBe("CATALOG_VERSION_REGRESSION");
    expect(await check(await successorOf(held, (manifest) => {
      manifest.version = 3; manifest.previousVersion = 2;
    }))).toBe("CATALOG_VERSION_GAP");
    expect(await check(await successorOf(held), "f".repeat(64))).toBe("CATALOG_CHAIN_MISMATCH");
  });
});

describe("catalog-envelope-v1", () => {
  it("verifies only pinned keys, the exact payload bytes and a domain-separated signature", async () => {
    const signer = await syntheticSigner();
    const { envelopeText, publicKey } = await signer.sign(compiledBaselineCatalogManifest());
    expect(publicKey).toBe(signer.trustedKeys[0]!.publicKey);
    const verified = await verifyCatalogEnvelope(envelopeText, { trustedKeys: signer.trustedKeys });
    expect(verified.version).toBe(1);
    expect(verified.digest).toBe(await webCryptoSha256Hex(JSON.stringify(committedBaseline)));

    expect(await codeOf(() => verifyCatalogEnvelope(envelopeText, { trustedKeys: [] })))
      .toBe("CATALOG_KEY_UNTRUSTED");
    expect(await codeOf(() => verifyCatalogEnvelope(envelopeText, {
      trustedKeys: catalogTrustedKeys("production"),
    }))).toBe("CATALOG_KEY_UNTRUSTED");
    const other = await syntheticSigner();
    expect(await codeOf(() => verifyCatalogEnvelope(envelopeText, { trustedKeys: other.trustedKeys })))
      .toBe("CATALOG_SIGNATURE_INVALID");

    const envelope = JSON.parse(envelopeText) as Record<string, string>;
    const signature = envelope.signature!;
    const flipped = `${signature.slice(0, 10)}${signature[10] === "A" ? "B" : "A"}${signature.slice(11)}`;
    expect(await codeOf(() => verifyCatalogEnvelope(JSON.stringify({ ...envelope, signature: flipped }),
      { trustedKeys: signer.trustedKeys }))).toBe("CATALOG_SIGNATURE_INVALID");
    expect(await codeOf(() => parseCatalogEnvelope(JSON.stringify({ ...envelope, extra: 1 }))))
      .toBe("CATALOG_ENVELOPE_INVALID");
    expect(await codeOf(() => parseCatalogEnvelope(JSON.stringify({ format: envelope.format, keyId: envelope.keyId,
      signature: envelope.signature, payload: envelope.payload })))).toBe("CATALOG_ENVELOPE_INVALID");
    expect(await codeOf(() => parseCatalogEnvelope(`${envelopeText} `))).toBe("CATALOG_ENVELOPE_INVALID");

    // A signature over the bare payload (no domain prefix) does not verify.
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
    const payloadBytes = new TextEncoder().encode(canonicalCatalogPayloadText(compiledBaselineCatalogManifest()));
    const bare = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, payloadBytes));
    const toUrl = (bytes: Uint8Array) => {
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    };
    const undomained = JSON.stringify({ format: "catalog-envelope-v1", keyId: "catalog-test-bare",
      payload: toUrl(payloadBytes), signature: toUrl(bare) });
    expect(await codeOf(() => verifyCatalogEnvelope(undomained, {
      trustedKeys: [{ keyId: "catalog-test-bare", publicKey: btoa(String.fromCharCode(...raw)) }],
    }))).toBe("CATALOG_SIGNATURE_INVALID");
  });
});
