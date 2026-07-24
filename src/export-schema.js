import Ajv from "ajv";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const schemas = Object.freeze({
  usageEvent: require("../schemas/telemetry-v0.1/usage-event.schema.json"),
  quotaSnapshot: require("../schemas/telemetry-v0.1/quota-snapshot.schema.json"),
  activityMarker: require("../schemas/telemetry-v0.1/activity-marker.schema.json"),
  bundle: require("../schemas/telemetry-v0.1/bundle.schema.json"),
  privacyReceipt: require("../schemas/telemetry-v0.1/privacy-receipt.schema.json"),
});

const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
    return Number.isFinite(Date.parse(value));
  },
});

for (const schema of Object.values(schemas)) ajv.addSchema(schema);

const validators = Object.freeze(Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.getSchema(schema.$id)]),
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
  return { valid, errors: valid ? [] : safeValidationErrors(validate.errors) };
}

export function assertValidExportRecord(name, value) {
  const result = validateExportRecord(name, value);
  if (!result.valid) {
    const summary = result.errors.map((error) => `${error.path}:${error.keyword}`).join(", ");
    throw new Error(`Privacy export ${name} failed schema validation (${summary})`);
  }
  return value;
}

export { schemas as exportSchemas };
