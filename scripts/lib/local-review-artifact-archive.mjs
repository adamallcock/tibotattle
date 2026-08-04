import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import {
  basename,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { RELEASE_VERSION } from "../../config/release-manifest.js";

const ARCHIVE_LIMIT_BYTES = 512 * 1024 * 1024;
const ENTRY_LIMIT_BYTES = 256 * 1024 * 1024;
const ENTRY_COUNT_LIMIT = 512;
const MANIFEST_LIMIT_BYTES = 4 * 1024 * 1024;
const BUILD_RECEIPT_LIMIT_BYTES = 512 * 1024;
const TAR_BLOCK_BYTES = 512;
const EXPECTED_ROOT =
  "usage-monitor-local-review-0.1.0-alpha.1-darwin-arm64";
const EXPECTED_COMPONENTS = Object.freeze([
  Object.freeze({
    name: "@app-usagemonitor/identity-core",
    version: RELEASE_VERSION,
  }),
  Object.freeze({ name: "@github/keytar", version: "7.10.6" }),
  Object.freeze({ name: "ajv", version: "8.20.0" }),
  Object.freeze({ name: "fast-deep-equal", version: "3.1.3" }),
  Object.freeze({ name: "fast-uri", version: "3.1.4" }),
  Object.freeze({ name: "json-schema-traverse", version: "1.0.0" }),
  Object.freeze({ name: "node", version: "26.2.0" }),
  Object.freeze({ name: "require-from-string", version: "2.0.2" }),
]);
const EXPECTED_PACKAGE_COMPONENTS = EXPECTED_COMPONENTS.filter(
  ({ name }) => name !== "node",
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ROOT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function fail(message, code = "LOCAL_REVIEW_ARCHIVE_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function localReviewRuntimeComponentPolicy() {
  return EXPECTED_COMPONENTS.map((component) => ({ ...component }));
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function validateBoundedMetadata(metadata, label, maximumBytes) {
  if (
    !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > maximumBytes
  ) {
    fail(`${label} must be a bounded regular file`);
  }
}

async function openBoundedRegularFile(path, label, maximumBytes) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(resolve(path), flags).catch((error) => {
    if (error?.code === "ELOOP") {
      fail(`${label} must not be a symbolic link`);
    }
    if (error?.code === "ENOENT") fail(`${label} is missing`);
    throw error;
  });
  try {
    const metadata = await handle.stat();
    validateBoundedMetadata(metadata, label, maximumBytes);
    return { handle, metadata };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function hashOpenFile(handle, size, label) {
  const hash = createHash("sha256");
  for (let position = 0; position < size; position += 1024 * 1024) {
    const length = Math.min(1024 * 1024, size - position);
    hash.update(await readExact(handle, length, position, label));
  }
  return hash.digest("hex");
}

async function hashBoundedRegularFile(path, label, maximumBytes) {
  const document = await openBoundedRegularFile(path, label, maximumBytes);
  try {
    return {
      bytes: document.metadata.size,
      sha256: await hashOpenFile(
        document.handle,
        document.metadata.size,
        label,
      ),
    };
  } finally {
    await document.handle.close();
  }
}

async function readBoundedJsonDocument(path, label, maximumBytes) {
  const document = await openBoundedRegularFile(path, label, maximumBytes);
  try {
    const bytes = await readExact(
      document.handle,
      document.metadata.size,
      0,
      label,
    );
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`${label} must contain valid JSON`);
    }
    return {
      bytes: document.metadata.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      value,
    };
  } finally {
    await document.handle.close();
  }
}

async function readBoundedJson(path, label, maximumBytes) {
  return (await readBoundedJsonDocument(path, label, maximumBytes)).value;
}

function decodeStringField(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const terminator = field.indexOf(0);
  const content = terminator === -1 ? field : field.subarray(0, terminator);
  if (
    terminator !== -1
    && field.subarray(terminator).some((byte) => byte !== 0)
  ) {
    fail(`Tar ${label} contains bytes after its terminator`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    fail(`Tar ${label} is not valid UTF-8`);
  }
}

function parseOctalField(header, start, length, label) {
  const text = header.subarray(start, start + length).toString("ascii");
  if (!/^[0-7]+[\0 ]*$/u.test(text)) {
    fail(`Tar ${label} is not canonical octal`);
  }
  const digits = text.replace(/[\0 ]+$/u, "");
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`Tar ${label} is outside the supported range`);
  }
  return value;
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function validateHeaderChecksum(header) {
  const expected = parseOctalField(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) fail("Tar header checksum did not match");
}

function safeArchivePath(path, expectedRootName) {
  if (
    path.length === 0
    || Buffer.byteLength(path) > 4096
    || path.startsWith("/")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail("Tar entry path is not a safe portable relative path");
  }
  const parts = path.split("/");
  if (
    parts.length < 2
    || parts[0] !== expectedRootName
    || parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("Tar entry path escaped or used an unexpected artifact root");
  }
  return parts.slice(1).join("/");
}

async function readExact(handle, length, position, label) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (result.bytesRead === 0) fail(`Tar ended inside ${label}`);
    offset += result.bytesRead;
  }
  return bytes;
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (result.bytesWritten === 0) {
      fail("Extracted file write made no progress");
    }
    offset += result.bytesWritten;
  }
}

