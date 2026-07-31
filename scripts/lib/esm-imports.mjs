import { init, parse } from "es-module-lexer";

function sourceLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineNumberAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Extract ESM dependency syntax without executing or transforming source.
 * Dynamic imports are retained even when their specifier is not a literal so
 * security-sensitive callers can fail closed. import.meta is not a dependency
 * edge and is intentionally omitted.
 */
export async function extractEsmImports(source, {
  sourceName = "<anonymous>",
} = {}) {
  await init;

  let imports;
  try {
    [imports] = parse(source, sourceName);
  } catch (error) {
    throw new SyntaxError(
      `Unable to inspect ESM imports in ${sourceName}: ${error.message}`,
      {
        cause: error,
      },
    );
  }

  const lineStarts = sourceLineStarts(source);
  return imports
    .filter(
      ({ d: dynamicImportOffset, n: specifier }) =>
        dynamicImportOffset >= 0 || typeof specifier === "string",
    )
    .map((record) => {
      const statementPrefix = source.slice(record.ss, record.s).trimStart();
      return {
        kind:
          record.d >= 0
            ? "dynamic-import"
            : statementPrefix.startsWith("export")
              ? "export-from"
              : "import",
        line: lineNumberAt(lineStarts, record.ss),
        specifier: record.n ?? null,
        statementEnd: record.se,
        statementStart: record.ss,
      };
    });
}
