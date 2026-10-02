/**
 * Pins into the committed staging desired state (STG-PREP).
 *
 * The staging provisioning tools (gcp-staging-secrets.mjs and
 * gcp-staging-bucket-birth.mjs) end by pinning what they made: each staging
 * secret's Secret Manager version number, and the bucket-birth proof. They
 * edit cloud-run/infra/staging.desired-state.json only, through this module,
 * which:
 *
 * - edits the committed text in place, one exact line per pin, so the file
 *   keeps its reviewed layout and the diff shows only the pins;
 * - proves the edit: the result must parse, validate under the OPS-2
 *   validator and the committed-file policy, describe staging, and equal the
 *   original with exactly the requested pins applied
 *   (STAGING_DESIRED_STATE_EDIT_UNEXPECTED otherwise);
 * - refuses to move a pin that is already set to another value
 *   (STAGING_SECRET_VERSION_ALREADY_PINNED, STAGING_BUCKET_PROOF_ALREADY_PINNED);
 * - writes through a temporary sibling file and a rename, never through a
 *   symlink, so the file is either the old or the new text.
 *
 * Pins are non-secret: version numbers and bucket generations. Nothing here
 * reads a secret value, calls gcloud or touches the production file.
 */

import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertCommittedDesiredState,
  committedDesiredStatePath,
  deepFreeze,
  desiredStateDigest,
  fail,
  requireEnvironment,
  validateDesiredState,
} from "./gcp-ops-infra-manifest.mjs";

export const STAGING_ENVIRONMENT = "staging";
const VERSION = /^[1-9][0-9]{0,9}$/u;
const GENERATION = /^[1-9][0-9]{0,18}$/u;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The validated staging desired state a text describes, under the committed-file policy. */
export function validateStagingDesiredStateText(text, { readSource } = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail("STAGING_DESIRED_STATE_UNREADABLE"); }
  const desired = validateDesiredState(parsed, readSource === undefined ? {} : { readSource });
  return { parsed, desired: assertCommittedDesiredState(requireEnvironment(desired, STAGING_ENVIRONMENT)) };
}

function assertExactEdit(before, after, apply) {
  const expected = structuredClone(before);
  apply(expected);
  if (JSON.stringify(expected) !== JSON.stringify(after)) fail("STAGING_DESIRED_STATE_EDIT_UNEXPECTED");
}

/**
 * Pins secret versions, by template variable: { IDENTITY_LINK_SECRET: "3", ... }.
 * A variable already pinned to the same version is left as is.
 */
export function pinStagingSecretVersions(text, pins, options = {}) {
  const { parsed, desired } = validateStagingDesiredStateText(text, options);
  if (pins === null || typeof pins !== "object" || Array.isArray(pins) || Object.keys(pins).length === 0) {
    fail("STAGING_SECRET_PINS_INVALID");
  }
  let next = text;
  const applied = {};
  for (const [name, version] of Object.entries(pins)) {
    const secret = desired.secrets[name];
    if (secret === undefined) fail(`STAGING_SECRET_UNKNOWN:${name}`);
    if (typeof version !== "string" || !VERSION.test(version)) fail(`STAGING_SECRET_VERSION_INVALID:${name}`);
    if (secret.version === version) continue;
    if (secret.version !== null) fail(`STAGING_SECRET_VERSION_ALREADY_PINNED:${name}`);
    const line = new RegExp(`("${escapeRegExp(name)}": \\{ "secretName": "${escapeRegExp(secret.secretName)}", "version": )null( \\})`, "gu");
    const matches = next.match(line) ?? [];
    if (matches.length !== 1) fail(`STAGING_DESIRED_STATE_LAYOUT_UNEXPECTED:secrets.${name}`);
    next = next.replace(line, `$1"${version}"$2`);
    applied[name] = version;
  }
  const after = validateStagingDesiredStateText(next, options);
  assertExactEdit(parsed, after.parsed, (value) => {
    for (const [name, version] of Object.entries(applied)) value.secrets[name].version = version;
  });
  return deepFreeze({ text: next, changed: Object.keys(applied).length > 0, applied,
    desiredStateDigestBefore: desiredStateDigest(desired), desiredStateDigestAfter: desiredStateDigest(after.desired) });
}

/** Pins the bucket-birth proof: { bucketGeneration, bucketMetageneration }. */
export function pinStagingBucketProof(text, proof, options = {}) {
  const { parsed, desired } = validateStagingDesiredStateText(text, options);
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)
      || Object.keys(proof).sort().join() !== "bucketGeneration,bucketMetageneration"
      || typeof proof.bucketGeneration !== "string" || !GENERATION.test(proof.bucketGeneration)
      || typeof proof.bucketMetageneration !== "string" || !GENERATION.test(proof.bucketMetageneration)) {
    fail("STAGING_BUCKET_PROOF_INVALID");
  }
  const current = desired.bucket.proof;
  if (current !== null) {
    if (current.bucketGeneration === proof.bucketGeneration
        && current.bucketMetageneration === proof.bucketMetageneration) {
      return deepFreeze({ text, changed: false, desiredStateDigestBefore: desiredStateDigest(desired),
        desiredStateDigestAfter: desiredStateDigest(desired) });
    }
    fail("STAGING_BUCKET_PROOF_ALREADY_PINNED");
  }
  const matches = text.match(/"proof": null/gu) ?? [];
  if (matches.length !== 1) fail("STAGING_DESIRED_STATE_LAYOUT_UNEXPECTED:bucket.proof");
  const next = text.replace("\"proof\": null", `"proof": { "bucketGeneration": "${proof.bucketGeneration}", `
    + `"bucketMetageneration": "${proof.bucketMetageneration}" }`);
  const after = validateStagingDesiredStateText(next, options);
  assertExactEdit(parsed, after.parsed, (value) => {
    value.bucket.proof = { bucketGeneration: proof.bucketGeneration, bucketMetageneration: proof.bucketMetageneration };
  });
  return deepFreeze({ text: next, changed: true, desiredStateDigestBefore: desiredStateDigest(desired),
    desiredStateDigestAfter: desiredStateDigest(after.desired) });
}

/** Reads the committed staging file, refusing a symlink. */
export function readStagingDesiredStateFile(path = committedDesiredStatePath(STAGING_ENVIRONMENT)) {
  let stat;
  try { stat = lstatSync(path); } catch { fail("STAGING_DESIRED_STATE_UNREADABLE"); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("STAGING_DESIRED_STATE_UNREADABLE");
  return readFileSync(path, "utf8");
}

/** Replaces the committed staging file atomically: a fresh sibling, then a rename. */
export function writeStagingDesiredStateFile(text, path = committedDesiredStatePath(STAGING_ENVIRONMENT)) {
  readStagingDesiredStateFile(path);
  const temporary = join(dirname(path), `.staging.desired-state.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o644 });
    renameSync(temporary, path);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* only this run's own file */ }
    fail("STAGING_DESIRED_STATE_WRITE_FAILED");
  }
}

/**
 * Applies one pin edit to the committed staging file: read, edit, prove,
 * write when it changed. `edit(text)` returns a pin result above.
 */
export function updateStagingDesiredState(edit, {
  readFile = () => readStagingDesiredStateFile(),
  writeFile = (text) => writeStagingDesiredStateFile(text),
} = {}) {
  const result = edit(readFile());
  if (result.changed) writeFile(result.text);
  const { text: _text, ...summary } = result;
  return deepFreeze(summary);
}
