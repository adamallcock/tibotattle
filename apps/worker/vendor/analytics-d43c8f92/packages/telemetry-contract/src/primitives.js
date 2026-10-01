import {
  MAX_TELEMETRY_BROWSER_BYTES,
} from "./constants.js";
import {
  telemetryContractFailure,
} from "./errors.js";

const FORBIDDEN_CONTENT_KEYS = new Set([
  "account",
  "accountid",
  "args",
  "argument",
  "arguments",
  "body",
  "command",
  "commandarguments",
  "commands",
  "content",
  "cwd",
  "email",
  "file",
  "filepath",
  "filepaths",
  "filename",
  "filenames",
  "files",
  "hostname",
  "message",
  "messages",
  "participantid",
  "path",
  "paths",
  "prompt",
  "prompts",
  "repo",
  "repository",
  "response",
  "responses",
  "sessionid",
  "text",
  "threadid",
  "url",
  "username",
  "workingdirectory",
]);

const DIRECT_IDENTITY_VALUE =
  /(?:openai-)?account:v1:[a-f0-9]{64}|participant:[0-9a-f-]{36}|um_session_|sessionScopeId|accountScopeId|providerAccountId|centralParticipantId/iu;
const LOCAL_CONTENT_VALUE =
  /(?:\/Users\/|\/home\/|[A-Z]:\\|file:\/\/|https?:\/\/|@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/u;

/**
 * Canonical emitters use lowercase hexadecimal SHA-256 identifiers. The
 * validator also accepts the historical, unpadded 32-byte base64url encoding
 * so already-created content-free exports remain readable.
 */
export const TELEMETRY_HASH_ID_BODY_PATTERN_SOURCE =
  "(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})";

const TELEMETRY_HASH_ID_PREFIX_PATTERN =
  /^[a-z][a-z0-9-]{0,31}:v[1-9][0-9]{0,3}$/u;
const TELEMETRY_HASH_ID_PATTERNS = new Map();

export function telemetryHashIdPatternSource(prefix) {
  if (
    typeof prefix !== "string"
    || !TELEMETRY_HASH_ID_PREFIX_PATTERN.test(prefix)
  ) return null;
  return `^${prefix}:${TELEMETRY_HASH_ID_BODY_PATTERN_SOURCE}$`;
}

export function isTelemetryRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function hasTelemetryExactKeys(value, keys) {
  if (!isTelemetryRecord(value)) return false;
  try {
    const actual = Object.keys(value).sort();
    const wanted = [...keys].sort();
    return actual.length === wanted.length
      && actual.every((key, index) => key === wanted[index]);
  } catch {
    return false;
  }
}

export function isTelemetryMember(value, values) {
  return typeof value === "string" && values.includes(value);
}

export function isTelemetryInstant(value) {
  if (typeof value !== "string" || value.length > 32) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

export function isTelemetryInteger(
  value,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum;
}

export function isTelemetryNullableInteger(
  value,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  return value === null || isTelemetryInteger(value, maximum);
}

export function isTelemetryBounded(value, minimum, maximum) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

export function isTelemetryMoney(value) {
  return value === null
    || (typeof value === "string"
      && /^(?:0|[1-9]\d{0,8})\.\d{6}$/u.test(value));
}

export function isTelemetryHashId(value, prefix) {
  if (typeof value !== "string") return false;
  const source = telemetryHashIdPatternSource(prefix);
  if (source === null) return false;
  let pattern = TELEMETRY_HASH_ID_PATTERNS.get(source);
  if (pattern === undefined) {
    pattern = new RegExp(source, "u");
    TELEMETRY_HASH_ID_PATTERNS.set(source, pattern);
  }
  return pattern.test(value);
}

export function isTelemetryBase64Url(value, minimum, maximum) {
  return typeof value === "string"
    && value.length >= minimum
    && value.length <= maximum
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function telemetryPrivacyCanary(value) {
  try {
    const stack = [value];
    const visited = new WeakSet();
    while (stack.length > 0) {
      const current = stack.pop();
      if (typeof current === "string") {
        if (
          DIRECT_IDENTITY_VALUE.test(current)
          || LOCAL_CONTENT_VALUE.test(current)
        ) return true;
        continue;
      }
      if (
        current === null
        || typeof current !== "object"
      ) continue;
      if (visited.has(current)) return true;
      visited.add(current);
      if (!Array.isArray(current) && !isTelemetryRecord(current)) return true;
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Array.isArray(current)) {
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0) return true;
        let elementCount = 0;
        for (const key of Reflect.ownKeys(descriptors)) {
          if (key === "length") continue;
          if (
            typeof key !== "string"
            || !/^(?:0|[1-9]\d*)$/u.test(key)
            || Number(key) >= length
          ) return true;
          elementCount += 1;
          const descriptor = descriptors[key];
          if (
            !Object.hasOwn(descriptor, "value")
            || descriptor.enumerable !== true
          ) return true;
          stack.push(descriptor.value);
        }
        if (elementCount !== length) return true;
      } else {
        for (const key of Reflect.ownKeys(descriptors)) {
          if (typeof key !== "string") return true;
          const descriptor = descriptors[key];
          if (
            FORBIDDEN_CONTENT_KEYS.has(normalizedKey(key))
            || !Object.hasOwn(descriptor, "value")
            || descriptor.enumerable !== true
          ) return true;
          stack.push(descriptor.value);
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function assertTelemetryClientBounds(value, {
  maxSerializedBytes = MAX_TELEMETRY_BROWSER_BYTES,
  maxDepth = 12,
  maxArrayItems = 200,
} = {}) {
  if (
    !Number.isSafeInteger(maxSerializedBytes)
    || maxSerializedBytes < 1
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 0
    || !Number.isSafeInteger(maxArrayItems)
    || maxArrayItems < 1
  ) {
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "validation_options_invalid",
      "Telemetry validation limits are invalid.",
    );
  }
  const stack = [{ value, depth: 0 }];
  const visited = new WeakSet();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > maxDepth) {
      telemetryContractFailure(
        "TELEMETRY_RECORD_INVALID",
        "maximum_depth_exceeded",
        "The export is nested too deeply.",
      );
    }
    if (current.value === null) continue;
    const valueType = typeof current.value;
    if (valueType !== "object") {
      if (
        valueType === "undefined"
        || valueType === "function"
        || valueType === "symbol"
        || valueType === "bigint"
        || (
          valueType === "number"
          && !Number.isFinite(current.value)
        )
      ) {
        telemetryContractFailure(
          "TELEMETRY_RECORD_INVALID",
          "non_json_value",
          "The export must contain only JSON values.",
        );
      }
      continue;
    }
    if (visited.has(current.value)) {
      telemetryContractFailure(
        "TELEMETRY_RECORD_INVALID",
        "cyclic_value",
        "The export must be ordinary JSON data.",
      );
    }
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      let descriptors;
      try {
        descriptors = Object.getOwnPropertyDescriptors(current.value);
      } catch {
        telemetryContractFailure(
          "TELEMETRY_RECORD_INVALID",
          "non_json_object",
          "The export must be ordinary JSON data.",
        );
      }
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        telemetryContractFailure(
          "TELEMETRY_RECORD_INVALID",
          "non_json_object",
          "The export must be ordinary JSON data.",
        );
      }
      if (length > maxArrayItems) {
        telemetryContractFailure(
          "TELEMETRY_RECORD_INVALID",
          "maximum_array_items_exceeded",
          "The export contains too many records.",
        );
      }
      let elementCount = 0;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue;
        if (
          typeof key !== "string"
          || !/^(?:0|[1-9]\d*)$/u.test(key)
          || Number(key) >= length
        ) {
          telemetryContractFailure(
            "TELEMETRY_RECORD_INVALID",
            "accessor_or_hidden_field",
            "The export must contain only ordinary enumerable JSON fields.",
          );
        }
        elementCount += 1;
        const descriptor = descriptors[key];
        if (
          !Object.hasOwn(descriptor, "value")
          || descriptor.enumerable !== true
        ) {
          telemetryContractFailure(
            "TELEMETRY_RECORD_INVALID",
            "accessor_or_hidden_field",
            "The export must contain only ordinary enumerable JSON fields.",
          );
        }
        stack.push({
          value: descriptor.value,
          depth: current.depth + 1,
        });
      }
      if (elementCount !== length) {
        telemetryContractFailure(
          "TELEMETRY_RECORD_INVALID",
          "non_json_value",
          "The export must contain only dense JSON arrays.",
        );
      }
      continue;
    }
    if (!isTelemetryRecord(current.value)) {
      telemetryContractFailure(
        "TELEMETRY_RECORD_INVALID",
        "non_json_object",
        "The export must be ordinary JSON data.",
      );
    }
    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current.value);
    } catch {
      telemetryContractFailure(
        "TELEMETRY_RECORD_INVALID",
        "non_json_object",
        "The export must be ordinary JSON data.",
      );
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        telemetryContractFailure(
          "TELEMETRY_RECORD_INVALID",
          "accessor_or_hidden_field",
          "The export must contain only ordinary enumerable JSON fields.",
        );
      }
      const descriptor = descriptors[key];
      if (
        !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
      ) {
        telemetryContractFailure(
          "TELEMETRY_RECORD_INVALID",
          "accessor_or_hidden_field",
          "The export must contain only ordinary enumerable JSON fields.",
        );
      }
      stack.push({
        value: descriptor.value,
        depth: current.depth + 1,
      });
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "serialization_failed",
      "The export must be ordinary JSON data.",
    );
  }
  if (
    typeof serialized !== "string"
    || new TextEncoder().encode(serialized).byteLength > maxSerializedBytes
  ) {
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "maximum_bytes_exceeded",
      "The export is larger than the browser validation limit.",
    );
  }
}

export function telemetryUsdToMicros(value) {
  const [whole = "0", fraction = "000000"] = value.split(".");
  return (BigInt(whole) * 1_000_000n) + BigInt(fraction);
}
