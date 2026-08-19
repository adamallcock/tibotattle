import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectReleaseAttestation,
  cleanupFrozenStaging,
  preflightReleaseAttestation,
  verifyAttestationBundle,
} from "../scripts/release-attestation-evidence.mjs";
import {
  GH_RELEASE_ARCHIVES,
  PINNED_GH_OIDC_ISSUER,
  PINNED_GH_VERSION,
} from "../scripts/release-attestation-evidence.mjs";
import { generateReleaseEvidence } from "../scripts/release-evidence.js";

const ACTION_PATH = new URL(
  "../.github/actions/attest-release-artifact/action.yml",
  import.meta.url,
);
const EVIDENCE_SCRIPT_PATH = new URL(
  "../scripts/release-attestation-evidence.mjs",
  import.meta.url,
);
const ACTION_SHA = "1e69f48acb82d1966a394da916b4c1698aa569d6";

const actionText = await readFile(ACTION_PATH, "utf8");
const evidenceScriptText = await readFile(EVIDENCE_SCRIPT_PATH, "utf8");

function ghVersionResult() {
  return { status: 0, stdout: `gh version ${PINNED_GH_VERSION} (2026-08-18)\n` };
}

function versionAwareRunner(handler) {
  return (file, args, options) => args.length === 1 && args[0] === "--version"
    ? ghVersionResult()
    : handler(file, args, options);
}

function attestStep(name) {
  const marker = `id: ${name}`;
  const start = actionText.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const end = actionText.indexOf("\n    - name:", start + marker.length);
  return actionText.slice(start, end === -1 ? actionText.length : end);
}

test("local finalizer action is composite and accepts frozen subject inputs", () => {
  assert.match(actionText, /runs:\n  using: composite\n/u);
  const inputsSection = actionText.slice(
    actionText.indexOf("inputs:\n"),
    actionText.indexOf("\noutputs:\n"),
  );
  assert.doesNotMatch(inputsSection, /^  signer-(?:workflow|digest):/mu,
    "signer identity must not be caller-controlled action input");
  for (const input of [
    "artifact-path",
    "sbom-path",
    "evidence-directory",
    "release-descriptor-path",
  ]) {
    assert.match(
      actionText,
      new RegExp(`^  ${input}:\\n`, "mu"),
      `missing required input ${input}`,
    );
  }
  assert.match(actionText, /shell: node \{0\}/u,
    "preflight and evidence copying should not depend on a platform shell");
});

test("artifact and SBOM attestations use one immutable action revision and exact subject paths", () => {
  const provenance = attestStep("provenance");
  const sbom = attestStep("sbom");
  for (const step of [provenance, sbom]) {
    assert.match(
      step,
      new RegExp(`uses: actions/attest@${ACTION_SHA}\\s+# v4\\.2\\.2`, "u"),
    );
    assert.match(step, /subject-path: \$\{\{ steps\.preflight\.outputs\.frozen-artifact-path \}\}/u);
  }
  assert.match(sbom, /sbom-path: \$\{\{ steps\.preflight\.outputs\.frozen-sbom-path \}\}/u);
  assert.doesNotMatch(provenance, /sbom-path:/u,
    "the provenance attestation must not silently use the SBOM as its subject");
  assert.equal(
    (actionText.match(new RegExp(`actions/attest@${ACTION_SHA}`, "gu")) || []).length,
    2,
    "exactly one provenance and one SBOM attestation are expected",
  );
});

