import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { posix } from "node:path";

export const LINUX_AUTOSTART_CONTRACT = "tibotattle-linux-autostart-v1";
export const LINUX_AUTOSTART_APPLICATION_ID = "com.usagemonitor.local";
export const LINUX_AUTOSTART_DESKTOP_FILE =
  `${LINUX_AUTOSTART_APPLICATION_ID}.desktop`;

const MAXIMUM_ENTRY_BYTES = 4096;
const FIXED_ARGUMENT = "--autostart";
const RESULT_STATUSES = new Set([
  "enabled",
  "disabled",
  "malformed",
  "unsafe",
  "unavailable",
  "error",
]);
const ERROR_CODES = new Set([
  "platform_invalid",
  "configuration_invalid",
  "config_root_invalid",
  "executable_path_invalid",
  "uid_invalid",
  "entry_too_large",
  "result_invalid",
  "random_unavailable",
  "directory_unsafe",
  "directory_unavailable",
  "directory_replaced",
  "directory_sync_failed",
  "executable_unsafe",
  "executable_unavailable",
  "executable_replaced",
  "entry_unsafe",
  "entry_unavailable",
  "entry_replaced",
  "stage_replaced",
  "readback_mismatch",
  "publish_failed",
  "remove_failed",
]);

export class LinuxAutostartError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux autostart error code");
    }
    super("Linux autostart operation failed");
    this.name = "LinuxAutostartError";
    this.code = `linux_autostart_${code}`;
  }
}

function fail(code) {
  throw new LinuxAutostartError(code);
}

function exactAbsolutePath(value, code) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || value.includes("\n")
      || value.includes("\r")
      || value.includes("%")
      || Buffer.byteLength(value, "utf8") > 4096
      || !posix.isAbsolute(value)
      || posix.resolve(value) !== value
      || value === posix.parse(value).root) {
    fail(code);
  }
  return value;
}

function quotedExecToken(value) {
  // The freedesktop Exec grammar does not invoke a shell. Quote the one
  // reviewed executable token and escape every character reserved inside a
  // double-quoted token. Percent is rejected above so no field code expands.
  return `"${value.replaceAll(/([\\"`$])/gu, "\\$1")}"`;
}

export function buildLinuxAutostartDesktopEntry(executablePath) {
  const executable = exactAbsolutePath(executablePath, "executable_path_invalid");
  const text = [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=TiboTattle",
    "Comment=Start TiboTattle at login",
    `Exec=${quotedExecToken(executable)} ${FIXED_ARGUMENT}`,
    "Terminal=false",
    "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true",
    `X-TiboTattle-Application-Id=${LINUX_AUTOSTART_APPLICATION_ID}`,
    `X-TiboTattle-Autostart-Contract=${LINUX_AUTOSTART_CONTRACT}`,
    "",
  ].join("\n");
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_ENTRY_BYTES) {
    fail("entry_too_large");
  }
  return text;
}

function result(status, canSet) {
  if (!RESULT_STATUSES.has(status) || typeof canSet !== "boolean") {
    fail("result_invalid");
  }
  return Object.freeze({
    contractVersion: LINUX_AUTOSTART_CONTRACT,
    status,
    canSet,
  });
}

function sameDirectoryIdentity(left, right) {
  return left?.device === right?.device
    && left?.inode === right?.inode
    && left?.uid === right?.uid
    && left?.mode === right?.mode;
}

function directoryChain(target) {
  const root = posix.parse(target).root;
  const relative = posix.relative(root, target);
  const parts = relative === "" ? [] : relative.split("/");
  const chain = [root];
  for (const part of parts) chain.push(posix.join(chain.at(-1), part));
  return chain;
}

