/**
 * Return whether a value's enumerable own string keys exactly match `expected`.
 *
 * `Object.keys` deliberately defines the key surface here: inherited,
 * non-enumerable, and symbol properties are outside the persisted-document
 * shape contract.
 */
export function hasExactEnumerableKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length
    && actual.every((key, index) => key === required[index]);
}
