import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_REVIEW_ARTIFACT_ROOT,
  localReviewRuntimeComponentPolicy,
  safeExtractLocalReviewArchive,
  sha256File,
  validateExtractedLocalReviewArtifact,
  validateLocalReviewBuildCandidate,
} from "../scripts/lib/local-review-artifact-archive.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function componentDigest(files, prefix) {
  const digest = createHash("sha256");
  const rootedPrefix = `${prefix}/`;
  const rows = [...files.entries()]
    .filter(([path]) => path.startsWith(rootedPrefix))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [path, bytes] of rows) {
    digest.update(path.slice(rootedPrefix.length));
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function octal(value, width) {
  const text = value.toString(8);
  return `${"0".repeat(width - text.length - 1)}${text}\0`;
}

function tarHeader({
  linkName = "",
  mode = 0o644,
  path,
  size,
  type = "0",
}) {
  const header = Buffer.alloc(512, 0);
  const slash = path.length > 100 ? path.lastIndexOf("/") : -1;
  const prefix = slash > 0 ? path.slice(0, slash) : "";
  const name = slash > 0 ? path.slice(slash + 1) : path;
  header.write(name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(1_785_000_000, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function tarBytes(entries, { mutate = null } = {}) {
  const parts = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes ?? "", "utf8");
    const header = tarHeader({
      ...entry,
      size: bytes.length,
    });
    parts.push(header, bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  const archive = Buffer.concat(parts);
  mutate?.(archive);
  return archive;
}

async function writeArchive(root, name, entries, options) {
  const path = join(root, name);
  await writeFile(path, tarBytes(entries, options), { mode: 0o600 });
  return path;
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-archive-test-"));
  await chmod(root, 0o700);
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("safe local-review extraction publishes only owner-readable files", async () => {
  await withRoot(async (root) => {
    const archive = await writeArchive(root, "artifact.tar", [
      {
        bytes: "#!/bin/sh\n",
        mode: 0o755,
        path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/bin/tool`,
      },
      {
        bytes: "{\"safe\":true}\n",
        path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/data.json`,
      },
    ]);
    const extracted = await safeExtractLocalReviewArchive({
      archivePath: archive,
      destinationParent: root,
    });
    assert.equal(extracted.entryCount, 2);
    assert.equal(extracted.ownerOnly, true);
    assert.equal(extracted.archiveSha256, await sha256File(archive));
    assert.equal(
      await readFile(join(extracted.artifactRoot, "data.json"), "utf8"),
      "{\"safe\":true}\n",
    );
    assert.equal(
      (await stat(join(extracted.artifactRoot, "bin", "tool"))).mode & 0o777,
      0o500,
    );
    assert.equal(
      (await stat(join(extracted.artifactRoot, "data.json"))).mode & 0o777,
      0o600,
    );
  });
});

test("safe local-review extraction rejects hostile archive structure", async () => {
  await withRoot(async (root) => {
    const cases = [
      {
        label: "absolute paths",
        entries: [{ path: `/${LOCAL_REVIEW_ARTIFACT_ROOT}/x`, bytes: "x" }],
      },
      {
        label: "traversal",
        entries: [{ path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/../x`, bytes: "x" }],
      },
      {
        label: "unexpected roots",
        entries: [{ path: "another-root/x", bytes: "x" }],
      },
      {
        label: "duplicates",
        entries: [
          { path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/x`, bytes: "x" },
          { path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/x`, bytes: "x" },
        ],
      },
      {
        label: "portable path collisions",
        entries: [
          { path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/A`, bytes: "x" },
          { path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/a`, bytes: "x" },
        ],
      },
      {
        label: "symbolic links",
        entries: [{
          path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/x`,
          bytes: "",
          linkName: "target",
          type: "2",
        }],
      },
      {
        label: "directory records",
        entries: [{
          path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/directory`,
          bytes: "",
          type: "5",
        }],
      },
    ];
    for (const [index, fixture] of cases.entries()) {
      const archive = await writeArchive(
        root,
        `hostile-${index}.tar`,
        fixture.entries,
      );
      await assert.rejects(
        safeExtractLocalReviewArchive({
          archivePath: archive,
          destinationParent: root,
        }),
        { code: "LOCAL_REVIEW_ARCHIVE_INVALID" },
        fixture.label,
      );
    }
  });
});

test("safe local-review extraction enforces checksum and resource bounds", async () => {
  await withRoot(async (root) => {
    const entries = [
      { path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/a`, bytes: "a" },
      { path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/b`, bytes: "bb" },
    ];
    const archive = await writeArchive(root, "bounded.tar", entries);
    await assert.rejects(
      safeExtractLocalReviewArchive({
        archivePath: archive,
        destinationParent: root,
        maximumEntryCount: 1,
      }),
      /entry count exceeded/u,
    );
    await assert.rejects(
      safeExtractLocalReviewArchive({
        archivePath: archive,
        destinationParent: root,
        maximumEntryBytes: 1,
      }),
      /entry exceeded/u,
    );
    const corrupt = await writeArchive(root, "corrupt.tar", [entries[0]], {
      mutate(bytes) {
        bytes[0] ^= 1;
      },
    });
    await assert.rejects(
      safeExtractLocalReviewArchive({
        archivePath: corrupt,
        destinationParent: root,
      }),
      /checksum did not match/u,
    );
    const trailingData = await writeArchive(
      root,
      "trailing-data.tar",
      [entries[0]],
      {
        mutate(bytes) {
          bytes[bytes.length - 512] = 1;
        },
      },
    );
    await assert.rejects(
      safeExtractLocalReviewArchive({
        archivePath: trailingData,
        destinationParent: root,
      }),
      /data after a terminal zero block/u,
    );
    const linkedArchive = join(root, "linked.tar");
    await symlink(archive, linkedArchive);
    await assert.rejects(
      safeExtractLocalReviewArchive({
        archivePath: linkedArchive,
        destinationParent: root,
      }),
      /must not be a symbolic link/u,
    );
  });
});

test("build receipt and extracted manifest bind the exact runtime closure", async () => {
  await withRoot(async (root) => {
    const files = new Map([
      ["bin/usage-monitor-local", Buffer.from("#!/bin/sh\n")],
      ["runtime/bin/node", Buffer.from("node-runtime")],
      [
        "node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
        Buffer.from("keytar-binding"),
      ],
      ...localReviewRuntimeComponentPolicy()
        .filter(({ name }) => name !== "node")
        .map(({ name, version }) => [
          `node_modules/${name}/package.json`,
          Buffer.from(`${JSON.stringify({ name, version })}\n`),
        ]),
    ]);
    const inventory = [...files.entries()].map(([path, bytes]) => ({
      bytes: bytes.length,
      mode: path.startsWith("bin/") || path === "runtime/bin/node"
        ? 0o755
        : 0o600,
      path,
      sha256: sha256(bytes),
    })).sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      schemaVersion: "usage-monitor-local-review-artifact-manifest-v0.1",
      artifactVersion: "0.1.0-alpha.1",
      platform: { architecture: "arm64", os: "darwin" },
      runtime: {
        binarySha256: sha256(files.get("runtime/bin/node")),
        name: "node",
        version: "26.2.0",
      },
      nativeDependencies: [{
        bindingSha256: sha256(files.get(
          "node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
        )),
        name: "@github/keytar",
        version: "7.10.6",
      }],
      localOnly: true,
      transportReady: false,
      externalParticipantsAuthorized: false,
      inventory,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    files.set("artifact-manifest.json", manifestBytes);
    const archiveName = `${LOCAL_REVIEW_ARTIFACT_ROOT}.tar`;
    const archive = await writeArchive(
      root,
      archiveName,
      [...files.entries()].map(([path, bytes]) => ({
        bytes,
        mode: path.startsWith("bin/") || path === "runtime/bin/node"
          ? 0o755
          : 0o600,
        path: `${LOCAL_REVIEW_ARTIFACT_ROOT}/${path}`,
      })),
    );
    const archiveMetadata = await stat(archive);
    const receipt = {
      archive: {
        basename: archiveName,
        bytes: archiveMetadata.size,
        sha256: await sha256File(archive),
      },
      artifactVersion: "0.1.0-alpha.1",
      components: localReviewRuntimeComponentPolicy().map((component) => ({
        ...component,
        sha256: componentDigest(
          files,
          component.name === "node"
            ? "runtime/bin"
            : `node_modules/${component.name}`,
        ),
      })),
      externalParticipantsAuthorized: false,
      firstPartyGraphFiles: 1,
      manifestSha256: sha256(manifestBytes),
      notarization: "not_notarized",
      privacyScan: "passed",
      rootName: LOCAL_REVIEW_ARTIFACT_ROOT,
      schemaVersion: "usage-monitor-local-review-build-receipt-v0.1",
      signing: "unsigned",
      sourceInputSha256: "b".repeat(64),
    };
    const receiptPath = join(root, "build-receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, {
      mode: 0o600,
    });
    const candidate = await validateLocalReviewBuildCandidate({
      archivePath: archive,
      buildReceiptPath: receiptPath,
    });
    const extracted = await safeExtractLocalReviewArchive({
      archivePath: archive,
      destinationParent: root,
    });
    const validated = await validateExtractedLocalReviewArtifact({
      artifactRoot: extracted.artifactRoot,
      buildReceipt: candidate.buildReceipt,
    });
    assert.equal(validated.runCostPayloadFiles, 0);
    assert.equal(validated.runtimePackageCount, 7);
    assert.equal(validated.componentDigestCount, 8);

    const wrongDigestReceipt = structuredClone(candidate.buildReceipt);
    wrongDigestReceipt.components.find(({ name }) => name === "ajv").sha256 =
      "c".repeat(64);
    await assert.rejects(
      validateExtractedLocalReviewArtifact({
        artifactRoot: extracted.artifactRoot,
        buildReceipt: wrongDigestReceipt,
      }),
      /component digest did not match its receipt: ajv/u,
    );

    const manifestPath = join(extracted.artifactRoot, "artifact-manifest.json");
    const originalManifestBytes = await readFile(manifestPath);
    const originalManifest = JSON.parse(originalManifestBytes.toString("utf8"));
    for (const [label, mutate] of [
      [
        "runtime binary digest",
        (value) => { value.runtime.binarySha256 = "d".repeat(64); },
      ],
      [
        "native keytar binding digest",
        (value) => {
          value.nativeDependencies[0].bindingSha256 = "e".repeat(64);
        },
      ],
    ]) {
      const alteredManifest = structuredClone(originalManifest);
      mutate(alteredManifest);
      const alteredManifestBytes = Buffer.from(
        `${JSON.stringify(alteredManifest)}\n`,
      );
      await writeFile(manifestPath, alteredManifestBytes, { mode: 0o600 });
      const alteredReceipt = structuredClone(candidate.buildReceipt);
      alteredReceipt.manifestSha256 = sha256(alteredManifestBytes);
      await assert.rejects(
        validateExtractedLocalReviewArtifact({
          artifactRoot: extracted.artifactRoot,
          buildReceipt: alteredReceipt,
        }),
        /Runtime or native binding digest did not match the manifest bytes/u,
        label,
      );
    }
    await writeFile(manifestPath, originalManifestBytes, { mode: 0o600 });

    receipt.components.push({
      name: "runcost",
      version: "0.2.0",
      sha256: "c".repeat(64),
    });
    const rejectedReceipt = join(root, "rejected-receipt.json");
    await writeFile(rejectedReceipt, `${JSON.stringify(receipt)}\n`, {
      mode: 0o600,
    });
    await assert.rejects(
      validateLocalReviewBuildCandidate({
        archivePath: archive,
        buildReceiptPath: rejectedReceipt,
      }),
      /component set is not exact/u,
    );
  });
});
