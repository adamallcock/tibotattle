import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFile } from "node:fs/promises";
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
} from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  downloadSyft,
  prepareReleaseSbom as prepareReleaseSbomProduction,
  ReleaseSbomValidationError,
  MAX_SBOM_BYTES,
  MAX_SYFT_ARCHIVE_BYTES,
  SYFT_RELEASE_ASSETS,
  SYFT_RELEASE_BASE_URL,
  SYFT_VERSION,
  installValidatedReleaseSbom as installValidatedReleaseSbomProduction,
  validateReleaseSbom as validateReleaseSbomProduction,
} from "../scripts/validate-release-sbom.mjs";

// The production API automatically protects action calls with
// GITHUB_WORKSPACE when that variable is present. These wrappers keep the
// existing filesystem-unit tests portable when they deliberately use a
// temporary directory outside the checkout.
const prepareReleaseSbom = (options) => prepareReleaseSbomProduction({
  trustedRoot: null,
  ...options,
});
const validateReleaseSbom = (options) => validateReleaseSbomProduction({
  trustedRoot: null,
  ...options,
});
const installValidatedReleaseSbom = (options) => installValidatedReleaseSbomProduction({
  trustedRoot: null,
  ...options,
});

const ACTION_PATH = new URL(
  "../.github/actions/generate-release-sbom/action.yml",
  import.meta.url,
);
const actionText = await readFile(ACTION_PATH, "utf8");
const validatorText = readFileSync(
  new URL("../scripts/validate-release-sbom.mjs", import.meta.url),
  "utf8",
);

