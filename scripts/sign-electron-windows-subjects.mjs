#!/usr/bin/env node
// The OIDC job runs only this reviewed, dependency-free signer and platform
// Authenticode inspection. Build subjects are data and are never executed.
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlainPath, createWindowsSigningSubjectManifest, hashPlainFile, readWindowsSigningSubjectManifest,
  sha256, verifyWindowsSigningSubjectManifest, WINDOWS_SIGNED_SUBJECT_SCHEMA } from './lib/windows-signing-subjects.mjs';
import { downloadWindowsSigningToolchain, readWindowsSigningToolchain, verifyWindowsSigningToolchain } from './lib/windows-signing-toolchain.mjs';

const FILE = fileURLToPath(import.meta.url);
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ENDPOINT = 'https://eus.codesigning.azure.net/';
const TIMESTAMP = 'http://timestamp.acs.microsoft.com';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
function fail(code) { throw new Error(`WINDOWS_ISOLATED_SIGNER_${code}`); }
function hostEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  // No builder caches, PATH-selected executables, user startup/profile files,
  // package-manager settings, or other credential sources enter the child.
  return env;
}
function execute(command, args, env = {}) {
  const result = spawnSync(command, args, { env: { ...hostEnvironment(), ...env }, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024, windowsHide: true });
  return !result.error && result.signal === null && result.status === 0;
}
export function verifyWindowsPublisher(path, certificateSha256) {
  return execute(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:TIBOTATTLE_VERIFY_FILE; if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){exit 1}; $h=[System.Security.Cryptography.SHA256]::Create(); $d=([BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant(); if($d -cne $env:TIBOTATTLE_VERIFY_CERTIFICATE){exit 1}"],
  { TIBOTATTLE_VERIFY_FILE: path, TIBOTATTLE_VERIFY_CERTIFICATE: certificateSha256 });
}
function verifySignedApplication(path) {
  return execute(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:TIBOTATTLE_VERIFY_FILE; if($s.Status -ne 'Valid' -or $null -eq $s.TimeStamperCertificate -or $null -eq $s.SignerCertificate -or $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -cne 'Adam Allcock'){exit 1}"],
  { TIBOTATTLE_VERIFY_FILE: path });
}
async function githubFederatedToken(environment) {
  let url;
  try { url = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL); } catch { fail('OIDC_UNAVAILABLE'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.actions.githubusercontent.com')
    || url.username || url.password || url.port || url.hash
    || typeof environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== 'string' || environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length < 16) fail('OIDC_UNAVAILABLE');
  url.searchParams.set('audience', 'api://AzureADTokenExchange');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) fail('OIDC_FAILED');
  let body = ''; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 32 * 1024) fail('OIDC_FAILED'); body += Buffer.from(chunk).toString('utf8'); }
  let token;
  try { token = JSON.parse(body).value; } catch { fail('OIDC_FAILED'); }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) fail('OIDC_FAILED');
  return token;
}
export async function signWindowsSubjects(options, adapters = {}) {
  const { inputRoot, outputRoot, toolchainRoot, manifestPath, manifestSha256,
    expectedSourceRevision, expectedCandidateSha256, expectedStage } = options;
  const policy = adapters.policy ?? await readWindowsSigningToolchain();
  const manifest = await readWindowsSigningSubjectManifest(manifestPath, manifestSha256);
  await verifyWindowsSigningSubjectManifest({ root: inputRoot, manifest, expectedSourceRevision, expectedCandidateSha256, expectedStage });
  const verifyPublisher = adapters.verifyPublisher ?? verifyWindowsPublisher;
  await verifyWindowsSigningToolchain({ root: toolchainRoot, policy, verifyPublisher });
  if ((adapters.platform ?? process.platform) !== 'win32' || (adapters.arch ?? process.arch) !== 'x64') fail('WINDOWS_X64_REQUIRED');
  const environment = adapters.environment ?? process.env;
  if (!UUID.test(environment.AZURE_CLIENT_ID) || !UUID.test(environment.AZURE_TENANT_ID)) fail('AZURE_IDENTITY_INVALID');
  await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const privateRoot = join(outputRoot, '.signer-private');
  await mkdir(privateRoot, { mode: 0o700 });
  const tokenPath = join(privateRoot, 'federated-token');
  const metadataPath = join(privateRoot, 'dlib-metadata.json');
  try {
    // Acquire authority only after admission. No module installation, imports,
    // bootstrap executables or generated candidate code run after this point.
    const token = await (adapters.getToken ?? githubFederatedToken)(environment);
    await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 });
    await writeFile(metadataPath, JSON.stringify({ Endpoint: ENDPOINT, CodeSigningAccountName: 'tibotattlesigning',
      CertificateProfileName: 'tibotattle-windows-public', ExcludeCredentials: ['EnvironmentCredential',
        'ManagedIdentityCredential', 'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
        'AzureCliCredential', 'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential'] }), { flag: 'wx', mode: 0o600 });
    const files = [];
    for (const file of manifest.files) {
      // Revalidate the entire tool closure immediately before each invocation.
      await verifyWindowsSigningToolchain({ root: toolchainRoot, policy, verifyPublisher });
      const target = join(outputRoot, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(await assertPlainPath(inputRoot, file.path), target, constants.COPYFILE_EXCL);
      const before = await hashPlainFile(outputRoot, file.path);
      if (before.sha256 !== file.sha256 || before.sizeBytes !== file.sizeBytes) fail('SUBJECT_CHANGED');
      const sign = adapters.execute ?? execute;
      const okay = await sign(await assertPlainPath(toolchainRoot, policy.tools.signtool), ['sign', '/fd', 'SHA256',
        '/tr', TIMESTAMP, '/td', 'SHA256', '/dlib', await assertPlainPath(toolchainRoot, policy.tools.dlib), '/dmdf', metadataPath, target],
      { AZURE_CLIENT_ID: environment.AZURE_CLIENT_ID, AZURE_TENANT_ID: environment.AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE: tokenPath });
      if (!okay) fail('SIGN_FAILED');
      if (!await (adapters.verifySigned ?? verifySignedApplication)(target)) fail('SIGNED_PUBLISHER_INVALID');
      const after = await hashPlainFile(outputRoot, file.path);
      if (after.sha256 === before.sha256) fail('SIGNATURE_NOT_APPLIED');
      files.push({ path: file.path, beforeSha256: before.sha256, afterSha256: after.sha256, sizeBytes: after.sizeBytes });
    }
    const receipt = { schemaVersion: WINDOWS_SIGNED_SUBJECT_SCHEMA, manifestSha256, sourceRevision: manifest.sourceRevision,
      candidateSha256: manifest.candidateSha256, stage: manifest.stage, files };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    await writeFile(join(outputRoot, 'signed-subjects.json'), receiptBytes, { flag: 'wx', mode: 0o600 });
    return { receipt, receiptSha256: sha256(receiptBytes) };
  } finally { await rm(privateRoot, { force: true, recursive: true }); }
}
function parse(argv) {
  const options = {};
  if (argv.length < 1 || !['prepare-tools', 'native-manifest', 'sign'].includes(argv[0])) fail('ARGUMENT_INVALID');
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/u, '');
    if (!argv[i]?.startsWith('--') || !argv[i + 1] || Object.hasOwn(options, key)) fail('ARGUMENT_INVALID');
    options[key] = argv[i + 1];
  }
  return { mode: argv[0], options };
}
async function main() {
  const { mode, options: o } = parse(process.argv.slice(2));
  const expectedKeys = mode === 'prepare-tools' ? ['toolchain-root'] : mode === 'native-manifest'
    ? ['candidate-root', 'candidate-sha256', 'source-revision', 'version', 'build-number', 'manifest']
    : ['input-root', 'output-root', 'toolchain-root', 'manifest', 'manifest-sha256', 'source-revision', 'candidate-sha256', 'stage'];
  if (Object.keys(o).sort().join('\0') !== expectedKeys.sort().join('\0')) fail('ARGUMENT_INVALID');
  if (mode === 'prepare-tools') {
    if (process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || process.env.ACTIONS_ID_TOKEN_REQUEST_URL) fail('PREPARATION_MUST_NOT_HAVE_OIDC');
    const policy = await readWindowsSigningToolchain();
    await downloadWindowsSigningToolchain({ root: resolve(o['toolchain-root']), policy });
    await verifyWindowsSigningToolchain({ root: resolve(o['toolchain-root']), policy, verifyPublisher: verifyWindowsPublisher });
    process.stdout.write('WINDOWS_SIGNING_TOOLCHAIN_ADMITTED\n');
  } else if (mode === 'native-manifest') {
    const manifest = await createWindowsSigningSubjectManifest({ root: o['candidate-root'], sourceRevision: o['source-revision'],
      candidateSha256: o['candidate-sha256'], version: o.version, buildNumber: o['build-number'], stage: 'native' });
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(o.manifest, bytes, { flag: 'wx', mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `manifest_sha256=${sha256(bytes)}\n`);
    process.stdout.write('WINDOWS_NATIVE_SUBJECTS_PREPARED\n');
  } else {
    const result = await signWindowsSubjects({ inputRoot: o['input-root'], outputRoot: o['output-root'], toolchainRoot: o['toolchain-root'],
      manifestPath: o.manifest, manifestSha256: o['manifest-sha256'], expectedSourceRevision: o['source-revision'],
      expectedCandidateSha256: o['candidate-sha256'], expectedStage: o.stage });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `receipt_sha256=${result.receiptSha256}\n`);
    process.stdout.write('WINDOWS_SUBJECTS_SIGNED_AND_VERIFIED\n');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === FILE) main().catch(error => {
  process.stderr.write(error?.message === 'WINDOWS_SIGNING_TOOLCHAIN_PROVISIONING_REQUIRED'
    ? 'WINDOWS_SIGNING_TOOLCHAIN_PROVISIONING_REQUIRED\n' : 'WINDOWS_ISOLATED_SIGNER_REFUSED\n');
  process.exitCode = 1;
});