test("bundle paths and digests are explicit outputs, while publication and uploads are absent", () => {
  for (const output of [
    "artifact-sha256",
    "sbom-sha256",
    "provenance-bundle-path",
    "sbom-bundle-path",
    "provenance-bundle-sha256",
    "sbom-bundle-sha256",
    "frozen-artifact-path",
    "frozen-sbom-path",
    "signer-workflow",
    "signer-digest",
    "enriched-release-descriptor-path",
    "enriched-release-descriptor-base-dir",
    "verifier-path",
    "verifier-version",
    "verifier-sha256",
    "verifier-archive-sha256",
  ]) {
    assert.match(actionText, new RegExp(`^  ${output}:\\n`, "mu"));
  }
  assert.match(actionText, /steps\.collect\.outputs\.provenance-bundle-path/u);
  assert.match(actionText, /steps\.collect\.outputs\.sbom-bundle-path/u);
  assert.match(evidenceScriptText, /copyBundleFile\(source, destination, label\)/u);
  assert.match(evidenceScriptText, /copyBundle\(/u);
  assert.match(evidenceScriptText, /gh.*attestation.*verify/u);
  assert.match(evidenceScriptText, /--bundle/u);
  assert.match(evidenceScriptText, /--format/u);
  assert.match(evidenceScriptText, /--cert-oidc-issuer/u);
  assert.match(evidenceScriptText, /--deny-self-hosted-runners/u);
  assert.match(evidenceScriptText, /MAX_GH_ARCHIVE_BYTES/u);
  assert.match(evidenceScriptText, /install-verifier/u);

  assert.doesNotMatch(actionText, /actions\/upload-artifact@/u);
  assert.doesNotMatch(actionText, /actions\/download-artifact@/u);
  assert.doesNotMatch(actionText, /gh\s+(?:release|attestation\s+publish)/u);
  assert.doesNotMatch(actionText, /npm\s+publish/u);
  assert.doesNotMatch(actionText, /github-token:/u,
    "the local action must not accept or forward custom secrets");
  assert.doesNotMatch(actionText, /actions\/attest@v[0-9]/u,
    "mutable action tags are prohibited");
  assert.doesNotMatch(actionText, /runs-on:/u,
    "runner selection belongs to the protected caller workflow");
  assert.match(actionText, /RELEASE_ATTESTATION_GH_PATH: \$\{\{ steps\.verifier\.outputs\.verifier-path \}\}/u);
  assert.match(actionText, /RELEASE_ATTESTATION_GH_VERSION: \$\{\{ steps\.verifier\.outputs\.verifier-version \}\}/u);
});

test("caller permission and deferred manifest-generation boundaries are documented", () => {
  for (const permission of [
    "id-token: write",
    "attestations: write",
    "artifact-metadata: write",
  ]) {
    assert.match(actionText, new RegExp(permission, "u"));
  }
  assert.match(actionText, /generated only after these steps/u);
  assert.match(actionText, /scripts\/generate-release-evidence\.js/u);
  assert.match(evidenceScriptText, /sha256Bytes export is required/u);
  assert.match(actionText, /RELEASE_TRUSTED_REPOSITORY: \$\{\{ github\.repository \}\}/u);
  assert.match(actionText, /RELEASE_TRUSTED_REF: \$\{\{ github\.ref \}\}/u);
  assert.match(actionText, /RELEASE_TRUSTED_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(actionText, /RELEASE_TRUSTED_WORKFLOW_REF: \$\{\{ job\.workflow_ref \|\| github\.workflow_ref \}\}/u);
  assert.match(actionText, /RELEASE_TRUSTED_WORKFLOW_SHA: \$\{\{ job\.workflow_sha \|\| github\.workflow_sha \}\}/u);
  assert.match(actionText, /RELEASE_TRUSTED_SERVER_URL: \$\{\{ github\.server_url \}\}/u);
  assert.match(actionText, /RELEASE_TRUSTED_RUN_ID: \$\{\{ github\.run_id \}\}/u);
  assert.match(actionText, /RELEASE_TRUSTED_RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/u);
  assert.doesNotMatch(actionText, /inputs\.(?:signer-workflow|signer-digest)/u,
    "signer identity must not be caller-controlled action input");
  assert.doesNotMatch(actionText, /RELEASE_SIGNER_(?:WORKFLOW|DIGEST)/u,
    "signer identity must not be caller-controlled environment input");
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-release-attestation-"));
  const artifactPath = join(root, "TiboTattle-test.bin");
  const sbomPath = join(root, "TiboTattle-test.spdx.json");
  const descriptorPath = join(root, "release-descriptor.json");
  const outputPath = join(root, "outputs.txt");
  const evidenceDirectory = join(root, "evidence");
  const verifierPath = join(root, "pinned-gh");
  const verifierBytes = Buffer.from("pinned GitHub CLI verifier fixture\n", "utf8");
  await writeFile(verifierPath, verifierBytes);
  await writeFile(artifactPath, "final frozen artifact\n", "utf8");
  const sbomDocument = {
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "TiboTattle-test",
    documentNamespace: "https://example.test/tibotattle/test",
    dataLicense: "CC0-1.0",
    creationInfo: { created: "2026-08-18T00:00:00Z", creators: ["Tool: test"] },
    packages: [],
  };
  await writeFile(sbomPath, JSON.stringify(sbomDocument), "utf8");
  const descriptor = {
    schemaVersion: "usage-monitor-release-evidence-input-v1",
    product: { name: "TiboTattle" },
    version: "0.1.0",
    tag: "v0.1.0",
    commit: "a".repeat(40),
    repository: "https://github.com/adamallcock/tibotattle",
    artifacts: [{
      platform: "macos",
      channel: "direct",
      architecture: "arm64",
      format: "dmg",
      path: "TiboTattle-test.bin",
      distribution: "github-release",
      downloadUrl: "https://github.com/adamallcock/tibotattle/releases/download/v0.1.0/TiboTattle-test.bin",
      nativeTrust: {
        signerIdentity: "Developer ID Application: TiboTattle (ABCDE12345)",
        teamId: "ABCDE12345",
      },
      build: {
        sourceManifestSha256: "c".repeat(64),
        unsignedPayloadSha256: "d".repeat(64),
      },
      assurances: {
        cleanInstallSmokePassed: true,
        developerIdSigned: true,
        hardenedRuntime: true,
        notarizationAccepted: true,
        ticketStapled: true,
        gatekeeperAssessmentPassed: true,
      },
      updater: { enabled: false, mechanism: "none", metadata: null },
      sbom: { path: "TiboTattle-test.spdx.json" },
    }],
  };
  await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
  return {
    root,
    artifactPath,
    sbomPath,
    descriptorPath,
    releaseDescriptorPath: descriptorPath,
    outputPath,
    evidenceDirectory,
    verifierPath,
    verifierSha256: createHash("sha256").update(verifierBytes).digest("hex"),
    trustedRepository: "adamallcock/tibotattle",
    trustedRef: "refs/tags/v0.1.0",
    trustedSha: "a".repeat(40),
    signerWorkflow: "adamallcock/tibotattle/.github/workflows/release.yml",
    signerDigest: "b".repeat(40),
    trustedWorkflowRef: "adamallcock/tibotattle/.github/workflows/release.yml@refs/tags/v0.1.0",
    trustedWorkflowSha: "b".repeat(40),
    signerRef: "refs/tags/v0.1.0",
    artifactSha256: "9f749ad8036072418507e7e2c7a7650d9cc0745295ae8cfc227a3c2c6b76e0d1",
    trustedServerUrl: "https://github.com",
    trustedRunId: "123456",
    trustedRunAttempt: "1",
    trustedRunUrl: "https://github.com/adamallcock/tibotattle/actions/runs/123456",
    sbomDocument,
  };
}

function verifiedBundle() {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: { tlogEntries: [{ logIndex: "1" }] },
    dsseEnvelope: {
      payload: "cGF5bG9hZA==",
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "c2ln" }],
    },
  };
}

