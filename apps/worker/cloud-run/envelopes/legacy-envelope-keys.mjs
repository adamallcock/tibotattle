/**
 * The d43c8f92 Worker's exact envelope key check (index.ts
 * hasExactEnvelopeKeyOccurrences) for the legacy envelope the PostgreSQL
 * origin serves (envelopes/v10.mjs) and for envelopes/v01.mjs, which owner
 * round 12 retires at the switch: the composed origin registers a retired
 * 503 envelope for v0.1, and v01.mjs is kept only for the legacy-admission
 * spec.
 *
 * handleContribution runs it over the exact claimed body text after the
 * upload-authorization claim and before any envelope handler, for every
 * envelope version, and answers 400 ENVELOPE_INVALID. JSON.parse keeps only
 * the last of duplicated keys, so the parsed value cannot show a duplicate;
 * only the raw text can. Plain JavaScript with no imports so node:test specs
 * load it directly.
 */

const ENVELOPE_KEYS = Object.freeze([
  "schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext",
].sort());

/**
 * True only when the raw body names each envelope key exactly once and no
 * other key, as the Worker's regular expression counts them.
 *
 * @param {unknown} raw
 */
export function hasExactEnvelopeKeyOccurrences(raw) {
  if (typeof raw !== "string") return false;
  const keys = [...raw.matchAll(/"([^"\\]+)"\s*:/gu)].map((match) => match[1]).sort();
  return keys.length === ENVELOPE_KEYS.length
    && keys.every((key, index) => key === ENVELOPE_KEYS[index]);
}
