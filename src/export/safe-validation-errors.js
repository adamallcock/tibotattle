export function safeValidationErrors(errors = []) {
  return errors.slice(0, 20).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  }));
}
