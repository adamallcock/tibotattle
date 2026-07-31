import Ajv from "ajv";

import activityMarkerSchema from "../../schemas/telemetry-v0.1/activity-marker.schema.json" with { type: "json" };
import bundleSchema from "../../schemas/telemetry-v0.1/bundle.schema.json" with { type: "json" };
import compatibilitySchema from "../../schemas/telemetry-v0.1/compatibility.schema.json" with { type: "json" };
import privacyReceiptSchema from "../../schemas/telemetry-v0.1/privacy-receipt.schema.json" with { type: "json" };
import quotaSnapshotSchema from "../../schemas/telemetry-v0.1/quota-snapshot.schema.json" with { type: "json" };
import usageEventSchema from "../../schemas/telemetry-v0.1/usage-event.schema.json" with { type: "json" };

const schemas = Object.freeze({
  compatibility: compatibilitySchema,
  usageEvent: usageEventSchema,
  quotaSnapshot: quotaSnapshotSchema,
  activityMarker: activityMarkerSchema,
  bundle: bundleSchema,
  privacyReceipt: privacyReceiptSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true });
const UTC_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

ajv.addFormat("date-time", {
  type: "string",
  validate(value) {
    const match = UTC_DATE_TIME_PATTERN.exec(value);
    if (!match) return false;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return false;
    const normalized = [
      match[1],
      "-",
      match[2],
      "-",
      match[3],
      "T",
      match[4],
      ":",
      match[5],
      ":",
      match[6],
      ".",
      match[7] ?? "000",
      "Z",
    ].join("");
    return parsed.toISOString() === normalized;
  },
});

for (const schema of Object.values(schemas)) ajv.addSchema(schema);

const validators = Object.freeze(Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [
    name,
    ajv.getSchema(schema.$id),
  ]),
));

function safeValidationErrors(errors = []) {
  return errors.slice(0, 20).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  }));
}

export function validateExportRecord(name, value) {
  const validate = validators[name];
  if (!validate) throw new Error(`Unknown export schema: ${name}`);
  const valid = validate(value);
  return {
    valid,
    errors: valid ? [] : safeValidationErrors(validate.errors),
  };
}

export function assertValidExportRecord(name, value) {
  const result = validateExportRecord(name, value);
  if (!result.valid) {
    const summary = result.errors
      .map((error) => `${error.path}:${error.keyword}`)
      .join(", ");
    throw new Error(
      `Privacy export ${name} failed schema validation (${summary})`,
    );
  }
  return value;
}

export { schemas as exportSchemas };
