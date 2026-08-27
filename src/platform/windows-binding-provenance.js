/**
 * Boundary for authenticating the packaged Windows filesystem binding.
 *
 * The adjacent manifest proves only that the bytes and JavaScript/native
 * contract agree. It is not a signature, and a manifest field cannot be
 * allowed to authorize itself. Until the Windows package/signature verifier
 * is implemented, this port returns a frozen unavailable result for every
 * request. Keeping the port here gives the loader one explicit replacement
 * point for a future OS/package verifier without accepting a caller callback,
 * boolean, or attestation object as authority.
 */

export const WINDOWS_FILESYSTEM_BINDING_PROVENANCE_STATUS = Object.freeze({
  unavailable: "unavailable",
});

export const WINDOWS_FILESYSTEM_BINDING_PROVENANCE_UNAVAILABLE = Object.freeze({
  status: WINDOWS_FILESYSTEM_BINDING_PROVENANCE_STATUS.unavailable,
  reason: "no-trusted-package-verifier",
});

/**
 * Verify the provenance of the exact binding bytes selected by the loader.
 *
 * The arguments are intentionally descriptive only. No verifier or result
 * can be injected through them. A future implementation may use the binding
 * path, bytes, and parsed manifest to ask an OS/package-signature boundary,
 * but until that boundary exists production promotion remains unavailable.
 */
export function verifyWindowsFilesystemBindingProvenance(_request = {}) {
  return WINDOWS_FILESYSTEM_BINDING_PROVENANCE_UNAVAILABLE;
}
