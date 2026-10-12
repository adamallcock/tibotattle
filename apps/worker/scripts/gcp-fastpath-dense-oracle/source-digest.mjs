// Content digest of a SQLite source: every table's rows in a total order,
// read through a private read-only connection. Two files with the same digest
// hold the same rows, whatever their page layout.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function sourceContentDigest(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const hash = createHash("sha256");
    for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const columns = database.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name).map((row) => `"${row.name}"`);
      const statement = database.prepare(`SELECT ${columns.join(",")} FROM "${name}" ORDER BY ${columns.join(",")}`);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      hash.update(`${name}\n`);
      for (const row of statement.iterate()) hash.update(JSON.stringify(row, (_, value) => typeof value === "bigint" ? `${value}n`
        : value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value));
    }
    return hash.digest("hex");
  } finally { database.close(); }
}

/** Usage records per owner digest and observed day, from the v1.1 and v1.2 chunk headers (work weights only). */
export function usageRowsByOwnerDay(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare(`SELECT l.owner_digest AS owner, c.chunk_day AS day, SUM(c.record_count) AS n
      FROM (SELECT participant_id, chunk_day, record_count FROM telemetry_v12_chunks WHERE stream='usage'
            UNION ALL SELECT participant_id, chunk_day, record_count FROM telemetry_v11_chunks WHERE stream='usage') c
      JOIN storage_v11_owner_links l ON l.participant_id=c.participant_id AND l.state='active'
      GROUP BY 1,2`).all();
    const out = new Map();
    for (const row of rows) {
      if (!out.has(row.owner)) out.set(row.owner, new Map());
      out.get(row.owner).set(row.day, Number(row.n));
    }
    return out;
  } finally { database.close(); }
}
