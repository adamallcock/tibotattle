/**
 * The single canonical JSON serializer for this Worker.
 *
 * Every byte this module produces is content-addressed somewhere: it feeds
 * `payload_sha256` for sealed community snapshots, `record_json` and the record
 * digests in `telemetry-repository.ts`, and the occurrence-compatibility compare
 * in `telemetry-v0.2-repository.ts`. Those consumers all ask the same question —
 * "is this the same *content* as what we already stored?" — which bare
 * `JSON.stringify` cannot answer, because its key order is the insertion order of
 * the object it happens to be handed. Two payloads with identical content but
 * different construction order stringify differently and therefore hash
 * differently, which silently breaks dedupe and integrity comparison alike.
 *
 * Three separate copies of this function previously lived in three modules, and
 * one of them (`community-snapshots.ts`) was a bare `JSON.stringify` despite the
 * name. Keep exactly one, here.
 *
 * Object keys are sorted with the default (UTF-16 code unit) comparator; arrays
 * keep their order, because array order is content. Values that `JSON.stringify`
 * renders as `undefined` (i.e. `undefined` itself and functions) are not part of
 * any payload this Worker serializes and are deliberately not special-cased —
 * every input reaching this function is either a validated closed-schema record
 * or a locally constructed payload of JSON scalars, plain objects and arrays.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
