/** Compare content-free K-PGSTAT family ledgers after coordinator measurement. */
import { readFile } from "node:fs/promises";
const families = ["occurrences.legacy_sources", "occurrences.v12_sources", "occurrences.correction_sources"];
const read = async (file) => {
  const value = JSON.parse(await readFile(file, "utf8"));
  const ledger = value.steps?.refresh?.reads?.statements?.families;
  if (!ledger || typeof ledger !== "object") throw new Error("READ_EXPANSION_LEDGER_INVALID");
  return Object.fromEntries(families.map((family) => {
    const row = ledger[family];
    if (row === undefined) return [family, { calls: 0, wallMs: 0, rows: 0, bytes: 0 }];
    const fields = {};
    for (const key of ["calls", "wallMs", "rows", "bytes"]) {
      const metric = row[key];
      if (key === "bytes" && metric === null) { fields[key] = null; continue; }
      if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
        throw new Error("READ_EXPANSION_LEDGER_INVALID");
      }
      fields[key] = metric;
    }
    return [family, fields];
  }));
};
if (process.argv.length !== 4) throw new Error("READ_EXPANSION_LEDGER_ARGUMENTS");
console.log(JSON.stringify({ status: "ok", before: await read(process.argv[2]), after: await read(process.argv[3]) }));
