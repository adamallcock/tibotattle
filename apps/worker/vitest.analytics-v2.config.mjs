// Node-environment Vitest gate for the GCP analytics-v2 work.
//
// Imports of @app-usagemonitor/{accounting,quota-analysis,telemetry-contract}
// made from the vendored d43c8f92 kernels (vendor/analytics-d43c8f92) or from
// the d43c8f92 kernel-parity specs resolve to the packages vendored at the
// same commit, never to this checkout's packages. Every other importer keeps
// normal resolution, matching what esbuild does through the vendor tree's
// tsconfig.json paths, so tests and bundles see the same package code.
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT = dirname(fileURLToPath(import.meta.url));
const VENDOR_ROOT = resolve(ROOT, "vendor/analytics-d43c8f92");
const PARITY_ROOT = resolve(ROOT, "analytics-v2-test/kernel-parity");

export const VENDORED_PACKAGE_ENTRIES = Object.freeze(Object.fromEntries(
  ["accounting", "quota-analysis", "telemetry-contract"].map((name) => [
    `@app-usagemonitor/${name}`,
    resolve(VENDOR_ROOT, `packages/${name}/index.js`),
  ]),
));

function importerPath(importer) {
  if (!importer) return null;
  const path = importer.split("?")[0];
  return path.startsWith("/@fs/") ? path.slice("/@fs".length) : path;
}

export function usesVendoredPackages(importer) {
  const path = importerPath(importer);
  return path !== null && [VENDOR_ROOT, PARITY_ROOT].some((root) => path.startsWith(`${root}${sep}`));
}

/** The Vitest counterpart of the vendor tree's tsconfig.json `paths`. */
const vendoredPackageResolution = {
  name: "analytics-v2-vendored-packages",
  enforce: "pre",
  resolveId(source, importer) {
    const entry = VENDORED_PACKAGE_ENTRIES[source];
    return entry && usesVendoredPackages(importer) ? entry : null;
  },
};

export default defineConfig({
  plugins: [vendoredPackageResolution],
  resolve: {
    // jsonc-parser publishes UMD as `main`; take its ESM build as esbuild does.
    mainFields: ["module", "main"],
  },
  test: {
    environment: "node",
    include: ["analytics-v2-test/**/*.spec.ts"],
    fileParallelism: false,
  },
});
