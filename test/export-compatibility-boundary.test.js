import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EXPORT_COMPATIBILITY_SCHEMA_NAMES,
  currentExportCompatibilityTupleFromArtifacts,
  exportRegistrySnapshot,
} from "../src/export/index.js";
import {
  readExportCompatibilityArtifactSet,
} from "../src/platform/index.js";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readArtifacts() {
  return readExportCompatibilityArtifactSet({
    schemaNames: EXPORT_COMPATIBILITY_SCHEMA_NAMES,
  });
}

function copiedArtifact(artifact) {
  return { bytes: Buffer.from(artifact.bytes) };
}

function copiedArtifacts() {
  const source = readArtifacts();
  return {
    schemas: source.schemas.map((schema) => ({
      name: schema.name,
      ...copiedArtifact(schema),
    })),
    consentStatus: copiedArtifact(source.consentStatus),
    contractStatus: copiedArtifact(source.contractStatus),
    fieldContract: copiedArtifact(source.fieldContract),
    generatedCompatibility: copiedArtifact(
      source.generatedCompatibility,
    ),
    packageMetadata: copiedArtifact(source.packageMetadata),
  };
}

function mutateJsonArtifact(artifact, mutate) {
  const value = JSON.parse(Buffer.from(artifact.bytes).toString("utf8"));
  mutate(value);
  return {
    bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
  };
}

function assertStale(artifacts, options = {}) {
  assert.throws(
    () => currentExportCompatibilityTupleFromArtifacts({
      artifacts,
      sha256Hex,
      ...options,
    }),
    {
      message: "Generated export compatibility manifest is stale",
    },
  );
}

test("platform compatibility artifacts expose defensive bytes, not mutable parsed JSON", () => {
  const artifacts = readArtifacts();
  const original = artifacts.fieldContract.bytes;
  const expectedFirstByte = original[0];
  original[0] = expectedFirstByte ^ 0xff;

  assert.equal("value" in artifacts.fieldContract, false);
  assert.equal(artifacts.fieldContract.bytes[0], expectedFirstByte);
  assert.notStrictEqual(
    artifacts.fieldContract.bytes,
    artifacts.fieldContract.bytes,
  );

  const tuple = currentExportCompatibilityTupleFromArtifacts({
    artifacts,
    sha256Hex,
  });
  assert.equal(Object.isFrozen(tuple), true);
  assert.equal(Object.isFrozen(tuple.schemas.members), true);
  assert.equal(Object.isFrozen(tuple.schemas.members[0]), true);
});

test("generated compatibility freshness binds every reviewed file input", () => {
  const mutations = [
    {
      label: "schema bytes",
      mutate(artifacts) {
        artifacts.schemas[0].bytes = Buffer.concat([
          artifacts.schemas[0].bytes,
          Buffer.from(" "),
        ]);
      },
    },
    {
      label: "schema identifier",
      mutate(artifacts) {
        artifacts.schemas[0] = {
          name: artifacts.schemas[0].name,
          ...mutateJsonArtifact(artifacts.schemas[0], (value) => {
            value.$id = `${value.$id}#changed`;
          }),
        };
      },
    },
    {
      label: "field contract",
      mutate(artifacts) {
        artifacts.fieldContract = mutateJsonArtifact(
          artifacts.fieldContract,
          (value) => {
            value.contractVersion = `${value.contractVersion}-changed`;
          },
        );
      },
    },
    {
      label: "package name",
      mutate(artifacts) {
        artifacts.packageMetadata = mutateJsonArtifact(
          artifacts.packageMetadata,
          (value) => {
            value.name = `${value.name}-changed`;
          },
        );
      },
    },
    {
      label: "package version",
      mutate(artifacts) {
        artifacts.packageMetadata = mutateJsonArtifact(
          artifacts.packageMetadata,
          (value) => {
            value.version = "999.0.0";
          },
        );
      },
    },
    {
      label: "consent status",
      mutate(artifacts) {
        artifacts.consentStatus = mutateJsonArtifact(
          artifacts.consentStatus,
          (value) => {
            value.status = `${value.status}-changed`;
          },
        );
      },
    },
    {
      label: "contract status",
      mutate(artifacts) {
        artifacts.contractStatus = mutateJsonArtifact(
          artifacts.contractStatus,
          (value) => {
            value.contractFamily = `${value.contractFamily}-changed`;
          },
        );
      },
    },
  ];

  for (const { label, mutate } of mutations) {
    const artifacts = copiedArtifacts();
    mutate(artifacts);
    assert.doesNotThrow(
      () => assertStale(artifacts),
      label,
    );
  }
});

test("generated compatibility freshness binds the reviewed registry snapshot", () => {
  assertStale(copiedArtifacts(), {
    registrySnapshot() {
      const value = exportRegistrySnapshot();
      value.reviewedAt = "2099-01-01";
      return value;
    },
  });
});