test("SBOM action uses the checked-in immutable Syft downloader", () => {
  assert.match(actionText, /runs:\n  using: composite\n/u);
  assert.match(actionText, /^  scan-path:\n[\s\S]*?required: true/mu);
  assert.match(actionText, /^  output-path:\n[\s\S]*?required: true/mu);
  assert.match(actionText, /generateReleaseSbom\(/u);
  assert.match(actionText, /official Anchore release/u);
  assert.match(actionText, /hardcoded SHA-256/u);
  assert.doesNotMatch(actionText, /^\s*uses:/mu,
    "Syft must not be obtained through a mutable action installer");
  assert.match(actionText, /value: \$\{\{ steps\.validate\.outputs\.sbom-path \}\}/u);
  assert.equal(SYFT_VERSION, "1.51.0");
  assert.match(SYFT_RELEASE_BASE_URL, /^https:\/\/github\.com\/anchore\/syft\/releases\/download\/v1\.51\.0$/u);
  for (const asset of Object.values(SYFT_RELEASE_ASSETS)) {
    assert.match(asset.fileName, /^syft_1\.51\.0_(?:darwin|linux|windows)_/u);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/u);
    assert.match(`${SYFT_RELEASE_BASE_URL}/${asset.fileName}`, /^https:\/\//u);
  }
});

test("Syft archive download rejects an oversized Content-Length before creating the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-sbom-"));
  const destination = join(root, "syft.tar.gz");
  const asset = {
    fileName: "fixture.tar.gz",
    sha256: "0".repeat(64),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(), {
    status: 200,
    headers: { "content-length": String(MAX_SYFT_ARCHIVE_BYTES + 1) },
  });
  try {
    await assert.rejects(
      () => downloadSyft(asset, destination),
      (error) => error instanceof ReleaseSbomValidationError
        && error.code === "RELEASE_SBOM_SYFT_DOWNLOAD_TOO_LARGE",
    );
    await assert.rejects(() => lstat(destination), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Syft archive download enforces the byte limit when Content-Length is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-sbom-"));
  const destination = join(root, "syft.tar.gz");
  const asset = {
    fileName: "fixture.tar.gz",
    sha256: "0".repeat(64),
  };
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  let remaining = MAX_SYFT_ARCHIVE_BYTES + 1;
  const body = new ReadableStream({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const size = Math.min(remaining, chunk.length);
      remaining -= size;
      controller.enqueue(chunk.subarray(0, size));
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try {
    await assert.rejects(
      () => downloadSyft(asset, destination),
      (error) => error instanceof ReleaseSbomValidationError
        && error.code === "RELEASE_SBOM_SYFT_DOWNLOAD_TOO_LARGE",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("SBOM action reserves the exact output and validates it after generation", () => {
  assert.match(actionText, /prepareReleaseSbom\(/u);
  assert.match(actionText, /validateReleaseSbom\(/u);
  assert.match(actionText, /RELEASE_SBOM_SCAN_PATH: \$\{\{ inputs\.scan-path \}\}/u);
  assert.match(actionText, /RELEASE_SBOM_OUTPUT_PATH: \$\{\{ inputs\.output-path \}\}/u);
  assert.match(actionText, /githubOutput: process\.env\.GITHUB_OUTPUT/u);
  assert.match(actionText, /shell: node \{0\}/u);
  assert.match(
    validatorText,
    /prepared\.scanPath,\s*"--base-path",\s*prepared\.scanPath,\s*"-o"/u,
    "Syft must bound filesystem symlink traversal to the finalized payload root",
  );
});

test("protected SBOM output cannot escape its trusted workspace through a directory symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-sbom-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const scanPath = join(workspace, "payload");
  const redirectedParent = join(workspace, "evidence-link");
  await mkdir(scanPath, { recursive: true });
  await mkdir(outside);
  await symlink(outside, redirectedParent);

  assert.throws(
    () => prepareReleaseSbomProduction({
      scanPath,
      outputPath: join(redirectedParent, "payload.spdx.json"),
      trustedRoot: workspace,
    }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_OUTSIDE_TRUSTED_ROOT",
  );
});

test("preflight rejects a stale output and accepts a new exact output path", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-sbom-"));
  const scanPath = join(root, "payload");
  const outputPath = join(root, "evidence", "payload.spdx.json");
  await writeFile(join(root, "placeholder"), "placeholder", "utf8");
  await mkdir(scanPath);

  const prepared = prepareReleaseSbom({ scanPath, outputPath });
  assert.equal(prepared.scanPath, await realpath(scanPath));
  assert.equal(prepared.outputPath,
    join(await realpath(join(root, "evidence")), "payload.spdx.json"));
  await assert.rejects(() => lstat(outputPath), { code: "ENOENT" });

  await writeFile(outputPath, "stale evidence", "utf8");
  assert.throws(
    () => prepareReleaseSbom({ scanPath, outputPath }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_EXISTS",
  );

  assert.throws(
    () => prepareReleaseSbom({
      scanPath,
      outputPath: join(scanPath, "self-referential.spdx.json"),
    }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_INSIDE_SCAN",
  );
});

test("preflight canonicalizes ancestor symlinks and rejects output routed into the scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-sbom-"));
  const scanPath = join(root, "payload");
  const evidence = join(root, "evidence");
  const outsideLink = join(root, "evidence-link");
  await mkdir(scanPath);
  await mkdir(evidence);
  await symlink(evidence, outsideLink);
  const prepared = prepareReleaseSbom({
    scanPath,
    outputPath: join(outsideLink, "nested", "payload.spdx.json"),
  });
  assert.equal(prepared.scanPath, await realpath(scanPath));
  assert.equal(prepared.outputPath,
    join(await realpath(join(evidence, "nested")), "payload.spdx.json"));

  const scanLink = join(root, "scan-link");
  await symlink(scanPath, scanLink);
  assert.throws(
    () => prepareReleaseSbom({
      scanPath,
      outputPath: join(scanLink, "evidence.spdx.json"),
    }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_INSIDE_SCAN",
  );
});

test("postflight requires a regular non-symlink SPDX-2.3 JSON file", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-sbom-"));
  const outputPath = join(root, "payload.spdx.json");
  const githubOutput = join(root, "github-output");

  await writeFile(outputPath, JSON.stringify({
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "TiboTattle payload",
    dataLicense: "CC0-1.0",
    documentNamespace: "https://github.com/adamallcock/tibotattle/sbom/test",
    creationInfo: {
      created: "2026-08-18T00:00:00Z",
      creators: ["Tool: Syft-1.51.0"],
    },
    packages: [],
  }), "utf8");
  const result = validateReleaseSbom({ outputPath, githubOutput });
  const canonicalOutput = join(await realpath(root), "payload.spdx.json");
  assert.equal(result.outputPath, canonicalOutput);
  assert.match(await readFile(githubOutput, "utf8"), new RegExp(`^sbom-path=${canonicalOutput}\\n?$`, "u"));

  await writeFile(outputPath, JSON.stringify({ spdxVersion: "SPDX-2.2" }), "utf8");
  assert.throws(
    () => validateReleaseSbom({ outputPath }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_DOCUMENT_INVALID",
  );

  await writeFile(outputPath, JSON.stringify({
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "missing canonical SPDX fields",
  }), "utf8");
  assert.throws(
    () => validateReleaseSbom({ outputPath }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_DOCUMENT_INVALID",
  );

  await writeFile(outputPath, Buffer.alloc(MAX_SBOM_BYTES + 1, 0x20));
  assert.throws(
    () => validateReleaseSbom({ outputPath }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_SIZE_INVALID",
  );
  await writeFile(outputPath, "", "utf8");
  assert.throws(
    () => validateReleaseSbom({ outputPath }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_SIZE_INVALID",
  );

  const target = join(root, "target.spdx.json");
  await writeFile(target, JSON.stringify({ spdxVersion: "SPDX-2.3" }), "utf8");
  const link = join(root, "symlink.spdx.json");
  await symlink(target, link);
  assert.throws(
    () => validateReleaseSbom({ outputPath: link }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_INVALID",
  );

  const raceTarget = join(root, "race-target.spdx.json");
  await writeFile(raceTarget, JSON.stringify({ spdxVersion: "SPDX-2.3" }), "utf8");
  const raceOutput = join(root, "race-output.spdx.json");
  await mkdir(join(root, "payload"));
  const reserved = prepareReleaseSbom({
    scanPath: join(root, "payload"),
    outputPath: raceOutput,
  });
  await symlink(raceTarget, raceOutput);
  assert.throws(
    () => validateReleaseSbom({ outputPath: raceOutput }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_INVALID",
  );
  assert.equal(reserved.outputPath, join(await realpath(root), "race-output.spdx.json"));
});

test("postflight bounds a replacement created after preflight without reading by path", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-sbom-"));
  const scanPath = join(root, "payload");
  const outputPath = join(root, "evidence", "payload.spdx.json");
  await mkdir(scanPath);
  prepareReleaseSbom({ scanPath, outputPath });

  // Simulate a writer replacing the reserved path before postflight.  A
  // sparse file keeps this race-boundary test cheap while still exercising
  // the hard size limit before JSON parsing or large allocation.
  const descriptor = openSync(outputPath, "wx");
  try {
    ftruncateSync(descriptor, MAX_SBOM_BYTES + 1);
    assert.equal(fstatSync(descriptor).size, MAX_SBOM_BYTES + 1);
  } finally {
    closeSync(descriptor);
  }
  assert.throws(
    () => validateReleaseSbom({ outputPath }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_SIZE_INVALID",
  );
  assert.match(validatorText, /fstatSync/u);
  assert.match(validatorText, /readSync/u);
  assert.doesNotMatch(validatorText, /readFileSync/u,
    "postflight must not allocate from an unbounded path read");
});

test("validated SBOM installation is atomic and preserves a concurrent destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-sbom-"));
  const stagedPath = join(root, "private", "payload.spdx.json");
  const destination = join(root, "evidence", "payload.spdx.json");
  await mkdir(join(root, "private"));
  await mkdir(join(root, "evidence"));
  const document = {
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "TiboTattle payload",
    dataLicense: "CC0-1.0",
    documentNamespace: "https://github.com/adamallcock/tibotattle/sbom/no-clobber",
    creationInfo: {
      created: "2026-08-18T00:00:00Z",
      creators: ["Tool: Syft-1.51.0"],
    },
    packages: [],
  };
  const original = `${JSON.stringify(document)}\n`;
  await writeFile(stagedPath, original, "utf8");

  const installed = installValidatedReleaseSbom({
    stagedOutputPath: stagedPath,
    outputPath: destination,
  });
  assert.equal(installed.outputPath, join(await realpath(root), "evidence", "payload.spdx.json"));
  assert.equal(await readFile(destination, "utf8"), original);

  const competingStage = join(root, "private", "competing.spdx.json");
  await writeFile(competingStage, original.replace("no-clobber", "competing"), "utf8");
  assert.throws(
    () => installValidatedReleaseSbom({
      stagedOutputPath: competingStage,
      outputPath: destination,
    }),
    (error) => error instanceof ReleaseSbomValidationError
      && error.code === "RELEASE_SBOM_OUTPUT_EXISTS",
  );
  assert.equal(await readFile(destination, "utf8"), original,
    "a concurrent destination must never be overwritten");
  assert.match(validatorText, /linkSync\(staged, destination\)/u);
});

test("SBOM action has no mutable action references or publication interfaces", () => {
  const references = [...actionText.matchAll(/^\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/gmu)];
  assert.equal(references.length, 0);
  assert.doesNotMatch(actionText, /(?:gh\s+release|npm\s+publish|curl|wget)\b/iu);
  assert.doesNotMatch(actionText, /(?:with:|env:)[\s\S]*?(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu);
  assert.match(actionText, /validateReleaseSbom\(/u);
});
