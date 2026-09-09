import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, link, unlink, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openOperation, operationError } from "./lib/release-operation.mjs";

const PHASES = ["build", "sign-app", "archive", "staple-app", "package", "sign-dmg", "staple-dmg"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function artifactDigest(path, { durable = false } = {}) {
  const root = resolve(path);
  if (await realpath(dirname(root)) !== dirname(root)) throw operationError("RELEASE_ARTIFACT_PARENT_UNSAFE");
  const hash = createHash("sha256");
  let entries = 0;
  const visit = async (selected, name) => {
    if (++entries > 100_000) throw operationError("RELEASE_ARTIFACT_TOO_LARGE");
    const info = await lstat(selected);
    if (info.isSymbolicLink()) {
      const target = await readlink(selected);
      const destination = await realpath(selected);
      if (isAbsolute(target) || !destination.startsWith(`${root}${sep}`)) throw operationError("RELEASE_ARTIFACT_LINK_UNSAFE");
      hash.update(JSON.stringify([name, "link", target]));
    } else if (info.isDirectory()) {
      hash.update(JSON.stringify([name, "directory", info.mode & 0o777]));
      for (const entry of (await readdir(selected)).sort()) await visit(join(selected, entry), `${name}/${entry}`);
      if (durable) { const handle = await open(selected, "r"); try { await handle.sync(); } finally { await handle.close(); } }
    } else if (info.isFile() && info.nlink === 1) {
      hash.update(JSON.stringify([name, "file", info.mode & 0o777, info.size]));
      const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (before.ino !== info.ino || before.dev !== info.dev || before.nlink !== 1) throw operationError("RELEASE_ARTIFACT_CHANGED");
        for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) throw operationError("RELEASE_ARTIFACT_CHANGED");
        if (durable) await handle.sync();
      } finally { await handle.close(); }
    } else throw operationError("RELEASE_ARTIFACT_TYPE_UNSAFE");
  };
  await visit(root, ".");
  return hash.digest("hex");
}

function localPath(root, path) {
  if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || !part)) throw operationError("RELEASE_PHASE_PATH_INVALID");
  const selected = resolve(root, path);
  if (!selected.startsWith(`${root}${sep}`)) throw operationError("RELEASE_PHASE_PATH_INVALID");
  return selected;
}

async function fileHash(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) throw operationError("RELEASE_FINAL_FILE_UNSAFE");
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.ino !== info.ino || before.dev !== info.dev || before.nlink !== 1) throw operationError("RELEASE_FINAL_FILE_UNSAFE");
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await handle.stat();
    if (after.nlink !== 1 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw operationError("RELEASE_FINAL_FILE_UNSAFE");
  } finally { await handle.close(); }
  return hash.digest("hex");
}

