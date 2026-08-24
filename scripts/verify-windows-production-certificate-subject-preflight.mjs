#!/usr/bin/env node

/**
 * Verify the Azure Artifact Signing certificate subject used by the protected
 * Windows signing lane.
 *
 * This is deliberately a read-only, content-free preflight.  It queries one
 * fixed ARM resource after `azure/login`, parses only the profile state and
 * active certificate subject in memory, and returns a SHA-256 of the exact
 * UTF-8 subject bytes.  The subject, profile response, thumbprint, serial
 * number, path, and PowerShell/Azure diagnostics never cross this boundary.
 */

import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";

export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_SCHEMA =
  "tibotattle-windows-certificate-subject-preflight-v1";
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_STATUS =
  "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PASSED";
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_ALGORITHM =
  "sha256-utf8-subject-dn-v1";
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_SUBSCRIPTION_ID =
  "8f6118f5-3c88-433d-a2c2-9f4b2aef8b23";
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_RESOURCE_GROUP =
  "TiboTattle";
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_ACCOUNT_NAME =
  "tibotattlesigning";
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_NAME =
  "tibotattle-windows-public";
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_API_VERSION = "2025-10-13";
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_RESOURCE =
  `/subscriptions/${WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_SUBSCRIPTION_ID}`
  + `/resourceGroups/${WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_RESOURCE_GROUP}`
  + "/providers/Microsoft.CodeSigning"
  + `/codeSigningAccounts/${WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_ACCOUNT_NAME}`
  + `/certificateProfiles/${WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_NAME}`;
export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_URL =
  `https://management.azure.com${WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_RESOURCE}`
  + `?api-version=${WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_API_VERSION}`;

export const WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_INPUT_INVALID",
  expectedInvalid: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_EXPECTED_SHA256_INVALID",
  azUnavailable: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_AZ_UNAVAILABLE",
  azQueryFailed: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_AZ_QUERY_FAILED",
  responseInvalid: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_RESPONSE_INVALID",
  profileInvalid: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_INVALID",
  profileInactive: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_INACTIVE",
  certificateInvalid: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_CERTIFICATE_INVALID",
  subjectInvalid: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_SUBJECT_INVALID",
  mismatch: "WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_SUBJECT_MISMATCH",
  passed: WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_STATUS,
});
export const FIXED_STATUS = WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_FIXED_STATUS;

const STATUS = FIXED_STATUS;
const KNOWN_STATUSES = new Set(Object.values(STATUS));
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_PROFILE_BYTES = 256 * 1024;
const MAXIMUM_SUBJECT_BYTES = 4096;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;

export class WindowsCertificateSubjectPreflightError extends Error {
  constructor(code) {
    super("Windows certificate subject preflight failed");
    this.name = "WindowsCertificateSubjectPreflightError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsCertificateSubjectPreflightError(code);
}

function ownRecord(value, code = STATUS.responseInvalid) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }
  let prototype;
  let keys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  if (prototype !== Object.prototype || keys.some((key) => typeof key !== "string")) {
    fail(code);
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail(code);
    }
  }
  return value;
}

function skipWhitespace(text, state) {
  while (state.index < text.length && /\s/u.test(text[state.index])) state.index += 1;
}

function scanJsonString(text, state) {
  if (text[state.index] !== '"') fail(STATUS.responseInvalid);
  const start = state.index;
  state.index += 1;
  while (state.index < text.length) {
    const code = text.charCodeAt(state.index);
    if (code === 0x22) {
      state.index += 1;
      try {
        return JSON.parse(text.slice(start, state.index));
      } catch {
        fail(STATUS.responseInvalid);
      }
    }
    if (code === 0x5c) {
      state.index += 1;
      if (state.index >= text.length) fail(STATUS.responseInvalid);
      if (text[state.index] === "u") {
        // The index currently points at `u`; consume it and exactly four
        // hexadecimal digits. JSON.parse below remains the authority for
        // validating the escape itself.
        state.index += 5;
      } else {
        state.index += 1;
      }
      continue;
    }
    if (code < 0x20) fail(STATUS.responseInvalid);
    state.index += 1;
  }
  fail(STATUS.responseInvalid);
}

