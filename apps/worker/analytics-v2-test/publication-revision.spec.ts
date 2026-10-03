// REV-SEED: the one published-revision computation (store-publication.ts
// nextPublishedRevision, max(head, floor, seed) + 1) and the static ratchets
// around it. Every publishing path (today the full-mode write; later
// K-INCR-MODE's incremental write, K-REPRICE and the offline purge's
// republish) must call it, so a Cloudflare revision floor is not bypassed by
// a second computation. Pure: no database.
//
// What the ratchets cover, exactly:
// - revision arithmetic (revision + 1, a max over revisions) only inside
//   nextPublishedRevision, scanned over src/analytics-v2 and the refresh
//   Job's cloud-run/analytics-refresh*.mjs (elsewhere "revision" names other
//   things: seal, owner and schema revisions);
// - a write of the published heads (INSERT INTO, UPDATE or MERGE INTO naming
//   analytics_v2_published_daily, literally or through a constant or property
//   bound to that name anywhere in the tree) and a call of
//   stampAnalyticsV2DailyPayload only in store-publication.ts, scanned over
//   EVERY non-test Worker source (src, cloud-run, scripts, migrations,
//   vendor; tracked or untracked, never ignored output), so a purge or
//   republish tool under scripts/ cannot write a head beside the helper.
// A statement whose table name is assembled at run time from a list (a
// generic copier) escapes any static scan; the database is the authority
// there: 0059's forward-only trigger and REV-SEED's separate
// analytics_v2_published_daily_above_floor trigger refuse a head that moves
// backwards or sits at or below its day's floor, whoever writes it.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYTICS_V2_TABLES } from "../src/analytics-v2/contract";
import { nextPublishedRevision } from "../src/analytics-v2/store";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("nextPublishedRevision", () => {
  it("is one above the head, the floor and the seed, whichever is largest", () => {
    expect(nextPublishedRevision({ seed: 0 })).toBe(1);
    expect(nextPublishedRevision({ head: null, floor: null, seed: 0 })).toBe(1);
    expect(nextPublishedRevision({ head: 4, seed: 0 })).toBe(5);
    expect(nextPublishedRevision({ floor: 4, seed: 0 })).toBe(5);
    expect(nextPublishedRevision({ head: 2, floor: 9, seed: 3 })).toBe(10);
    expect(nextPublishedRevision({ head: 12, floor: 9, seed: 3 })).toBe(13);
    expect(nextPublishedRevision({ head: 2, floor: 9, seed: 40 })).toBe(41);
    expect(nextPublishedRevision({ floor: 2_000_000_000, seed: 0 })).toBe(2_000_000_001);
  });

  it("refuses anything but non-negative safe integers", () => {
    for (const input of [{ head: -1, seed: 0 }, { floor: 1.5, seed: 0 }, { seed: Number.NaN },
      { head: Number.MAX_SAFE_INTEGER + 1, seed: 0 }, { seed: -2 }]) {
      expect(() => nextPublishedRevision(input as never)).toThrow(expect.objectContaining({ code: "ANALYTICS_V2_STATE_INVALID" }));
    }
  });
});

