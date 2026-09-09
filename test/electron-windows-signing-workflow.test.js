import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL(
  "../.github/workflows/electron-windows-signing.yml",
  import.meta.url,
);

test("Windows signing workflow registers safely, while signing stays manual and source-bound", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /^on:\n  # GitHub registers[\s\S]*?\n  push:\n    branches: \[codex\/unified-desktop-accountless\]\n  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (?:pull_request|schedule):/mu);
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /AZURE_CLIENT_SECRET|AZURE_CREDENTIALS|CSC_LINK/u);
  assert.match(workflow, /registration:\n    if: github\.event_name == 'push'[\s\S]*?runs-on: ubuntu-24\.04[\s\S]*?WINDOWS_SIGNING_WORKFLOW_REGISTERED/u);
  assert.match(workflow, /sign:\n    if: github\.event_name == 'workflow_dispatch'/u);
  assert.match(workflow, /environment:\n      name: windows-production-signing/u);
  assert.match(workflow, /permissions:\n      contents: read\n      id-token: write/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /SOURCE_REVISION: \$\{\{ inputs\.source-revision \}\}/u);
  assert.match(workflow, /EXPECTED_DISPATCH_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /WINDOWS_SIGNING_SOURCE_REVISION_MISMATCH/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME: \$\{\{ vars\.AZURE_CODE_SIGNING_PUBLISHER_NAME \}\}/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_AZURE_ENDPOINT: \$\{\{ vars\.AZURE_CODE_SIGNING_ENDPOINT \}\}/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME: \$\{\{ vars\.AZURE_CODE_SIGNING_ACCOUNT_NAME \}\}/u);
  assert.match(workflow, /TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME: \$\{\{ vars\.AZURE_CODE_SIGNING_PROFILE_NAME \}\}/u);
  assert.match(workflow, /azure\/login@f5d393ae46f8fde4be8b75f32e3fc50e654ad0ca/u);
  assert.match(workflow, /azure\/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82/u);
  assert.match(workflow, /exclude-environment-credential: true/u);
  assert.match(workflow, /exclude-azure-cli-credential: false/u);
  assert.match(workflow, /cache-dependencies: false/u);
  assert.match(workflow, /windows_filesystem\.node/u);
  assert.match(workflow, /@github\\keytar\\prebuilds\\win32-x64\\keytar\.node/u);
  assert.doesNotMatch(workflow, /@github\\keytar\\build\\Release\\keytar\.node/u);
  assert.match(workflow, /--sign --confirm-azure-trusted-signing/u);
  assert.doesNotMatch(workflow, /--publish\s+(?!never)/u);
  assert.match(workflow, /WINDOWS_SIGNED_INSTALLER_VERIFIED/u);

  const preflight = workflow.indexOf("Preflight the exact protected Azure resource selection");
  const journal = workflow.indexOf("Inspect and journal native module bytes before signing");
  const probePreSign = workflow.indexOf("Execute the native Authenticode verifier before signing");
  const makeWritable = workflow.indexOf("Make the fixed signed native modules writable");
  const azureLogin = workflow.indexOf("Authenticate to Azure with protected OIDC inputs");
  const nativeSigning = workflow.indexOf("Sign only the staged native modules");
  const makeRebindMetadataWritable = workflow.indexOf("Make the fixed rebinding metadata writable");
  const rebind = workflow.indexOf("Rebind signed native modules to their manifest");
  const restoreReadOnly = workflow.indexOf("Restore the fixed native modules and rebinding metadata read-only state");
  const installerSigning = workflow.indexOf("Sign the reviewed installer without publishing");
  const verification = workflow.indexOf("Verify the signed final installer and retained signing evidence");
  assert.ok(preflight >= 0 && preflight < journal);
  assert.ok(journal < probePreSign && probePreSign < makeWritable && makeWritable < azureLogin && azureLogin < nativeSigning);
  assert.ok(nativeSigning < makeRebindMetadataWritable && makeRebindMetadataWritable < rebind);
  assert.ok(rebind < restoreReadOnly && restoreReadOnly < installerSigning && installerSigning < verification);
  assert.match(workflow, /WINDOWS_NATIVE_SIGNING_INPUT_READONLY_EXPECTED/u);
  assert.match(workflow, /--probe-authenticode-pre-sign/u);
  assert.match(workflow, /WINDOWS_NATIVE_SIGNING_INPUT_WRITABLE_UNAVAILABLE/u);
  assert.match(workflow, /WINDOWS_REBIND_METADATA_READONLY_EXPECTED/u);
  assert.match(workflow, /WINDOWS_REBIND_METADATA_WRITABLE_UNAVAILABLE/u);
  assert.match(workflow, /WINDOWS_NATIVE_SIGNING_INPUT_READONLY_RESTORE_FAILED/u);
  assert.match(workflow, /\[System\.IO\.File\]::SetAttributes\(\$path, \$writableAttributes\)/u);
  assert.doesNotMatch(workflow, /(?:\battrib(?:\.exe)?\b|\bicacls(?:\.exe)?\b|\bchmod\b|\bSet-Acl\b)/iu);

  const nativeSigningInputs = workflow.slice(makeWritable, azureLogin);
  const rebindInputs = workflow.slice(makeRebindMetadataWritable, rebind);
  const restoredInputs = workflow.slice(restoreReadOnly, installerSigning);
  assert.equal((nativeSigningInputs.match(/Join-Path \$env:GITHUB_WORKSPACE/g) ?? []).length, 2);
  assert.equal((rebindInputs.match(/Join-Path \$env:GITHUB_WORKSPACE/g) ?? []).length, 2);
  assert.equal((restoredInputs.match(/Join-Path \$env:GITHUB_WORKSPACE/g) ?? []).length, 4);
  assert.match(rebindInputs, /windows_filesystem\.node\.manifest\.json/u);
  assert.match(rebindInputs, /electron-runtime-manifest\.json/u);
});