function scanJsonValue(text, state, depth) {
  if (depth > MAXIMUM_JSON_DEPTH || ++state.nodes > MAXIMUM_JSON_NODES) {
    fail(STATUS.responseInvalid);
  }
  skipWhitespace(text, state);
  const first = text[state.index];
  if (first === '"') {
    scanJsonString(text, state);
    return;
  }
  if (first === "{") {
    state.index += 1;
    skipWhitespace(text, state);
    const keys = new Set();
    if (text[state.index] === "}") {
      state.index += 1;
      return;
    }
    for (;;) {
      skipWhitespace(text, state);
      const key = scanJsonString(text, state);
      if (keys.has(key)) fail(STATUS.responseInvalid);
      keys.add(key);
      skipWhitespace(text, state);
      if (text[state.index] !== ":") fail(STATUS.responseInvalid);
      state.index += 1;
      scanJsonValue(text, state, depth + 1);
      skipWhitespace(text, state);
      if (text[state.index] === "}") {
        state.index += 1;
        return;
      }
      if (text[state.index] !== ",") fail(STATUS.responseInvalid);
      state.index += 1;
    }
  }
  if (first === "[") {
    state.index += 1;
    skipWhitespace(text, state);
    if (text[state.index] === "]") {
      state.index += 1;
      return;
    }
    for (;;) {
      scanJsonValue(text, state, depth + 1);
      skipWhitespace(text, state);
      if (text[state.index] === "]") {
        state.index += 1;
        return;
      }
      if (text[state.index] !== ",") fail(STATUS.responseInvalid);
      state.index += 1;
    }
  }
  if (text.startsWith("true", state.index)) {
    state.index += 4;
    return;
  }
  if (text.startsWith("false", state.index)) {
    state.index += 5;
    return;
  }
  if (text.startsWith("null", state.index)) {
    state.index += 4;
    return;
  }
  const numberStart = state.index;
  while (state.index < text.length && /[-+0-9.eE]/u.test(text[state.index])) {
    state.index += 1;
  }
  if (state.index === numberStart) fail(STATUS.responseInvalid);
}

function parseStrictJson(text) {
  if (typeof text !== "string" || text.length === 0
      || Buffer.byteLength(text, "utf8") > MAXIMUM_PROFILE_BYTES) {
    fail(STATUS.responseInvalid);
  }
  const source = text.replace(/^\uFEFF/u, "");
  const state = { index: 0, nodes: 0 };
  try {
    scanJsonValue(source, state, 0);
  } catch (error) {
    if (error instanceof WindowsCertificateSubjectPreflightError) throw error;
    fail(STATUS.responseInvalid);
  }
  skipWhitespace(source, state);
  if (state.index !== source.length) fail(STATUS.responseInvalid);
  try {
    return JSON.parse(source);
  } catch {
    fail(STATUS.responseInvalid);
  }
}

function assertExpectedSubjectSha256(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(STATUS.expectedInvalid);
  }
  return value;
}

export function canonicalSubjectUtf8Bytes(subject) {
  if (typeof subject !== "string" || subject.length === 0
      || /[\u0000-\u001F\u007F]/u.test(subject)) {
    fail(STATUS.subjectInvalid);
  }
  for (let index = 0; index < subject.length; index += 1) {
    const code = subject.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = subject.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) fail(STATUS.subjectInvalid);
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      fail(STATUS.subjectInvalid);
    }
  }
  const bytes = Buffer.from(subject, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_SUBJECT_BYTES) {
    fail(STATUS.subjectInvalid);
  }
  return bytes;
}

export function hashCertificateSubject(subject) {
  const bytes = canonicalSubjectUtf8Bytes(subject);
  return Object.freeze({
    subjectSha256: createHash("sha256").update(bytes).digest("hex"),
    subjectUtf8Bytes: bytes.byteLength,
  });
}

function selectActiveCertificate(profile) {
  const source = ownRecord(profile, STATUS.profileInvalid);
  const properties = ownRecord(source.properties, STATUS.profileInvalid);
  if (properties.profileType !== "PublicTrust") fail(STATUS.profileInvalid);
  if (properties.status !== "Active") fail(STATUS.profileInactive);
  if (!Array.isArray(properties.certificates)
      || Object.getPrototypeOf(properties.certificates) !== Array.prototype
      || properties.certificates.length === 0
      || properties.certificates.length > 32) {
    fail(STATUS.certificateInvalid);
  }
  const active = [];
  for (const certificate of properties.certificates) {
    const selected = ownRecord(certificate, STATUS.certificateInvalid);
    if (selected.status === "Active") active.push(selected);
  }
  if (active.length !== 1) fail(STATUS.certificateInvalid);
  const subject = active[0].subjectName;
  if (typeof subject !== "string") fail(STATUS.subjectInvalid);
  return hashCertificateSubject(subject);
}

