/** GCP-only import binding. Vendor generation and independent oracle builds never use it. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FAST_PRICER_CONSUMER = resolve(ROOT, "vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v1.ts");
export const FAST_PRICER_MODULE = resolve(ROOT, "src/analytics-v2/fast-pricer.ts");
export const FAST_PRICER_BINDING_POLICY = fileURLToPath(import.meta.url);

/** Only this reviewed edge is rebound; entry.ts continues to export the original oracle. */
export function fastPricerImport(source, importer) {
  const path = importer?.split("?")[0].replace(/^\/@fs/u, "");
  return source === "./server-pricing" && path === FAST_PRICER_CONSUMER ? FAST_PRICER_MODULE : null;
}

export function analyticsFastPricerPlugin() {
  return { name: "analytics-v2-fast-pricer", setup(build) {
    build.onResolve({ filter: /^\.\/server-pricing$/ }, (args) => {
      const path = fastPricerImport(args.path, args.importer);
      return path === null ? null : { path };
    });
  } };
}

/** File-set hashing alone cannot distinguish the bound and unbound import graph. */
export function assertAnalyticsFastPricerBinding(metafile, cwd) {
  const entry = Object.entries(metafile.inputs).find(([path]) => resolve(cwd, path) === FAST_PRICER_CONSUMER);
  const edge = entry?.[1].imports.find((item) => item.original === "./server-pricing");
  if (!edge || edge.external || resolve(cwd, edge.path) !== FAST_PRICER_MODULE) {
    throw Object.assign(new Error("ANALYTICS_FAST_PRICER_BINDING_MISSING"), { code: "ANALYTICS_FAST_PRICER_BINDING_MISSING" });
  }
}
