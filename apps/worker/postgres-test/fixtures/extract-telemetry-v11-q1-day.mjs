#!/usr/bin/env node
/**
 * Extract one owner-day of the Q-1 production-code oracle (d43c8f92 D1, typed
 * v1.1 admission) into a small committed fixture for
 * postgres-telemetry-v11-live.spec.mjs (GCP fast path, IN-2).
 *
 *   node postgres-test/fixtures/extract-telemetry-v11-q1-day.mjs \
 *     <q1 usage-monitor-db.json dump> <q1 corpus.json> <owner key> <day> <output.json>
 *
 * The corpus and dump are synthetic and content-free (generate-corpus.mjs,
 * seed gcp-fastpath-oracle-2026-10-01). The fixture holds the day's input
 * records exactly as the oracle uploaded them and the id-free row shape the
 * oracle wrote for them (telemetry-v11-row-shape.mjs). Test-only.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { d1DumpRows, telemetryV11DayShape, TELEMETRY_V11_SHAPE_TABLES } from "./telemetry-v11-row-shape.mjs";

const PARSER_VERSION = "synthetic-gcp-oracle-v11";

function typedIdHex(value) {
  // encodeTypedTelemetryId for the 'participant:' UUID form (prefix byte 2).
  const match = /^participant:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(value);
  if (!match) throw new Error("participant id is not the participant UUID form");
  return "02" + match[1].replaceAll("-", "");
}

const [dumpPath, corpusPath, ownerKey, day, outputPath] = process.argv.slice(2);
if (!dumpPath || !corpusPath || !ownerKey || !day || !outputPath) {
  console.error("usage: extract-telemetry-v11-q1-day.mjs <dump> <corpus.json> <owner> <day> <output>");
  process.exit(2);
}
const dump = JSON.parse(await readFile(dumpPath, "utf8"));
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
if (dump.header?.synthetic !== true || corpus.synthetic !== true) throw new Error("only synthetic oracle inputs");
const owner = corpus.owners.find((entry) => entry.key === ownerKey);
if (!owner) throw new Error("owner not in corpus");
const shard = JSON.parse(await readFile(join(dirname(corpusPath), corpus.shards[ownerKey]), "utf8"));
const corpusDay = shard.days.find((entry) => entry.day === day);
if (!corpusDay || corpusDay.format !== "v11" || corpusDay.v1Extra) throw new Error("day is not a plain v1.1 day");

const tables = Object.fromEntries(TELEMETRY_V11_SHAPE_TABLES.map((name) => {
  const table = dump.tables.find((entry) => entry.name === name);
  if (!table) throw new Error("dump lacks " + name);
  return [name, d1DumpRows(table)];
}));
const ownerOriginalHex = typedIdHex(owner.participantId);
const expected = telemetryV11DayShape(tables, { participantId: owner.participantId, day, ownerOriginalHex });

await writeFile(outputPath, JSON.stringify({
  schemaVersion: "telemetry-v11-live-q1-day-v1",
  synthetic: true,
  source: {
    oracle: dump.header.oracle,
    sourceCommit: dump.header.sourceCommit,
    corpusSeed: corpus.seed,
    owner: ownerKey,
    ownerKind: owner.kind,
  },
  participantId: owner.participantId,
  ownerOriginalHex,
  day,
  parserVersion: PARSER_VERSION,
  records: corpusDay.records,
  expected,
}, null, 1) + "\n", { flag: "wx" });
console.log(JSON.stringify({ wrote: outputPath, chunks: expected.chunks.length,
  records: expected.chunks.reduce((total, chunk) => total + chunk.records.length, 0) }));
