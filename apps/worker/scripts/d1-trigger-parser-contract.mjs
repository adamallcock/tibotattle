// Cloudflare D1's remote migration endpoint can terminate a CREATE TRIGGER
// early at a bare `SELECT CASE ... END;`. SQLite accepts both forms, so keep
// this source check independent of local migration execution.
export const FRESH_D1_ROLE_MIGRATION_DIRECTORIES = Object.freeze([
  "migrations",
  "ingestion-routing-migrations",
  "typed-ingestion-migrations",
  "routing-migrations",
  "analytics-migrations",
  "deletion-ledger-migrations",
  "ingestion-bridge-migrations",
  "ingestion-isolation-migrations",
  "typed-v1-admission-migrations",
  "typed-v11-admission-migrations",
]);

function tokens(sql) {
  const result = [];
  let index = 0;
  const quoted = (quote, closing = quote) => {
    index++;
    while (index < sql.length) {
      if (sql[index] === closing) {
        if (closing !== "]" && sql[index + 1] === closing) index += 2;
        else { index++; break; }
      } else index++;
    }
  };
  while (index < sql.length) {
    const start = index, char = sql[index];
    if (/\s/u.test(char)) { index++; continue; }
    if (char === "-" && sql[index + 1] === "-") {
      index += 2; while (index < sql.length && sql[index] !== "\n") index++; continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2; while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index++;
      index = Math.min(sql.length, index + 2); continue;
    }
    if (char === "'" || char === '"' || char === "`") { quoted(char); continue; }
    if (char === "[") { quoted("[", "]"); continue; }
    if (/[A-Za-z_]/u.test(char)) {
      index++; while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index])) index++;
      result.push({ kind: "word", value: sql.slice(start, index).toUpperCase(), start, end: index });
      continue;
    }
    index++;
    result.push({ kind: "symbol", value: char, start, end: index });
  }
  return result;
}

function triggerRanges(allTokens) {
  const ranges = [];
  for (let index = 0; index < allTokens.length; index++) {
    if (allTokens[index].value !== "CREATE") continue;
    let cursor = index + 1;
    if (["TEMP", "TEMPORARY"].includes(allTokens[cursor]?.value)) cursor++;
    if (allTokens[cursor]?.value !== "TRIGGER") continue;
    while (cursor < allTokens.length && allTokens[cursor].value !== "BEGIN") cursor++;
    if (cursor === allTokens.length) continue;
    const bodyStart = cursor + 1;
    let caseDepth = 0;
    for (cursor = bodyStart; cursor < allTokens.length; cursor++) {
      const value = allTokens[cursor].value;
      if (value === "CASE") caseDepth++;
      else if (value === "END" && caseDepth > 0) caseDepth--;
      else if (value === "END" && allTokens[cursor + 1]?.value === ";") {
        ranges.push([bodyStart, cursor]); index = cursor + 1; break;
      }
    }
  }
  return ranges;
}

function lineAndColumn(sql, offset) {
  const prefix = sql.slice(0, offset), lineStart = prefix.lastIndexOf("\n");
  return { line: 1 + (prefix.match(/\n/gu) ?? []).length, column: offset - lineStart };
}

export function findBareCompleteTriggerCases(sql) {
  const allTokens = tokens(sql), found = [];
  for (const [start, end] of triggerRanges(allTokens)) {
    for (let index = start; index < end; index++) {
      if (allTokens[index].value !== "SELECT" || allTokens[index + 1]?.value !== "CASE") continue;
      const caseEnd = completeCaseEnd(allTokens, index + 1);
      if (caseEnd < 0 || allTokens[caseEnd + 1]?.value !== ";") continue;
      const location = lineAndColumn(sql, allTokens[index].start);
      found.push({ ...location, offset: allTokens[index].start });
    }
  }
  return found;
}

function completeCaseEnd(allTokens, caseIndex) {
  let depth = 0;
  for (let index = caseIndex; index < allTokens.length; index++) {
    if (allTokens[index].value === "CASE") depth++;
    else if (allTokens[index].value === "END" && --depth === 0) return index;
  }
  return -1;
}

export function normalizeCompleteTriggerCaseWrappers(sql) {
  const allTokens = tokens(sql), removals = [];
  for (const [start, end] of triggerRanges(allTokens)) {
    for (let index = start; index < end; index++) {
      if (allTokens[index].value !== "SELECT" || allTokens[index + 1]?.value !== "(" || allTokens[index + 2]?.value !== "CASE") continue;
      const caseEnd = completeCaseEnd(allTokens, index + 2);
      if (caseEnd >= 0 && allTokens[caseEnd + 1]?.value === ")" && allTokens[caseEnd + 2]?.value === ";") {
        removals.push(allTokens[index + 1].start, allTokens[caseEnd + 1].start);
      }
    }
  }
  for (const offset of removals.sort((left, right) => right - left)) sql = `${sql.slice(0, offset)}${sql.slice(offset + 1)}`;
  return sql;
}