function verifiedResult(fixture, {
  bundlePath,
  subjectPath,
  predicateType,
}) {
  const bundle = verifiedBundle();
  const certificate = {
    certificateIssuer: "GitHub, Inc.",
    subjectAlternativeName: "https://github.com/adamallcock/tibotattle/.github/workflows/release.yml@refs/tags/v0.1.0",
    issuer: "https://token.actions.githubusercontent.com",
    githubWorkflowTrigger: "workflow_dispatch",
    githubWorkflowSHA: fixture.signerDigest,
    githubWorkflowName: "release",
    githubWorkflowRepository: "adamallcock/tibotattle",
    githubWorkflowRef: fixture.signerRef,
    buildSignerURI: "https://github.com/adamallcock/tibotattle/.github/workflows/release.yml@refs/tags/v0.1.0",
    buildSignerDigest: fixture.signerDigest,
    runnerEnvironment: "github-hosted",
    sourceRepositoryURI: "https://github.com/adamallcock/tibotattle",
    sourceRepositoryDigest: fixture.trustedSha,
    sourceRepositoryRef: fixture.trustedRef,
  };
  const statement = {
    subject: [{ name: "TiboTattle-test.bin", digest: { sha256: fixture.artifactSha256 } }],
    predicateType,
    predicate: predicateType === "https://slsa.dev/provenance/v1"
      ? {
          buildDefinition: { buildType: "https://example.invalid/untrusted" },
          runDetails: {
            builder: { id: "https://example.invalid/untrusted" },
            metadata: { invocationId: fixture.trustedRunUrl },
          },
        }
      : structuredClone(fixture.sbomDocument),
  };
  return {
    subjectPath,
    bundlePath,
    bundle: { path: bundlePath, mediaType: bundle.mediaType },
    predicateType,
    statement,
    certificate,
    certificateBackedSignerVerified: true,
    builderId: certificate.buildSignerURI,
    runUrl: fixture.trustedRunUrl,
    runBinding: predicateType === "https://slsa.dev/provenance/v1"
      ? "provenance-invocation"
      : "verification-context-only",
    runnerPolicy: { denySelfHostedRunners: true, runnerEnvironment: "github-hosted" },
    stdout: JSON.stringify([{
      attestation: bundle,
      verificationResult: {
        statement,
        signature: { certificate },
        verifiedTimestamps: [{ kind: "test" }],
      },
    }]),
  };
}

function verifyFixture(fixture, options) {
  return verifiedResult(fixture, options);
}

test("preflight validates SPDX, exact descriptor association, and canonical digests", async () => {
  const fixture = await makeFixture();
  const result = preflightReleaseAttestation({
    ...fixture,
    workspace: process.cwd(),
  });
  assert.match(result.artifactSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.sbomSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.frozenArtifactPath.split("/").at(-1), "TiboTattle-test.bin");
  assert.equal(result.frozenSbomPath.split("/").at(-1), "TiboTattle-test.spdx.json");
  const outputs = await readFile(fixture.outputPath, "utf8");
  assert.match(outputs, new RegExp(`artifact-sha256=${result.artifactSha256}`));
  assert.match(outputs, new RegExp(`sbom-sha256=${result.sbomSha256}`));
  assert.match(outputs, /trusted-run-url=https:\/\/github\.com\/adamallcock\/tibotattle\/actions\/runs\/123456/u);
});

test("preflight rejects same-basename artifact and SBOM staging collisions", async () => {
  const fixture = await makeFixture();
  const collisionDirectory = join(fixture.root, "collision");
  await mkdir(collisionDirectory);
  const collidingArtifact = join(collisionDirectory, "TiboTattle-test.spdx.json");
  await writeFile(collidingArtifact, "collision artifact\n", "utf8");
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
  descriptor.artifacts[0].path = "collision/TiboTattle-test.spdx.json";
  fixture.artifactPath = collidingArtifact;
  await writeFile(fixture.descriptorPath, JSON.stringify(descriptor), "utf8");
  assert.throws(
    () => preflightReleaseAttestation({ ...fixture, workspace: process.cwd() }),
    (error) => error?.code === "RELEASE_ATTESTATION_STAGING_COLLISION",
  );
});

