import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  buildSha256Sums,
  generateReleaseEvidence,
  readJsonFile,
  ReleaseEvidenceError,
  stableStringify,
  validateReleaseEvidenceManifest,
  writeReleaseEvidenceFiles,
  assertRepository,
} from "../scripts/release-evidence.js";
import {
  main as releaseEvidenceCliMain,
} from "../scripts/generate-release-evidence.js";
import {
  RELEASE_MANIFEST,
} from "../config/release-manifest.js";
import {
  RELEASE_EVIDENCE_ALLOWED_PLATFORM_ASSURANCES,
  RELEASE_EVIDENCE_PLATFORM_ASSURANCES,
  RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN,
  RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
} from "../config/release-evidence.js";

const RELEASE = Object.freeze({
  product: { name: "TiboTattle" },
  version: RELEASE_MANIFEST.version,
  tag: RELEASE_MANIFEST.tag,
  commit: "a".repeat(40),
  repository: "https://github.com/adamallcock/tibotattle",
});

const RELEASE_SOURCE = Object.freeze({
  version: RELEASE.version,
  tag: RELEASE.tag,
  commit: RELEASE.commit,
  repository: RELEASE.repository,
});

const ASSURANCES = Object.freeze({
  macos: {
    direct: {
      cleanInstallSmokePassed: true,
      developerIdSigned: true,
      hardenedRuntime: true,
      notarizationAccepted: true,
      ticketStapled: true,
      gatekeeperAssessmentPassed: true,
    },
    store: {
      storePublisherVerified: true,
      storeBuildVerified: true,
      storeSignatureVerified: true,
    },
  },
  windows: {
    direct: {
      cleanInstallSmokePassed: true,
      authenticodeSigned: true,
      timestamped: true,
    },
    store: {
      storePublisherVerified: true,
      storeBuildVerified: true,
      storeSignatureVerified: true,
    },
  },
  linux: {
    direct: {
      cleanInstallSmokePassed: true,
      artifactIntegrityVerified: true,
    },
    store: {
      storePublisherVerified: true,
      storeBuildVerified: true,
      storeSignatureVerified: true,
    },
  },
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sbom(name) {
  return JSON.stringify({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name,
    documentNamespace: `https://example.invalid/spdx/${name}`,
    creationInfo: {
      created: "2026-08-18T00:00:00Z",
      creators: ["Tool: test"],
    },
    packages: [],
  });
}

function provenance() {
  return JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      certificate: { rawBytes: "AA==" },
      tlogEntries: [],
    },
    dsseEnvelope: {
      payload: "AA==",
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "AA==" }],
    },
  });
}

