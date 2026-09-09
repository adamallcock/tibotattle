import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { identityDigest, openOperation, operationError, readOperation } from "./release-operation.mjs";

export const QUALIFICATION_CACHE_POLICY = "synthetic-release-admission-v1";
const SHA = /^[a-f0-9]{64}$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const fail = (code) => { throw operationError(code); };

export function validateAdmissionResult(value) {
  if (!object(value) || Object.keys(value).sort().join() !== "cancelled,durationMs,exitCode,failed,passed,skipped,tests,todo"
      || ![0, 1].includes(value.exitCode)
      || !["cancelled", "durationMs", "failed", "passed", "skipped", "tests", "todo"].every((key) => integer(value[key]))) {
    fail("RELEASE_QUALIFICATION_RESULT_INVALID");
  }
  return value.exitCode === 0 && value.tests > 0 && value.passed === value.tests
    && value.failed + value.skipped + value.cancelled + value.todo === 0;
}

function validateInputs(value) {
  if (!object(value) || !SHA.test(value.digest ?? "") || !integer(value.fileCount)
      || value.fileCount === 0 || typeof value.reusable !== "boolean") fail("RELEASE_QUALIFICATION_INPUTS_INVALID");
  return value;
}

function validateState(state, digest) {
  if (!object(state) || Object.keys(state).sort().join() !== "attempts,inputDigest,policy,proof,proofDigest,status"
      || state.policy !== QUALIFICATION_CACHE_POLICY || state.inputDigest !== digest
      || !integer(state.attempts) || !["running", "failed", "complete"].includes(state.status)) fail("RELEASE_QUALIFICATION_RECORD_INVALID");
  if (state.status === "complete") {
    if (!validateAdmissionResult(state.proof) || state.proofDigest !== identityDigest(state.proof)) fail("RELEASE_QUALIFICATION_RECORD_INVALID");
  } else if (state.proof !== null || state.proofDigest !== null) fail("RELEASE_QUALIFICATION_RECORD_INVALID");
}

async function existing(directory) {
  try { await lstat(directory); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw operationError("RELEASE_QUALIFICATION_CACHE_UNAVAILABLE"); }
}

// Only this trusted local executor may create reusable results. Importing a
// JSON receipt or passing a previous release's manual evidence is not supported.
// Read-only inspection never creates a directory, lock or receipt.
export async function qualifyWithCache({ cacheDirectory, inspect = false, refresh = false,
  computeInputs, execute, now = () => performance.now() }) {
  if (typeof computeInputs !== "function" || (!inspect && typeof execute !== "function")
      || (inspect && refresh)) fail("RELEASE_QUALIFICATION_OPTIONS_INVALID");
  const started = now();
  const inputs = validateInputs(await computeInputs());
  const key = identityDigest({ policy: QUALIFICATION_CACHE_POLICY, inputDigest: inputs.digest });
  const directory = join(resolve(cacheDirectory), key);
  const exists = await existing(directory);
  const binding = { policy: QUALIFICATION_CACHE_POLICY, inputDigest: inputs.digest };
  const summary = (status, proof, attempts) => ({
    schema: 1, profile: QUALIFICATION_CACHE_POLICY, status, inputDigest: inputs.digest,
    executableDigest: inputs.executableDigest ?? null, executableReviewed: inputs.executableReviewed ?? false,
    fileCount: inputs.fileCount, reusable: inputs.reusable, attempts,
    elapsedMs: Math.max(0, Math.round(now() - started)),
    runDurationMs: proof?.durationMs ?? null, savedRunDurationMs: status === "reused" ? proof.durationMs : 0,
    tests: proof?.tests ?? null, releaseReady: false,
    remainingGates: ["r7", "exact_predecessor", "signed_installed_app", "remote_migration", "live_publication"],
  });
  if (inspect) {
    if (!exists) return summary("not_run", null, 0);
    const record = await readOperation(directory);
    if (record.kind !== "qualification" || record.binding !== identityDigest(binding)) fail("RELEASE_QUALIFICATION_RECORD_INVALID");
    if (Object.keys(record.state).length === 0) return summary("run_required", null, 0);
    validateState(record.state, inputs.digest);
    return summary(record.state.status === "complete" && inputs.reusable ? "reusable" : "run_required", record.state.proof, record.state.attempts);
  }
  const operation = await openOperation({ directory, kind: "qualification", binding, resume: exists });
  try {
    const previous = operation.record.state;
    if (exists && Object.keys(previous).length > 0) validateState(previous, inputs.digest);
    // Recheck under ownership and after the child: concurrent source changes
    // cannot promote a result under a fingerprint calculated before those edits.
    const confirm = async () => {
      const current = validateInputs(await computeInputs());
      if (current.digest !== inputs.digest || current.reusable !== inputs.reusable) fail("RELEASE_QUALIFICATION_INPUTS_CHANGED");
    };
    await confirm();
    if (!refresh && inputs.reusable && previous.status === "complete") return summary("reused", previous.proof, previous.attempts);
    const state = { policy: QUALIFICATION_CACHE_POLICY, inputDigest: inputs.digest,
      attempts: (previous.attempts ?? 0) + 1, status: "running", proof: null, proofDigest: null };
    await operation.save(state);
    let result;
    try {
      result = await execute();
      const complete = validateAdmissionResult(result);
      await confirm();
      if (!complete) {
        await operation.save({ ...state, status: "failed" });
        return summary("failed", result, state.attempts);
      }
      if (inputs.reusable) await operation.save({ ...state, status: "complete", proof: result, proofDigest: identityDigest(result) });
      else await operation.save({ ...state, status: "failed" });
      return summary(inputs.reusable ? "passed" : "passed_not_reusable", result, state.attempts);
    } catch (error) {
      await operation.save({ ...state, status: "failed" });
      throw operationError(/^RELEASE_QUALIFICATION_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "RELEASE_QUALIFICATION_EXECUTION_FAILED");
    }
  } finally { operation.close(); }
}