/** The code of a file without its comments, line by line (enough for this ratchet's patterns). */
function codeLines(path: string): string[] {
  const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "));
  return text.split("\n").map((line) => line.replace(/(^|[^:"'`])\/\/.*$/u, "$1"));
}

function sources(): string[] {
  const analytics = readdirSync(join(WORKER_ROOT, "src", "analytics-v2"))
    .filter((name) => name.endsWith(".ts")).map((name) => join("src", "analytics-v2", name));
  const job = readdirSync(join(WORKER_ROOT, "cloud-run"))
    .filter((name) => /^analytics-refresh.*\.mjs$/u.test(name) && !name.endsWith(".check.mjs"))
    .map((name) => join("cloud-run", name));
  return [...analytics, ...job].sort();
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|sql)$/u;
const TEST_FILE = /\.(?:spec|check|test)\.[cm]?[jt]s$/u;
const TEST_DIRECTORIES = new Set(["analytics-v2-test", "postgres-test", "test", "gcp-test"]);

/** Every non-test Worker source, tracked or untracked but never ignored (node_modules, cloud-run/dist). */
function workerSources(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
    { cwd: WORKER_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listed.split("\0").filter((path) => path.length > 0 && SOURCE_FILE.test(path) && !TEST_FILE.test(path)
    && !TEST_DIRECTORIES.has(path.split("/")[0])).sort();
}

/** A file's code without its comments (block, line and SQL line comments); null once deleted from the tree. */
function codeOf(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(WORKER_ROOT, path), "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
    throw error;
  }
  const blank = (block: string) => block.replace(/[^\n]/gu, " ");
  text = text.replace(/\/\*[\s\S]*?\*\//gu, blank);
  return path.endsWith(".sql")
    ? text.replace(/--[^\n]*/gu, blank)
    : text.split("\n").map((line) => line.replace(/(^|[^:"'`])\/\/.*$/u, "$1")).join("\n");
}

const PUBLISHED_DAILY = ANALYTICS_V2_TABLES.publishedDaily;
const ESCAPE = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * The names the published-heads table goes by across the tree: the literal,
 * every constant bound to it (as an identifier) and every property bound to
 * it (as `.name`).
 */
function publishedDailyNames(texts: string[]): RegExp[] {
  const literal = ESCAPE(PUBLISHED_DAILY);
  const constants = new Set<string>();
  const properties = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*["'\`]${literal}["'\`]`, "gu"))) {
      constants.add(match[1]);
    }
    for (const match of text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*["'\`]${literal}["'\`]`, "gu"))) {
      properties.add(match[1]);
    }
  }
  return [new RegExp(`${literal}(?![A-Za-z0-9_])`, "u"), ...[...constants].map((name) => new RegExp(`(?<![\\w$.])${ESCAPE(name)}(?![\\w$])`, "u")),
    ...[...properties].map((name) => new RegExp(`\\.${ESCAPE(name)}(?![\\w$])`, "u"))];
}

/**
 * The relations a text writes: what directly follows INSERT INTO, UPDATE or
 * MERGE INTO (any case, across line breaks), a run of interpolations and
 * non-space characters. A trigger, grant or policy clause (UPDATE OR ...,
 * UPDATE ON ...) names no relation there.
 */
function writtenRelations(text: string): string[] {
  return [...text.matchAll(/\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO)\s+(?:ONLY\s+)?((?:\$\{[^}]*\}|[^\s(,;])+)/giu)]
    .map((match) => match[1]);
}

function writesPublishedDaily(text: string, names: RegExp[]): boolean {
  return writtenRelations(text).some((relation) => names.some((name) => name.test(relation)));
}

describe("the static ratchets: one published-revision computation, one writer of the heads", () => {
  const files = sources();
  const tree = workerSources();
  const texts = new Map(tree.map((path) => [path, codeOf(path)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null));
  const names = publishedDailyNames([...texts.values()]);

  it("scans the analytics_v2 sources and the refresh Job for arithmetic, and every non-test Worker source for writers", () => {
    expect(files).toContain(join("src", "analytics-v2", "store-publication.ts"));
    expect(files).toContain(join("cloud-run", "analytics-refresh.mjs"));
    for (const path of [...files, join("scripts", "local-owner-erasure.mjs"), join("scripts", "cutover-revision-floor.mjs"),
      join("scripts", "postgres-production-transfer.mjs"), join("postgres", "migrations", "primary", "0059_analytics_v2.sql")]) {
      expect(texts.has(path), path).toBe(true);
    }
    expect(tree.some((path) => TEST_FILE.test(path) || path.startsWith("node_modules/") || path.includes("/dist/"))).toBe(false);
    // The names it knows the table by include every binding in the tree today.
    const sources = names.map((name) => name.source);
    for (const expected of ["\\.publishedDaily(?![\\w$])", "\\.published(?![\\w$])", "(?<![\\w$.])PUBLISHED_DAILY_TABLE(?![\\w$])",
      "(?<![\\w$.])PUBLISHED_TABLE(?![\\w$])"]) {
      expect(sources).toContain(expected);
    }
  });

  it("detects a head writer however the table is named, and only a writer", () => {
    const known = publishedDailyNames(["const HEADS = 'analytics_v2_published_daily';", "const t = { heads: \"analytics_v2_published_daily\" };"]);
    for (const writer of [
      "INSERT INTO analytics_v2_published_daily (day) VALUES ($1)",
      "await q(`update ${s}.\"analytics_v2_published_daily\" SET revision = $1`)",
      "`INSERT INTO\n  ${quote(schema)}.${HEADS} (day, revision)`",
      "`UPDATE ${table(t.heads)} SET revision = revision + 1`",
      "`INSERT INTO ${relation(schema, tables.heads)} AS head`",
      "MERGE INTO \"x\".analytics_v2_published_daily AS head USING src ON true",
    ]) {
      expect(writesPublishedDaily(writer, known), writer).toBe(true);
    }
    for (const other of [
      "CREATE TRIGGER t BEFORE UPDATE OR DELETE ON analytics_v2_published_daily FOR EACH ROW",
      "BEFORE INSERT OR UPDATE ON analytics_v2_published_daily",
      "GRANT SELECT, INSERT, UPDATE ON analytics_v2_published_daily TO runtime",
      "SELECT count(*) FROM analytics_v2_published_daily",
      "INSERT INTO other_table SELECT day FROM analytics_v2_published_daily",
      "ON CONFLICT (day) DO UPDATE SET revision = EXCLUDED.revision",
      "hash.update(HEADS)",
    ]) {
      expect(writesPublishedDaily(other, known), other).toBe(false);
    }
  });

  it("computes a revision (revision + 1, or a max over revisions) only in nextPublishedRevision", () => {
    const arithmetic = /[Rr]evision[A-Za-z]*(?:\?\.[A-Za-z]+)*\)?\s*\+\s*1\b|Math\.max\([^)]*[Rr]evision|\+\+\s*[A-Za-z.]*[Rr]evision|[Rr]evision\s*\+=/u;
    const found = files.flatMap((file) => codeLines(join(WORKER_ROOT, file))
      .flatMap((line, index) => (arithmetic.test(line) ? [`${file}:${index + 1}`] : [])));
    // compute-community.ts builds a candidate with a placeholder revision
    // (revisionSeed + 1) that the store always replaces when it stamps the
    // published payload; it never reaches a published row.
    expect(found.filter((at) => !at.startsWith(join("src", "analytics-v2", "store-publication.ts"))))
      .toEqual([expect.stringMatching(/^src\/analytics-v2\/compute-community\.ts:\d+$/u)]);
    const helper = codeLines(join(WORKER_ROOT, "src", "analytics-v2", "store-publication.ts"));
    const helperStart = helper.findIndex((line) => line.includes("export function nextPublishedRevision("));
    const helperEnd = helper.findIndex((line, index) => index > helperStart && line.startsWith("}"));
    expect(helperStart).toBeGreaterThan(-1);
    for (const at of found.filter((item) => item.startsWith(join("src", "analytics-v2", "store-publication.ts")))) {
      const line = Number(at.split(":").at(-1)) - 1;
      expect(line > helperStart && line < helperEnd, at).toBe(true);
    }
  });

  it("writes and stamps published heads only in store-publication.ts, through the helper, across the whole Worker", () => {
    const writes = [...texts].filter(([, text]) => writesPublishedDaily(text, names)).map(([path]) => path);
    expect(writes).toEqual([join("src", "analytics-v2", "store-publication.ts")]);
    const stamps = [...texts].filter(([, text]) => text.split("\n")
      .some((line) => /stampAnalyticsV2DailyPayload\(/u.test(line) && !/export (async )?function stampAnalyticsV2DailyPayload/u.test(line)))
      .map(([path]) => path);
    expect(stamps).toEqual([join("src", "analytics-v2", "store-publication.ts")]);
    const publication = readFileSync(join(WORKER_ROOT, "src", "analytics-v2", "store-publication.ts"), "utf8");
    expect(publication).toMatch(/const revision = nextPublishedRevision\(\{ head: head\?\.revision, floor: floors\.get\(candidate\.day\),/u);
  });
});
