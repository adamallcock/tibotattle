export function renderParticipantIdentityBackendMode(mode) {
  if (mode === "macos_keychain") return "macos_keychain";
  if (mode === "owner_file_override") {
    return "owner_only_file_development_override";
  }
  if (mode === "external_environment_override") {
    return "external_environment_development_override";
  }
  return "invalid";
}

export function renderParticipantIdentitySourceState(inspection) {
  if (inspection?.conflict === true) return "conflict";
  if (inspection?.source === "environment") return "external_override";
  if (inspection?.source === "secret_backend") return "keychain";
  if (inspection?.source === "owner_only_file") return "owner_only_file";
  if (inspection?.source === "legacy_owner_only_file") {
    return "legacy_owner_only_file";
  }
  if (["ready", "missing"].includes(inspection?.status)) {
    return inspection.status;
  }
  return "invalid";
}

export function renderParticipantIdentityFileResidueState(state) {
  if (["missing", "retired_removed"].includes(state)) return "absent";
  if (
    [
      "present",
      "retired_retained",
      "retired_retained_unverified",
    ].includes(state)
  ) {
    return "retained";
  }
  if (state === "disabled") return "not_applicable";
  return "invalid";
}