function storeReceipt({ provider, listing, artifactName, artifactContents }) {
  return JSON.stringify({
    schemaVersion: "usage-monitor-store-delivery-receipt-v1",
    format: "store-delivery-receipt",
    product: RELEASE.product.name,
    provider,
    listing,
    version: RELEASE.version,
    tag: RELEASE.tag,
    commit: RELEASE.commit,
    repository: RELEASE.repository,
    artifactFileName: artifactName,
    artifactBytes: Buffer.byteLength(artifactContents),
    artifactSha256: digest(artifactContents),
    subjectKind: "store-retrieved",
    deliveryState: "final",
    uploadCandidate: false,
    retrievedAt: "2026-08-18T00:00:00.000Z",
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-evidence-"));
  const files = new Map();
  async function add(name, value) {
    const path = join(root, name);
    await writeFile(path, value);
    files.set(name, path);
    return path;
  }
  function descriptor({
    platform,
    channel = "direct",
    architecture,
    format,
    name,
    store,
    updater,
    assurances = ASSURANCES[platform][channel],
  }) {
    const artifactName = `${name}.${format}`;
    const sbomName = `${name}.spdx.json`;
    const sbomAttestationName = `${name}.sbom.sigstore.json`;
    const provenanceName = `${name}.sigstore.json`;
    const artifactPath = files.get(artifactName);
    const sbomPath = files.get(sbomName);
    const sbomAttestationPath = files.get(sbomAttestationName);
    const provenancePath = files.get(provenanceName);
    return {
      platform,
      channel,
      architecture,
      format,
      path: relative(root, artifactPath),
      fileName: artifactName,
      source: { ...RELEASE_SOURCE },
      downloadUrl: `https://github.com/adamallcock/tibotattle/releases/download/${RELEASE.tag}/${artifactName}`,
      distribution: "github-release",
      nativeTrust: platform === "macos"
        ? { signerIdentity: "Developer ID Application: TiboTattle (ABCDE12345)", teamId: "ABCDE12345" }
        : platform === "windows"
          ? { publisher: "TiboTattle, Inc.", certificateSha256: "1".repeat(64) }
          : { scheme: "none" },
      sbom: {
        path: relative(root, sbomPath),
        fileName: sbomName,
        attestation: {
          path: relative(root, sbomAttestationPath),
          fileName: sbomAttestationName,
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          predicateType: "https://spdx.dev/Document/v2.3",
          builderId: "https://github.com/actions/runner",
          signerWorkflow: "adamallcock/tibotattle/.github/workflows/release.yml",
          signerDigest: "b".repeat(40),
          runUrl: "https://github.com/adamallcock/tibotattle/actions/runs/123456",
          denySelfHostedRunners: true,
        },
      },
      provenance: {
        path: relative(root, provenancePath),
        fileName: provenanceName,
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        predicateType: "https://slsa.dev/provenance/v1",
        builderId: "https://github.com/actions/runner",
        signerWorkflow: "adamallcock/tibotattle/.github/workflows/release.yml",
        signerDigest: "b".repeat(40),
        runUrl: "https://github.com/adamallcock/tibotattle/actions/runs/123456",
        denySelfHostedRunners: true,
      },
      assurances,
      ...(store === undefined ? {} : { store }),
      updater,
    };
  }
  return {
    root,
    files,
    add,
    descriptor,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function buildBaseFixture() {
  const value = await fixture();
  const names = [
    ["TiboTattle-0.1.12-macOS-arm64.dmg", "mac artifact"],
    ["TiboTattle-0.1.12-macOS-arm64.spdx.json", sbom("mac")],
    ["TiboTattle-0.1.12-macOS-arm64.sbom.sigstore.json", provenance()],
    ["TiboTattle-0.1.12-macOS-arm64.sigstore.json", provenance()],
    ["TiboTattle-0.1.12-macOS-arm64-appcast.xml", "<rss>signed</rss>"],
    [
      "TiboTattle-0.1.12-macOS-arm64.store-receipt.json",
      storeReceipt({
        provider: "mac-app-store",
        listing: "https://apps.apple.com/app/tibotattle/id123456789",
        artifactName: "TiboTattle-0.1.12-macOS-arm64.dmg",
        artifactContents: "mac artifact",
      }),
    ],
  ];
  for (const [name, bytes] of names) await value.add(name, bytes);
  const artifactName = names[0][0];
  const sbomName = names[1][0];
  const sbomAttestationName = names[2][0];
  const provenanceName = names[3][0];
  return {
    ...value,
    input: {
      ...RELEASE,
      artifacts: [{
        platform: "macos",
        channel: "direct",
        architecture: "arm64",
        format: "dmg",
        path: relative(value.root, value.files.get(artifactName)),
        fileName: artifactName,
        source: { ...RELEASE_SOURCE },
        downloadUrl: `https://github.com/adamallcock/tibotattle/releases/download/${RELEASE.tag}/${artifactName}`,
        distribution: "github-release",
        nativeTrust: {
          signerIdentity: "Developer ID Application: TiboTattle (ABCDE12345)",
          teamId: "ABCDE12345",
        },
        build: {
          sourceManifestSha256: "2".repeat(64),
          unsignedPayloadSha256: "3".repeat(64),
        },
        sbom: {
          path: relative(value.root, value.files.get(sbomName)),
          fileName: sbomName,
          attestation: {
            path: relative(value.root, value.files.get(sbomAttestationName)),
            fileName: sbomAttestationName,
            mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
            predicateType: "https://spdx.dev/Document/v2.3",
            builderId: "https://github.com/actions/runner",
            signerWorkflow: "adamallcock/tibotattle/.github/workflows/release.yml",
            signerDigest: "b".repeat(40),
            runUrl: "https://github.com/adamallcock/tibotattle/actions/runs/123456",
            denySelfHostedRunners: true,
          },
        },
        provenance: {
          path: relative(value.root, value.files.get(provenanceName)),
          fileName: provenanceName,
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          predicateType: "https://slsa.dev/provenance/v1",
          builderId: "https://github.com/actions/runner",
          signerWorkflow: "adamallcock/tibotattle/.github/workflows/release.yml",
          signerDigest: "b".repeat(40),
          runUrl: "https://github.com/adamallcock/tibotattle/actions/runs/123456",
          denySelfHostedRunners: true,
        },
        assurances: ASSURANCES.macos.direct,
        updater: {
          enabled: true,
          mechanism: "sparkle",
          metadata: {
            path: relative(value.root, value.files.get("TiboTattle-0.1.12-macOS-arm64-appcast.xml")),
            fileName: "TiboTattle-0.1.12-macOS-arm64-appcast.xml",
          },
        },
      }],
    },
  };
}

async function assertCode(code, callback) {
  await assert.rejects(callback, (error) => {
    assert.ok(error instanceof ReleaseEvidenceError);
    assert.equal(error.code, code);
    return true;
  });
}

test("existing macOS RELEASE_MANIFEST filename compatibility remains intact", () => {
  // The compatibility surface is the filename SHAPE (brand, version slot,
  // arch suffix); the version itself tracks RELEASE_VERSION so bumps stop
  // breaking this pin (same derivation move as the replacement-contract
  // fixture tags).
  assert.equal(
    RELEASE_MANIFEST.macOS.arm64DmgFileName,
    `TiboTattle-${RELEASE_MANIFEST.version}-macOS-arm64.dmg`,
  );
});

test("published JSON Schema stays aligned with the v1 runtime vocabulary", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../schemas/release-evidence-v1/manifest.schema.json",
    import.meta.url,
  ), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, RELEASE_EVIDENCE_SCHEMA_VERSION);
  assert.equal(
    schema.$defs.attestation.properties.mediaType.const,
    "application/vnd.dev.sigstore.bundle.v0.3+json",
  );
  assert.equal(
    new RegExp(schema.$defs.attestation.properties.mediaType.const.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u").test(
      "application/vnd.dev.sigstore.bundle.v0.3+json",
    ),
    RELEASE_EVIDENCE_PROVENANCE_MEDIA_TYPE_PATTERN.test(
      "application/vnd.dev.sigstore.bundle.v0.3+json",
    ),
  );
  assert.equal(
    schema.$defs.sbom.properties.attestation.anyOf[1].allOf[1]
      .properties.predicateType.const,
    "https://spdx.dev/Document/v2.3",
  );
  assert.equal(
    schema.$defs.artifact.properties.provenance.anyOf[1].allOf[1]
      .properties.predicateType.const,
    "https://slsa.dev/provenance/v1",
  );
  assert.ok(schema.$defs.artifact.required.includes("nativeTrust"));
  assert.ok(schema.$defs.artifact.required.includes("build"));
  assert.deepEqual(
    Object.keys(schema.$defs.assurances.properties).sort(),
    [...new Set(Object.values(RELEASE_EVIDENCE_ALLOWED_PLATFORM_ASSURANCES)
      .flatMap((channels) => Object.values(channels).flat()))].sort(),
  );
  assert.deepEqual(
    schema.$defs.artifact.required,
    [
      "platform", "channel", "architecture", "format", "version",
      "distribution", "downloadUrl", "fileName", "bytes", "sha256",
      "source", "nativeTrust", "build", "sbom", "provenance",
      "assurances", "store", "updater",
    ],
  );
  for (const requiredAssurance of Object.values(RELEASE_EVIDENCE_PLATFORM_ASSURANCES)
    .flatMap((channels) => Object.values(channels).flat())) {
    assert.ok(Object.hasOwn(schema.$defs.assurances.properties, requiredAssurance));
  }
  assert.equal(
    RELEASE_EVIDENCE_PROVENANCE_PREDICATE_PATTERN.test(
      schema.$defs.artifact.properties.provenance.anyOf[1].allOf[1]
        .properties.predicateType.const,
    ),
    true,
  );
  const ajv = new Ajv2020({ strict: false });
  const validateSchema = ajv.compile(schema);
  const validateRepositorySchema = ajv.compile(schema.$defs.repository);
  for (const [candidate, expected] of [
    ["https://github.com/adamallcock/tibotattle", true],
    ["https://github.com/adamallcock/tibotattle.git", false],
    ["https://github.com/adamallcock/tibotattle/", false],
    ["https://GITHUB.com/adamallcock/tibotattle", false],
  ]) {
    let runtimeAccepted = true;
    try {
      assertRepository(candidate);
    } catch {
      runtimeAccepted = false;
    }
    assert.equal(runtimeAccepted, expected, candidate);
    assert.equal(validateRepositorySchema(candidate), expected, candidate);
  }
  const value = await buildBaseFixture();
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });
    assert.equal(validateSchema(manifest), true, JSON.stringify(validateSchema.errors));
    const invalid = structuredClone(manifest);
    invalid.artifacts[0].store = { provider: "mac-app-store" };
    assert.equal(validateSchema(invalid), false);
    const wrongNativeTrust = structuredClone(manifest);
    wrongNativeTrust.artifacts[0].nativeTrust = { scheme: "none" };
    assert.equal(validateSchema(wrongNativeTrust), false);
    const wrongStoreCondition = structuredClone(manifest);
    wrongStoreCondition.artifacts[0].channel = "store";
    assert.equal(validateSchema(wrongStoreCondition), false);
  } finally {
    await value.close();
  }
});

