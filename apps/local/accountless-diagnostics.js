// Local, content-free support trail. The fixed vocabulary prevents a raw
// transport error, identifier or path from entering the private diagnostics log.
const FAILURES = new Set([
  "transient_failure", "terminal_failure", "credential_recovery_required", "preference_unavailable",
]);
const INTERVAL_MS = 60 * 60 * 1000;
const canonicalInstant = (value) => typeof value === "string"
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function createAccountlessDiagnosticRecorder({ recordNote, createReference, clock = Date.now }) {
  if ([recordNote, createReference, clock].some((value) => typeof value !== "function")) {
    throw new TypeError("Invalid accountless diagnostic recorder");
  }
  const recorded = new Map();
  let lastObservedSuccessAt = null;
  return async (snapshot) => {
    let code = null;
    if (["retry_wait", "paused", "recovery_required", "unavailable"].includes(snapshot?.state)
        && FAILURES.has(snapshot?.lastFailureCode)) {
      code = `accountless_${snapshot.lastFailureCode}`;
    } else if (snapshot?.state === "uploading") {
      code = "accountless_sync_attempt";
    } else if (["up_to_date", "pending"].includes(snapshot?.state)
        && canonicalInstant(snapshot.lastSuccessfulSyncAt) && snapshot.lastFailureCode === null
        && snapshot.lastSuccessfulSyncAt !== lastObservedSuccessAt) {
      code = "accountless_sync_succeeded";
      lastObservedSuccessAt = snapshot.lastSuccessfulSyncAt;
    }
    if (code === null) return false;
    const now = clock();
    const previous = recorded.get(code);
    if (!Number.isFinite(now)) return false;
    if (previous !== undefined && now < previous) {
      // Rebase once without writing; repeated backwards samples never create a
      // write storm, and a subsequently stable clock resumes after one hour.
      recorded.set(code, now);
      return false;
    }
    if (previous !== undefined && now - previous < INTERVAL_MS) return false;
    // Six possible keys; stamp before I/O to bound even a failing log sink.
    recorded.set(code, now);
    try {
      await recordNote({ reference: createReference(), surface: "automatic_contribution", code, requestId: "" });
      return true;
    } catch { return false; }
  };
}
