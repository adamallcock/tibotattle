const THREAD_SOURCES = new Set(["user", "subagent", "automation", "unknown"]);
const SURFACES = new Set([
  "scheduled_task",
  "subagent",
  "extension_or_ide",
  "cli_exec",
  "local_interactive_unclassified",
  "local_rollout_unclassified",
]);
const AGENT_SCOPES = new Set(["root", "subagent", "automation", "unknown"]);
const LINEAGE_DISPOSITIONS = new Set(["standalone", "forked", "parent_linked"]);

// These are deliberately a closed vocabulary.  The classifier only uses source
// metadata as an input signal; it never retains the source string or object.
const AUTOMATION_WORDS = new Set(["automation", "automated", "scheduled", "scheduler", "cron", "background_task"]);
const SUBAGENT_WORDS = new Set(["subagent", "child_agent", "agent_child", "collaboration"]);
const USER_WORDS = new Set(["user", "human", "interactive", "manual"]);
const IDE_WORDS = new Set(["ide", "extension", "editor", "vscode", "cursor", "jetbrains", "zed"]);
const CLI_WORDS = new Set(["cli", "terminal", "shell", "exec", "command_line", "commandline"]);
const INTERACTIVE_WORDS = new Set(["interactive", "chat", "desktop", "tui", "manual", "user"]);
const ROOT_WORDS = new Set(["root", "primary", "main", "user", "human"]);
const SOURCE_KEYS = [
  "thread_source",
  "threadSource",
  "source",
  "subagent",
  "thread_spawn",
  "origin",
  "originator",
  "initiator",
  "created_by",
  "createdBy",
  "agent_scope",
  "agentScope",
  "agent_role",
  "type",
  "kind",
  "client",
  "client_type",
  "clientType",
  "surface",
  "channel",
  "runner",
  "mode",
  "task_type",
  "taskType",
];
const PARENT_KEYS = ["forked_from_id", "forkedFromId"];
const LINKED_PARENT_KEYS = ["parent_thread_id", "parentThreadId", "parent_id", "parentId"];

function ownDataValue(object, key) {
  if (!object || typeof object !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function normalizedWord(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return /^[a-z0-9_]{1,128}$/.test(normalized) ? normalized : null;
}

function collectSourceWords(payload) {
  const words = new Set();
  const visit = (value, depth) => {
    const word = normalizedWord(value);
    if (word) {
      words.add(word);
      return;
    }
    if (!value || typeof value !== "object" || depth === 0) return;
    for (const key of SOURCE_KEYS) visit(ownDataValue(value, key), depth - 1);
  };
  visit(payload, 3);
  return words;
}

function hasAny(words, candidates) {
  for (const word of candidates) if (words.has(word)) return true;
  return false;
}

function hasOwnPresentValue(payload, keys) {
  for (const key of keys) {
    const value = ownDataValue(payload, key);
    if (value !== undefined && value !== null && value !== "") return true;
  }
  return false;
}

function classifyThreadSource(words) {
  if (hasAny(words, AUTOMATION_WORDS)) return "automation";
  if (hasAny(words, SUBAGENT_WORDS)) return "subagent";
  if (hasAny(words, USER_WORDS)) return "user";
  return "unknown";
}

function classifySurface(words, threadSource) {
  if (threadSource === "automation" || hasAny(words, AUTOMATION_WORDS)) return "scheduled_task";
  if (threadSource === "subagent" || hasAny(words, SUBAGENT_WORDS)) return "subagent";
  if (hasAny(words, IDE_WORDS)) return "extension_or_ide";
  if (hasAny(words, CLI_WORDS)) return "cli_exec";
  if (hasAny(words, INTERACTIVE_WORDS)) return "local_interactive_unclassified";
  return "local_rollout_unclassified";
}

function classifyAgentScope(words, threadSource) {
  if (threadSource === "automation" || hasAny(words, AUTOMATION_WORDS)) return "automation";
  if (threadSource === "subagent" || hasAny(words, SUBAGENT_WORDS)) return "subagent";
  if (threadSource === "user" || hasAny(words, ROOT_WORDS)) return "root";
  return "unknown";
}

/**
 * Converts a raw `session_meta` payload into a fixed, privacy-safe taxonomy.
 * The returned object intentionally excludes all raw metadata, including IDs,
 * parent/fork references, paths, titles, source labels, and nested objects.
 */
export function classifySessionSurface(payload) {
  const safePayload = payload && typeof payload === "object" ? payload : null;
  const words = collectSourceWords(safePayload);
  const threadSource = classifyThreadSource(words);
  const surface = classifySurface(words, threadSource);
  const agentScope = classifyAgentScope(words, threadSource);
  const lineageDisposition = hasOwnPresentValue(safePayload, PARENT_KEYS)
    ? "forked"
    : hasOwnPresentValue(safePayload, LINKED_PARENT_KEYS)
      ? "parent_linked"
      : "standalone";

  const result = {
    schemaVersion: "0.1",
    threadSource,
    surface,
    agentScope,
    lineageDisposition,
  };
  // Keep the sets live as a cheap invariant if future changes touch this file.
  if (!THREAD_SOURCES.has(threadSource) || !SURFACES.has(surface)
    || !AGENT_SCOPES.has(agentScope) || !LINEAGE_DISPOSITIONS.has(lineageDisposition)) {
    throw new Error("surface classification invariant failed");
  }
  return result;
}