test("generator emits a deterministic cross-platform manifest and SHA256SUMS", async () => {
  const value = await buildBaseFixture();
  try {
    const first = await generateReleaseEvidence({
      descriptor: value.input,
      baseDir: value.root,
    });
    const second = await generateReleaseEvidence({
      descriptor: value.input,
      baseDir: value.root,
    });
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, "usage-monitor-release-evidence-v1");
    assert.equal(first.artifacts.length, 1);
    const artifact = first.artifacts[0];
    assert.equal(artifact.source.commit, RELEASE.commit);
    assert.equal(artifact.sbom.format, "spdx-json");
    assert.equal(artifact.sbom.subjectSha256, artifact.sha256);
    assert.equal(artifact.provenance.subjectSha256, artifact.sha256);
    assert.equal(artifact.provenance.verificationStatus, "unverified");
    assert.equal(
      artifact.downloadUrl,
      `https://github.com/adamallcock/tibotattle/releases/download/${RELEASE.tag}/${artifact.fileName}`,
    );
    assert.equal(artifact.distribution, "github-release");
    assert.equal(artifact.nativeTrust.teamId, "ABCDE12345");
    assert.equal(artifact.build.sourceManifestSha256, "2".repeat(64));
    assert.equal(artifact.build.unsignedPayloadSha256, "3".repeat(64));
    assert.equal(
      artifact.provenance.signerWorkflow,
      "adamallcock/tibotattle/.github/workflows/release.yml",
    );
    assert.equal(artifact.provenance.signerDigest, "b".repeat(40));
    assert.equal(
      artifact.provenance.runUrl,
      "https://github.com/adamallcock/tibotattle/actions/runs/123456",
    );
    assert.deepEqual(artifact.sbom.attestation.predicateType,
      "https://spdx.dev/Document/v2.3");
    assert.match(buildSha256Sums(first), new RegExp(`${artifact.sha256}  `));

    const output = await writeReleaseEvidenceFiles({
      manifest: first,
      manifestPath: join(value.root, "release-manifest.json"),
    });
    assert.equal(output.manifestText, `${stableStringify(first)}\n`);
    assert.equal(
      JSON.parse(await readFile(output.manifestPath, "utf8")).schemaVersion,
      first.schemaVersion,
    );
    assert.equal(await readFile(output.sumsPath, "utf8"), output.sumsText);
    await validateReleaseEvidenceManifest(first, {
      artifactRoot: value.root,
      manifestPath: output.manifestPath,
    });
  } finally {
    await value.close();
  }
});

test("canonical runtime rejects an omitted direct Store field with a controlled error", async () => {
  const value = await buildBaseFixture();
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });
    delete manifest.artifacts[0].store;
    await assertCode("RELEASE_EVIDENCE_ARTIFACT_INVALID",
      () => validateReleaseEvidenceManifest(manifest));
  } finally {
    await value.close();
  }
});