test("preflight rejects a descriptor digest mismatch and symlinked subject", async () => {
  const fixture = await makeFixture();
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
  descriptor.artifacts[0].sha256 = "0".repeat(64);
  await writeFile(fixture.descriptorPath, JSON.stringify(descriptor), "utf8");
  assert.throws(
    () => preflightReleaseAttestation({ ...fixture, workspace: process.cwd() }),
    (error) => error?.code === "RELEASE_ATTESTATION_SUBJECT_MISMATCH",
  );

  const symlinkFixture = await makeFixture();
  const symlinkPath = join(symlinkFixture.root, "artifact-link.bin");
  await symlink(symlinkFixture.artifactPath, symlinkPath);
  assert.throws(
    () => preflightReleaseAttestation({
      ...symlinkFixture,
      artifactPath: symlinkPath,
      workspace: process.cwd(),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_FILE_INVALID",
  );
});

test("preflight requires the canonical SPDX-2.3 release shape", async () => {
  const fixture = await makeFixture();
  const sbom = JSON.parse(await readFile(fixture.sbomPath, "utf8"));
  sbom.spdxVersion = "SPDX-2.2";
  await writeFile(fixture.sbomPath, JSON.stringify(sbom), "utf8");
  assert.throws(
    () => preflightReleaseAttestation({ ...fixture, workspace: process.cwd() }),
    (error) => error?.code === "RELEASE_ATTESTATION_SBOM_INVALID",
  );
  const missingLicenseFixture = await makeFixture();
  const missingLicense = JSON.parse(
    await readFile(missingLicenseFixture.sbomPath, "utf8"),
  );
  delete missingLicense.dataLicense;
  await writeFile(
    missingLicenseFixture.sbomPath,
    JSON.stringify(missingLicense),
    "utf8",
  );
  assert.throws(
    () => preflightReleaseAttestation({
      ...missingLicenseFixture,
      workspace: process.cwd(),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_SBOM_INVALID",
  );
  const oversizedFixture = await makeFixture();
  await writeFile(oversizedFixture.sbomPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  assert.throws(
    () => preflightReleaseAttestation({ ...oversizedFixture, workspace: process.cwd() }),
    (error) => error?.code === "RELEASE_ATTESTATION_SBOM_INVALID",
  );
});

test("preflight binds source identity to the trusted tag context", async () => {
  const fixture = await makeFixture();
  assert.throws(
    () => preflightReleaseAttestation({
      ...fixture,
      trustedRef: "refs/heads/main",
      workspace: process.cwd(),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_TRUST_CONTEXT_INVALID",
  );
  assert.throws(
    () => preflightReleaseAttestation({
      ...fixture,
      trustedRepository: "evil/example",
      workspace: process.cwd(),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_SOURCE_MISMATCH",
  );
});

test("preflight permits a trusted reusable signer workflow ref distinct from the release tag", async () => {
  const fixture = await makeFixture();
  fixture.trustedWorkflowRef =
    "adamallcock/tibotattle/.github/workflows/reusable-release.yml@refs/heads/release-workflow";
  const result = preflightReleaseAttestation({
    ...fixture,
    workspace: process.cwd(),
  });
  assert.equal(result.signer.signerWorkflow,
    "adamallcock/tibotattle/.github/workflows/reusable-release.yml");
  assert.equal(result.signer.signerDigest, fixture.trustedWorkflowSha);
});

test("bundle verification invokes gh with exact source, signer, predicate, and runner policy", async () => {
  const fixture = await makeFixture();
  const bundlePath = join(fixture.root, "bundle.json");
  await writeFile(bundlePath, JSON.stringify(verifiedBundle()), "utf8");
  const fixtureOutput = JSON.parse(verifiedResult(fixture, {
    bundlePath,
    subjectPath: fixture.artifactPath,
    predicateType: "https://slsa.dev/provenance/v1",
  }).stdout);
  assert.deepEqual(Object.keys(fixtureOutput[0]).sort(), [
    "attestation",
    "verificationResult",
  ]);
  assert.equal(fixtureOutput[0].attestation.path, undefined,
    "the attestation fixture must mirror the raw Sigstore bundle, not add a local path");
  assert.equal(fixtureOutput[0].verificationResult.signature.certificate.sourceRepositoryRef,
    fixture.trustedRef);
  let invocation;
  verifyAttestationBundle({
    subjectPath: fixture.artifactPath,
    bundlePath,
    repository: fixture.trustedRepository,
    sourceRef: fixture.trustedRef,
    sourceDigest: fixture.trustedSha,
    signerWorkflow: fixture.signerWorkflow,
    signerDigest: fixture.signerDigest,
    signerRef: fixture.signerRef,
    trustedRunUrl: fixture.trustedRunUrl,
    predicateType: "https://slsa.dev/provenance/v1",
    verifierPath: fixture.verifierPath,
    verifierSha256: fixture.verifierSha256,
    runner: versionAwareRunner((file, args, options) => {
      invocation = { file, args, options };
      const verification = verifiedResult(fixture, {
        bundlePath,
        subjectPath: fixture.artifactPath,
        predicateType: "https://slsa.dev/provenance/v1",
      });
      return { status: 0, stdout: verification.stdout };
    }),
  });
  assert.equal(invocation.file, await realpath(fixture.verifierPath));
  assert.ok(invocation.args.includes("--bundle"));
  assert.ok(invocation.args.includes("--source-ref"));
  assert.ok(invocation.args.includes(fixture.trustedRef));
  assert.ok(invocation.args.includes("--source-digest"));
  assert.ok(invocation.args.includes(fixture.trustedSha));
  assert.ok(invocation.args.includes("--signer-workflow"));
  assert.ok(invocation.args.includes(fixture.signerWorkflow));
  assert.ok(invocation.args.includes("--signer-digest"));
  assert.ok(invocation.args.includes(fixture.signerDigest));
  assert.ok(invocation.args.includes("--predicate-type"));
  assert.ok(invocation.args.includes("--cert-oidc-issuer"));
  assert.ok(invocation.args.includes(PINNED_GH_OIDC_ISSUER));
  assert.ok(invocation.args.includes("--deny-self-hosted-runners"));
  assert.deepEqual(invocation.options, { encoding: "utf8", windowsHide: true });
});

test("the verifier archive matrix is pinned for every supported runner", () => {
  assert.deepEqual(Object.keys(GH_RELEASE_ARCHIVES).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  for (const [platform, archive] of Object.entries(GH_RELEASE_ARCHIVES)) {
    assert.match(archive.archive, new RegExp(`^gh_${PINNED_GH_VERSION.replaceAll(".", "\\.")}_`, "u"));
    assert.match(archive.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(["zip", "tar.gz"].includes(archive.format), platform);
  }
  assert.match(actionText, /Install pinned GitHub CLI verifier/u);
  assert.match(actionText, /verifier-archive-sha256/u);
  assert.match(evidenceScriptText, /official release archive/u);
  assert.match(evidenceScriptText, /content-length/u);
});

test("verification requires immutable timestamps and exact provenance invocation binding", async () => {
  const fixture = await makeFixture();
  const bundlePath = join(fixture.root, "binding.bundle.json");
  await writeFile(bundlePath, JSON.stringify(verifiedBundle()), "utf8");
  const common = {
    subjectPath: fixture.artifactPath,
    bundlePath,
    repository: fixture.trustedRepository,
    sourceRef: fixture.trustedRef,
    sourceDigest: fixture.trustedSha,
    signerWorkflow: fixture.signerWorkflow,
    signerDigest: fixture.signerDigest,
    signerRef: fixture.signerRef,
    trustedRunUrl: fixture.trustedRunUrl,
    predicateType: "https://slsa.dev/provenance/v1",
    verifierPath: fixture.verifierPath,
    verifierSha256: fixture.verifierSha256,
  };
  assert.throws(
    () => verifyAttestationBundle({
      ...common,
      runner: versionAwareRunner(() => {
        const output = JSON.parse(verifiedResult(fixture, {
          bundlePath,
          subjectPath: fixture.artifactPath,
          predicateType: common.predicateType,
        }).stdout);
        output[0].verificationResult.verifiedTimestamps = [];
        return { status: 0, stdout: JSON.stringify(output) };
      }),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_VERIFICATION_TIMESTAMP_INVALID",
  );
  assert.throws(
    () => verifyAttestationBundle({
      ...common,
      runner: versionAwareRunner(() => {
        const output = JSON.parse(verifiedResult(fixture, {
          bundlePath,
          subjectPath: fixture.artifactPath,
          predicateType: common.predicateType,
        }).stdout);
        delete output[0].verificationResult.statement.predicate.runDetails.metadata.invocationId;
        return { status: 0, stdout: JSON.stringify(output) };
      }),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_RUN_MISMATCH",
  );
  const sbomVerification = verifyAttestationBundle({
    ...common,
    predicateType: "https://spdx.dev/Document/v2.3",
    runner: versionAwareRunner(() => ({
      status: 0,
      stdout: verifiedResult(fixture, {
        bundlePath,
        subjectPath: fixture.artifactPath,
        predicateType: "https://spdx.dev/Document/v2.3",
      }).stdout,
    })),
  });
  assert.equal(sbomVerification.runBinding, "verification-context-only");
});

test("verification rejects a different GitHub CLI version before reading attestation output", async () => {
  const fixture = await makeFixture();
  const bundlePath = join(fixture.root, "version.bundle.json");
  await writeFile(bundlePath, JSON.stringify(verifiedBundle()), "utf8");
  assert.throws(
    () => verifyAttestationBundle({
      subjectPath: fixture.artifactPath,
      bundlePath,
      repository: fixture.trustedRepository,
      sourceRef: fixture.trustedRef,
      sourceDigest: fixture.trustedSha,
      signerWorkflow: fixture.signerWorkflow,
      signerDigest: fixture.signerDigest,
      signerRef: fixture.signerRef,
      trustedRunUrl: fixture.trustedRunUrl,
      predicateType: "https://slsa.dev/provenance/v1",
      verifierPath: fixture.verifierPath,
      verifierSha256: "0".repeat(64),
      runner: versionAwareRunner(() => ({ status: 0, stdout: "[]" })),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_VERIFIER_HASH_MISMATCH",
  );
  assert.throws(
    () => verifyAttestationBundle({
      subjectPath: fixture.artifactPath,
      bundlePath,
      repository: fixture.trustedRepository,
      sourceRef: fixture.trustedRef,
      sourceDigest: fixture.trustedSha,
      signerWorkflow: fixture.signerWorkflow,
      signerDigest: fixture.signerDigest,
      signerRef: fixture.signerRef,
      trustedRunUrl: fixture.trustedRunUrl,
      predicateType: "https://slsa.dev/provenance/v1",
      verifierPath: fixture.verifierPath,
      verifierSha256: fixture.verifierSha256,
      runner: (file, args) => args[0] === "--version"
        ? { status: 0, stdout: "gh version 2.95.0 (2026-08-18)\n" }
        : { status: 0, stdout: "[]" },
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_VERIFIER_VERSION_MISMATCH",
  );
});

test("collect rechecks frozen subjects, copies both bundles, and rejects output collisions", async () => {
  const fixture = await makeFixture();
  const preflight = preflightReleaseAttestation({
    ...fixture,
    workspace: process.cwd(),
  });
  const provenanceSource = join(fixture.root, "attestation-provenance.json");
  const sbomSource = join(fixture.root, "attestation-sbom.json");
  await writeFile(provenanceSource, JSON.stringify(verifiedBundle()), "utf8");
  await writeFile(sbomSource, JSON.stringify(verifiedBundle()), "utf8");
  const collected = collectReleaseAttestation({
    ...fixture,
    frozenArtifactPath: preflight.frozenArtifactPath,
    frozenSbomPath: preflight.frozenSbomPath,
    expectedArtifactSha256: preflight.artifactSha256,
    expectedSbomSha256: preflight.sbomSha256,
    expectedDescriptorSha256: preflight.descriptorSha256,
    provenanceBundlePath: provenanceSource,
    sbomBundlePath: sbomSource,
    verifyBundle: (options) => verifyFixture(fixture, options),
    cleanupStaging: false,
  });
  assert.equal(
    collected.provenanceBundlePath,
    join(await realpath(fixture.evidenceDirectory), "TiboTattle-test.bin.provenance.bundle.json"),
  );
  assert.equal(
    collected.sbomBundlePath,
    join(await realpath(fixture.evidenceDirectory), "TiboTattle-test.bin.sbom.bundle.json"),
  );
  assert.equal(await readFile(collected.provenanceBundlePath, "utf8"),
    await readFile(provenanceSource, "utf8"));
  assert.equal(await readFile(collected.sbomBundlePath, "utf8"),
    await readFile(sbomSource, "utf8"));
  const enriched = JSON.parse(await readFile(collected.enrichedReleaseDescriptorPath, "utf8"));
  const enrichedArtifact = enriched.artifacts[0];
  assert.equal(enrichedArtifact.provenance.mediaType,
    "application/vnd.dev.sigstore.bundle.v0.3+json");
  assert.equal(enrichedArtifact.provenance.predicateType,
    "https://slsa.dev/provenance/v1");
  assert.equal(enrichedArtifact.provenance.builderId,
    "https://github.com/adamallcock/tibotattle/.github/workflows/release.yml@refs/tags/v0.1.0");
  assert.equal(enrichedArtifact.provenance.runUrl, fixture.trustedRunUrl);
  assert.equal(enrichedArtifact.provenance.signerRepository, fixture.trustedRepository);
  assert.equal(enrichedArtifact.provenance.signerWorkflow, fixture.signerWorkflow);
  assert.equal(enrichedArtifact.provenance.signerDigest, fixture.signerDigest);
  assert.equal(enrichedArtifact.provenance.denySelfHostedRunners, true);
  assert.equal(enrichedArtifact.sbom.attestation.sha256, collected.sbomBundleSha256);
  assert.equal(collected.enrichedReleaseDescriptorBaseDir,
    await realpath(fixture.root));
  const generatedManifest = await generateReleaseEvidence({
    descriptor: enriched,
    baseDir: collected.enrichedReleaseDescriptorBaseDir,
  });
  assert.equal(generatedManifest.artifacts[0].provenance.predicateType,
    "https://slsa.dev/provenance/v1");
  assert.equal(generatedManifest.artifacts[0].sbom.attestation.sha256,
    collected.sbomBundleSha256);

  // A second evidence directory still resolves the enriched descriptor to the
  // shared trusted root. The existing descriptor must win, and only the
  // second invocation's own copied bundles may be rolled back.
  const secondEvidenceDirectory = join(fixture.root, "second-evidence");
  await mkdir(secondEvidenceDirectory);
  const secondProvenanceSource = join(fixture.root, "second-provenance.json");
  const secondSbomSource = join(fixture.root, "second-sbom.json");
  await writeFile(secondProvenanceSource, JSON.stringify(verifiedBundle()), "utf8");
  await writeFile(secondSbomSource, JSON.stringify(verifiedBundle()), "utf8");
  const secondPreflight = preflightReleaseAttestation({
    ...fixture,
    evidenceDirectory: secondEvidenceDirectory,
    workspace: process.cwd(),
  });
  assert.throws(
    () => collectReleaseAttestation({
      ...fixture,
      evidenceDirectory: secondEvidenceDirectory,
      frozenArtifactPath: secondPreflight.frozenArtifactPath,
      frozenSbomPath: secondPreflight.frozenSbomPath,
      expectedArtifactSha256: secondPreflight.artifactSha256,
      expectedSbomSha256: secondPreflight.sbomSha256,
      expectedDescriptorSha256: secondPreflight.descriptorSha256,
      provenanceBundlePath: secondProvenanceSource,
      sbomBundlePath: secondSbomSource,
      verifyBundle: (options) => verifyFixture(fixture, options),
      cleanupStaging: false,
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_DESCRIPTOR_OUTPUT_EXISTS",
  );
  const secondEvidencePath = await realpath(secondEvidenceDirectory);
  assert.throws(
    () => lstatSync(join(secondEvidencePath, "TiboTattle-test.bin.provenance.bundle.json")),
    { code: "ENOENT" },
  );
  assert.throws(
    () => lstatSync(join(secondEvidencePath, "TiboTattle-test.bin.sbom.bundle.json")),
    { code: "ENOENT" },
  );

  await writeFile(fixture.artifactPath, "changed after attestation preflight\n", "utf8");
  assert.throws(
    () => collectReleaseAttestation({
      ...fixture,
      frozenArtifactPath: preflight.frozenArtifactPath,
      frozenSbomPath: preflight.frozenSbomPath,
      expectedArtifactSha256: preflight.artifactSha256,
      expectedSbomSha256: preflight.sbomSha256,
      expectedDescriptorSha256: preflight.descriptorSha256,
      provenanceBundlePath: provenanceSource,
      sbomBundlePath: sbomSource,
      verifyBundle: (options) => verifyFixture(fixture, options),
      cleanupStaging: false,
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_SUBJECT_CHANGED",
  );

  // Restore the frozen subject so this assertion exercises the output guard,
  // not the changed-subject guard.
  await writeFile(fixture.artifactPath, "final frozen artifact\n", "utf8");
  assert.throws(
    () => collectReleaseAttestation({
      ...fixture,
      frozenArtifactPath: preflight.frozenArtifactPath,
      frozenSbomPath: preflight.frozenSbomPath,
      expectedArtifactSha256: preflight.artifactSha256,
      expectedSbomSha256: preflight.sbomSha256,
      expectedDescriptorSha256: preflight.descriptorSha256,
      provenanceBundlePath: provenanceSource,
      sbomBundlePath: sbomSource,
      verifyBundle: (options) => verifyFixture(fixture, options),
      cleanupStaging: false,
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_OUTPUT_EXISTS",
  );
});

test("collect binds the verified SBOM predicate to the exact frozen SPDX document", async () => {
  const fixture = await makeFixture();
  const preflight = preflightReleaseAttestation({
    ...fixture,
    workspace: process.cwd(),
  });
  const provenanceSource = join(fixture.root, "predicate-provenance.json");
  const sbomSource = join(fixture.root, "predicate-sbom.json");
  await writeFile(provenanceSource, JSON.stringify(verifiedBundle()), "utf8");
  await writeFile(sbomSource, JSON.stringify(verifiedBundle()), "utf8");
  assert.throws(
    () => collectReleaseAttestation({
      ...fixture,
      frozenArtifactPath: preflight.frozenArtifactPath,
      frozenSbomPath: preflight.frozenSbomPath,
      expectedArtifactSha256: preflight.artifactSha256,
      expectedSbomSha256: preflight.sbomSha256,
      expectedDescriptorSha256: preflight.descriptorSha256,
      provenanceBundlePath: provenanceSource,
      sbomBundlePath: sbomSource,
      verifyBundle: (options) => {
        const result = verifyFixture(fixture, options);
        if (options.predicateType === "https://spdx.dev/Document/v2.3") {
          result.statement.predicate.name = "a different valid SPDX document";
        }
        return result;
      },
      cleanupStaging: false,
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_SBOM_PREDICATE_MISMATCH",
  );
});

test("enriched descriptors rebase nested updater paths to the emitted base directory", async () => {
  const fixture = await makeFixture();
  const nested = join(fixture.root, "descriptors", "nested");
  const metadataDirectory = join(fixture.root, "metadata");
  await mkdir(nested, { recursive: true });
  await mkdir(metadataDirectory);
  await writeFile(join(metadataDirectory, "appcast.xml"), "<rss />\n", "utf8");
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
  descriptor.artifacts[0].path = "../../TiboTattle-test.bin";
  descriptor.artifacts[0].sbom.path = "../../TiboTattle-test.spdx.json";
  descriptor.artifacts[0].updater = {
    enabled: true,
    mechanism: "sparkle",
    metadata: { path: "../../metadata/appcast.xml" },
  };
  fixture.descriptorPath = join(nested, "release-descriptor.json");
  fixture.releaseDescriptorPath = fixture.descriptorPath;
  await writeFile(fixture.descriptorPath, JSON.stringify(descriptor), "utf8");
  const preflight = preflightReleaseAttestation({
    ...fixture,
    workspace: process.cwd(),
  });
  const provenanceSource = join(fixture.root, "nested-provenance.json");
  const sbomSource = join(fixture.root, "nested-sbom.json");
  await writeFile(provenanceSource, JSON.stringify(verifiedBundle()), "utf8");
  await writeFile(sbomSource, JSON.stringify(verifiedBundle()), "utf8");
  const collected = collectReleaseAttestation({
    ...fixture,
    frozenArtifactPath: preflight.frozenArtifactPath,
    frozenSbomPath: preflight.frozenSbomPath,
    expectedArtifactSha256: preflight.artifactSha256,
    expectedSbomSha256: preflight.sbomSha256,
    expectedDescriptorSha256: preflight.descriptorSha256,
    provenanceBundlePath: provenanceSource,
    sbomBundlePath: sbomSource,
    verifyBundle: (options) => verifyFixture(fixture, options),
    cleanupStaging: false,
  });
  const enriched = JSON.parse(
    await readFile(collected.enrichedReleaseDescriptorPath, "utf8"),
  );
  assert.equal(enriched.artifacts[0].updater.metadata.path, "metadata/appcast.xml");
  const manifest = await generateReleaseEvidence({
    descriptor: enriched,
    baseDir: collected.enrichedReleaseDescriptorBaseDir,
  });
  assert.equal(manifest.artifacts[0].updater.metadata.fileName, "appcast.xml");
});

test("collect rolls back a provenance bundle when the SBOM bundle copy fails", async () => {
  const fixture = await makeFixture();
  const preflight = preflightReleaseAttestation({
    ...fixture,
    workspace: process.cwd(),
  });
  const provenanceSource = join(fixture.root, "rollback-provenance.json");
  const sbomSource = join(fixture.root, "rollback-sbom.json");
  await writeFile(provenanceSource, JSON.stringify(verifiedBundle()), "utf8");
  await writeFile(sbomSource, JSON.stringify(verifiedBundle()), "utf8");
  let copyCount = 0;
  const copyBundle = (source, destination) => {
    copyCount += 1;
    if (copyCount === 2) throw new Error("injected SBOM copy failure");
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    return lstatSync(destination);
  };
  assert.throws(
    () => collectReleaseAttestation({
      ...fixture,
      frozenArtifactPath: preflight.frozenArtifactPath,
      frozenSbomPath: preflight.frozenSbomPath,
      expectedArtifactSha256: preflight.artifactSha256,
      expectedSbomSha256: preflight.sbomSha256,
      expectedDescriptorSha256: preflight.descriptorSha256,
      provenanceBundlePath: provenanceSource,
      sbomBundlePath: sbomSource,
      verifyBundle: (options) => verifyFixture(fixture, options),
      copyBundle,
      cleanupStaging: false,
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_OUTPUT_WRITE_FAILED",
  );
  const evidencePath = await realpath(fixture.evidenceDirectory);
  assert.throws(
    () => lstatSync(join(evidencePath, "TiboTattle-test.bin.provenance.bundle.json")),
    { code: "ENOENT" },
  );
});

test("ancestor symlinks are canonicalized before generated evidence outputs", async () => {
  const fixture = await makeFixture();
  const realEvidence = join(fixture.root, "real-evidence");
  const linkedParent = join(fixture.root, "linked-parent");
  await mkdir(realEvidence);
  await symlink(realEvidence, linkedParent);
  fixture.evidenceDirectory = join(linkedParent, "nested");
  const preflight = preflightReleaseAttestation({ ...fixture, workspace: process.cwd() });
  const provenanceSource = join(fixture.root, "ancestor-provenance.json");
  const sbomSource = join(fixture.root, "ancestor-sbom.json");
  await writeFile(provenanceSource, JSON.stringify(verifiedBundle()), "utf8");
  await writeFile(sbomSource, JSON.stringify(verifiedBundle()), "utf8");
  const collected = collectReleaseAttestation({
    ...fixture,
    frozenArtifactPath: preflight.frozenArtifactPath,
    frozenSbomPath: preflight.frozenSbomPath,
    expectedArtifactSha256: preflight.artifactSha256,
    expectedSbomSha256: preflight.sbomSha256,
    expectedDescriptorSha256: preflight.descriptorSha256,
    provenanceBundlePath: provenanceSource,
    sbomBundlePath: sbomSource,
    verifyBundle: (options) => verifyFixture(fixture, options),
    cleanupStaging: false,
  });
  assert.equal(
    collected.provenanceBundlePath,
    join(await realpath(join(realEvidence, "nested")), "TiboTattle-test.bin.provenance.bundle.json"),
  );
});

test("frozen staging cleanup removes only the original device/inode and survives symlink replacement", async () => {
  const fixture = await makeFixture();
  const preflight = preflightReleaseAttestation({ ...fixture, workspace: process.cwd() });
  const provenanceSource = join(fixture.root, "cleanup-provenance.json");
  const sbomSource = join(fixture.root, "cleanup-sbom.json");
  await writeFile(provenanceSource, JSON.stringify(verifiedBundle()), "utf8");
  await writeFile(sbomSource, JSON.stringify(verifiedBundle()), "utf8");
  collectReleaseAttestation({
    ...fixture,
    frozenArtifactPath: preflight.frozenArtifactPath,
    frozenSbomPath: preflight.frozenSbomPath,
    expectedArtifactSha256: preflight.artifactSha256,
    expectedSbomSha256: preflight.sbomSha256,
    expectedDescriptorSha256: preflight.descriptorSha256,
    provenanceBundlePath: provenanceSource,
    sbomBundlePath: sbomSource,
    verifyBundle: (options) => verifyFixture(fixture, options),
  });
  assert.throws(() => lstatSync(preflight.frozenArtifactPath), { code: "ENOENT" });
  assert.throws(() => lstatSync(preflight.frozenSbomPath), { code: "ENOENT" });

  const stagingDirectory = await mkdtemp(join(tmpdir(), "tibotattle-release-frozen-"));
  const replacementRoot = await mkdtemp(join(tmpdir(), "tibotattle-cleanup-target-"));
  const replacementArtifact = join(replacementRoot, "preserve-me.txt");
  await writeFile(join(stagingDirectory, "artifact.bin"), "artifact\n", "utf8");
  await writeFile(join(stagingDirectory, "sbom.json"), "sbom\n", "utf8");
  const replacementStagingIdentity = {
    directory: lstatSync(stagingDirectory),
    artifact: lstatSync(join(stagingDirectory, "artifact.bin")),
    sbom: lstatSync(join(stagingDirectory, "sbom.json")),
  };
  await writeFile(replacementArtifact, "must survive\n", "utf8");
  const movedDirectory = `${stagingDirectory}-moved`;
  await rename(stagingDirectory, movedDirectory);
  await symlink(replacementRoot, stagingDirectory);
  assert.throws(
    () => cleanupFrozenStaging(
      join(stagingDirectory, "artifact.bin"),
      join(stagingDirectory, "sbom.json"),
      replacementStagingIdentity,
    ),
    (error) => error?.code === "RELEASE_ATTESTATION_STAGING_INVALID",
  );
  assert.equal(await readFile(replacementArtifact, "utf8"), "must survive\n");
});

test("collect rechecks original/frozen subjects and descriptor after verification", async () => {
  for (const target of [
    "original-sbom",
    "frozen-sbom",
    "original-artifact",
    "frozen-artifact",
    "descriptor",
  ]) {
    const fixture = await makeFixture();
    const preflight = preflightReleaseAttestation({
      ...fixture,
      workspace: process.cwd(),
    });
    const provenanceSource = join(fixture.root, `${target}-provenance.json`);
    const sbomSource = join(fixture.root, `${target}-sbom.json`);
    await writeFile(provenanceSource, JSON.stringify(verifiedBundle()), "utf8");
    await writeFile(sbomSource, JSON.stringify(verifiedBundle()), "utf8");
    let calls = 0;
    assert.throws(
      () => collectReleaseAttestation({
        ...fixture,
        frozenArtifactPath: preflight.frozenArtifactPath,
        frozenSbomPath: preflight.frozenSbomPath,
        expectedArtifactSha256: preflight.artifactSha256,
        expectedSbomSha256: preflight.sbomSha256,
        expectedDescriptorSha256: preflight.descriptorSha256,
        provenanceBundlePath: provenanceSource,
        sbomBundlePath: sbomSource,
        verifyBundle: (options) => {
          calls += 1;
          if (target === "descriptor" && calls === 2) {
            writeFileSync(
              fixture.descriptorPath,
              "descriptor mutated after verification\n",
              "utf8",
            );
          } else if (calls === (target.startsWith("original-") ? 1 : 2)) {
            writeFileSync(
              target === "original-sbom"
                ? fixture.sbomPath
                : target === "frozen-sbom"
                  ? preflight.frozenSbomPath
                  : target === "original-artifact"
                    ? fixture.artifactPath
                    : preflight.frozenArtifactPath,
              "mutated after verification\n",
              "utf8",
            );
          }
          return verifyFixture(fixture, options);
        },
        cleanupStaging: false,
      }),
      (error) => error?.code === (target === "descriptor"
        ? "RELEASE_ATTESTATION_DESCRIPTOR_CHANGED"
        : "RELEASE_ATTESTATION_SUBJECT_CHANGED"),
    );
    const evidencePath = await realpath(fixture.evidenceDirectory);
    assert.throws(
      () => lstatSync(join(evidencePath, "TiboTattle-test.bin.provenance.bundle.json")),
      { code: "ENOENT" },
    );
    assert.throws(
      () => lstatSync(join(evidencePath, "TiboTattle-test.bin.sbom.bundle.json")),
      { code: "ENOENT" },
    );
  }
});

test("preflight bounds descriptor bytes and artifact count before descriptor matching", async () => {
  const oversized = await makeFixture();
  await writeFile(oversized.descriptorPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
  assert.throws(
    () => preflightReleaseAttestation({ ...oversized, workspace: process.cwd() }),
    (error) => error?.code === "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
  );

  const tooMany = await makeFixture();
  const descriptor = JSON.parse(await readFile(tooMany.descriptorPath, "utf8"));
  descriptor.artifacts = Array.from({ length: 65 }, () => ({ ...descriptor.artifacts[0] }));
  await writeFile(tooMany.descriptorPath, JSON.stringify(descriptor), "utf8");
  assert.throws(
    () => preflightReleaseAttestation({ ...tooMany, workspace: process.cwd() }),
    (error) => error?.code === "RELEASE_ATTESTATION_DESCRIPTOR_INVALID",
  );
});

test("verifyAttestationBundle rejects malformed JSON and verified metadata mismatches", async () => {
  const fixture = await makeFixture();
  const bundlePath = join(fixture.root, "verification-output.bundle.json");
  await writeFile(bundlePath, JSON.stringify(verifiedBundle()), "utf8");
  const common = {
    subjectPath: fixture.artifactPath,
    bundlePath,
    repository: fixture.trustedRepository,
    sourceRef: fixture.trustedRef,
    sourceDigest: fixture.trustedSha,
    signerWorkflow: fixture.signerWorkflow,
    signerDigest: fixture.signerDigest,
    signerRef: fixture.signerRef,
    trustedRunUrl: fixture.trustedRunUrl,
    predicateType: "https://slsa.dev/provenance/v1",
    verifierPath: fixture.verifierPath,
    verifierSha256: fixture.verifierSha256,
  };
  assert.throws(
    () => verifyAttestationBundle({
      ...common,
      runner: versionAwareRunner(() => ({ status: 0, stdout: "{malformed" })),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_VERIFICATION_OUTPUT_INVALID",
  );
  assert.throws(
    () => verifyAttestationBundle({
      ...common,
      runner: versionAwareRunner(() => {
        const result = verifiedResult(fixture, {
          bundlePath,
          subjectPath: fixture.artifactPath,
          predicateType: common.predicateType,
        });
        const output = JSON.parse(result.stdout);
        output[0].verificationResult.signature.certificate.sourceRepositoryURI =
          "https://github.com/evil/example";
        return { status: 0, stdout: JSON.stringify(output) };
      }),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_CERTIFICATE_MISMATCH",
  );
  assert.throws(
    () => verifyAttestationBundle({
      ...common,
      runner: versionAwareRunner(() => {
        const result = verifiedResult(fixture, {
          bundlePath,
          subjectPath: fixture.artifactPath,
          predicateType: common.predicateType,
        });
        const output = JSON.parse(result.stdout);
        output[0].verificationResult.statement.predicateType =
          "https://spdx.dev/Document/v2.3";
        return { status: 0, stdout: JSON.stringify(output) };
      }),
    }),
    (error) => error?.code === "RELEASE_ATTESTATION_PREDICATE_MISMATCH",
  );
});
