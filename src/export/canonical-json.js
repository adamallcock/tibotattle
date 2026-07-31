function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]),
  );
}

export function stableJson(value) {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}
