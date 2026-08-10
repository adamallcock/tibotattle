export {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  ExportIdentityKeychainError,
  KEYTAR_DARWIN_ARM64_SHA256,
  KEYTAR_SIGNING_CODE_IDENTIFIER,
  KEYTAR_SIGNING_TEAM_IDENTIFIER,
  createExportIdentityKeychainBackend,
  deleteExportIdentityKeychainItemByAttributes,
  exportIdentityKeychainAttributeDeleteArguments,
  keytarSignedBindingRequirement,
  keytarSignedBindingVerificationArguments,
  loadExportIdentityKeychainBinding,
} from "./platform/index.js";
