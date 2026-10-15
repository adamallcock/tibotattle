/* Unprivileged electron-builder transfer adapter. Never loads signing tools. */
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const PREFIX = "WINDOWS_SIGNING_TRANSFER_";
const APPLICATION_LEAVES = Object.freeze([
  "TiboTattle.exe", "d3dcompiler_47.dll", "ffmpeg.dll", "libEGL.dll",
  "libGLESv2.dll", "vk_swiftshader.dll", "vulkan-1.dll",
]);
const AUTH_ENV = /^(?:ACTIONS_ID_TOKEN_REQUEST_(?:URL|TOKEN)|ACTIONS_RUNTIME_TOKEN$|AZURE_|ARM_|CSC_|WIN_CSC_|GITHUB_TOKEN$|GH_TOKEN$|GH_ENTERPRISE_TOKEN$|GITHUB_ENTERPRISE_TOKEN$)/iu;
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(code) { const error = new Error(`${PREFIX}${code}`); error.code = error.message; throw error; }
function assertUnprivileged(environment = process.env) {
  if (Object.keys(environment).some((key) => AUTH_ENV.test(key))) fail("AUTHORITY_PRESENT");
}
function portable(root, file) {
  const value = path.relative(root, file).split(path.sep).join("/");
  if (!value || value.startsWith("../") || value === ".." || path.isAbsolute(value)
      || /[\0\r\n]/u.test(value)) fail("PATH_INVALID");
  return value;
}
async function regular(root, file, maximum = 1024 * 1024 * 1024) {
  const rootMetadata = await fs.lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail("PATH_INVALID");
  const relative = portable(root, file);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const metadata = await fs.lstat(current);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && current !== file)) fail("PATH_INVALID");
  }
  const before = await fs.lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > maximum) fail("FILE_INVALID");
  const same = (value) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1
    && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => value[key] === before[key]);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!same(await handle.stat())) fail("FILE_CHANGED");
    // The sentinel byte detects growth without allowing readFile to allocate
    // an unbounded result after the admission stat.
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== before.size || !same(await handle.stat()) || !same(await fs.lstat(file))) fail("FILE_CHANGED");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
async function writeExclusive(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return digest(bytes);
}
async function context() {
  assertUnprivileged();
  const repositoryRoot = path.resolve(__dirname, "../..");
  const root = path.join(repositoryRoot, ".release-build/electron-production/win32-x64");
  if (process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_ROOT !== root) fail("ROOT_INVALID");
  const stateRoot = path.join(root, "signing-transfer");
  const value = JSON.parse((await regular(root, path.join(stateRoot, "context.json"), 16384)).toString("utf8"));
  if (value.schemaVersion !== "tibotattle-windows-signing-transfer-v1"
      || !/^[0-9a-f]{40}$/u.test(value.sourceRevision) || !/^[0-9a-f]{64}$/u.test(value.candidateSha256)
      || !/^\d+\.\d+\.\d+$/u.test(value.version) || !/^[1-9][0-9]*$/u.test(value.buildNumber)) fail("CONTEXT_INVALID");
  return { root, repositoryRoot, stateRoot, binding: value };
}
async function recordSubject(file, stage) {
  const { root, stateRoot, binding } = await context();
  const relative = portable(root, path.resolve(file));
  const allowed = stage === "application"
    ? APPLICATION_LEAVES.map((leaf) => `artifacts/win-unpacked/${leaf}`)
    : stage === "uninstaller" ? [`artifacts/TiboTattle-${binding.version}-Windows-x64.__uninstaller.exe`] : [];
  if (!allowed.includes(relative)) fail("SUBJECT_INVALID");
  const bytes = await regular(root, file);
  const directory = path.join(stateRoot, `${stage}-requests`);
  await fs.mkdir(directory, { recursive: true });
  await writeExclusive(path.join(directory, `${path.basename(file)}.json`), {
    path: relative, sha256: digest(bytes), sizeBytes: bytes.length,
  });
}
async function treeFiles(root, directory) {
  const output = [];
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail("PATH_INVALID");
      if (entry.isDirectory()) await walk(file);
      else {
        const bytes = await regular(root, file);
        output.push({ path: portable(root, file), sha256: digest(bytes), sizeBytes: bytes.length });
      }
      if (output.length > 20000) fail("INPUT_LIMIT");
    }
  };
  await walk(directory);
  return output;
}
async function checkpointMakensis({ command, args, script, cwd, environment, temporaryRoot, uninstaller }) {
  const { root, repositoryRoot, stateRoot, binding } = await context();
  if (process.env.TIBOTATTLE_WINDOWS_SIGNING_TRANSFER_STAGE !== "uninstaller"
      || path.basename(command).toLowerCase() !== "makensis.exe"
      || !portable(root, command).startsWith("tool-cache/")
      || !portable(repositoryRoot, cwd).startsWith("node_modules/")
      || Object.keys(environment).some((key) => key !== "NSISDIR")) fail("COMPILER_INVALID");
  if (portable(root, uninstaller) !== `artifacts/TiboTattle-${binding.version}-Windows-x64.__uninstaller.exe`)
    fail("SUBJECT_INVALID");
  if (!portable(root, temporaryRoot).startsWith("builder-tmp/")) fail("TEMPORARY_ROOT_INVALID");
  const savedTemporaryRoot = path.join(stateRoot, "nsis-inputs");
  await fs.mkdir(savedTemporaryRoot);
  for (const entry of await treeFiles(root, temporaryRoot)) {
    const source = path.join(root, entry.path);
    const target = path.join(savedTemporaryRoot, portable(temporaryRoot, source));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await regular(root, source), { flag: "wx", mode: 0o600 });
  }
  const rewrite = (value) => value.split(temporaryRoot).join(savedTemporaryRoot)
    .split(temporaryRoot.split(path.sep).join("/")).join(savedTemporaryRoot.split(path.sep).join("/"))
    .split(repositoryRoot).join("@TIBOTATTLE_REPOSITORY_ROOT@")
    .split(repositoryRoot.split(path.sep).join("/")).join("@TIBOTATTLE_REPOSITORY_ROOT_FORWARD@");
  for (const entry of await treeFiles(root, savedTemporaryRoot)) {
    if (!/\.(?:nsh|nsi)$/u.test(entry.path)) continue;
    const file = path.join(root, entry.path);
    await fs.writeFile(file, rewrite((await regular(root, file)).toString("utf8")), { mode: 0o600 });
  }
  const savedScript = path.join(stateRoot, "installer.nsi");
  await fs.writeFile(savedScript, rewrite(script), { flag: "wx", mode: 0o600 });
  const inputs = [
    ...await treeFiles(root, savedTemporaryRoot), ...await treeFiles(root, path.join(root, "tool-cache")),
  ];
  // The prepared archive already embeds signed application/native bytes. It
  // must be reused verbatim after uninstaller signing, never rebuilt.
  for (const leaf of (await fs.readdir(path.join(root, "artifacts"))).sort()) {
    if (!/\.nsis\.(?:7z|zip)$/u.test(leaf)) continue;
    const file = path.join(root, "artifacts", leaf); const bytes = await regular(root, file);
    inputs.push({ path: portable(root, file), sha256: digest(bytes), sizeBytes: bytes.length });
  }
  if (!inputs.some((entry) => /\.nsis\.(?:7z|zip)$/u.test(entry.path))) fail("ARCHIVE_MISSING");
  const scriptBytes = await regular(root, savedScript, 4 * 1024 * 1024);
  inputs.push({ path: portable(root, savedScript), sha256: digest(scriptBytes), sizeBytes: scriptBytes.length });
  await writeExclusive(path.join(stateRoot, "nsis-continuation.json"), {
    ...binding, schemaVersion: "tibotattle-windows-nsis-continuation-v1",
    command: portable(root, command), args: args.map(rewrite),
    cwd: portable(repositoryRoot, cwd), environment: Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, rewrite(value)])),
    script: portable(root, savedScript), inputs,
    uninstaller: portable(root, uninstaller),
  });
  fail("CHECKPOINT_READY");
}

module.exports = { APPLICATION_LEAVES, assertUnprivileged, checkpointMakensis, digest,
  portable, recordSubject, regular, treeFiles, writeExclusive };
