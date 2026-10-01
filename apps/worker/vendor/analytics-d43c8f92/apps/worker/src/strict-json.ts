import {
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser";

import {
  ApiError,
  type ErrorCode,
} from "./errors";

function invalid(code: ErrorCode): never {
  throw new ApiError(400, code);
}

function assertNoDuplicateKeys(
  root: Node,
  errorCode: ErrorCode,
): void {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "object") {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const [name, child] = property.children ?? [];
        if (
          property.type !== "property"
          || property.children?.length !== 2
          || name?.type !== "string"
          || typeof name.value !== "string"
          || child === undefined
          || names.has(name.value)
        ) {
          invalid(errorCode);
        }
        names.add(name.value);
        stack.push(child);
      }
      continue;
    }
    if (node.type === "array") {
      stack.push(...(node.children ?? []));
    }
  }
}

/**
 * Parse one strict JSON value while preserving the security significance of
 * duplicate object keys.
 *
 * Native JSON.parse keeps only the last value, which can hide an earlier
 * privacy canary from closed-schema validation. The tree pass rejects all
 * duplicates before native parsing and never places source text in an error.
 */
export function parseStrictJson(
  raw: string,
  errorCode: ErrorCode = "BODY_INVALID",
): unknown {
  if (typeof raw !== "string") {
    throw new TypeError("raw must be a string");
  }
  const errors: ParseError[] = [];
  const root = parseTree(raw, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!root || errors.length > 0) invalid(errorCode);
  assertNoDuplicateKeys(root, errorCode);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return invalid(errorCode);
  }
}
