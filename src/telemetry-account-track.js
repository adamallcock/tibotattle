import { deriveExportPseudonym } from "./export-identity.js";

export const TELEMETRY_ACCOUNT_TRACK_VERSION = "account-track-v1";
export const UNATTRIBUTED_ACCOUNT_TRACK_ID = "unattributed";

const LOCAL_ACCOUNT_SCOPE_PATTERN = /^account:v1:([a-f0-9]{64})$/u;
const CENTRAL_PARTICIPANT_PATTERN = /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_TRACK_PATTERN = /^account-track:v1:[a-f0-9]{64}$/u;
const PROVIDERS = new Set(["openai_codex", "anthropic_claude_code"]);

function assertCentralParticipantId(value) {
  if (typeof value !== "string" || !CENTRAL_PARTICIPANT_PATTERN.test(value)) {
    throw new TypeError("Central participant identifier is invalid");
  }
  return value.toLowerCase();
}

function assertProvider(value) {
  if (typeof value !== "string" || !PROVIDERS.has(value)) {
    throw new TypeError("Account-track provider is invalid");
  }
  return value;
}

/**
 * Convert the installation-local export account scope into the only account
 * continuity value eligible for a central contribution.
 *
 * The local scope is itself a keyed digest. It becomes key material for a
 * third, central-participant-scoped derivation and is never returned. A new
 * central enrollment therefore cannot be linked by comparing this output.
 */
export function deriveTelemetryAccountTrackId(
  localAccountScopeId,
  centralParticipantId,
  provider,
) {
  const participant = assertCentralParticipantId(centralParticipantId);
  const safeProvider = assertProvider(provider);
  if (localAccountScopeId === UNATTRIBUTED_ACCOUNT_TRACK_ID) {
    return UNATTRIBUTED_ACCOUNT_TRACK_ID;
  }
  const match = typeof localAccountScopeId === "string"
    ? LOCAL_ACCOUNT_SCOPE_PATTERN.exec(localAccountScopeId)
    : null;
  if (!match) throw new TypeError("Local account scope is invalid");

  const localScopeKey = Buffer.from(match[1], "hex");
  try {
    const track = deriveExportPseudonym(
      localScopeKey,
      "account-track",
      `${safeProvider}\u0000${participant}`,
    );
    if (!ACCOUNT_TRACK_PATTERN.test(track)) {
      throw new Error("Derived account track is invalid");
    }
    return track;
  } finally {
    localScopeKey.fill(0);
  }
}

export function isTelemetryAccountTrackId(value) {
  return value === UNATTRIBUTED_ACCOUNT_TRACK_ID
    || (typeof value === "string" && ACCOUNT_TRACK_PATTERN.test(value));
}