test("direct artifacts reject Store providers from every platform", async () => {
  const value = await buildBaseFixture();
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });
    for (const provider of ["mac-app-store", "microsoft-store", "flathub", "snap", "apt", "rpm"]) {
      const invalid = structuredClone(manifest);
      invalid.artifacts[0].distribution = provider;
      await assertCode("RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION",
        () => validateReleaseEvidenceManifest(invalid));
    }
  } finally {
    await value.close();
  }
});

test("release identity does not pair a base version with a suffixed tag", async () => {
  const value = await buildBaseFixture();
  try {
    const prereleaseTag = structuredClone(value.input);
    prereleaseTag.tag = `${RELEASE.tag}-rc.1`;
    await assertCode("RELEASE_EVIDENCE_VERSION_MISMATCH", () => generateReleaseEvidence({
      descriptor: prereleaseTag,
      baseDir: value.root,
    }));
  } finally {
    await value.close();
  }
});

test("generator supports Windows and Linux store/direct artifacts without inventing absent artifacts", async () => {
  const value = await fixture();
  try {
    const descriptors = [];
    for (const [name, contents] of [
      ["TiboTattle-0.1.12-Windows-x64.exe", "windows"],
      ["TiboTattle-0.1.12-Linux-x86_64.AppImage", "linux"],
      ["TiboTattle-0.1.12-Windows-store-x64.msix", "store windows"],
      ["TiboTattle-0.1.12-Linux-store-x86_64.flatpak", "store linux"],
    ]) {
      await value.add(name, contents);
      const prefix = name.slice(0, name.lastIndexOf("."));
      const sbomName = `${prefix}.spdx.json`;
      const sbomAttestationName = `${prefix}.sbom.sigstore.json`;
      const provenanceName = `${prefix}.sigstore.json`;
      await value.add(sbomName, sbom(prefix));
      await value.add(sbomAttestationName, provenance());
      await value.add(provenanceName, provenance());
      const platform = name.includes("Windows") ? "windows" : "linux";
      const channel = name.includes("store") ? "store" : "direct";
      const storeProvider = platform === "windows" ? "microsoft-store" : "flathub";
      const storeListing = platform === "windows"
        ? "https://apps.microsoft.com/detail/tibotattle"
        : "https://flathub.org/apps/com.tibotattle";
      const storeReceiptName = `${prefix}.store-receipt.json`;
      if (channel === "store") {
        await value.add(storeReceiptName, storeReceipt({
          provider: storeProvider,
          listing: storeListing,
          artifactName: name,
          artifactContents: contents,
        }));
      }
      descriptors.push({
        platform,
        channel,
        architecture: platform === "windows" ? "x64" : "x86_64",
        format: platform === "windows" ? (channel === "store" ? "msix" : "exe") : (channel === "store" ? "flatpak" : "appimage"),
        path: relative(value.root, value.files.get(name)),
        fileName: name,
        downloadUrl: channel === "store"
          ? storeListing
          : `https://github.com/adamallcock/tibotattle/releases/download/${RELEASE.tag}/${name}`,
        distribution: channel === "store" ? storeProvider : "github-release",
        nativeTrust: channel === "store"
          ? {
              provider: storeProvider,
              publisher: "TiboTattle",
              listing: storeListing,
            }
          : platform === "windows"
            ? { publisher: "TiboTattle, Inc.", certificateSha256: "1".repeat(64) }
            : { scheme: "none" },
        build: channel === "store"
          ? null
          : {
              sourceManifestSha256: "2".repeat(64),
              unsignedPayloadSha256: "3".repeat(64),
            },
        sbom: {
          path: relative(value.root, value.files.get(sbomName)),
          fileName: sbomName,
          attestation: {
            path: relative(value.root, value.files.get(sbomAttestationName)),
            fileName: sbomAttestationName,
            mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
            predicateType: "https://spdx.dev/Document/v2.3",
            builderId: "https://github.com/actions/runner",
            signerWorkflow: "adamallcock/tibotattle/.github/workflows/release.yml",
            signerDigest: "b".repeat(40),
            runUrl: "https://github.com/adamallcock/tibotattle/actions/runs/123456",
            denySelfHostedRunners: true,
          },
        },
        provenance: {
          path: relative(value.root, value.files.get(provenanceName)),
          fileName: provenanceName,
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          predicateType: "https://slsa.dev/provenance/v1",
          builderId: "https://github.com/actions/runner",
          signerWorkflow: "adamallcock/tibotattle/.github/workflows/release.yml",
          signerDigest: "b".repeat(40),
          runUrl: "https://github.com/adamallcock/tibotattle/actions/runs/123456",
          denySelfHostedRunners: true,
        },
        assurances: ASSURANCES[platform][channel],
        ...(channel === "store"
          ? {
              store: {
                provider: storeProvider,
                listing: storeListing,
                receipt: {
                  path: relative(value.root, value.files.get(storeReceiptName)),
                  fileName: storeReceiptName,
                },
              },
            }
          : {}),
        updater: {
          enabled: false,
          mechanism: channel === "store" ? "store-managed" : "none",
        },
      });
    }
    const manifest = await generateReleaseEvidence({
      descriptor: { ...RELEASE, artifacts: descriptors },
      baseDir: value.root,
    });
    assert.equal(manifest.artifacts.length, 4);
    assert.deepEqual(
      manifest.artifacts.map(({ platform, channel }) => `${platform}/${channel}`),
      ["linux/direct", "windows/direct", "linux/store", "windows/store"],
    );
    assert.equal(manifest.artifacts.find((item) => item.channel === "direct").store, null);
    assert.equal(manifest.artifacts.find((item) => item.channel === "store").updater.mechanism, "store-managed");
    assert.equal(
      manifest.artifacts.find((item) => item.channel === "store").store.receipt.subjectSha256,
      manifest.artifacts.find((item) => item.channel === "store").sha256,
    );
  } finally {
    await value.close();
  }
});

