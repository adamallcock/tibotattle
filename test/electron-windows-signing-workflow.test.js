import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
// Reuse the YAML parser already locked with the packaging dependencies.
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
const source = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const parse = async (path) => yaml.load(await source(path));
const expr = (value) => "$" + "{{ " + value + " }}";
const runId = expr("github.run_id"), root = ".release-build/electron-production/win32-x64";
const stages = ["native", "application", "uninstaller", "installer"];
const unprivileged = [...stages.map((stage) => "prepare-" + stage), "qualify"];
const bootstrapPath = "./.github/actions/windows-unprivileged-build";
const runText = (job) => job.steps.filter((step) => step.run).map((step) => step.run).join("\n");
const actions = (job, name) => job.steps.filter((step) => step.uses?.startsWith(name + "@"));
const needs = (job) => Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
async function workflows() {
  return {
    main: await parse(".github/workflows/electron-windows-signing.yml"),
    signer: await parse(".github/workflows/electron-windows-sign-subjects.yml"),
    bootstrap: await parse(".github/actions/windows-unprivileged-build/action.yml"),
  };
}
function assertCheckout(job) {
  const matches = actions(job, "actions/checkout");
  assert.equal(matches.length, 1);
  assert.match(matches[0].uses, /^actions\/checkout@[0-9a-f]{40}$/u);
  assert.deepEqual(matches[0].with, { ref: expr("github.sha"), "persist-credentials": false, "fetch-depth": 1 });
}