function assertDirectory(stats, { target, currentUid }) {
  if (!stats?.isDirectory?.() || stats?.isSymbolicLink?.()) {
    fail("directory_unsafe");
  }
  if (currentUid !== null) {
    if (target && stats.uid !== currentUid) fail("directory_unsafe");
    if (!target && stats.uid !== currentUid && stats.uid !== 0) {
      fail("directory_unsafe");
    }
  }
  const mode = stats.mode & 0o7777;
  const traversable = currentUid === null
    ? (mode & 0o111) !== 0
    : stats.uid === currentUid
      ? (mode & 0o100) !== 0
      : (mode & 0o001) !== 0;
  if (!traversable) fail("directory_unsafe");
  if (target) {
    if ((mode & 0o700) !== 0o700 || (mode & 0o022) !== 0) {
      fail("directory_unsafe");
    }
  } else if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
    fail("directory_unsafe");
  }
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev
    && left?.ino === right?.ino
    && left?.uid === right?.uid
    && left?.nlink === right?.nlink
    && left?.size === right?.size
    && left?.mtimeMs === right?.mtimeMs
    && left?.ctimeMs === right?.ctimeMs;
}

function assertOwnerFile(stats, currentUid, {
  executable = false,
  maximumBytes = Number.MAX_SAFE_INTEGER,
} = {}) {
  if (!stats?.isFile?.() || stats?.isSymbolicLink?.() || stats.nlink !== 1) {
    fail(executable ? "executable_unsafe" : "entry_unsafe");
  }
  if (currentUid !== null && stats.uid !== currentUid
      && !(executable && stats.uid === 0)) {
    fail(executable ? "executable_unsafe" : "entry_unsafe");
  }
  const mode = stats.mode & 0o7777;
  const executableByCaller = currentUid === null
    ? (mode & 0o111) !== 0
    : stats.uid === currentUid
      ? (mode & 0o100) !== 0
      : (mode & 0o001) !== 0;
  if ((mode & 0o022) !== 0
      || (!executable && (mode & 0o077) !== 0)
      || (executable && !executableByCaller)
      || !Number.isSafeInteger(stats.size)
      || stats.size < 0
      || stats.size > maximumBytes) {
    fail(executable ? "executable_unsafe" : "entry_unsafe");
  }
}

function stageToken(randomBytesFunction) {
  let bytes;
  try {
    bytes = randomBytesFunction(16);
  } catch {
    fail("random_unavailable");
  }
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
      || bytes.byteLength !== 16) {
    fail("random_unavailable");
  }
  return Buffer.from(bytes).toString("hex");
}

/**
 * Own one explicit per-user XDG autostart entry. Construction and status are
 * inert; only an explicit enable() call creates the entry.
 */
