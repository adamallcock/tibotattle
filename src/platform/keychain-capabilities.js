/**
 * Closed logical Keychain capabilities shared by every native backend.
 *
 * These legacy service/account pairs remain the public capability tokens used
 * by the standalone CLI and Windows implementation. The packaged macOS app
 * never sends either string across its broker channel: the binding translates
 * the exact frozen object to a short wire capability, and the signed app owns
 * the corresponding `.app.v1` item.
 */
export const EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES = Object.freeze({
  exportIdentity: Object.freeze({
    service: "app-usagemonitor.export-identity.v1",
    account: "installation",
  }),
  accountObservation: Object.freeze({
    service: "app-usagemonitor.account-observation.v1",
    account: "installation",
  }),
  claudeSessionPseudonym: Object.freeze({
    service: "app-usagemonitor.claude-session-pseudonym.v1",
    account: "installation",
  }),
  contributionDevice: Object.freeze({
    service: "app-usagemonitor.contribution-device.v1",
    account: "installation",
  }),
  contributionDeviceApp: Object.freeze({
    service: "app-usagemonitor.contribution-device.app.v1",
    account: "installation",
  }),
});

/**
 * App-owned storage attributes. They are exported only for destructive,
 * attribute-addressed maintenance such as Identity & Device Reset. Ordinary
 * companion code addresses logical capabilities through the broker and can
 * never choose these service strings.
 */
export const MACOS_APP_KEYCHAIN_CAPABILITIES = Object.freeze({
  exportIdentity: Object.freeze({
    service: "app-usagemonitor.export-identity.app.v1",
    account: "installation",
  }),
  accountObservation: Object.freeze({
    service: "app-usagemonitor.account-observation.app.v1",
    account: "installation",
  }),
  claudeSessionPseudonym: Object.freeze({
    service: "app-usagemonitor.claude-session-pseudonym.app.v1",
    account: "installation",
  }),
  contributionDevice:
    EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp,
});

export const MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES = Object.freeze({
  exportIdentity: "export_identity",
  accountObservation: "account_observation",
  claudeSessionPseudonym: "claude_session_pseudonym",
  contributionDevice: "contribution_device",
});

export function macOSKeychainBrokerCapabilityName(capability) {
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity) {
    return MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES.exportIdentity;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation) {
    return MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES.accountObservation;
  }
  if (capability
      === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.claudeSessionPseudonym) {
    return MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES.claudeSessionPseudonym;
  }
  if (capability === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice
      || capability
        === EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp) {
    return MACOS_KEYCHAIN_BROKER_CAPABILITY_NAMES.contributionDevice;
  }
  return null;
}