test("missing SBOM and provenance are explicit null evidence, not inferred claims", async () => {
  const value = await buildBaseFixture();
  try {
    const noSbomAttestation = structuredClone(value.input);
    noSbomAttestation.artifacts[0].sbom.attestation = null;
    const attestationless = await generateReleaseEvidence({
      descriptor: noSbomAttestation,
      baseDir: value.root,
    });
    assert.equal(attestationless.artifacts[0].sbom.attestation, null);

    const input = structuredClone(value.input);
    input.artifacts[0].sbom = null;
    input.artifacts[0].provenance = null;
    input.artifacts[0].updater = { enabled: false, mechanism: "none" };
    const manifest = await generateReleaseEvidence({ descriptor: input, baseDir: value.root });
    assert.equal(manifest.artifacts[0].sbom, null);
    assert.equal(manifest.artifacts[0].provenance, null);
    assert.equal(buildSha256Sums(manifest).trim().split("\n").length, 2);
    await validateReleaseEvidenceManifest(manifest, { artifactRoot: value.root });
  } finally {
    await value.close();
  }
});

test("Store entries require a verified final listing subject and cannot masquerade as GitHub downloads", async () => {
  const value = await buildBaseFixture();
  try {
    const input = structuredClone(value.input);
    const artifact = input.artifacts[0];
    artifact.channel = "store";
    artifact.distribution = "mac-app-store";
    artifact.downloadUrl = "https://apps.apple.com/app/tibotattle/id123456789";
    artifact.store = {
      provider: "mac-app-store",
      listing: artifact.downloadUrl,
      receipt: {
        path: relative(value.root,
          value.files.get("TiboTattle-0.1.12-macOS-arm64.store-receipt.json")),
        fileName: "TiboTattle-0.1.12-macOS-arm64.store-receipt.json",
      },
    };
    artifact.nativeTrust = {
      provider: "mac-app-store",
      publisher: "TiboTattle",
      listing: artifact.downloadUrl,
    };
    artifact.assurances = ASSURANCES.macos.store;
    artifact.build = null;
    artifact.sbom = null;
    artifact.provenance = null;
    artifact.updater = { enabled: false, mechanism: "store-managed" };
    const manifest = await generateReleaseEvidence({ descriptor: input, baseDir: value.root });
    assert.equal(manifest.artifacts[0].store.receipt.format, "store-delivery-receipt");
    assert.equal(manifest.artifacts[0].store.receipt.subjectSha256,
      manifest.artifacts[0].sha256);
    assert.equal(manifest.artifacts[0].downloadUrl, manifest.artifacts[0].store.listing);

    const deliveredReceiptPath = value.files.get(
      "TiboTattle-0.1.12-macOS-arm64.store-receipt.json",
    );
    const deliveredReceipt = JSON.parse(await readFile(deliveredReceiptPath, "utf8"));
    deliveredReceipt.uploadCandidate = true;
    const tamperedReceiptText = JSON.stringify(deliveredReceipt);
    await writeFile(deliveredReceiptPath, tamperedReceiptText, "utf8");
    const receiptTamperedManifest = structuredClone(manifest);
    receiptTamperedManifest.artifacts[0].store.receipt.sha256 = digest(tamperedReceiptText);
    receiptTamperedManifest.artifacts[0].store.receipt.bytes = Buffer.byteLength(
      tamperedReceiptText,
    );
    await assertCode("RELEASE_EVIDENCE_STORE_RECEIPT_NOT_DELIVERED", () =>
      validateReleaseEvidenceManifest(receiptTamperedManifest, {
        artifactRoot: value.root,
      }));
    deliveredReceipt.uploadCandidate = false;
    await writeFile(deliveredReceiptPath, JSON.stringify(deliveredReceipt), "utf8");

    const wrongUrl = structuredClone(input);
    wrongUrl.artifacts[0].downloadUrl =
      `https://github.com/adamallcock/tibotattle/releases/download/${RELEASE.tag}/${wrongUrl.artifacts[0].fileName}`;
    await assertCode("RELEASE_EVIDENCE_STORE_INVALID", () => generateReleaseEvidence({
      descriptor: wrongUrl,
      baseDir: value.root,
    }));

    const unverified = structuredClone(input);
    const receiptPath = value.files.get("TiboTattle-0.1.12-macOS-arm64.store-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.uploadCandidate = true;
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    await assertCode("RELEASE_EVIDENCE_STORE_RECEIPT_NOT_DELIVERED", () => generateReleaseEvidence({
      descriptor: unverified,
      baseDir: value.root,
    }));
  } finally {
    await value.close();
  }
});

test("generator rejects unsafe paths, symlinks, and mismatched file metadata", async () => {
  const value = await buildBaseFixture();
  const outside = await mkdtemp(join(tmpdir(), "tibotattle-release-evidence-outside-"));
  try {
    const base = structuredClone(value.input);
    base.artifacts[0].fileName = "../release.dmg";
    await assertCode("RELEASE_EVIDENCE_UNSAFE_FILE_NAME", () => generateReleaseEvidence({ descriptor: base, baseDir: value.root }));

    const traversal = structuredClone(value.input);
    traversal.artifacts[0].path = relative(
      value.root,
      join(outside, "outside.dmg"),
    );
    await writeFile(join(outside, "outside.dmg"), "outside artifact");
    await assertCode("RELEASE_EVIDENCE_UNSAFE_PATH", () => generateReleaseEvidence({
      descriptor: traversal,
      baseDir: value.root,
    }));

    const absolute = structuredClone(value.input);
    absolute.artifacts[0].path = value.files.get("TiboTattle-0.1.12-macOS-arm64.dmg");
    await assertCode("RELEASE_EVIDENCE_UNSAFE_PATH", () => generateReleaseEvidence({
      descriptor: absolute,
      baseDir: value.root,
    }));

    const linkedDirectory = join(value.root, "linked-directory");
    await symlink(outside, linkedDirectory, "dir");
    const ancestorEscape = structuredClone(value.input);
    ancestorEscape.artifacts[0].path = "linked-directory/outside.dmg";
    ancestorEscape.artifacts[0].fileName = "outside.dmg";
    await assertCode("RELEASE_EVIDENCE_UNSAFE_PATH", () => generateReleaseEvidence({
      descriptor: ancestorEscape,
      baseDir: value.root,
    }));

    const symlinkPath = join(value.root, "linked.dmg");
    await symlink(value.files.get("TiboTattle-0.1.12-macOS-arm64.dmg"), symlinkPath);
    const linked = structuredClone(value.input);
    linked.artifacts[0].path = relative(value.root, symlinkPath);
    linked.artifacts[0].fileName = "linked.dmg";
    await assertCode("RELEASE_EVIDENCE_SYMLINK_OR_NONFILE", () => generateReleaseEvidence({ descriptor: linked, baseDir: value.root }));

    const mismatched = structuredClone(value.input);
    mismatched.artifacts[0].bytes = 99;
    await assertCode("RELEASE_EVIDENCE_BYTES_MISMATCH", () => generateReleaseEvidence({ descriptor: mismatched, baseDir: value.root }));

    const wrongHash = structuredClone(value.input);
    wrongHash.artifacts[0].sha256 = "0".repeat(64);
    await assertCode("RELEASE_EVIDENCE_HASH_MISMATCH", () => generateReleaseEvidence({ descriptor: wrongHash, baseDir: value.root }));
  } finally {
    await value.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test("validator rejects source drift, incomplete assurances, subject drift, duplicates, and direct/store conflation", async () => {
  const value = await buildBaseFixture();
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });

    const wrongSource = structuredClone(manifest);
    wrongSource.artifacts[0].source.commit = "b".repeat(40);
    await assertCode("RELEASE_EVIDENCE_SOURCE_MISMATCH", () => validateReleaseEvidenceManifest(wrongSource));

    const incomplete = structuredClone(manifest);
    incomplete.artifacts[0].assurances.notarizationAccepted = false;
    await assertCode("RELEASE_EVIDENCE_ASSURANCES_INCOMPLETE", () => validateReleaseEvidenceManifest(incomplete));

    const wrongSubject = structuredClone(manifest);
    wrongSubject.artifacts[0].sbom.subjectSha256 = "0".repeat(64);
    await assertCode("RELEASE_EVIDENCE_SUBJECT_MISMATCH", () => validateReleaseEvidenceManifest(wrongSubject));

    const duplicate = structuredClone(manifest);
    duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
    await assertCode("RELEASE_EVIDENCE_DUPLICATE_ARTIFACT", () => validateReleaseEvidenceManifest(duplicate));

    const conflated = structuredClone(manifest);
    conflated.artifacts[0].store = { provider: "mac-app-store" };
    await assertCode("RELEASE_EVIDENCE_STORE_DIRECT_CONFLATION", () => validateReleaseEvidenceManifest(conflated));

    const unknownCanonicalField = structuredClone(manifest);
    unknownCanonicalField.artifacts[0].provenance.unreviewedClaim = true;
    await assertCode("RELEASE_EVIDENCE_PROVENANCE_INVALID", () =>
      validateReleaseEvidenceManifest(unknownCanonicalField));

    const unknownUpdaterField = structuredClone(manifest);
    unknownUpdaterField.artifacts[0].updater.unreviewedClaim = true;
    await assertCode("RELEASE_EVIDENCE_UPDATER_INVALID", () =>
      validateReleaseEvidenceManifest(unknownUpdaterField));

    const caseCollision = structuredClone(manifest);
    caseCollision.artifacts[0].provenance.fileName =
      caseCollision.artifacts[0].fileName.toUpperCase();
    await assertCode("RELEASE_EVIDENCE_DUPLICATE_FILE_NAME", () =>
      validateReleaseEvidenceManifest(caseCollision));

    const sumsCollision = structuredClone(manifest);
    sumsCollision.artifacts[0].fileName = "SHA256SUMS";
    sumsCollision.artifacts[0].downloadUrl =
      `https://github.com/adamallcock/tibotattle/releases/download/${RELEASE.tag}/SHA256SUMS`;
    await assertCode("RELEASE_EVIDENCE_DUPLICATE_FILE_NAME", () =>
      validateReleaseEvidenceManifest(sumsCollision));
  } finally {
    await value.close();
  }
});

test("validator rejects a non-SPDX SBOM and unsafe metadata filename", async () => {
  const value = await buildBaseFixture();
  try {
    await writeFile(value.files.get("TiboTattle-0.1.12-macOS-arm64.spdx.json"), "{}", "utf8");
    await assertCode("RELEASE_EVIDENCE_SBOM_INVALID", () => generateReleaseEvidence({ descriptor: value.input, baseDir: value.root }));

    const restored = sbom("mac");
    await writeFile(value.files.get("TiboTattle-0.1.12-macOS-arm64.spdx.json"), restored, "utf8");
    for (const version of ["SPDX-2.2", "SPDX-3.0"]) {
      const wrongVersion = JSON.parse(restored);
      wrongVersion.spdxVersion = version;
      await writeFile(value.files.get("TiboTattle-0.1.12-macOS-arm64.spdx.json"),
        JSON.stringify(wrongVersion), "utf8");
      await assertCode("RELEASE_EVIDENCE_SBOM_INVALID", () => generateReleaseEvidence({
        descriptor: value.input,
        baseDir: value.root,
      }));
    }
    await writeFile(value.files.get("TiboTattle-0.1.12-macOS-arm64.spdx.json"), restored, "utf8");
    const unsafe = structuredClone(value.input);
    unsafe.artifacts[0].provenance.fileName = "metadata/attestation.json";
    await assertCode("RELEASE_EVIDENCE_UNSAFE_FILE_NAME", () => generateReleaseEvidence({ descriptor: unsafe, baseDir: value.root }));
  } finally {
    await value.close();
  }
});

test("claims, native trust, and the two attestation kinds fail closed", async () => {
  const value = await buildBaseFixture();
  try {
    const unknownAssurance = structuredClone(value.input);
    unknownAssurance.artifacts[0].assurances.vulnerabilityFree = true;
    await assertCode("RELEASE_EVIDENCE_ASSURANCES_UNKNOWN", () => generateReleaseEvidence({
      descriptor: unknownAssurance,
      baseDir: value.root,
    }));

    const badNativeTrust = structuredClone(value.input);
    badNativeTrust.artifacts[0].nativeTrust.teamId = "not-a-team";
    await assertCode("RELEASE_EVIDENCE_NATIVE_TRUST_INVALID", () => generateReleaseEvidence({
      descriptor: badNativeTrust,
      baseDir: value.root,
    }));

    const swappedAttestation = structuredClone(value.input);
    swappedAttestation.artifacts[0].sbom.attestation.predicateType =
      "https://slsa.dev/provenance/v1";
    await assertCode("RELEASE_EVIDENCE_PROVENANCE_INVALID", () => generateReleaseEvidence({
      descriptor: swappedAttestation,
      baseDir: value.root,
    }));

    const missingSigner = structuredClone(value.input);
    delete missingSigner.artifacts[0].provenance.runUrl;
    await assertCode("RELEASE_EVIDENCE_PROVENANCE_INVALID", () => generateReleaseEvidence({
      descriptor: missingSigner,
      baseDir: value.root,
    }));

    await writeFile(
      value.files.get("TiboTattle-0.1.12-macOS-arm64.sigstore.json"),
      JSON.stringify({
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        verificationMaterial: {},
        dsseEnvelope: {},
      }),
      "utf8",
    );
    await assertCode("RELEASE_EVIDENCE_PROVENANCE_INVALID", () => generateReleaseEvidence({
      descriptor: value.input,
      baseDir: value.root,
    }));

    const malformedRunUrl = structuredClone(value.input);
    malformedRunUrl.artifacts[0].provenance.runUrl =
      "https://github.com/adamallcock/tibotattle/actions/runs/not-a-number";
    await assertCode("RELEASE_EVIDENCE_PROVENANCE_INVALID", () => generateReleaseEvidence({
      descriptor: malformedRunUrl,
      baseDir: value.root,
    }));
  } finally {
    await value.close();
  }
});

test("attestation metadata may name an external reusable signer workflow", async () => {
  const value = await buildBaseFixture();
  try {
    const external = structuredClone(value.input);
    for (const attestation of [
      external.artifacts[0].sbom.attestation,
      external.artifacts[0].provenance,
    ]) {
      attestation.signerRepository = "release-org/trust-workflows";
      attestation.signerWorkflow =
        "release-org/trust-workflows/.github/workflows/sign-release.yml";
      attestation.runUrl =
        "https://github.com/release-org/trust-workflows/actions/runs/987654";
    }
    const manifest = await generateReleaseEvidence({
      descriptor: external,
      baseDir: value.root,
    });
    assert.equal(
      manifest.artifacts[0].provenance.signerRepository,
      "release-org/trust-workflows",
    );
    assert.equal(
      manifest.artifacts[0].sbom.attestation.runUrl,
      "https://github.com/release-org/trust-workflows/actions/runs/987654",
    );
  } finally {
    await value.close();
  }
});

test("validator detects tampered final bytes and SHA256SUMS", async () => {
  const value = await buildBaseFixture();
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });
    const output = await writeReleaseEvidenceFiles({
      manifest,
      manifestPath: join(value.root, "release-manifest.json"),
    });
    await writeFile(value.files.get("TiboTattle-0.1.12-macOS-arm64.dmg"), "tampered");
    await assertCode("RELEASE_EVIDENCE_HASH_MISMATCH", () => validateReleaseEvidenceManifest(manifest, {
      artifactRoot: value.root,
      manifestPath: output.manifestPath,
    }));
    await writeFile(value.files.get("TiboTattle-0.1.12-macOS-arm64.dmg"), "mac artifact");
    await writeFile(output.sumsPath, `${output.sumsText}tampered\n`, "utf8");
    await assertCode("RELEASE_EVIDENCE_SUMS_MISMATCH", () => releaseEvidenceCliMain([
      "--validate",
      "--manifest",
      output.manifestPath,
      "--artifacts-dir",
      value.root,
      "--sha256sums",
      output.sumsPath,
    ]));
  } finally {
    await value.close();
  }
});

