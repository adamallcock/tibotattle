// Privacy-scoped read of exactly one key from the Codex configuration file.
//
// WHY THIS EXISTS
// ---------------
// Codex writes the speed mode into the rollout log only when it is applied or
// changed (`thread_settings_applied`), never at session start. The session
// baseline is therefore unobservable from the log alone. `~/.codex/config.toml`
// holds a top-level `service_tier` key with the CURRENT setting, which is the
// only place the baseline exists at all.
//
// WHY IT MAY ONLY BE READ, NEVER MINED
// ------------------------------------
// The Codex UI rewrites that file on every toggle, so the key proves the value
// at read time and nothing else. It can never be used to backfill history.
// This port therefore returns a single token plus nothing; the caller stamps it
// with the moment it was read.
//
// HARD PRIVACY CONSTRAINT
// -----------------------
// The same file carries MCP server configuration and can carry secrets. This
// reader:
//   * examines only the file's root table, stopping at the first `[table]`
//     header, so table bodies are never even inspected;
//   * reads at most a bounded prefix of the file;
//   * retains only a `service_tier` token matching a narrow safe charset;
//   * zeroes its read buffer;
//   * never includes any file content in a return value, an error, or a log.
// Every failure is fail-closed: a fixed status code and a null tier. A default
// is never guessed.
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Fixed, content-free statuses. No file content ever reaches a caller. */
export const CODEX_CONFIG_SERVICE_TIER_STATUSES = Object.freeze([
  // The root table declared a well-formed `service_tier` string.
  "declared",
  // The file was readable but its root table declares no usable value.
  "absent",
  // No configuration file exists.
  "missing",
  // Present but unreadable, oversized, or not an ordinary file.
  "unreadable",
]);

/** The only key this reader is permitted to retain. */
export const CODEX_CONFIG_RETAINED_KEYS = Object.freeze(["service_tier"]);

// A whole config.toml may be large. Only the root-table prefix is ever needed,
// and scanning stops at the first table header well before this in practice.
const DEFAULT_MAXIMUM_PREFIX_BYTES = 64 * 1_024;
const MAXIMUM_FILE_BYTES = 8 * 1_024 * 1_024;

// `key = "value"` in the root table, with an optional trailing comment. The
// value charset is deliberately narrow: a provider tier token, nothing else.
const SERVICE_TIER_ASSIGNMENT =
  /^[ \t]*service_tier[ \t]*=[ \t]*(?:"([A-Za-z0-9._-]{1,32})"|'([A-Za-z0-9._-]{1,32})')[ \t]*(?:#.*)?$/u;
// A `[table]` or `[[array of tables]]` header ends the root table. Everything
// after it - including every MCP server block - is out of scope by construction.
const TABLE_HEADER = /^[ \t]*\[/u;

function outcome(status, serviceTier = null) {
  return Object.freeze({
    status,
    serviceTier,
    retainedKeys: CODEX_CONFIG_RETAINED_KEYS,
  });
}

/**
 * Read the root-table `service_tier` token from a Codex configuration file.
 *
 * Returns `{ status, serviceTier, retainedKeys }` where `serviceTier` is the
 * raw provider token (for example "priority" or "default") or null. Mapping the
 * token to a speed mode is deliberately left to the caller so this port keeps
 * no product vocabulary.
 */
export async function readCodexConfigServiceTier({
  configFile,
  maximumPrefixBytes = DEFAULT_MAXIMUM_PREFIX_BYTES,
} = {}) {
  if (typeof configFile !== "string" || configFile.length < 1) {
    return outcome("unreadable");
  }
  if (!Number.isSafeInteger(maximumPrefixBytes)
      || maximumPrefixBytes < 1
      || maximumPrefixBytes > MAXIMUM_FILE_BYTES) {
    return outcome("unreadable");
  }

  let handle;
  let buffer;
  try {
    handle = await open(
      configFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stats = await handle.stat();
    if (!stats.isFile() || stats.isSymbolicLink()) return outcome("unreadable");
    if (stats.size === 0) return outcome("absent");
    const budget = Math.min(maximumPrefixBytes, stats.size);
    buffer = Buffer.allocUnsafe(budget);
    let filled = 0;
    while (filled < budget) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        budget - filled,
        filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const truncated = filled < stats.size;
    const lines = buffer.toString("utf8", 0, filled).split("\n");
    // A prefix read can split the final line; never interpret a partial line.
    if (truncated && lines.length > 0) lines.pop();
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      // Stop before any table body. Nothing below this point is looked at.
      if (TABLE_HEADER.test(line)) break;
      const match = SERVICE_TIER_ASSIGNMENT.exec(line);
      if (match === null) continue;
      const token = match[1] ?? match[2];
      // Only the matched token survives this function.
      return outcome("declared", token);
    }
    return outcome("absent");
  } catch (error) {
    return outcome(error?.code === "ENOENT" ? "missing" : "unreadable");
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => {});
  }
}
