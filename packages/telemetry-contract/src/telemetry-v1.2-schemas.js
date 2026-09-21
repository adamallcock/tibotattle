import { telemetryV11JsonSchemas } from "./telemetry-v1.1-schemas.js";
import {
  MAX_TELEMETRY_V12_TIE_ORDER,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12RequiredConsent,
} from "./telemetry-v1.2.js";

const ROOT = "https://tibotattle.com/schemas/telemetry-contribution-v1.2/";
const COUNT = (maximum) => ({
  type: "integer",
  minimum: 0,
  maximum,
});

function rewriteV12Strings(value) {
  if (typeof value === "string") return value.replaceAll("v1.1", "v1.2");
  if (Array.isArray(value)) return value.map(rewriteV12Strings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    rewriteV12Strings(child),
  ]));
}

function v12UsageSchema(source) {
  const schema = structuredClone(source);
  schema.required = [...schema.required, "boundaryFlags", "tieOrder", "cacheWriteTtl"];
  schema.properties.boundaryFlags = {
    anyOf: [{ type: "null" }, COUNT(3)],
  };
  schema.properties.tieOrder = {
    anyOf: [{ type: "null" }, COUNT(MAX_TELEMETRY_V12_TIE_ORDER)],
  };
  schema.properties.cacheWriteTtl = {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        additionalProperties: false,
        required: ["fiveMinuteTokens", "oneHourTokens"],
        properties: {
          fiveMinuteTokens: COUNT(1_000_000_000_000),
          oneHourTokens: COUNT(1_000_000_000_000),
        },
      },
    ],
  };
  schema.$comment = `${schema.$comment ?? ""} Runtime additionally requires cacheWriteTtl to be non-null only with a non-null aggregate inputCacheWriteTokens and to reconcile exactly to it; tie-order completeness is a whole-day proof.`.trim();
  return schema;
}

/** Canonical source; the owning generator emits package and root mirrors. */
export function telemetryV12JsonSchemas() {
  const source = telemetryV11JsonSchemas();
  const schemas = rewriteV12Strings(source);
  const usage = v12UsageSchema(schemas["usage-event.schema.json"]);
  usage.properties = {
    ...schemas["usage-event.schema.json"].properties,
    ...usage.properties,
  };
  usage.$comment = `${usage.$comment} Field dictionary ${TELEMETRY_V12_FIELD_DICTIONARY_VERSION}; privacy contract ${TELEMETRY_V12_PRIVACY_CONTRACT_VERSION}.`;
  usage.allOf = [
    ...(usage.allOf ?? []),
    {
      if: { properties: { cacheWriteTtl: { type: "object" } } },
      then: { properties: { components: { type: "object", properties: {
        inputCacheWriteTokens: { type: "integer", minimum: 0, maximum: 1_000_000_000_000 },
      } } } },
    },
  ];
  schemas["usage-event.schema.json"] = usage;
  for (const condition of schemas["contribution.schema.json"].allOf ?? []) {
    if (condition.if?.properties?.chunkId?.pattern) {
      condition.if.properties.chunkId.type = "string";
      if (condition.then?.properties?.records?.items) {
        condition.then.properties.records.type = "array";
      }
    }
  }
  for (const condition of schemas["quota-observation.schema.json"].allOf ?? []) {
    if (condition.if?.properties?.planType) {
      condition.if.properties.planType.type = "string";
    }
    if (condition.then?.properties?.accountPlanAttribution?.properties) {
      condition.then.properties.accountPlanAttribution.type = "object";
    }
  }
  const consent = telemetryV12RequiredConsent();
  for (const basename of ["contribution.schema.json", "day-manifest.schema.json"]) {
    const consentSchema = schemas[basename].properties.consent;
    for (const [key, value] of Object.entries(consent)) {
      consentSchema.properties[key] = { const: value };
    }
  }
  return Object.fromEntries(Object.entries(schemas).map(([basename, schema]) => [
    basename,
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: `${ROOT}${basename}`,
      ...schema,
    },
  ]));
}