test("generator rejects collisions across metadata and attestation filenames", async () => {
  const value = await buildBaseFixture();
  try {
    const secondArtifactName = "TiboTattle-0.1.12-macOS-x64.dmg";
    const secondSbomName = "TiboTattle-0.1.12-macOS-x64.spdx.json";
    const secondProvenanceName = "TiboTattle-0.1.12-macOS-x64.sigstore.json";
    await value.add(secondArtifactName, "second mac artifact");
    await value.add(secondSbomName, sbom("second-mac"));
    await value.add(secondProvenanceName, provenance());
    const second = structuredClone(value.input.artifacts[0]);
    second.architecture = "x64";
    second.path = relative(value.root, value.files.get(secondArtifactName));
    second.fileName = secondArtifactName;
    second.downloadUrl = `https://github.com/adamallcock/tibotattle/releases/download/${RELEASE.tag}/${secondArtifactName}`;
    second.sbom.path = relative(value.root, value.files.get(secondSbomName));
    second.sbom.fileName = secondSbomName;
    second.provenance.path = relative(value.root, value.files.get(secondProvenanceName));
    second.provenance.fileName = secondProvenanceName;
    // This is a different supplied file, but reusing the first public name is
    // still ambiguous in a flat release and must fail closed.
    second.sbom.attestation.path = relative(value.root,
      value.files.get("TiboTattle-0.1.12-macOS-arm64.sbom.sigstore.json"));
    second.sbom.attestation.fileName = "TiboTattle-0.1.12-macOS-arm64.sbom.sigstore.json";
    second.updater = { enabled: false, mechanism: "none" };
    await assertCode("RELEASE_EVIDENCE_DUPLICATE_FILE_NAME", () => generateReleaseEvidence({
      descriptor: { ...value.input, artifacts: [value.input.artifacts[0], second] },
      baseDir: value.root,
    }));
  } finally {
    await value.close();
  }
});

