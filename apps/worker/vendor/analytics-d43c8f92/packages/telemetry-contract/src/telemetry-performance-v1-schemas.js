import {
  MAX_PERFORMANCE_COUNT,
  MAX_PERFORMANCE_RECORD_CANONICAL_BYTES,
  MAX_PERFORMANCE_SPEED_CENTI_TOKENS_PER_SECOND,
  MAX_PERFORMANCE_TURN_DURATION_MILLISECONDS,
  MAX_PERFORMANCE_TTFT_MILLISECONDS,
  PERFORMANCE_API_SERVICE_TIERS,
  PERFORMANCE_BUCKET_SCHEME_VERSION,
  PERFORMANCE_HISTOGRAM_SCHEMA_VERSION,
  PERFORMANCE_MEASUREMENT_VERSION,
  PERFORMANCE_REASONING_EFFORTS,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  PERFORMANCE_SPEED_MODE_SOURCES,
  PERFORMANCE_SPEED_MODES,
  PERFORMANCE_SPEED_METHODS,
} from "./telemetry-performance-v1.js";
import { REVIEWED_MODEL_CATALOG } from "./model-catalog.js";

const ROOT = "https://tibotattle.com/schemas/telemetry-performance-v1/";
const DAY = "^\\d{4}-\\d{2}-\\d{2}$";
const PERFORMANCE_PROVIDERS = Object.freeze([
  ...new Set(REVIEWED_MODEL_CATALOG.map(({ provider }) => provider)),
]);
const PERFORMANCE_MODELS = Object.freeze(
  REVIEWED_MODEL_CATALOG.map(({ id }) => id),
);
const PERFORMANCE_MODELS_BY_PROVIDER = new Map();
for (const { provider, id } of REVIEWED_MODEL_CATALOG) {
  const models = PERFORMANCE_MODELS_BY_PROVIDER.get(provider) ?? [];
  models.push(id);
  PERFORMANCE_MODELS_BY_PROVIDER.set(provider, models);
}
const COUNT = {
  type: "integer",
  minimum: 0,
  maximum: MAX_PERFORMANCE_COUNT,
};
const POSITIVE_COUNT = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PERFORMANCE_COUNT,
};

const HISTOGRAM_BUCKET = {
  type: "object",
  additionalProperties: false,
  propertyNames: { pattern: "^(?:0|[1-9]\\d?)$" },
  patternProperties: {
    "^(?:0|[1-9]\\d?)$": POSITIVE_COUNT,
  },
};

const HISTOGRAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "metric", "sampleCount", "buckets", "min", "max"],
  properties: {
    schemaVersion: { const: PERFORMANCE_HISTOGRAM_SCHEMA_VERSION },
    metric: { enum: ["speed", "ttft", "turnDuration"] },
    sampleCount: COUNT,
    buckets: HISTOGRAM_BUCKET,
    min: { anyOf: [{ type: "null" }, COUNT] },
    max: { anyOf: [{ type: "null" }, COUNT] },
  },
  allOf: [
    {
      if: { properties: { metric: { const: "speed" } } },
      then: {
        properties: {
          buckets: {
            propertyNames: {
              pattern: "^(?:0|[1-9]|[1-5]\\d|60)$",
            },
          },
          min: {
            anyOf: [{ type: "null" }, {
              type: "integer", minimum: 0,
              maximum: MAX_PERFORMANCE_SPEED_CENTI_TOKENS_PER_SECOND,
            }],
          },
          max: {
            anyOf: [{ type: "null" }, {
              type: "integer", minimum: 1,
              maximum: MAX_PERFORMANCE_SPEED_CENTI_TOKENS_PER_SECOND,
            }],
          },
        },
      },
    },
    {
      if: { properties: { metric: { const: "ttft" } } },
      then: {
        properties: {
          buckets: {
            propertyNames: {
              pattern: "^(?:0|[1-9]|[1-4]\\d|5[0-7])$",
            },
          },
          min: {
            anyOf: [{ type: "null" }, {
              type: "integer", minimum: 0,
              maximum: MAX_PERFORMANCE_TTFT_MILLISECONDS,
            }],
          },
          max: {
            anyOf: [{ type: "null" }, {
              type: "integer", minimum: 0,
              maximum: MAX_PERFORMANCE_TTFT_MILLISECONDS,
            }],
          },
        },
      },
    },
    {
      if: { properties: { metric: { const: "turnDuration" } } },
      then: {
        properties: {
          buckets: {
            propertyNames: {
              pattern: "^(?:[1-9]|[1-4]\\d|5[0-7])$",
            },
          },
          min: {
            anyOf: [{ type: "null" }, {
              type: "integer", minimum: 1,
              maximum: MAX_PERFORMANCE_TURN_DURATION_MILLISECONDS,
            }],
          },
          max: {
            anyOf: [{ type: "null" }, {
              type: "integer", minimum: 1,
              maximum: MAX_PERFORMANCE_TURN_DURATION_MILLISECONDS,
            }],
          },
        },
      },
    },
    {
      if: { properties: { sampleCount: { const: 0 } } },
      then: {
        properties: {
          buckets: { maxProperties: 0 },
          min: { const: null },
          max: { const: null },
        },
      },
    },
    {
      if: { properties: { sampleCount: { minimum: 1 } } },
      then: {
        properties: {
          buckets: { minProperties: 1 },
          min: { type: "integer" },
          max: { type: "integer" },
        },
      },
    },
  ],
  $comment: "Speed bins are half-open [0,2), [2,4), through [118,120), with overflow >=120 tokens/second; TTFT has [0,1ms), [1,500ms), logarithmic upper-exclusive bins through the final edge, and overflow at or above that edge; turnDuration uses the same positive millisecond bins and never occupies bucket 0. Runtime additionally requires sparse bucket counts to sum to sampleCount, non-empty extrema to be ordered and occupied-bin compatible, singleton TTFT extrema to be equal, singleton speed extrema to differ by at most one centi-TPS, and metric-specific units to match the selected bucket scheme.",
};

const RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "day", "provider", "modelId", "reasoningEffort",
    "speedMethod", "speedMode", "speedModeSource", "apiServiceTier",
    "measurementVersion", "bucketSchemeVersion", "turns", "speedTurns",
    "ttftTurns", "completionTurns", "timedResponses", "speedTokens",
    "speedDurationMs", "speedHistogram", "ttftHistogram", "completionHistogram",
  ],
  properties: {
    schemaVersion: { const: PERFORMANCE_RECORD_SCHEMA_VERSION },
    day: { type: "string", pattern: DAY, format: "date" },
    provider: { enum: PERFORMANCE_PROVIDERS },
    modelId: { enum: PERFORMANCE_MODELS },
    reasoningEffort: { enum: PERFORMANCE_REASONING_EFFORTS },
    speedMethod: { enum: PERFORMANCE_SPEED_METHODS },
    speedMode: { enum: PERFORMANCE_SPEED_MODES },
    speedModeSource: { enum: PERFORMANCE_SPEED_MODE_SOURCES },
    apiServiceTier: { enum: PERFORMANCE_API_SERVICE_TIERS },
    measurementVersion: { const: PERFORMANCE_MEASUREMENT_VERSION },
    bucketSchemeVersion: { const: PERFORMANCE_BUCKET_SCHEME_VERSION },
    turns: POSITIVE_COUNT,
    speedTurns: COUNT,
    ttftTurns: COUNT,
    completionTurns: COUNT,
    timedResponses: COUNT,
    speedTokens: COUNT,
    speedDurationMs: COUNT,
    speedHistogram: {
      allOf: [
        { $ref: "performance-histogram.schema.json" },
        { properties: { metric: { const: "speed" } } },
      ],
    },
    ttftHistogram: {
      allOf: [
        { $ref: "performance-histogram.schema.json" },
        { properties: { metric: { const: "ttft" } } },
      ],
    },
    completionHistogram: {
      allOf: [
        { $ref: "performance-histogram.schema.json" },
        { properties: { metric: { const: "turnDuration" } } },
      ],
    },
  },
  allOf: [
    ...[...PERFORMANCE_MODELS_BY_PROVIDER].map(([provider, modelIds]) => ({
      if: { properties: { provider: { const: provider } } },
      then: { properties: { modelId: { enum: modelIds } } },
    })),
    {
      if: { properties: { speedMethod: { const: "unavailable" } } },
      then: {
        properties: {
          speedTurns: { const: 0 },
          timedResponses: { const: 0 },
          speedTokens: { const: 0 },
          speedDurationMs: { const: 0 },
          speedHistogram: { properties: { sampleCount: { const: 0 } } },
        },
      },
    },
    {
      if: { properties: { speedMode: { const: "unknown" } } },
      then: { properties: { speedModeSource: { const: "unobserved" } } },
    },
    {
      if: { properties: { speedMode: { const: "mixed" } } },
      then: { properties: { speedModeSource: { const: "mixed" } } },
    },
    {
      if: { properties: { speedMode: { enum: ["fast", "standard", "other"] } } },
      then: {
        properties: {
          speedModeSource: {
            enum: ["rollout_thread_settings", "lineage_inherited"],
          },
        },
      },
    },
    {
      if: { properties: { completionTurns: { const: 0 } } },
      then: {
        properties: {
          completionHistogram: { properties: { sampleCount: { const: 0 } } },
        },
      },
    },
    {
      if: { properties: { completionTurns: { minimum: 1 } } },
      then: {
        properties: {
          completionHistogram: { properties: { sampleCount: { minimum: 1 } } },
        },
      },
    },
    {
      if: { properties: { speedMethod: { enum: ["receipt", "legacy", "tool_free"] } } },
      then: {
        properties: {
          turns: { minimum: 1 },
          speedTurns: { minimum: 1 },
        },
      },
    },
  ],
  $comment: "Provider and model IDs come from the reviewed catalog and its exact provider pairing. Runtime additionally requires speedTurns, ttftTurns, and completionTurns to be no greater than positive turns; receipt/legacy/tool_free cohorts to have speedTurns equal turns; unavailable speed cohorts to have zero speed sums and an empty speed histogram; timedResponses to be at least speedTurns; speed, TTFT, and completion histogram counts to match their eligible counts; completion observations to be positive integer milliseconds; and the ratio of summed speedTokens to speedDurationMs to lie within conservative speed extrema. Speed mode evidence and API service tier are independent dimensions.",
};

/** Canonical JSON Schema sources; package and root mirrors are generated. */
export function telemetryPerformanceJsonSchemas() {
  return Object.fromEntries([
    ["performance-histogram.schema.json", HISTOGRAM_SCHEMA],
    ["performance-record.schema.json", RECORD_SCHEMA],
  ].map(([basename, schema]) => [basename, {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `${ROOT}${basename}`,
    ...structuredClone(schema),
  }]));
}

export const TELEMETRY_PERFORMANCE_SCHEMA_LIMITS = Object.freeze({
  maxSerializedBytes: MAX_PERFORMANCE_RECORD_CANONICAL_BYTES,
  maxHistogramBuckets: 61,
});