export function createLinuxAutostartOwner({
  platform = process.platform,
  configRoot,
  executablePath,
  currentUid = typeof process.getuid === "function" ? process.getuid() : null,
  failpoint = async () => {},
  randomBytesFunction = randomBytes,
  fileSystem = {},
} = {}) {
  if (platform !== "linux") fail("platform_invalid");
  const selectedConfigRoot = exactAbsolutePath(configRoot, "config_root_invalid");
  const selectedExecutable = exactAbsolutePath(
    executablePath,
    "executable_path_invalid",
  );
  if (currentUid !== null
      && (!Number.isSafeInteger(currentUid) || currentUid < 0)) {
    fail("uid_invalid");
  }
  if (typeof failpoint !== "function" || typeof randomBytesFunction !== "function") {
    fail("configuration_invalid");
  }
  const fs = Object.freeze({
    lstat: fileSystem.lstat ?? lstat,
    mkdir: fileSystem.mkdir ?? mkdir,
    open: fileSystem.open ?? open,
    realpath: fileSystem.realpath ?? realpath,
    rename: fileSystem.rename ?? rename,
    unlink: fileSystem.unlink ?? unlink,
  });
  for (const method of Object.values(fs)) {
    if (typeof method !== "function") fail("configuration_invalid");
  }

  const directory = posix.join(selectedConfigRoot, "autostart");
  const target = posix.join(directory, LINUX_AUTOSTART_DESKTOP_FILE);
  const expectedText = buildLinuxAutostartDesktopEntry(selectedExecutable);
  const expectedBytes = Buffer.from(expectedText, "utf8");

  async function validateDirectory(path) {
    let before;
    try {
      for (const component of directoryChain(path)) {
        const stats = await fs.lstat(component);
        const targetDirectory = component === path;
        assertDirectory(stats, { target: targetDirectory, currentUid });
        if (targetDirectory) before = stats;
      }
    } catch (error) {
      if (error instanceof LinuxAutostartError) throw error;
      if (error?.code === "ENOENT") fail("directory_unavailable");
      fail("directory_unsafe");
    }
    let canonical;
    try {
      canonical = await fs.realpath(path);
    } catch {
      fail("directory_unavailable");
    }
    if (canonical !== path) fail("directory_unsafe");
    let handle;
    try {
      handle = await fs.open(
        path,
        constants.O_RDONLY
          | (constants.O_DIRECTORY ?? 0)
          | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      assertDirectory(opened, { target: true, currentUid });
      if (opened.dev !== before.dev || opened.ino !== before.ino
          || opened.uid !== before.uid
          || (opened.mode & 0o7777) !== (before.mode & 0o7777)) {
        fail("directory_replaced");
      }
      const after = await fs.lstat(path);
      assertDirectory(after, { target: true, currentUid });
      if (after.dev !== opened.dev || after.ino !== opened.ino
          || after.uid !== opened.uid
          || (after.mode & 0o7777) !== (opened.mode & 0o7777)) {
        fail("directory_replaced");
      }
      return Object.freeze({
        device: opened.dev,
        inode: opened.ino,
        uid: opened.uid,
        mode: opened.mode & 0o7777,
      });
    } catch (error) {
      if (error instanceof LinuxAutostartError) throw error;
      fail("directory_replaced");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function existingAutostartDirectory({ create = false } = {}) {
    const configIdentity = await validateDirectory(selectedConfigRoot);
    let metadata;
    try {
      metadata = await fs.lstat(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") fail("directory_unsafe");
      if (!create) return null;
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") fail("directory_unavailable");
      }
      metadata = await fs.lstat(directory).catch(() => null);
    }
    if (!metadata) fail("directory_unavailable");
    const directoryIdentity = await validateDirectory(directory);
    const configAfter = await validateDirectory(selectedConfigRoot);
    if (!sameDirectoryIdentity(configIdentity, configAfter)) {
      fail("directory_replaced");
    }
    return directoryIdentity;
  }

  async function revalidateDirectory(expected) {
    const observed = await validateDirectory(directory);
    if (!sameDirectoryIdentity(expected, observed)) fail("directory_replaced");
    return observed;
  }

  async function inspectExecutable() {
    let before;
    let handle;
    try {
      for (const component of directoryChain(posix.dirname(selectedExecutable))) {
        const directoryMetadata = await fs.lstat(component);
        assertDirectory(directoryMetadata, { target: false, currentUid });
      }
      if (await fs.realpath(selectedExecutable) !== selectedExecutable) {
        fail("executable_unsafe");
      }
      before = await fs.lstat(selectedExecutable);
      assertOwnerFile(before, currentUid, { executable: true });
      handle = await fs.open(
        selectedExecutable,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      assertOwnerFile(opened, currentUid, { executable: true });
      if (!sameFileIdentity(before, opened)) fail("executable_replaced");
      const after = await fs.lstat(selectedExecutable);
      assertOwnerFile(after, currentUid, { executable: true });
      if (!sameFileIdentity(opened, after)) fail("executable_replaced");
      return Object.freeze({
        dev: opened.dev,
        ino: opened.ino,
        uid: opened.uid,
        nlink: opened.nlink,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        ctimeMs: opened.ctimeMs,
      });
    } catch (error) {
      if (error instanceof LinuxAutostartError) throw error;
      fail("executable_unavailable");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function inspectEntry(directoryIdentity) {
    let pathStats;
    try {
      pathStats = await fs.lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      fail("entry_unavailable");
    }
    assertOwnerFile(pathStats, currentUid, { maximumBytes: MAXIMUM_ENTRY_BYTES });
    let handle;
    try {
      handle = await fs.open(
        target,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      assertOwnerFile(opened, currentUid, { maximumBytes: MAXIMUM_ENTRY_BYTES });
      if (!sameFileIdentity(pathStats, opened)) fail("entry_replaced");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameFileIdentity(opened, after) || bytes.byteLength !== opened.size) {
        fail("entry_replaced");
      }
      const pathAfter = await fs.lstat(target);
      assertOwnerFile(pathAfter, currentUid, { maximumBytes: MAXIMUM_ENTRY_BYTES });
      if (!sameFileIdentity(after, pathAfter)) fail("entry_replaced");
      await revalidateDirectory(directoryIdentity);
      return Object.freeze({
        identity: Object.freeze({
          dev: opened.dev,
          ino: opened.ino,
          uid: opened.uid,
          nlink: opened.nlink,
          size: opened.size,
          mtimeMs: opened.mtimeMs,
          ctimeMs: opened.ctimeMs,
        }),
        exact: bytes.equals(expectedBytes),
      });
    } catch (error) {
      if (error instanceof LinuxAutostartError) throw error;
      fail("entry_unavailable");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function revalidateEntry(expectedIdentity) {
    let current;
    try {
      current = await fs.lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT" && expectedIdentity === null) return;
      fail("entry_replaced");
    }
    if (expectedIdentity === null) fail("entry_replaced");
    assertOwnerFile(current, currentUid, { maximumBytes: MAXIMUM_ENTRY_BYTES });
    if (!sameFileIdentity(current, expectedIdentity)) fail("entry_replaced");
  }

  async function syncAutostartDirectory(expectedIdentity) {
    let handle;
    try {
      handle = await fs.open(
        directory,
        constants.O_RDONLY
          | (constants.O_DIRECTORY ?? 0)
          | (constants.O_NOFOLLOW ?? 0),
      );
      const stats = await handle.stat();
      if (stats.dev !== expectedIdentity.device
          || stats.ino !== expectedIdentity.inode) {
        fail("directory_replaced");
      }
      await handle.sync();
    } catch (error) {
      if (error instanceof LinuxAutostartError) throw error;
      fail("directory_sync_failed");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function status() {
    try {
      const directoryIdentity = await existingAutostartDirectory();
      if (directoryIdentity === null) {
        await inspectExecutable();
        return result("disabled", true);
      }
      const observed = await inspectEntry(directoryIdentity);
      if (observed === null) {
        await inspectExecutable();
        return result("disabled", true);
      }
      await inspectExecutable();
      return observed.exact
        ? result("enabled", true)
        : result("malformed", false);
    } catch (error) {
      if (!(error instanceof LinuxAutostartError)) return result("error", false);
      if ([
        "linux_autostart_entry_unsafe",
        "linux_autostart_directory_unsafe",
        "linux_autostart_directory_replaced",
        "linux_autostart_entry_replaced",
        "linux_autostart_executable_unsafe",
        "linux_autostart_executable_replaced",
      ].includes(error.code)) return result("unsafe", false);
      if ([
        "linux_autostart_directory_unavailable",
        "linux_autostart_executable_unavailable",
      ].includes(error.code)) return result("unavailable", false);
      return result("error", false);
    }
  }

  async function cleanupStage(stagePath, stageIdentity) {
    if (stageIdentity === null) return;
    try {
      const current = await fs.lstat(stagePath);
      if (sameFileIdentity(current, stageIdentity)) await fs.unlink(stagePath);
    } catch {
      // Cleanup is best effort and never broadens the target beyond the one
      // random stage inode created by this operation.
    }
  }

  async function enable() {
    const directoryIdentity = await existingAutostartDirectory({ create: true });
    const executableIdentity = await inspectExecutable();
    const existing = await inspectEntry(directoryIdentity);
    if (existing?.exact === true) return result("enabled", true);
    // Ownership and a fixed pathname are not authority to replace arbitrary
    // user content. A malformed entry requires explicit user remediation (or
    // a future reviewed native conditional-mutation primitive).
    if (existing !== null) fail("entry_unsafe");

    const stagePath = posix.join(
      directory,
      `.${LINUX_AUTOSTART_DESKTOP_FILE}.${stageToken(randomBytesFunction)}.tmp`,
    );
    let stageHandle;
    let stageIdentity = null;
    try {
      stageHandle = await fs.open(
        stagePath,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const created = await stageHandle.stat();
      assertOwnerFile(created, currentUid, { maximumBytes: MAXIMUM_ENTRY_BYTES });
      stageIdentity = Object.freeze({
        dev: created.dev,
        ino: created.ino,
        uid: created.uid,
        nlink: created.nlink,
        size: created.size,
        mtimeMs: created.mtimeMs,
        ctimeMs: created.ctimeMs,
      });
      await stageHandle.writeFile(expectedBytes);
      await stageHandle.sync();
      const written = await stageHandle.stat();
      assertOwnerFile(written, currentUid, { maximumBytes: MAXIMUM_ENTRY_BYTES });
      if (written.dev !== stageIdentity.dev || written.ino !== stageIdentity.ino
          || written.size !== expectedBytes.byteLength) {
        fail("stage_replaced");
      }
      stageIdentity = Object.freeze({
        dev: written.dev,
        ino: written.ino,
        uid: written.uid,
        nlink: written.nlink,
        size: written.size,
        mtimeMs: written.mtimeMs,
        ctimeMs: written.ctimeMs,
      });
      await stageHandle.close();
      stageHandle = null;

      await failpoint("after_stage");
      await revalidateDirectory(directoryIdentity);
      const executableAfterStage = await inspectExecutable();
      if (!sameFileIdentity(executableIdentity, executableAfterStage)) {
        fail("executable_replaced");
      }
      await revalidateEntry(existing?.identity ?? null);
      await failpoint("before_publish");
      await revalidateDirectory(directoryIdentity);
      const executableBeforePublish = await inspectExecutable();
      if (!sameFileIdentity(executableIdentity, executableBeforePublish)) {
        fail("executable_replaced");
      }
      await revalidateEntry(existing?.identity ?? null);

      await fs.rename(stagePath, target);
      await syncAutostartDirectory(directoryIdentity);
      const published = await inspectEntry(directoryIdentity);
      if (published?.exact !== true
          || published.identity.dev !== stageIdentity.dev
          || published.identity.ino !== stageIdentity.ino) {
        fail("readback_mismatch");
      }
      return result("enabled", true);
    } catch (error) {
      if (error instanceof LinuxAutostartError) throw error;
      fail("publish_failed");
    } finally {
      await stageHandle?.close().catch(() => {});
      await cleanupStage(stagePath, stageIdentity);
    }
  }

  async function disable() {
    const directoryIdentity = await existingAutostartDirectory();
    if (directoryIdentity === null) return result("disabled", false);
    const existing = await inspectEntry(directoryIdentity);
    if (existing === null) return result("disabled", true);
    // Delete only the exact reviewed TiboTattle entry. A safe-but-different
    // desktop file at the fixed path is not deletion authority.
    if (!existing.exact) fail("entry_unsafe");
    try {
      await failpoint("before_remove");
      await revalidateDirectory(directoryIdentity);
      await revalidateEntry(existing.identity);
      await fs.unlink(target);
      await syncAutostartDirectory(directoryIdentity);
      await revalidateEntry(null);
      await revalidateDirectory(directoryIdentity);
      return result("disabled", true);
    } catch (error) {
      if (error instanceof LinuxAutostartError) throw error;
      fail("remove_failed");
    }
  }

  return Object.freeze({
    status,
    enable,
    disable,
    remove: disable,
    productionSafe: false,
  });
}