test("default output writing refuses collisions before creating a partial pair", async () => {
  const value = await buildBaseFixture();
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });
    const manifestPath = join(value.root, "release-manifest.json");
    const sumsPath = join(value.root, "SHA256SUMS");
    await writeFile(manifestPath, "existing", "utf8");
    await assertCode("RELEASE_EVIDENCE_OUTPUT_EXISTS", () => writeReleaseEvidenceFiles({
      manifest,
      manifestPath,
      sumsPath,
    }));
    assert.equal(await readFile(manifestPath, "utf8"), "existing");
    await assert.rejects(readFile(sumsPath), { code: "ENOENT" });
  } finally {
    await value.close();
  }
});

test("output writing rejects a directory symlink that escapes the trusted artifact root", async () => {
  const value = await buildBaseFixture();
  const outside = await mkdtemp(join(tmpdir(), "tibotattle-release-output-outside-"));
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });
    const redirected = join(value.root, "redirected-output");
    await symlink(outside, redirected);
    await assertCode("RELEASE_EVIDENCE_UNSAFE_PATH", () => writeReleaseEvidenceFiles({
      manifest,
      manifestPath: join(redirected, "release-manifest.json"),
      artifactRoot: value.root,
    }));
    await assert.rejects(readFile(join(outside, "release-manifest.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(outside, "SHA256SUMS")), { code: "ENOENT" });
  } finally {
    await rm(outside, { recursive: true, force: true });
    await value.close();
  }
});