test("manual Windows signing gives OIDC only to the four isolated subject jobs", async () => {
  const { main, signer } = await workflows();
  assert.deepEqual(Object.keys(main.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(main.on.push, { branches: ["codex/unified-desktop-accountless"] });
  assert.deepEqual(Object.keys(main.on.workflow_dispatch.inputs).sort(), ["build-number", "source-revision"]);
  for (const input of Object.values(main.on.workflow_dispatch.inputs)) {
    assert.equal(input.required, true); assert.equal(input.type, "string");
  }
  assert.deepEqual(main.permissions, { contents: "read" });
  assert.equal(main.concurrency["cancel-in-progress"], false);
  assert.equal(main.jobs.registration.if, "github.event_name == 'push'");
  assert.match(runText(main.jobs.registration), /WINDOWS_SIGNING_WORKFLOW_REGISTERED/u);
  assert.equal(main.jobs["prepare-native"].if, "github.event_name == 'workflow_dispatch'");
  assert.deepEqual(Object.keys(main.jobs).sort(),
    ["registration", ...unprivileged, ...stages.map((stage) => "sign-" + stage)].sort());
  const privileged = Object.entries(main.jobs).filter(([, job]) => job.permissions?.["id-token"] === "write");
  assert.deepEqual(privileged.map(([name]) => name).sort(), stages.map((stage) => "sign-" + stage).sort());
  for (const [name, job] of privileged) {
    assert.equal(job.uses, "./.github/workflows/electron-windows-sign-subjects.yml", name);
    assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" }, name);
    assert.equal(job.steps, undefined, name); assert.equal(job.secrets, undefined, name);
  }
  for (const name of unprivileged) {
    const job = main.jobs[name];
    assert.deepEqual(job.permissions, { contents: "read" }, name);
    assert.equal(job.environment, undefined, name);
    assert.equal(job["runs-on"], "windows-2025", name);
    assertCheckout(job);
    assert.equal(job.env.SOURCE_REVISION, expr("inputs.source-revision"));
    assert.doesNotMatch(JSON.stringify(job), /AZURE_(?:CLIENT|TENANT|SUBSCRIPTION|CREDENTIAL)|secrets\./u);
  }
  assert.deepEqual(Object.keys(signer.on), ["workflow_call"]);
  assert.deepEqual(Object.keys(signer.jobs), ["sign"]);
  assert.deepEqual(signer.permissions, { contents: "read" });
  assert.deepEqual(signer.jobs.sign.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(signer.jobs.sign.environment, { name: "windows-production-signing" });
});

test("tool admission precedes bootstrap and bootstrap refuses OIDC before installing dependencies", async () => {
  const { main, bootstrap } = await workflows();
  const native = main.jobs["prepare-native"];
  assert.equal(native.env.DISPATCH_SHA, expr("github.sha"));
  assert.equal(native.env.BUILD_NUMBER, expr("inputs.build-number"));
  const gateIndex = native.steps.findIndex((step) => step.run?.includes("prepare-tools"));
  const dependencyIndex = native.steps.findIndex((step) => step.uses === bootstrapPath);
  assert.ok(gateIndex > 0 && gateIndex < dependencyIndex);
  const gate = native.steps[gateIndex].run;
  assert.match(gate, /ACTIONS_ID_TOKEN_REQUEST_TOKEN -or \$env:ACTIONS_ID_TOKEN_REQUEST_URL/u);
  assert.match(gate, /SOURCE_REVISION -notmatch '\^\[0-9a-f\]\{40\}\$'/u);
  assert.match(gate, /SOURCE_REVISION -cne \$env:DISPATCH_SHA/u);
  assert.match(gate, /\(git rev-parse HEAD\)\.Trim\(\) -cne \$env:DISPATCH_SHA/u);
  assert.match(gate, /BUILD_NUMBER -notmatch '\^\[1-9\]\[0-9\]\{0,9\}\$'/u);
  assert.match(gate, /if \(\$LASTEXITCODE -ne 0\).*WINDOWS_SIGNING_TOOLCHAIN_NOT_ADMITTED/u);
  assert.doesNotMatch(native.steps.slice(0, gateIndex + 1).map((step) => step.run ?? step.uses).join("\n"),
    /setup-node|npm install|pnpm install|corepack|Install-Module/u);
  assert.equal(bootstrap.runs.using, "composite");
  assert.equal(bootstrap.runs.steps.length, 2);
  const [authorityGate, install] = bootstrap.runs.steps;
  assert.match(authorityGate.run, /if \(\$env:ACTIONS_ID_TOKEN_REQUEST_TOKEN -or \$env:ACTIONS_ID_TOKEN_REQUEST_URL\).*throw 'WINDOWS_BUILD_MUST_NOT_HAVE_OIDC'/u);
  assert.ok(bootstrap.runs.steps.every((step) => step.shell === "pwsh" && !step.uses));
  assert.doesNotMatch(JSON.stringify(bootstrap), /setup-node|corepack|npm install --global/u);
  assert.match(install.run, /node scripts\/prepare-windows-build-bootstrap\.mjs --output-root \.release-build\/windows-build-bootstrap/u);
  assert.match(install.run, /if \(\$LASTEXITCODE -ne 0\).*WINDOWS_BUILD_BOOTSTRAP_FAILED/u);
  assert.ok(install.run.indexOf("WINDOWS_BUILD_BOOTSTRAP_FAILED")
    < install.run.indexOf("& ./scripts/expand-windows-build-bootstrap.ps1"));
  assert.ok(install.run.indexOf("& ./scripts/expand-windows-build-bootstrap.ps1")
    < install.run.indexOf("& $node --version"));
  assert.match(install.run, /\$nodeRoot = \(Resolve-Path '\.release-build\/windows-build-bootstrap\/node\/node-v26\.2\.0-win-x64'\)\.Path/u);
  assert.match(install.run, /\$node = Join-Path \$nodeRoot 'node\.exe'/u);
  assert.match(install.run, /if \(\(& \$node --version\) -cne 'v26\.2\.0' -or \$LASTEXITCODE -ne 0\)/u);
  assert.match(install.run, /\$nodeRoot \| Out-File -FilePath \$env:GITHUB_PATH -Append -Encoding utf8/u);
  assert.match(install.run, /\$env:PATH = "\$nodeRoot;\$env:PATH"/u);
  assert.match(install.run, /& \$node \.release-build\/windows-build-bootstrap\/pnpm\/package\/bin\/pnpm\.mjs install --frozen-lockfile --ignore-scripts/u);
  assert.ok(install.run.indexOf("WINDOWS_BUILD_NODE_VERSION_MISMATCH")
    < install.run.indexOf("pnpm/package/bin/pnpm.mjs install"));
  // Later node-gyp resolves npm from precisely the Node directory admitted
  // above, rather than reintroducing an independently installed npm runtime.
  assert.match(runText(native), /\$npmCommand = \(Get-Command npm\.cmd\)\.Source/u);
  assert.match(runText(native), /Join-Path \(Split-Path \$npmCommand -Parent\) 'node_modules\/npm\/node_modules\/node-gyp\/bin\/node-gyp\.js'/u);
  for (const name of unprivileged) {
    const steps = main.jobs[name].steps;
    assert.equal(steps.filter((step) => step.uses === bootstrapPath).length, 1, name);
    assert.ok(steps.findIndex((step) => step.uses === bootstrapPath)
      < steps.findIndex((step) => step.run?.includes("--stage ") || step.run?.includes("node $nodeGypScript")), name);
  }
  const policy = JSON.parse(await source("config/windows-signing-toolchain.json"));
  const { validateWindowsSigningToolchain } = await import("../scripts/lib/windows-signing-toolchain.mjs");
  assert.equal(policy.status, "provisioning_required");
  assert.throws(() => validateWindowsSigningToolchain(policy), /WINDOWS_SIGNING_TOOLCHAIN_/u);
});

test("bootstrap admits both archive closures before writing or executing downloaded code", async () => {
  const { readWindowsBuildBootstrapPolicy } = await import("../scripts/prepare-windows-build-bootstrap.mjs");
  const policy = await readWindowsBuildBootstrapPolicy();
  assert.equal(policy.node.version, "26.2.0");
  assert.equal(policy.node.archiveRoot, "node-v26.2.0-win-x64");
  assert.match(policy.node.archiveSha256, /^[a-f0-9]{64}$/u);
  assert.equal(policy.pnpm.version, "11.9.0");
  assert.equal(policy.pnpm.entrypoint, "package/bin/pnpm.mjs");
  assert.match(policy.pnpm.integrity, /^sha512-/u);
  // readWindowsBuildBootstrapPolicy performs actual registry-signature
  // verification. The owning bootstrap tests cover corrupt and hostile bytes.
  const helper = await source("scripts/prepare-windows-build-bootstrap.mjs");
  const preparation = helper.slice(helper.indexOf("export async function prepareWindowsBuildBootstrap("));
  assert.ok(preparation.indexOf("assertNoWindowsSigningAuthority(") < preparation.indexOf("await downloadBytes("));
  assert.match(preparation, /createHash\("sha256"\)\.update\(node\)\.digest\("hex"\) !== policy\.node\.archiveSha256/u);
  assert.ok(preparation.indexOf("NODE_ARCHIVE_DIGEST_MISMATCH") < preparation.indexOf("await downloadBytes(policy.pnpm.archiveUrl"));
  assert.ok(preparation.indexOf("inspectWindowsPnpmArchive(pnpm, policy)") < preparation.indexOf("await mkdir(root,"));
  assert.match(preparation, /writeFile\(join\(root, "node.zip"\), node, \{ flag: "wx"/u);
  assert.doesNotMatch(helper, /node:child_process|\b(?:spawnSync|execFile|execSync)\s*\(/u);
});

test("Node ZIP expansion validates the same held bytes and the complete entry set before extraction", async () => {
  // PowerShell/.NET are trusted runner substrate. These source assertions do
  // not claim native Windows extraction or publisher qualification on macOS.
  const expand = await source("scripts/expand-windows-build-bootstrap.ps1");
  assert.match(expand, /ACTIONS_ID_TOKEN_REQUEST_TOKEN -or \$env:ACTIONS_ID_TOKEN_REQUEST_URL/u);
  assert.match(expand, /\$archiveStream = \[IO.File\]::Open\(\$archivePath, \[IO.FileMode\]::Open, \[IO.FileAccess\]::Read, \[IO.FileShare\]::Read\)/u);
  assert.match(expand, /\$sha\.ComputeHash\(\$archiveStream\)/u);
  assert.match(expand, /\$digest -cne \$policy\.node\.archiveSha256/u);
  assert.match(expand, /\$archiveStream.Position = 0/u);
  assert.match(expand, /\[IO.Compression.ZipArchive\]::new\(\$archiveStream, \[IO.Compression.ZipArchiveMode\]::Read, \$true\)/u);
  const digest = expand.indexOf("WINDOWS_BUILD_NODE_ARCHIVE_DIGEST_MISMATCH");
  const archive = expand.indexOf("[IO.Compression.ZipArchive]::new");
  const extract = expand.indexOf("[IO.Directory]::CreateDirectory($destination)");
  assert.ok(digest >= 0 && digest < archive && archive < extract);
  const admission = expand.slice(archive, extract);
  for (const refusal of ["ENTRY_LIMIT", "PATH_INVALID", "DUPLICATE_PATH", "ENTRY_INVALID", "SIZE_LIMIT", "PATH_COLLISION"]) {
    assert.ok(admission.includes("WINDOWS_BUILD_NODE_ARCHIVE_" + refusal), refusal);
  }
  assert.match(admission, /OrdinalIgnoreCase/u);
  assert.match(admission, /\$zip.Entries.Count -gt 8192/u);
  assert.match(admission, /\$kind -notin @\(0, 0x4000, 0x8000\)/u);
  assert.match(admission, /\$entry.ExternalAttributes -band 0x400/u);
  assert.match(admission, /\$entry.Length -gt 268435456/u);
  assert.match(admission, /\$expandedBytes -gt 536870912/u);
  assert.match(admission, /WINDOWS_BUILD_NODE_BINARY_MISSING/u);
  assert.match(expand.slice(extract), /\[IO.FileMode\]::CreateNew/u);
  assert.match(expand.slice(extract), /\$copied -gt \$item.entry.Length/u);
  assert.match(expand.slice(extract), /\$copied -ne \$item.entry.Length/u);
  assert.match(expand, /finally \{ \$archiveStream.Dispose\(\) \}/u);
  assert.doesNotMatch(expand, /Expand-Archive|Start-Process|Invoke-Expression|&.*node\.exe/u);
});

test("all signing hops propagate candidate, manifest, receipt, and continuation digests", async () => {
  const { main, signer } = await workflows();
  const candidateDigest = expr("needs.prepare-native.outputs.candidate-sha256");
  assert.equal(main.jobs["prepare-native"].outputs["candidate-sha256"], expr("steps.candidate.outputs.candidate_sha256"));
  for (const [index, stage] of stages.entries()) {
    const prepare = main.jobs["prepare-" + stage], sign = main.jobs["sign-" + stage];
    assert.deepEqual(needs(sign), stage === "native" ? ["prepare-native"] : ["prepare-native", "prepare-" + stage]);
    assert.deepEqual(sign.with, {
      "source-revision": expr("inputs.source-revision"), "candidate-sha256": candidateDigest,
      "manifest-sha256": expr("needs.prepare-" + stage + ".outputs.manifest-sha256"),
      stage, "input-artifact": "windows-stage-" + stage + "-" + runId,
    });
    assert.equal(prepare.outputs["manifest-sha256"],
      expr("steps." + (stage === "native" ? "subjects" : "stage") + ".outputs.manifest_sha256"));
    const upload = actions(prepare, "actions/upload-artifact").find((step) => step.with.name === sign.with["input-artifact"]);
    assert.ok(upload, stage); assert.equal(upload.with.path, root); assert.equal(upload.with["if-no-files-found"], "error");
    if (!index) continue;
    const previous = stages[index - 1];
    assert.ok(needs(prepare).includes("sign-" + previous));
    assert.ok(needs(prepare).includes("prepare-" + previous));
    assert.equal(prepare.env.CANDIDATE_SHA256, candidateDigest);
    assert.equal(prepare.env.PREVIOUS_MANIFEST_SHA256, expr("needs.prepare-" + previous + ".outputs.manifest-sha256"));
    assert.equal(prepare.env.SIGNED_RECEIPT_SHA256, expr("needs.sign-" + previous + ".outputs.receipt-sha256"));
    assert.deepEqual(actions(prepare, "actions/download-artifact").map((step) => step.with), [
      { name: "windows-stage-" + previous + "-" + runId, path: root },
      { name: "windows-signed-" + previous + "-" + runId, path: ".release-build/windows-signed-subjects" },
    ]);
  }
  assert.equal(main.jobs["prepare-uninstaller"].outputs["continuation-sha256"], expr("steps.stage.outputs.continuation_sha256"));
  assert.equal(main.jobs["prepare-installer"].env.CONTINUATION_SHA256, expr("needs.prepare-uninstaller.outputs.continuation-sha256"));
  assert.equal(signer.on.workflow_call.outputs["receipt-sha256"].value, expr("jobs.sign.outputs.receipt-sha256"));
  assert.equal(signer.jobs.sign.outputs["receipt-sha256"], expr("steps.sign.outputs.receipt_sha256"));
});

test("each stage workflow command passes the real closed CLI parser with all hash bindings", async () => {
  const { main } = await workflows();
  const { parseWindowsSigningStageArguments } = await import("../scripts/prepare-electron-windows-signing-stage.mjs");
  const values = {
    "$candidate": root + "/production-source-candidate.json", "$env:SOURCE_REVISION": "a".repeat(40),
    "$env:CANDIDATE_SHA256": "b".repeat(64), "$env:SIGNED_RECEIPT_SHA256": "c".repeat(64),
    "$env:PREVIOUS_MANIFEST_SHA256": "d".repeat(64), "$env:CONTINUATION_SHA256": "e".repeat(64),
  };
  for (const name of unprivileged) {
    const lines = runText(main.jobs[name]).split("\n")
      .filter((line) => line.trim().startsWith("node scripts/prepare-electron-windows-signing-stage.mjs "));
    assert.equal(lines.length, 1, name);
    const args = lines[0].trim().split(/\s+/u).slice(2).map((part) => values[part] ?? part);
    assert.ok(!args.some((arg) => arg.includes("$")), name + " has an unbound shell variable");
    const stage = name === "qualify" ? "complete" : name.slice("prepare-".length);
    assert.deepEqual(parseWindowsSigningStageArguments(args), {
      stage, "candidate-receipt": values.$candidate, "candidate-sha256": values["$env:CANDIDATE_SHA256"],
      "source-revision": values["$env:SOURCE_REVISION"],
      ...(stage === "native" ? {} : {
        "signed-root": ".release-build/windows-signed-subjects",
        "signed-receipt-sha256": values["$env:SIGNED_RECEIPT_SHA256"], "manifest-sha256": values["$env:PREVIOUS_MANIFEST_SHA256"],
      }),
      ...(stage === "installer" ? { "continuation-sha256": values["$env:CONTINUATION_SHA256"] } : {}),
    }, name);
  }
});

test("the reusable signer has no registry bootstrap, builder, Azure login action, or candidate execution", async () => {
  const { signer } = await workflows();
  const job = signer.jobs.sign;
  assertCheckout(job);
  assert.deepEqual(Object.keys(signer.on.workflow_call.inputs).sort(),
    ["source-revision", "candidate-sha256", "manifest-sha256", "stage", "input-artifact"].sort());
  for (const input of Object.values(signer.on.workflow_call.inputs)) assert.deepEqual(input, { required: true, type: "string" });
  assert.deepEqual(job.env, {
    SOURCE_REVISION: expr("inputs.source-revision"), CANDIDATE_SHA256: expr("inputs.candidate-sha256"),
    MANIFEST_SHA256: expr("inputs.manifest-sha256"), SIGNING_STAGE: expr("inputs.stage"),
  });
  const sourceGate = job.steps.findIndex((step) => step.run?.includes("WINDOWS_SIGNER_SOURCE_MISMATCH"));
  assert.ok(sourceGate > 0 && sourceGate < job.steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@")));
  assert.match(job.steps[sourceGate].run, /SOURCE_REVISION -cne \$env:DISPATCH_SHA/u);
  assert.match(job.steps[sourceGate].run, /\(git rev-parse HEAD\)\.Trim\(\) -cne \$env:DISPATCH_SHA/u);
  const sign = job.steps.find((step) => step.id === "sign");
  assert.match(sign.run, /sign-electron-windows-subjects\.mjs sign .*--manifest-sha256 \$env:MANIFEST_SHA256 --source-revision \$env:SOURCE_REVISION --candidate-sha256 \$env:CANDIDATE_SHA256 --stage \$env:SIGNING_STAGE/u);
  assert.deepEqual(sign.env, { AZURE_CLIENT_ID: expr("vars.AZURE_CLIENT_ID"), AZURE_TENANT_ID: expr("vars.AZURE_TENANT_ID") });
  assert.doesNotMatch(runText(job), /\b(?:npm|pnpm|corepack|electron-builder|Install-Module|Install-Package|Invoke-TrustedSigning|Invoke-ArtifactSigning)\b|--execute|prepare-electron|smoke-electron|dotnet\s+tool/u);
  for (const step of job.steps.filter((step) => step.uses)) {
    assert.match(step.uses, /^actions\/(?:checkout|download-artifact|upload-artifact)@[0-9a-f]{40}$/u);
  }
  assert.deepEqual(actions(job, "actions/download-artifact").map((step) => step.with), [
    { name: expr("inputs.input-artifact"), path: root },
    { name: "windows-signing-tools-" + runId, path: ".release-build/windows-signing-tools" },
  ]);
  const [upload] = actions(job, "actions/upload-artifact");
  assert.equal(upload.with.name, "windows-signed-" + expr("inputs.stage") + "-" + runId);
  assert.equal(upload.with.path, ".release-build/windows-signed-subjects");
  assert.equal(upload.with["if-no-files-found"], "error");
});

test("native probe and signed-byte transfer precede qualification in a job without signing authority", async () => {
  const { main } = await workflows();
  const nativeRun = runText(main.jobs["prepare-native"]);
  assert.ok(nativeRun.indexOf("--stage native") >= 0 && nativeRun.indexOf("--stage native") < nativeRun.indexOf("--probe-authenticode-pre-sign"));
  assert.match(nativeRun, /if \(\$LASTEXITCODE -ne 0\).*WINDOWS_NATIVE_PRE_SIGN_PROBE_FAILED/u);
  const qualify = main.jobs.qualify;
  assert.deepEqual(needs(qualify), ["prepare-native", "prepare-installer", "sign-installer"]);
  assert.equal(qualify.env.CANDIDATE_SHA256, expr("needs.prepare-native.outputs.candidate-sha256"));
  assert.equal(qualify.env.PREVIOUS_MANIFEST_SHA256, expr("needs.prepare-installer.outputs.manifest-sha256"));
  assert.equal(qualify.env.SIGNED_RECEIPT_SHA256, expr("needs.sign-installer.outputs.receipt-sha256"));
  const run = runText(qualify);
  assert.ok(run.indexOf("--stage complete") >= 0 && run.indexOf("--stage complete") < run.indexOf("smoke-electron-windows-signed-installed.mjs"));
  assert.match(run, /if \(\$LASTEXITCODE -ne 0\).*WINDOWS_SIGNED_FINALIZATION_FAILED/u);
  assert.match(run, /Get-FileHash -LiteralPath \$installer -Algorithm SHA256/u);
  assert.match(run, /smoke-electron-windows-signed-installed\.mjs --execute --installer \$installer --installer-sha256 \$digest --staged-app .* --source-candidate \$candidate --source-revision \$env:SOURCE_REVISION --receipt /u);
  assert.match(run, /if \(\$LASTEXITCODE -ne 0\).*WINDOWS_SIGNED_INSTALLED_QUALIFICATION_FAILED/u);
  for (const job of Object.values(main.jobs)) if (job.steps) {
    assert.doesNotMatch(runText(job), /--publish\s+(?!never)|gh release|release:publish|publish-electron/u);
  }
  assert.match(await source("scripts/prepare-electron-windows-signing-stage.mjs"), /"--publish", "never"/u);
  // Preserve the old workflow's installed-configuration evidence checks.
  const harness = await source("scripts/smoke-electron-windows-signed-installed.mjs");
  const installedRun = harness.slice(harness.indexOf("export async function runWindowsSignedInstalled("));
  assert.match(installedRun, /sourceCandidateSha256 = createHash\('sha256'\)\.update\(sourceCandidateBytes\)/u);
  assert.match(installedRun, /boundedEvidence\(options\.sourceCandidatePath, 128 \* 1024\)\)\.equals\(sourceCandidateBytes\)/u);
  assert.match(installedRun, /expectedSha256: receipt\.updaterArtifacts\.packagedUpdaterConfigurationSha256/u);
  assert.ok(installedRun.indexOf("receipt.retainedAppUpdate = await retainWindowsInstalledUpdateConfiguration")
    < installedRun.indexOf("buildWindowsNsisUninstallArguments(installRoot)"));
});

test("signer egress is restricted before signing and restored on failure or interruption", async () => {
  const { signer } = await workflows();
  const job = signer.jobs.sign;
  const signIndex = job.steps.findIndex((step) => step.id === "sign");
  const signing = job.steps[signIndex].run;
  assert.ok(signing.indexOf("try {") < signing.indexOf("windows-signing-egress.ps1 -Mode restrict"));
  assert.ok(signing.indexOf("windows-signing-egress.ps1 -Mode restrict")
    < signing.indexOf("node scripts/sign-electron-windows-subjects.mjs sign"));
  assert.match(signing, /finally\s*\{\s*& \.\/scripts\/windows-signing-egress\.ps1 -Mode restore/u);
  const restoreIndex = job.steps.findIndex((step) => step.run === "./scripts/windows-signing-egress.ps1 -Mode restore");
  assert.ok(restoreIndex > signIndex);
  assert.equal(job.steps[restoreIndex].if, expr("always()"));
  assert.ok(restoreIndex < job.steps.findIndex((step) => step.uses?.startsWith("actions/upload-artifact@")));

  // These are policy and wiring assertions. Actual firewall enforcement and
  // successful Windows authentication/signing remain native qualification.
  const firewall = await source("scripts/windows-signing-egress.ps1");
  assert.match(firewall, /ValidateSet\('restrict','restore'\)/u);
  assert.match(firewall, /GITHUB_ACTIONS -cne 'true'.*RUNNER_OS -cne 'Windows'/u);
  assert.match(firewall, /Oidc|OIDC_INVALID/u);
  assert.match(firewall, /\.EndsWith\('\.actions\.githubusercontent\.com'\)/u);
  assert.match(firewall, /\$hosts = @\(\$oidc\.DnsSafeHost, 'login\.microsoftonline\.com', 'eus\.codesigning\.azure\.net', 'timestamp\.acs\.microsoft\.com'\)/u);
  assert.match(firewall, /Get-NetFirewallRule -Enabled True -Direction Outbound -Action Allow/u);
  assert.match(firewall, /foreach \(\$name in \$rules\) \{ Disable-NetFirewallRule -Name \$name \}/u);
  assert.match(firewall, /-Protocol TCP -RemotePort 443 -RemoteAddress \$addresses/u);
  assert.match(firewall, /-Protocol TCP -RemotePort 80 -RemoteAddress \(\[System\.Net\.Dns\]::GetHostAddresses\('timestamp\.acs\.microsoft\.com'\)/u);
  for (const protocol of ["TCP", "UDP"]) {
    assert.ok(firewall.includes("-Protocol " + protocol + " -RemotePort 53 -RemoteAddress $dns"));
  }
  assert.match(firewall, /Set-NetFirewallProfile -Name Domain,Private,Public -Enabled True -DefaultOutboundAction Block/u);
  assert.match(firewall, /WINDOWS_SIGNING_EGRESS_NOT_ENFORCED/u);
  assert.ok(firewall.indexOf("[System.IO.FileMode]::CreateNew") < firewall.indexOf("Disable-NetFirewallRule"));
  assert.match(firewall, /Set-NetFirewallProfile -Name \$profile\.name -DefaultOutboundAction \$profile\.outbound -Enabled \$profile\.enabled/u);
  assert.match(firewall, /foreach \(\$name in \$state\.disabledAllowRules\) \{ Enable-NetFirewallRule -Name \$name \}/u);
  assert.doesNotMatch(firewall, /PSGallery|powershellgallery|nuget\.org|registry\.npmjs|github\.com\/.*download/u);
});

test("final artifact retention has only the explicit installer and content-free evidence set", async () => {
  const { main } = await workflows();
  const [retained] = actions(main.jobs.qualify, "actions/upload-artifact");
  assert.equal(retained.with.name, "electron-windows-signed-" + runId);
  assert.equal(retained.with["if-no-files-found"], "error");
  assert.deepEqual(retained.with.path.trim().split("\n"), [
    root + "/artifacts/TiboTattle-*-Windows-x64.exe",
    root + "/artifacts/TiboTattle-*-Windows-x64.exe.blockmap", root + "/artifacts/latest.yml",
    root + "/production-source-candidate.json", root + "/app-update.yml",
    root + "/evidence/windows-signing-operation-ledger.json", root + "/windows-native-rebinding/rebound.json",
    root + "/evidence/windows-signed-installed.json",
    ...stages.map((stage) => root + "/signing-transfer/" + stage + "-signed-receipt.json"),
  ]);
});