// No overwrite: a pre-existing target is accepted only against this operation's
// durable expected bytes. Copy-on-install retains the staged evidence for resume.
async function installFile(source, target, expectedHash, operationId) {
  await mkdir(dirname(target), { recursive: true });
  if (await realpath(dirname(target)) !== dirname(target)) throw operationError("RELEASE_FINAL_PARENT_UNSAFE");
  const temporary = `${target}.install-${operationId}`;
  let exists = false;
  try { await lstat(target); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) {
    // Recover the exact link-before-unlink crash window, never another link.
    const installed = await lstat(target);
    if (installed.nlink === 2 && installed.isFile()) {
      const staged = await lstat(temporary);
      if (!staged.isFile() || installed.ino !== staged.ino || installed.dev !== staged.dev) throw operationError("RELEASE_FINAL_FILE_UNSAFE");
      await unlink(temporary);
    }
    if (await fileHash(target) !== expectedHash) throw operationError("RELEASE_FINAL_FILE_CONFLICT");
    await chmod(target, 0o444);
    return;
  }
  try { await copyFile(source, temporary, 1); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await fileHash(temporary) !== expectedHash) {
      // A process may have died during the private copy, before its hash/sync.
      // Preserve that exact operation-owned partial file, then create anew;
      // never truncate or delete it, and never touch a linked/public target.
      const info = await lstat(temporary);
      if (info.nlink !== 1 || !info.isFile() || (process.getuid && info.uid !== process.getuid())) throw operationError("RELEASE_FINAL_FILE_CONFLICT");
      const abandoned = `${temporary}.incomplete-${randomUUID()}`;
      await rename(temporary, abandoned);
      await copyFile(source, temporary, 1);
    }
  }
  const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.chmod(0o444); await handle.sync(); } finally { await handle.close(); }
  if (await fileHash(temporary) !== expectedHash) throw operationError("RELEASE_FINAL_FILE_CONFLICT");
  // link is an atomic no-clobber install. Unlink the known temporary name so
  // final evidence has a single link before recording success.
  await link(temporary, target);
  await unlink(temporary);
  const directory = await open(dirname(target), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function runJournaledMacOSRelease({ directory, resume = false, binding, output, manifestPath, actions, progress = () => {} }) {
  if (resolve(directory) !== `${resolve(output)}.operation`) throw operationError("RELEASE_OPERATION_OUTPUT_LOCK_REQUIRED");
  const operation = await openOperation({ directory, kind: "native", binding, resume });
  let state = operation.record.state;
  const save = async () => { await operation.save(state); };
  try {
    if (Object.keys(state).length === 0) {
      state = { phases: {}, notary: {}, install: null };
      // A fresh operation never adopts someone else's final bytes.
      for (const target of [output, manifestPath]) {
        try { await lstat(target); throw operationError("RELEASE_FINAL_FILE_EXISTS"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await save();
    }
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    if (!object(state.phases) || !object(state.notary) || (state.install !== null && !object(state.install)) || Object.keys(state).sort().join() !== "install,notary,phases"
        || Object.keys(state.phases).some((name) => !PHASES.includes(name))
        || Object.keys(state.notary).some((name) => !["app", "dmg"].includes(name))) throw operationError("RELEASE_PHASE_STATE_INVALID");
    let missing = false;
    for (const name of PHASES) {
      const record = state.phases[name];
      if (!record) { missing = true; continue; }
      if (missing || !object(record) || Object.keys(record).sort().join() !== "digest,path"
          || !/^[a-f0-9]{64}$/.test(record.digest) || typeof record.path !== "string") throw operationError("RELEASE_PHASE_STATE_INVALID");
    }
    for (const [name, record] of Object.entries(state.notary)) {
      if (!object(record) || Object.keys(record).sort().join() !== "digest,id,status"
          || !/^[a-f0-9]{64}$/.test(record.digest) || !["submitting", "submitted", "accepted"].includes(record.status)
          || (record.status === "submitting" ? record.id !== null : !UUID.test(record.id ?? ""))
          || !state.phases[name === "app" ? "archive" : "sign-dmg"]) throw operationError("RELEASE_NOTARY_STATE_INVALID");
    }
    if ((state.phases["staple-app"] && state.notary.app?.status !== "accepted")
        || (state.phases["staple-dmg"] && state.notary.dmg?.status !== "accepted")
        || (state.install && (!state.phases["staple-dmg"] || Object.keys(state.install).sort().join() !== "dmg,manifest,status"
          || !/^[a-f0-9]{64}$/.test(state.install.dmg) || !/^[a-f0-9]{64}$/.test(state.install.manifest)
          || !["installing", "complete"].includes(state.install.status)))) throw operationError("RELEASE_PHASE_STATE_INVALID");
    const phase = async (name, run) => {
      let record = state.phases[name];
      if (record) {
        if (Object.keys(record).sort().join() !== "digest,path" || !/^[a-f0-9]{64}$/.test(record.digest)) throw operationError("RELEASE_PHASE_STATE_INVALID");
        const selected = localPath(operation.directory, record.path);
        if (await artifactDigest(selected) !== record.digest) throw operationError("RELEASE_PHASE_OUTPUT_CHANGED");
        progress({ phase: name, state: "reused" });
        return selected;
      }
      progress({ phase: name, state: "running" });
      const attempt = await mkdtemp(join(operation.directory, `${name}-`));
      await chmod(attempt, 0o700);
      const selected = resolve(await run(attempt));
      if (!selected.startsWith(`${attempt}${sep}`)) throw operationError("RELEASE_PHASE_PATH_INVALID");
      record = { path: relative(operation.directory, selected), digest: await artifactDigest(selected, { durable: true }) };
      const parent = await open(attempt, "r"); try { await parent.sync(); } finally { await parent.close(); }
      state.phases[name] = record;
      await save();
      progress({ phase: name, state: "passed" });
      return selected;
    };
    const notarize = async (name, path) => {
      let record = state.notary[name];
      const digest = await artifactDigest(path);
      if (!record) {
        record = { digest, status: "submitting", id: null };
        state.notary[name] = record;
        await save(); // Must precede the remote side effect.
        const result = await actions.submit(path);
        if (!UUID.test(result?.id ?? "")) throw operationError("MACOS_NOTARY_SUBMISSION_UNCERTAIN");
        record.id = result.id;
        record.status = "submitted";
        await save();
      }
      if (Object.keys(record).sort().join() !== "digest,id,status" || record.digest !== digest
          || !["submitting", "submitted", "accepted"].includes(record.status)) throw operationError("RELEASE_NOTARY_STATE_INVALID");
      if (!UUID.test(record.id ?? "")) throw operationError("MACOS_NOTARY_SUBMISSION_UNCERTAIN");
      // Query known IDs again even when the earlier acceptance was recorded.
      if ((await actions.wait(record.id))?.status !== "Accepted") throw operationError("MACOS_NOTARIZATION_REJECTED");
      record.status = "accepted";
      await save();
    };
    const built = await phase("build", actions.build);
    const signed = await phase("sign-app", (root) => actions.signApp(built, root));
    const archive = await phase("archive", (root) => actions.archive(signed, root));
    await notarize("app", archive);
    const app = await phase("staple-app", (root) => actions.stapleApp(signed, root));
    await actions.validateApp(app); // Present trust / installed checks are not cached.
    const packaged = await phase("package", (root) => actions.package(app, root));
    const signedDMG = await phase("sign-dmg", (root) => actions.signDMG(packaged, root));
    await notarize("dmg", signedDMG);
    const dmg = await phase("staple-dmg", (root) => actions.stapleDMG(signedDMG, root));
    await actions.validateDMG(dmg);
    const manifest = await actions.manifest(built, dmg);
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    const expected = { dmg: await fileHash(dmg), manifest: createHash("sha256").update(manifestBytes).digest("hex") };
    if (state.install && (state.install.dmg !== expected.dmg || state.install.manifest !== expected.manifest)) throw operationError("RELEASE_INSTALL_STATE_MISMATCH");
    state.install = { ...expected, status: "installing" };
    await save();
    const manifestStage = join(await mkdtemp(join(operation.directory, "manifest-")), "release.json");
    const handle = await open(manifestStage, "wx", 0o600);
    try { await handle.writeFile(manifestBytes); await handle.sync(); } finally { await handle.close(); }
    await installFile(dmg, output, expected.dmg, operation.record.id);
    await installFile(manifestStage, manifestPath, expected.manifest, operation.record.id);
    state.install.status = "complete";
    await save();
    return { channel: manifest.channel?.name ?? binding.channel, output, releaseManifest: manifestPath, sha256: expected.dmg };
  } finally { operation.close(); }
}
