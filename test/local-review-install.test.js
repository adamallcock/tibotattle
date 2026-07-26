import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installLocalReviewArtifact,
  planLocalReviewUninstall,
  uninstallLocalReviewArtifact,
  verifyLocalReviewArtifact,
} from "../local-review/install.js";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(root) {
  const artifact = join(root, "artifact");
  await mkdir(join(artifact, "bin"), { recursive: true });
  const launcher = Buffer.from("#!/bin/sh\nexit 0\n");
  await writeFile(join(artifact, "bin", "usage-monitor-local"), launcher);
  await chmod(join(artifact, "bin", "usage-monitor-local"), 0o755);
  const manifest = {
    schemaVersion: "usage-monitor-local-review-artifact-manifest-v0.1",
    artifactVersion: "test",
    platform: { os: "darwin", architecture: "arm64" },
    localOnly: true,
    transportReady: false,
    inventory: [{
      path: "bin/usage-monitor-local",
      sha256: digest(launcher),
      bytes: launcher.byteLength,
      mode: 0o755,
    }],
  };
  await writeFile(
    join(artifact, "artifact-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return artifact;
}

test("artifact verification, explicit install, and exact-receipt uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-install-test-"));
  try {
    const artifactRoot = await fixture(root);
    const verified = await verifyLocalReviewArtifact({ artifactRoot });
    assert.equal(verified.status, "verified");
    assert.equal(verified.localOnly, true);
    assert.equal(verified.transportReady, false);

    const target = join(root, "installed");
    const installed = await installLocalReviewArtifact({ artifactRoot, target });
    assert.equal(installed.status, "installed");
    assert.equal(installed.participantIdentityPreservedOnUninstall, true);
    assert.equal(
      await readFile(join(target, "bin", "usage-monitor-local"), "utf8"),
      "#!/bin/sh\nexit 0\n",
    );

    const planned = await planLocalReviewUninstall({ target });
    assert.equal(planned.status, "ready");
    assert.match(planned.confirmationToken, /^[A-F0-9]{16}$/);
    const removed = await uninstallLocalReviewArtifact({
      target,
      confirmationToken: planned.confirmationToken,
    });
    assert.equal(removed.status, "uninstalled");
    assert.equal(removed.participantIdentityPreserved, true);
    await assert.rejects(readFile(join(target, ".install-receipt.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall refuses a modified installed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-install-test-"));
  try {
    const artifactRoot = await fixture(root);
    const target = join(root, "installed");
    await installLocalReviewArtifact({ artifactRoot, target });
    await writeFile(join(target, "bin", "usage-monitor-local"), "modified\n");
    await assert.rejects(
      planLocalReviewUninstall({ target }),
      { code: "LOCAL_REVIEW_UNINSTALL_MODIFIED_FILE" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall refuses files outside the committed install receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-install-test-"));
  try {
    const artifactRoot = await fixture(root);
    const target = join(root, "installed");
    await installLocalReviewArtifact({ artifactRoot, target });
    await writeFile(join(target, "unexpected.txt"), "belongs to the user\n");
    await assert.rejects(
      planLocalReviewUninstall({ target }),
      { code: "LOCAL_REVIEW_UNINSTALL_UNEXPECTED_ENTRY" },
    );
    assert.equal(
      await readFile(join(target, "unexpected.txt"), "utf8"),
      "belongs to the user\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install refuses an existing target", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-install-test-"));
  try {
    const artifactRoot = await fixture(root);
    const target = join(root, "installed");
    await mkdir(target);
    await assert.rejects(
      installLocalReviewArtifact({ artifactRoot, target }),
      { code: "LOCAL_REVIEW_INSTALL_TARGET_EXISTS" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact integrity failure is detected before the install target is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-install-test-"));
  try {
    const artifactRoot = await fixture(root);
    const target = join(root, "installed");
    await writeFile(
      join(artifactRoot, "bin", "usage-monitor-local"),
      "#!/bin/sh\nprintf tampered\n",
    );
    await assert.rejects(
      installLocalReviewArtifact({ artifactRoot, target }),
      { code: "LOCAL_REVIEW_INSTALL_INTEGRITY_MISMATCH" },
    );
    await assert.rejects(readFile(join(target, ".install-receipt.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
