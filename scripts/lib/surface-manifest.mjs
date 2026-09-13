import {
  SURFACE_MANIFEST,
  SURFACE_MANIFEST_SCHEMA,
} from "../../config/surface-manifest.js";

const RELATIVE_PATH_PATTERN = /^[^/\\][^\\]*$/u;
const FORBIDDEN_PATH_PARTS = new Set(["", ".", ".."]);

function fail(message) {
  const error = new TypeError(message);
  error.code = "SURFACE_MANIFEST_INVALID";
  throw error;
}

function assertRelativePath(path, label) {
  if (typeof path !== "string"
      || path.length === 0
      || path.includes("\0")
      || !RELATIVE_PATH_PATTERN.test(path)
      || /[*?\[\]]/u.test(path)
      || path.split("/").some((part) => FORBIDDEN_PATH_PARTS.has(part))) {
    fail(`${label} must be a non-empty repository-relative path`);
  }
  return path;
}

function assertManifest(manifest) {
  if (manifest === null || typeof manifest !== "object"
      || manifest.schemaVersion !== SURFACE_MANIFEST_SCHEMA
      || manifest.surfaces === null
      || typeof manifest.surfaces !== "object"
      || Array.isArray(manifest.surfaces)) {
    fail("Surface manifest has an unexpected schema");
  }
  const surfaceNames = Object.keys(manifest.surfaces).sort();
  const expectedSurfaceNames = [
    "electron-runtime",
    "history-free-export",
    "local-companion",
    "native-macos",
  ];
  if (JSON.stringify(surfaceNames) !== JSON.stringify(expectedSurfaceNames)) {
    fail("Surface manifest surface names changed");
  }
  for (const [surface, paths] of Object.entries(manifest.surfaces)) {
    if (!Array.isArray(paths) || paths.length === 0) {
      fail(`Surface manifest projection is invalid: ${surface}`);
    }
    const seen = new Set();
    for (const path of paths) {
      assertRelativePath(path, `Surface manifest path for ${surface}`);
      if (seen.has(path)) fail(`Duplicate surface manifest path: ${path}`);
      seen.add(path);
    }
  }
  return true;
}

assertManifest(SURFACE_MANIFEST);

export function surfaceFiles(surface) {
  if (typeof surface !== "string"
      || !Object.hasOwn(SURFACE_MANIFEST.surfaces, surface)) {
    fail(`Unknown surface manifest projection: ${surface}`);
  }
  return Object.freeze([...SURFACE_MANIFEST.surfaces[surface]]);
}

/**
 * Assert exact membership after a caller has applied its own semantic
 * normalization (for example, local HTTP route aliases map to one file).
 */
export function assertSurfaceProjection(surface, paths, {
  label = `${surface} surface projection`,
} = {}) {
  if (!Array.isArray(paths) && !(paths instanceof Set)) {
    fail(`${label} must be an array or Set`);
  }
  const actual = [...paths].map((path) => assertRelativePath(path, label));
  const uniqueActual = [...new Set(actual)].sort();
  const expected = [...surfaceFiles(surface)].sort();
  if (JSON.stringify(uniqueActual) !== JSON.stringify(expected)) {
    fail(`${label} does not match the reviewed surface manifest`);
  }
  return true;
}

export { assertManifest as assertSurfaceManifest };
