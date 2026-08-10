import test from "node:test";
import assert from "node:assert/strict";
import { safeValidationErrors } from "../src/safe-validation-errors.js";

test("safe validation errors retain only the fixed privacy-safe shape", () => {
  const result = safeValidationErrors([
    {
      instancePath: "",
      keyword: "required",
      schemaPath: "#/required",
      message: "/private/workspace/DO_NOT_EXPOSE",
      params: { missingProperty: "privateField" },
      data: { privateField: "PRIVATE_VALUE" },
    },
    {
      instancePath: "/items/0",
      keyword: "type",
      schemaPath: "#/properties/items/items/type",
      message: "private validator detail",
      extra: "PRIVATE_EXTRA",
    },
  ]);

  assert.deepEqual(result, [
    { path: "/", keyword: "required", schemaPath: "#/required" },
    {
      path: "/items/0",
      keyword: "type",
      schemaPath: "#/properties/items/items/type",
    },
  ]);
  assert.deepEqual(Object.keys(result[0]).sort(), ["keyword", "path", "schemaPath"]);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("safe validation errors preserve order and cap output at twenty entries", () => {
  const errors = Array.from({ length: 25 }, (_, index) => ({
    instancePath: `/items/${index}`,
    keyword: `keyword-${index}`,
    schemaPath: `#/items/${index}`,
  }));

  const result = safeValidationErrors(errors);

  assert.equal(result.length, 20);
  assert.equal(result[0].keyword, "keyword-0");
  assert.equal(result.at(-1).keyword, "keyword-19");
  assert.deepEqual(result.map((error) => error.path), errors.slice(0, 20).map((error) => error.instancePath));
});