async function assertOwnerOnlyDirectory(path, label) {
  const metadata = await lstat(path).catch(() => fail(`${label} is missing`));
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    fail(`${label} must be an owner-only real directory`);
  }
  return realpath(path);
}

function parsedHeader(header, expectedRootName) {
  validateHeaderChecksum(header);
  if (
    !header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii"))
    || !header.subarray(263, 265).equals(Buffer.from("00", "ascii"))
  ) {
    fail("Tar entry is not canonical POSIX ustar");
  }
  const type = header[156];
  if (type !== 0 && type !== "0".charCodeAt(0)) {
    fail("Tar entry type is unsupported; links and special files are rejected");
  }
  if (decodeStringField(header, 157, 100, "link name") !== "") {
    fail("Tar regular entry unexpectedly declared a link target");
  }
  const name = decodeStringField(header, 0, 100, "name");
  const prefix = decodeStringField(header, 345, 155, "prefix");
  const archivePath = prefix ? `${prefix}/${name}` : name;
  return {
    archivePath,
    mode: parseOctalField(header, 100, 8, "mode"),
    relativePath: safeArchivePath(archivePath, expectedRootName),
    size: parseOctalField(header, 124, 12, "size"),
  };
}

export async function safeExtractLocalReviewArchive({
  archivePath,
  destinationParent,
  expectedRootName = EXPECTED_ROOT,
  maximumArchiveBytes = ARCHIVE_LIMIT_BYTES,
  maximumEntryBytes = ENTRY_LIMIT_BYTES,
  maximumEntryCount = ENTRY_COUNT_LIMIT,
  maximumExtractedBytes = ARCHIVE_LIMIT_BYTES,
}) {
  if (!SAFE_ROOT_PATTERN.test(expectedRootName)) {
    fail("Expected artifact root name is invalid");
  }
  for (const [label, value] of Object.entries({
    maximumArchiveBytes,
    maximumEntryBytes,
    maximumEntryCount,
    maximumExtractedBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail(`${label} must be a positive safe integer`);
    }
  }
  const canonicalParent = await assertOwnerOnlyDirectory(
    resolve(destinationParent),
    "Extraction parent",
  );
  const archiveDocument = await openBoundedRegularFile(
    resolve(archivePath),
    "Artifact archive",
    maximumArchiveBytes,
  );
  const { handle, metadata: archiveMetadata } = archiveDocument;
  if (archiveMetadata.size % TAR_BLOCK_BYTES !== 0) {
    await handle.close();
    fail("Artifact archive is not block aligned");
  }

  const artifactRoot = join(canonicalParent, expectedRootName);
  let created = false;
  try {
    try {
      await lstat(artifactRoot);
      fail("Extraction target already exists", "LOCAL_REVIEW_EXTRACTION_EXISTS");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await mkdir(artifactRoot, { mode: 0o700 });
    await chmod(artifactRoot, 0o700);
    created = true;
    const entries = [];
    const seen = new Set();
    const portableSeen = new Set();
    const archiveDigest = createHash("sha256");
    let extractedBytes = 0;
    let position = 0;
    let terminalZeroBlocks = 0;

    while (position < archiveMetadata.size) {
      const header = await readExact(
        handle,
        TAR_BLOCK_BYTES,
        position,
        "header",
      );
      position += TAR_BLOCK_BYTES;
      archiveDigest.update(header);
      if (isZeroBlock(header)) {
        terminalZeroBlocks = 1;
        while (position < archiveMetadata.size) {
          const length = Math.min(
            1024 * 1024,
            archiveMetadata.size - position,
          );
          const trailing = await readExact(
            handle,
            length,
            position,
            "terminal padding",
          );
          if (!isZeroBlock(trailing)) {
            fail("Tar contains data after a terminal zero block");
          }
          archiveDigest.update(trailing);
          position += length;
          terminalZeroBlocks += length / TAR_BLOCK_BYTES;
        }
        break;
      }
      if (entries.length >= maximumEntryCount) {
        fail("Tar entry count exceeded its configured bound");
      }
      const parsed = parsedHeader(header, expectedRootName);
      if (parsed.size > maximumEntryBytes) {
        fail("Tar entry exceeded its configured size bound");
      }
      extractedBytes += parsed.size;
      if (extractedBytes > maximumExtractedBytes) {
        fail("Tar extracted bytes exceeded their configured bound");
      }
      const portableKey = parsed.relativePath.normalize("NFC").toLowerCase();
      if (
        seen.has(parsed.relativePath)
        || portableSeen.has(portableKey)
      ) {
        fail("Tar contains a duplicate or portable-path-colliding entry");
      }
      seen.add(parsed.relativePath);
      portableSeen.add(portableKey);

      const outputPath = resolve(artifactRoot, parsed.relativePath);
      if (!outputPath.startsWith(`${artifactRoot}${sep}`)) {
        fail("Tar output path escaped the artifact root");
      }
      const outputParent = resolve(outputPath, "..");
      await mkdir(outputParent, { recursive: true, mode: 0o700 });
      await chmod(outputParent, 0o700);
      const realOutputParent = await realpath(outputParent);
      if (
        realOutputParent !== artifactRoot
        && !realOutputParent.startsWith(`${artifactRoot}${sep}`)
      ) {
        fail("Tar output parent escaped through a symbolic link");
      }

      const executable = (parsed.mode & 0o100) !== 0;
      const publishedMode = executable ? 0o500 : 0o600;
      const openFlags = constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0);
      const outputHandle = await open(outputPath, openFlags, publishedMode)
        .catch((error) => {
          if (error?.code === "EEXIST" || error?.code === "ELOOP") {
            fail("Tar output collided with an existing path");
          }
          throw error;
        });
      const digest = createHash("sha256");
      try {
        let remaining = parsed.size;
        while (remaining > 0) {
          const length = Math.min(remaining, 1024 * 1024);
          const chunk = await readExact(handle, length, position, "entry data");
          position += length;
          remaining -= length;
          digest.update(chunk);
          archiveDigest.update(chunk);
          await writeAll(outputHandle, chunk);
        }
        await outputHandle.sync();
      } finally {
        await outputHandle.close();
      }
      await chmod(outputPath, publishedMode);

      const padding = (TAR_BLOCK_BYTES - (parsed.size % TAR_BLOCK_BYTES))
        % TAR_BLOCK_BYTES;
      if (padding > 0) {
        const paddingBytes = await readExact(
          handle,
          padding,
          position,
          "entry padding",
        );
        if (!isZeroBlock(paddingBytes)) {
          fail("Tar entry padding is not zero-filled");
        }
        archiveDigest.update(paddingBytes);
        position += padding;
      }
      entries.push({
        bytes: parsed.size,
        executable,
        path: parsed.relativePath,
        sha256: digest.digest("hex"),
      });
    }
    if (terminalZeroBlocks < 2) {
      fail("Tar archive is missing its two terminal zero blocks");
    }
    if (entries.length === 0) fail("Tar archive contains no entries");
    return {
      archiveBytes: archiveMetadata.size,
      archiveSha256: archiveDigest.digest("hex"),
      artifactRoot,
      entries,
      entryCount: entries.length,
      extractedBytes,
      ownerOnly: true,
      rootName: expectedRootName,
    };
  } catch (error) {
    if (created) await rm(artifactRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateComponentRows(components) {
  if (!Array.isArray(components) || components.length !== EXPECTED_COMPONENTS.length) {
    fail("Build receipt component set is not exact");
  }
  const rows = new Map();
  const normalized = components.map((component) => {
    if (
      component === null
      || typeof component !== "object"
      || typeof component.name !== "string"
      || typeof component.version !== "string"
      || !SHA256_PATTERN.test(component.sha256)
    ) {
      fail("Build receipt contains an invalid component row");
    }
    if (rows.has(component.name)) {
      fail("Build receipt contains a duplicate component row");
    }
    rows.set(component.name, component);
    return {
      name: component.name,
      version: component.version,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const expected = [...EXPECTED_COMPONENTS]
    .sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
    fail("Build receipt component names or versions changed");
  }
  return rows;
}

export async function validateLocalReviewBuildCandidate({
  archivePath,
  buildReceiptPath,
}) {
  const receiptDocument = await readBoundedJsonDocument(
    buildReceiptPath,
    "Local-review build receipt",
    BUILD_RECEIPT_LIMIT_BYTES,
  );
  const receipt = receiptDocument.value;
  const archiveDocument = await hashBoundedRegularFile(
    archivePath,
    "Local-review archive",
    ARCHIVE_LIMIT_BYTES,
  );
  if (
    receipt?.schemaVersion
      !== "usage-monitor-local-review-build-receipt-v0.1"
    || receipt?.rootName !== EXPECTED_ROOT
    || receipt?.artifactVersion !== "0.1.0-alpha.1"
    || receipt?.archive?.basename !== `${EXPECTED_ROOT}.tar`
    || basename(resolve(archivePath)) !== receipt.archive.basename
    || receipt?.archive?.bytes !== archiveDocument.bytes
    || !SHA256_PATTERN.test(receipt?.archive?.sha256 ?? "")
    || !SHA256_PATTERN.test(receipt?.manifestSha256 ?? "")
    || !SHA256_PATTERN.test(receipt?.sourceInputSha256 ?? "")
    || receipt?.privacyScan !== "passed"
    || receipt?.signing !== "unsigned"
    || receipt?.notarization !== "not_notarized"
    || receipt?.externalParticipantsAuthorized !== false
    || !Number.isSafeInteger(receipt?.firstPartyGraphFiles)
    || receipt.firstPartyGraphFiles < 1
  ) {
    fail("Local-review build receipt did not match its closed contract");
  }
  validateComponentRows(receipt.components);
  const archiveSha256 = archiveDocument.sha256;
  if (archiveSha256 !== receipt.archive.sha256) {
    fail("Local-review archive digest did not match its build receipt");
  }
  return {
    archiveBytes: archiveDocument.bytes,
    archiveSha256,
    buildReceipt: receipt,
    buildReceiptSha256: receiptDocument.sha256,
  };
}

function safeManifestPath(path) {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some(
      (part) => part === "" || part === "." || part === "..",
    )
  ) {
    fail("Artifact manifest contains an unsafe inventory path");
  }
  return path;
}

async function walkExtractedFiles(root, current = root) {
  const rows = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const metadata = await lstat(path);
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      fail("Extracted artifact contains a symbolic link");
    }
    if (entry.isDirectory()) {
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        fail("Extracted artifact contains a non-owner-only directory");
      }
      rows.push(...await walkExtractedFiles(root, path));
    } else if (entry.isFile()) {
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        fail("Extracted artifact contains a non-owner-only file");
      }
      rows.push({
        bytes: metadata.size,
        path: relative(root, path).split(sep).join("/"),
        sha256: await sha256File(path),
      });
    } else {
      fail("Extracted artifact contains an unsupported filesystem entry");
    }
  }
  return rows;
}

async function digestComponentDirectory(root, relativeRoot, actualRows) {
  const prefix = `${relativeRoot}/`;
  const rows = actualRows
    .filter(({ path }) => path.startsWith(prefix))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (rows.length === 0) {
    fail(`Runtime component directory is empty: ${relativeRoot}`);
  }
  const digest = createHash("sha256");
  for (const row of rows) {
    const componentPath = row.path.slice(prefix.length);
    digest.update(componentPath);
    digest.update("\0");
    const document = await openBoundedRegularFile(
      join(root, row.path),
      `Runtime component file ${row.path}`,
      ENTRY_LIMIT_BYTES,
    );
    try {
      for (let position = 0; position < document.metadata.size;
        position += 1024 * 1024) {
        const length = Math.min(
          1024 * 1024,
          document.metadata.size - position,
        );
        digest.update(await readExact(
          document.handle,
          length,
          position,
          `runtime component file ${row.path}`,
        ));
      }
    } finally {
      await document.handle.close();
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

export async function validateExtractedLocalReviewArtifact({
  artifactRoot,
  buildReceipt,
}) {
  const canonicalRoot = await assertOwnerOnlyDirectory(
    resolve(artifactRoot),
    "Extracted artifact root",
  );
  if (basename(canonicalRoot) !== EXPECTED_ROOT) {
    fail("Extracted artifact root name changed");
  }
  const manifestPath = join(canonicalRoot, "artifact-manifest.json");
  const manifestDocument = await readBoundedJsonDocument(
    manifestPath,
    "Extracted artifact manifest",
    MANIFEST_LIMIT_BYTES,
  );
  const manifest = manifestDocument.value;
  const manifestSha256 = manifestDocument.sha256;
  if (
    manifestSha256 !== buildReceipt?.manifestSha256
    || manifest?.schemaVersion
      !== "usage-monitor-local-review-artifact-manifest-v0.1"
    || manifest?.artifactVersion !== "0.1.0-alpha.1"
    || manifest?.platform?.os !== "darwin"
    || manifest?.platform?.architecture !== "arm64"
    || manifest?.runtime?.name !== "node"
    || manifest?.runtime?.version !== "26.2.0"
    || !SHA256_PATTERN.test(manifest?.runtime?.binarySha256 ?? "")
    || manifest?.localOnly !== true
    || manifest?.transportReady !== false
    || manifest?.externalParticipantsAuthorized !== false
    || !Array.isArray(manifest?.inventory)
    || manifest.inventory.length === 0
    || manifest.inventory.length > ENTRY_COUNT_LIMIT
  ) {
    fail("Extracted artifact manifest did not match its closed contract");
  }
  if (
    !Array.isArray(manifest.nativeDependencies)
    || manifest.nativeDependencies.length !== 1
    || manifest.nativeDependencies[0]?.name !== "@github/keytar"
    || manifest.nativeDependencies[0]?.version !== "7.10.6"
    || !SHA256_PATTERN.test(
      manifest.nativeDependencies[0]?.bindingSha256 ?? "",
    )
  ) {
    fail("Extracted artifact native dependency contract changed");
  }

  const expectedRows = new Map();
  const allowedPackageRoots = EXPECTED_PACKAGE_COMPONENTS.map(
    ({ name }) => `node_modules/${name}/`,
  );
  for (const row of manifest.inventory) {
    const path = safeManifestPath(row?.path);
    if (
      expectedRows.has(path)
      || !Number.isSafeInteger(row?.bytes)
      || row.bytes < 0
      || row.bytes > ENTRY_LIMIT_BYTES
      || !SHA256_PATTERN.test(row?.sha256 ?? "")
      || ![0o600, 0o644, 0o755].includes(row?.mode)
    ) {
      fail("Extracted artifact manifest contains an invalid inventory row");
    }
    if (
      path.startsWith("node_modules/")
      && !allowedPackageRoots.some((prefix) => path.startsWith(prefix))
    ) {
      fail("Unexpected package payload entered the local-review artifact");
    }
    expectedRows.set(path, row);
  }
  const actualRows = await walkExtractedFiles(canonicalRoot);
  const actualPaths = actualRows.map(({ path }) => path).sort();
  const expectedPaths = [
    ...expectedRows.keys(),
    "artifact-manifest.json",
  ].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    fail("Extracted artifact files did not exactly match its manifest");
  }
  for (const row of actualRows) {
    if (row.path === "artifact-manifest.json") continue;
    const expected = expectedRows.get(row.path);
    if (
      row.bytes !== expected.bytes
      || row.sha256 !== expected.sha256
    ) {
      fail(`Extracted artifact file failed manifest verification: ${row.path}`);
    }
  }

  const runtimeRow = expectedRows.get("runtime/bin/node");
  const keytarBindingRow = expectedRows.get(
    "node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node",
  );
  if (
    runtimeRow?.sha256 !== manifest.runtime.binarySha256
    || keytarBindingRow?.sha256
      !== manifest.nativeDependencies[0].bindingSha256
  ) {
    fail("Runtime or native binding digest did not match the manifest bytes");
  }

  const componentRows = validateComponentRows(buildReceipt?.components);
  const componentRoots = new Map([
    ["node", "runtime/bin"],
    ...EXPECTED_PACKAGE_COMPONENTS.map(({ name }) => [
      name,
      `node_modules/${name}`,
    ]),
  ]);
  for (const [name, relativeRoot] of componentRoots) {
    const digest = await digestComponentDirectory(
      canonicalRoot,
      relativeRoot,
      actualRows,
    );
    if (digest !== componentRows.get(name).sha256) {
      fail(`Runtime component digest did not match its receipt: ${name}`);
    }
  }

  for (const component of EXPECTED_PACKAGE_COMPONENTS) {
    const packagePath = join(
      canonicalRoot,
      "node_modules",
      ...component.name.split("/"),
      "package.json",
    );
    const metadata = await readBoundedJson(
      packagePath,
      `Runtime package ${component.name}`,
      1024 * 1024,
    );
    if (
      metadata?.name !== component.name
      || metadata?.version !== component.version
    ) {
      fail(`Runtime package identity changed for ${component.name}`);
    }
  }
  return {
    artifactManifestSha256: manifestSha256,
    componentDigestCount: componentRows.size,
    fileCount: actualRows.length,
    nativeDependencyCount: manifest.nativeDependencies.length,
    runCostPayloadFiles: 0,
    runtimePackageCount: EXPECTED_PACKAGE_COMPONENTS.length,
  };
}

export async function filesAreByteIdentical(firstPath, secondPath) {
  const [firstDocument, secondDocument] = await Promise.all([
    openBoundedRegularFile(
      firstPath,
      "First comparison file",
      ARCHIVE_LIMIT_BYTES,
    ),
    openBoundedRegularFile(
      secondPath,
      "Second comparison file",
      ARCHIVE_LIMIT_BYTES,
    ),
  ]);
  try {
    if (firstDocument.metadata.size !== secondDocument.metadata.size) {
      return false;
    }
    for (let position = 0; position < firstDocument.metadata.size;
      position += 1024 * 1024) {
      const length = Math.min(
        1024 * 1024,
        firstDocument.metadata.size - position,
      );
      const [left, right] = await Promise.all([
        readExact(
          firstDocument.handle,
          length,
          position,
          "first comparison file",
        ),
        readExact(
          secondDocument.handle,
          length,
          position,
          "second comparison file",
        ),
      ]);
      if (!left.equals(right)) return false;
    }
    return true;
  } finally {
    await Promise.all([
      firstDocument.handle.close(),
      secondDocument.handle.close(),
    ]);
  }
}

export const LOCAL_REVIEW_ARTIFACT_ROOT = EXPECTED_ROOT;
