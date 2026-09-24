import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { comparePublicGraphBenchmarkReceipts } from "./public-graph-benchmark.mjs";

export async function checkPublicGraphBenchmarkFiles(paths) {
  if (!Array.isArray(paths) || paths.length !== 2 || paths.some((path) => typeof path !== "string" || path.length === 0)) {
    throw new TypeError("usage: node public-graph-benchmark-compare.mjs <d1-receipt.json> <postgres-receipt.json>");
  }
  const receipts = await Promise.all(paths.map(async (path) => {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1_048_576) throw new TypeError("receipt file exceeds the 1 MiB limit");
    const value = JSON.parse(await readFile(path, "utf8"));
    return value;
  }));
  return comparePublicGraphBenchmarkReceipts(receipts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await checkPublicGraphBenchmarkFiles(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("public graph receipts are missing, malformed, or not comparable\n");
    process.exitCode = 1;
  }
}
