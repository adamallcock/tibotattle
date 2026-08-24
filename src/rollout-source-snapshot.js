import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export class RolloutSourceChangedError extends Error {
  constructor() {
    super("Codex rollout source changed during indexing; retry");
    this.name = "RolloutSourceChangedError";
    this.code = "codex_rollout_source_changed";
    this.retryable = true;
  }
}

function sourceChanged() {
  throw new RolloutSourceChangedError();
}

function sameInteger(left, right) {
  return Number.isSafeInteger(Number(left))
    && Number.isSafeInteger(Number(right))
    && Number(left) === Number(right);
}

function sameTimestamp(left, right) {
  return Number.isFinite(Number(left))
    && Number.isFinite(Number(right))
    && Number(left) === Number(right);
}

function assertRegularOwnedFile(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    sourceChanged();
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    sourceChanged();
  }
}

function assertIdentity(stats, expected) {
  assertRegularOwnedFile(stats);
  if (Number.isSafeInteger(Number(expected?.dev))
      && !sameInteger(stats.dev, expected.dev)) sourceChanged();
  if (Number.isSafeInteger(Number(expected?.ino))
      && !sameInteger(stats.ino, expected.ino)) sourceChanged();
  if (Number.isFinite(Number(expected?.birthtimeMs))
      && !sameTimestamp(stats.birthtimeMs, expected.birthtimeMs)) sourceChanged();
}

function sameState(left, right) {
  return sameInteger(left.size, right.size)
    && sameTimestamp(left.mtimeMs, right.mtimeMs)
    && sameTimestamp(left.ctimeMs, right.ctimeMs);
}

async function assertPathIdentity(path, expected) {
  const stats = await lstat(path);
  assertIdentity(stats, expected);
  return stats;
}

async function assertAppendBoundary(handle, discoveredSize) {
  if (discoveredSize === 0) return;
  const byte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(byte, 0, 1, discoveredSize - 1);
  if (bytesRead !== 1 || byte[0] !== 0x0a) sourceChanged();
}

/**
 * Open a rollout once and bind every read to that descriptor. The discovered
 * byte range is immutable for this pass. Same-inode monotonic growth is
 * accepted because Codex rollout files are append-only; replacement,
 * truncation, link changes and same-size in-place edits fail the pass so the
 * last published index remains authoritative.
 */
export async function openStableRolloutSource(info) {
  if (!info || typeof info !== "object" || typeof info.path !== "string"
      || !Number.isSafeInteger(Number(info.size)) || Number(info.size) < 0) {
    throw new TypeError("rollout source metadata is invalid");
  }
  const discoveredSize = Number(info.size);
  const handle = await open(
    info.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    assertIdentity(before, info);
    const pathBefore = await assertPathIdentity(info.path, before);
    if (before.size < discoveredSize || pathBefore.size < discoveredSize) {
      sourceChanged();
    }
    if (before.size === discoveredSize
        && (!sameTimestamp(before.mtimeMs, info.mtimeMs)
          || !sameTimestamp(before.ctimeMs, info.ctimeMs))) {
      sourceChanged();
    }
    if (before.size > discoveredSize) {
      await assertAppendBoundary(handle, discoveredSize);
    }

    let closed = false;
    return Object.freeze({
      handle,
      discoveredSize,
      async verify() {
        if (closed) sourceChanged();
        const after = await handle.stat();
        assertIdentity(after, before);
        const pathAfter = await assertPathIdentity(info.path, after);
        if (after.size < discoveredSize || pathAfter.size < discoveredSize) {
          sourceChanged();
        }
        const unchanged = sameState(before, after)
          && sameState(after, pathAfter);
        const appendOnlyGrowth = after.size >= before.size
          && pathAfter.size >= after.size
          && (after.size > before.size || pathAfter.size > before.size);
        if (!unchanged && !appendOnlyGrowth) sourceChanged();
      },
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
      },
    });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function withStableRolloutSource(info, operation) {
  if (typeof operation !== "function") {
    throw new TypeError("rollout source operation must be a function");
  }
  const snapshot = await openStableRolloutSource(info);
  let operationFailed = false;
  let operationError;
  let result;
  try {
    result = await operation(snapshot.handle);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let verificationFailed = false;
  let verificationError;
  try {
    await snapshot.verify();
  } catch (error) {
    verificationFailed = true;
    verificationError = error;
  } finally {
    await snapshot.close().catch(() => {});
  }
  // A parse result or parse failure from bytes that changed during the pass
  // is never trustworthy. Prefer the retryable integrity verdict so a
  // transient writer race cannot be persisted as terminal content damage.
  if (verificationFailed) throw verificationError;
  if (operationFailed) throw operationError;
  return result;
}
