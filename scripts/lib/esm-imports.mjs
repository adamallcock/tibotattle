import { parse as parseTypeScript } from "@babel/parser";
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

function literalSpecifier(argument) {
  if (argument?.extra?.parenthesized) return null;
  if (argument?.type === "StringLiteral") return argument.value;
  if (argument?.type === "TemplateLiteral" && argument.expressions.length === 0) {
    return argument.quasis[0].value.cooked ?? null;
  }
  return null;
}

function extractTypeScriptImports(source, sourceName) {
  const ast = parseTypeScript(source, {
    attachComment: false,
    allowUndeclaredExports: true,
    createImportExpressions: true,
    plugins: [["typescript", { dts: /\.d\.(?:ts|mts|cts)$/u.test(sourceName) }]],
    sourceType: "unambiguous",
  });
  const imports = [];
  const pending = [ast.program];
  const record = (node, kind, argument) => {
    imports.push({
      kind,
      line: node.loc.start.line,
      specifier: literalSpecifier(argument),
      statementEnd: node.end,
      statementStart: node.start,
    });
  };
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === "ImportDeclaration") {
      record(node, "import", node.source);
    } else if ((node.type === "ExportNamedDeclaration"
        || node.type === "ExportAllDeclaration") && node.source) {
      record(node, "export-from", node.source);
    } else if (node.type === "ImportExpression") {
      record(node, "dynamic-import", node.source);
    } else if (node.type === "TSImportType") {
      record(node, "import", node.argument);
    } else if (node.type === "TSImportEqualsDeclaration"
        && node.moduleReference.type === "TSExternalModuleReference") {
      record(node, "import", node.moduleReference.expression);
    }
    // Walk syntax nodes only. Retaining the typed AST keeps erased type-only
    // imports and declaration-file dependencies in the inspected closure.
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const element of child) {
          if (element && typeof element.type === "string") pending.push(element);
        }
      } else if (child && typeof child.type === "string") {
        pending.push(child);
      }
    }
  }
  return imports.sort((left, right) => left.statementStart - right.statementStart);
}

/**
 * Extract ESM dependency syntax without executing or transforming source.
 * Dynamic imports are retained even when their specifier is not a literal so
 * security-sensitive callers can fail closed. import.meta is not a dependency
 * edge and is intentionally omitted. Typed sources are parsed as TypeScript
 * when sourceName ends in .ts, .mts, or .cts, including declaration files.
 */
export async function extractEsmImports(source, {
  sourceName = "<anonymous>",
} = {}) {
  let imports;
  try {
    if (/\.(?:ts|mts|cts)$/u.test(sourceName)) {
      return extractTypeScriptImports(source, sourceName);
    }
    await init;
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
