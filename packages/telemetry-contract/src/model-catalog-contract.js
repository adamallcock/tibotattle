import {
  REVIEWED_CLAUDE_MODEL_IDS,
  REVIEWED_CODEX_MODEL_IDS,
  REVIEWED_MODEL_CATALOG,
  REVIEWED_MODEL_CATALOG_VERSION,
  reviewedModelIdentity,
} from "./model-catalog.js";

// The reviewed vocabulary's own completeness contract. It lives beside the
// catalog rather than inside it so that gate-time validation stays out of the
// public browser mirror, which carries the vocabulary itself and nothing else.
const REVIEWED_MODEL_ENTRY_KEYS = Object.freeze(
  ["id", "label", "provider", "allowanceTrack", "pricingStatus", "priceModelId"],
);
const REVIEWED_MODEL_PROVIDERS = Object.freeze(["openai_codex", "anthropic_claude_code"]);
const REVIEWED_ALLOWANCE_TRACKS = Object.freeze(["primary", "spark"]);
const REVIEWED_PRICING_STATUSES = Object.freeze(["published", "assumed_alias", "unpriced"]);
// `reviewedModelIdentity` refuses anything longer than 80 characters, so an
// identity past that bound could never resolve through the reviewed lookup.
const REVIEWED_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,79}$/u;
const REVIEWED_MODEL_LABEL_PATTERN = /^[^\p{C}]{1,80}$/u;

function reviewedModelFailure(id, reason) {
  throw new Error(`Reviewed model identity ${JSON.stringify(id)} ${reason}`);
}

/**
 * The package's own vocabulary contract: the catalog carries exactly the
 * reviewed keys, unique bounded identities, closed provider/track/pricing
 * values, and price references that resolve inside the catalog. Surfaces and
 * release gates call this rather than restating a weaker approximation of it.
 *
 * The returned `identities` deliberately omit `label`. A label is site-visible
 * copy; the rest of an identity is the vocabulary that the price cards, the
 * export registries and the closed upload enum are reviewed against, so a
 * caller that must prove the vocabulary did not move compares exactly that
 * projection. Throws on the first gap.
 */
export function assertReviewedModelCatalogCompleteness({
  catalog = REVIEWED_MODEL_CATALOG,
} = {}) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new TypeError("The reviewed model catalog must be a non-empty array");
  }
  const byId = new Map();
  for (const entry of catalog) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Every reviewed model identity must be an object");
    }
    const { id, label } = entry;
    if (typeof id !== "string" || !REVIEWED_MODEL_ID_PATTERN.test(id)) {
      reviewedModelFailure(id, "is not a bounded lowercase identity");
    }
    const keys = Object.keys(entry);
    if (keys.length !== REVIEWED_MODEL_ENTRY_KEYS.length
        || REVIEWED_MODEL_ENTRY_KEYS.some((name, index) => keys[index] !== name)) {
      reviewedModelFailure(id, `does not carry exactly ${REVIEWED_MODEL_ENTRY_KEYS.join(", ")}`);
    }
    if (!Object.isFrozen(entry)) reviewedModelFailure(id, "is not frozen");
    if (typeof label !== "string" || !REVIEWED_MODEL_LABEL_PATTERN.test(label)
        || label.trim() !== label) {
      reviewedModelFailure(id, "does not carry a bounded single-line label");
    }
    if (!REVIEWED_MODEL_PROVIDERS.includes(entry.provider)) {
      reviewedModelFailure(id, "names an unreviewed provider");
    }
    if (!REVIEWED_ALLOWANCE_TRACKS.includes(entry.allowanceTrack)) {
      reviewedModelFailure(id, "names an unreviewed allowance track");
    }
    if (!REVIEWED_PRICING_STATUSES.includes(entry.pricingStatus)) {
      reviewedModelFailure(id, "names an unreviewed pricing status");
    }
    if (entry.pricingStatus === "unpriced"
      ? entry.priceModelId !== null
      : typeof entry.priceModelId !== "string") {
      reviewedModelFailure(id, "does not pair its pricing status with a price identity");
    }
    if (byId.has(id)) reviewedModelFailure(id, "is listed more than once");
    byId.set(id, entry);
  }
  for (const entry of catalog) {
    if (entry.priceModelId !== null && !byId.has(entry.priceModelId)) {
      reviewedModelFailure(
        entry.id, `prices against an unreviewed ${JSON.stringify(entry.priceModelId)}`,
      );
    }
  }
  // The derived exports and the reviewed lookup are only meaningful for the
  // shipped catalog; a caller-supplied catalog is validated on its own terms.
  if (catalog === REVIEWED_MODEL_CATALOG) {
    for (const [provider, exported] of [
      ["openai_codex", REVIEWED_CODEX_MODEL_IDS],
      ["anthropic_claude_code", REVIEWED_CLAUDE_MODEL_IDS],
    ]) {
      const expected = catalog
        .filter((entry) => entry.provider === provider)
        .map((entry) => entry.id);
      if (expected.length !== exported.length
          || expected.some((id, index) => exported[index] !== id)) {
        throw new Error(
          `The exported ${provider} identity list no longer matches the reviewed catalog`,
        );
      }
    }
    for (const entry of catalog) {
      if (reviewedModelIdentity(entry.id) !== entry) {
        reviewedModelFailure(entry.id, "is not resolvable through the reviewed lookup");
      }
    }
  }
  return Object.freeze({
    version: REVIEWED_MODEL_CATALOG_VERSION,
    identityCount: catalog.length,
    modelIds: Object.freeze(catalog.map((entry) => entry.id)),
    identities: Object.freeze(catalog.map((entry) => Object.freeze({
      id: entry.id,
      provider: entry.provider,
      allowanceTrack: entry.allowanceTrack,
      pricingStatus: entry.pricingStatus,
      priceModelId: entry.priceModelId,
    }))),
  });
}