test("concurrent output writers never overwrite or mix a manifest pair", async () => {
  const value = await buildBaseFixture();
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });
    const manifestPath = join(value.root, "concurrent", "release-manifest.json");
    const attempts = await Promise.allSettled([
      writeReleaseEvidenceFiles({ manifest, manifestPath }),
      writeReleaseEvidenceFiles({ manifest, manifestPath }),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    const rejected = attempts.find((result) => result.status === "rejected");
    assert.ok(["RELEASE_EVIDENCE_OUTPUT_BUSY", "RELEASE_EVIDENCE_OUTPUT_EXISTS"]
      .includes(rejected.reason.code));
    await validateReleaseEvidenceManifest(manifest, {
      artifactRoot: value.root,
      manifestPath,
    });
    await rm(manifestPath, { force: true });
    await rm(join(value.root, "concurrent", "SHA256SUMS"), { force: true });
    await writeReleaseEvidenceFiles({ manifest, manifestPath });
  } finally {
    await value.close();
  }
});

test("SHA256SUMS is stable and includes every supplied final evidence file", async () => {
  const value = await buildBaseFixture();
  try {
    const manifest = await generateReleaseEvidence({ descriptor: value.input, baseDir: value.root });
    const lines = buildSha256Sums(manifest).trim().split("\n");
    assert.equal(lines.length, 6);
    assert.ok(lines.some((line) => line.endsWith("  release-manifest.json")));
    assert.deepEqual(
      lines.map((line) => line.slice(line.indexOf("  ") + 2)),
      [...lines.map((line) => line.slice(line.indexOf("  ") + 2))].sort(),
    );
  } finally {
    await value.close();
  }
});

test("bounded JSON reads fail before accepting oversized metadata", async () => {
  const value = await fixture();
  try {
    const oversized = join(value.root, "oversized.json");
    await writeFile(oversized, Buffer.alloc(65, 0x20));
    await assertCode("RELEASE_EVIDENCE_FILE_TOO_LARGE", () => readJsonFile(
      oversized,
      "oversized metadata",
      64,
    ));
  } finally {
    await value.close();
  }
});
