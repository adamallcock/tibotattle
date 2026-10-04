/** Read-only build provenance prerequisites shared by OPS infrastructure and rollout. */
// VERIFIED Cloud Build provenance requires Container Analysis before upload.
// Operators enable it explicitly; no tooling in this module enables a service.
export const GCP_OPS_BUILD_REQUIRED_SERVICES = Object.freeze(["containeranalysis.googleapis.com"]);
