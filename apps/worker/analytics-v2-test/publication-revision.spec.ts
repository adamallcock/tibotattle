// REV-SEED: the one published-revision computation (store-publication.ts
// nextPublishedRevision, max(head, floor, seed) + 1) and the static ratchet
// that keeps it the only one. Every publishing path (today the full-mode
// write; later K-INCR-MODE's incremental write, K-REPRICE and the offline
// purge's republish) must call it, so a Cloudflare revision floor can never be
// bypassed by a second computation. Pure: no database.
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

describe("the static ratchet: one published-revision computation", () => {
  const files = sources();

  it("scans the analytics_v2 sources and the refresh Job", () => {
    expect(files).toContain(join("src", "analytics-v2", "store-publication.ts"));
    expect(files).toContain(join("cloud-run", "analytics-refresh.mjs"));
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

  it("writes and stamps published heads only in store-publication.ts, through the helper", () => {
    const writer = new RegExp(`(INSERT\\s+INTO|UPDATE)\\s+\\$\\{relation\\(schema,\\s*(tables|ANALYTICS_V2_TABLES)\\.publishedDaily\\)|`
      + `(INSERT\\s+INTO|UPDATE)\\s+[^\\n]*${ANALYTICS_V2_TABLES.publishedDaily}`, "u");
    const writes = files.filter((file) => codeLines(join(WORKER_ROOT, file)).some((line) => writer.test(line)));
    expect(writes).toEqual([join("src", "analytics-v2", "store-publication.ts")]);
    const stamps = files.filter((file) => codeLines(join(WORKER_ROOT, file))
      .some((line) => /stampAnalyticsV2DailyPayload\(/u.test(line) && !/export (async )?function stampAnalyticsV2DailyPayload/u.test(line)));
    expect(stamps).toEqual([join("src", "analytics-v2", "store-publication.ts")]);
    const publication = readFileSync(join(WORKER_ROOT, "src", "analytics-v2", "store-publication.ts"), "utf8");
    expect(publication).toMatch(/const revision = nextPublishedRevision\(\{ head: head\?\.revision, floor: floors\.get\(candidate\.day\),/u);
  });
});
