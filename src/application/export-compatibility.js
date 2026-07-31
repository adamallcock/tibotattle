import {
  EXPORT_COMPATIBILITY_SCHEMA_NAMES,
  buildExportCompatibilityTupleFromArtifacts,
  currentExportCompatibilityTupleFromArtifacts,
} from "../export/index.js";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

export function createExportCompatibilityContext({
  readExportCompatibilityArtifactSet,
  sha256Hex,
} = {}) {
  const readArtifacts = requireFunction(
    readExportCompatibilityArtifactSet,
    "readExportCompatibilityArtifactSet",
  );
  const hash = requireFunction(sha256Hex, "sha256Hex");

  function artifacts() {
    return readArtifacts({
      schemaNames: EXPORT_COMPATIBILITY_SCHEMA_NAMES,
    });
  }

  return Object.freeze({
    buildExportCompatibilityTuple() {
      return buildExportCompatibilityTupleFromArtifacts({
        artifacts: artifacts(),
        sha256Hex: hash,
      });
    },
    exportCompatibilityTuple() {
      return currentExportCompatibilityTupleFromArtifacts({
        artifacts: artifacts(),
        sha256Hex: hash,
      });
    },
  });
}
