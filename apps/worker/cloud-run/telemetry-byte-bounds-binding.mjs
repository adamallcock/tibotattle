/** Node ESM composition only: original package/vendor/oracle bytes stay portable. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TELEMETRY_BYTE_BOUNDS_POLICY = fileURLToPath(import.meta.url);
export const TELEMETRY_BYTE_BOUNDS_SOURCE_SHA256 = "6f883333bf39759f0f42b7c8f6fa5524d0b6cd421ed0cc7fe3d61c338c20aa2e";
const HOST_IMPORT = "tibotattle:node-telemetry-utf8";
const ORIGINAL = "new TextEncoder().encode(serialized).byteLength";
const REPLACEMENT = "telemetryNodeUtf8Length(serialized)";

export function telemetryByteBoundsSource(workerRoot) {
  return resolve(workerRoot, "vendor/analytics-d43c8f92/packages/telemetry-contract/src/primitives.js");
}

function refuse(code) { throw Object.assign(new Error(code), { code }); }

/** Full-source pin and one exact expression keep this transformation reviewable. */
export function bindTelemetryByteBoundsSource(source) {
  if (createHash("sha256").update(source).digest("hex") !== TELEMETRY_BYTE_BOUNDS_SOURCE_SHA256
      || source.split(ORIGINAL).length - 1 !== 1 || source.includes("telemetryNodeUtf8Length")) {
    refuse("TELEMETRY_BYTE_BOUNDS_SOURCE_CHANGED");
  }
  return `import { hostUtf8Length as telemetryNodeUtf8Length } from "${HOST_IMPORT}";\n`
    + source.replace(ORIGINAL, REPLACEMENT);
}

/** Unknown paths, portable platforms and the registry IIFE are never transformed. */
export function telemetryByteBoundsPlugin(workerRoot, { read = readFile } = {}) {
  const target = telemetryByteBoundsSource(workerRoot);
  const host = resolve(workerRoot, "cloud-run/node-host-primitives.mjs");
  return { name: "node-telemetry-byte-bounds", setup(build) {
    if (build.initialOptions.platform !== "node" || build.initialOptions.format !== "esm") return;
    build.onResolve({ filter: /^tibotattle:node-telemetry-utf8$/ }, args => {
      if (resolve(args.importer) !== target) refuse("TELEMETRY_BYTE_BOUNDS_HOST_IMPORT_ESCAPED");
      return { path: host };
    });
    build.onLoad({ filter: /[/\\]packages[/\\]telemetry-contract[/\\]src[/\\]primitives\.js$/ }, async args => {
      if (resolve(args.path) !== target) return null;
      return { contents: bindTelemetryByteBoundsSource(Buffer.from(await read(args.path)).toString("utf8")),
        loader: "js", resolveDir: dirname(args.path) };
    });
  } };
}

/** Required graph edge, rather than mere host-file presence from crypto aliases. */
export function assertTelemetryByteBoundsBinding(metafile, { workerRoot, cwd = process.cwd(), requiredEntries = [] }) {
  const target = telemetryByteBoundsSource(workerRoot);
  const input = Object.entries(metafile?.inputs ?? {}).find(([path]) => resolve(cwd, path) === target);
  const edge = input?.[1].imports?.find(item => item.original === HOST_IMPORT);
  if (!edge || edge.external || resolve(cwd, edge.path) !== resolve(workerRoot, "cloud-run/node-host-primitives.mjs")) {
    refuse("TELEMETRY_BYTE_BOUNDS_BINDING_MISSING");
  }
  for (const entry of requiredEntries) {
    const output = Object.values(metafile.outputs ?? {}).find(item => item.entryPoint && resolve(cwd, item.entryPoint) === entry);
    if (!output || !Object.keys(output.inputs ?? {}).some(path => resolve(cwd, path) === target)) {
      refuse("TELEMETRY_BYTE_BOUNDS_BINDING_MISSING");
    }
  }
}