export function validateCertificateProfileResponse(value, expectedSubjectSha256) {
  const expected = assertExpectedSubjectSha256(expectedSubjectSha256);
  const hashed = selectActiveCertificate(value);
  const expectedBytes = Buffer.from(expected, "hex");
  const actualBytes = Buffer.from(hashed.subjectSha256, "hex");
  if (!timingSafeEqual(expectedBytes, actualBytes)) fail(STATUS.mismatch);
  return Object.freeze({
    status: WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_STATUS,
    algorithm: WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_ALGORITHM,
    subjectSha256: hashed.subjectSha256,
    subjectUtf8Bytes: hashed.subjectUtf8Bytes,
  });
}

export function buildCertificateProfileRestArguments() {
  return Object.freeze([
    "rest",
    "--method",
    "get",
    "--url",
    WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_URL,
    "--only-show-errors",
  ]);
}

export function runWindowsCertificateSubjectPreflight({
  expectedSubjectSha256,
  azPath = "az",
  spawn = spawnSync,
} = {}) {
  const expected = assertExpectedSubjectSha256(expectedSubjectSha256);
  if (typeof azPath !== "string" || azPath.length === 0 || typeof spawn !== "function") {
    fail(STATUS.inputInvalid);
  }
  let child;
  try {
    child = spawn(azPath, buildCertificateProfileRestArguments(), {
      encoding: "utf8",
      maxBuffer: MAXIMUM_PROFILE_BYTES,
      timeout: 120_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    fail(STATUS.azUnavailable);
  }
  if (!child || child.error || child.status !== 0 || typeof child.stdout !== "string") {
    fail(STATUS.azQueryFailed);
  }
  let profile;
  try {
    profile = parseStrictJson(child.stdout);
  } catch (error) {
    if (error instanceof WindowsCertificateSubjectPreflightError) {
      if (error.code === STATUS.responseInvalid) throw error;
      throw error;
    }
    fail(STATUS.responseInvalid);
  }
  return validateCertificateProfileResponse(profile, expected);
}

function fixedStatus(error) {
  return error instanceof WindowsCertificateSubjectPreflightError
    && KNOWN_STATUSES.has(error.code)
    ? error.code
    : STATUS.responseInvalid;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2
      || argv[0] !== "--expected-subject-sha256") {
    fail(STATUS.inputInvalid);
  }
  return { expectedSubjectSha256: argv[1] };
}

export function formatWindowsCertificateSubjectPreflight(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(STATUS.inputInvalid);
  }
  const selected = validateCertificateSubjectResult(value);
  return `${JSON.stringify(selected)}\n`;
}

function validateCertificateSubjectResult(value) {
  const selected = ownRecord(value, STATUS.inputInvalid);
  const keys = Object.keys(selected).sort();
  if (keys.join("\0") !== ["algorithm", "status", "subjectSha256", "subjectUtf8Bytes"].join("\0")) {
    fail(STATUS.inputInvalid);
  }
  if (selected.status !== WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_STATUS
      || selected.algorithm !== WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_ALGORITHM
      || !SHA256_PATTERN.test(selected.subjectSha256)
      || !Number.isSafeInteger(selected.subjectUtf8Bytes)
      || selected.subjectUtf8Bytes <= 0
      || selected.subjectUtf8Bytes > MAXIMUM_SUBJECT_BYTES) {
    fail(STATUS.inputInvalid);
  }
  return Object.freeze({
    status: selected.status,
    algorithm: selected.algorithm,
    subjectSha256: selected.subjectSha256,
    subjectUtf8Bytes: selected.subjectUtf8Bytes,
  });
}

async function main(argv = process.argv.slice(2)) {
  try {
    const result = runWindowsCertificateSubjectPreflight(parseArguments(argv));
    process.stdout.write(formatWindowsCertificateSubjectPreflight(result));
  } catch (error) {
    process.stdout.write(`${fixedStatus(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("verify-windows-production-certificate-subject-preflight.mjs")) {
  await main();
}
