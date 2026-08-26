import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_ALGORITHM,
  WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_FIXED_STATUS as STATUS,
  WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_URL,
  WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_STATUS,
  WindowsCertificateSubjectPreflightError,
  buildCertificateProfileRestArguments,
  formatWindowsCertificateSubjectPreflight,
  hashCertificateSubject,
  runWindowsCertificateSubjectPreflight,
  validateCertificateProfileResponse,
} from "../scripts/verify-windows-production-certificate-subject-preflight.mjs";

const SUBJECT = "CN=Adam Allcock, O=Adam Allcock";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function certificate(subject = SUBJECT, status = "Active") {
  return {
    createdDate: "2026-08-23T00:00:00Z",
    expiryDate: "2027-08-23T00:00:00Z",
    serialNumber: "never-emitted",
    status,
    subjectName: subject,
    thumbprint: "never-emitted",
  };
}

function profile({
  subject = SUBJECT,
  profileType = "PublicTrust",
  status = "Active",
  certificates = [certificate(subject)],
} = {}) {
  return {
    properties: {
      profileType,
      status,
      certificates,
    },
  };
}

function expected(subject = SUBJECT) {
  return hashCertificateSubject(subject).subjectSha256;
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof WindowsCertificateSubjectPreflightError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows certificate subject preflight failed");
    return true;
  });
}

test("queries only the fixed Azure profile and emits a bounded subject hash", () => {
  const calls = [];
  const result = runWindowsCertificateSubjectPreflight({
    expectedSubjectSha256: expected(),
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: JSON.stringify(profile()),
        stderr: `private diagnostic for ${SUBJECT}`,
      };
    },
  });
  assert.deepEqual(result, {
    status: WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_STATUS,
    algorithm: WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_ALGORITHM,
    subjectSha256: expected(),
    subjectUtf8Bytes: Buffer.byteLength(SUBJECT, "utf8"),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "az");
  assert.deepEqual(calls[0].args, buildCertificateProfileRestArguments());
  assert.equal(calls[0].args.at(-1), "--only-show-errors");
  assert.equal(calls[0].args.includes(WINDOWS_CERTIFICATE_SUBJECT_PREFLIGHT_PROFILE_URL), true);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "ignore"]);
  assert.equal(calls[0].options.maxBuffer, 256 * 1024);
  assert.equal(JSON.stringify(result).includes(SUBJECT), false);
  assert.equal(JSON.stringify(result).includes("never-emitted"), false);

  const formatted = formatWindowsCertificateSubjectPreflight(result);
  assert.equal(formatted.endsWith("\n"), true);
  assert.equal(formatted.includes(SUBJECT), false);
  assert.equal(formatted.includes("never-emitted"), false);
  assert.deepEqual(JSON.parse(formatted), result);
});
test("uses exact UTF-8 bytes and rejects unsafe subject text", () => {
  const subject = "CN=Ádam Allcock, O=Adam Allcock";
  const hashed = hashCertificateSubject(subject);
  assert.equal(hashed.subjectUtf8Bytes, Buffer.byteLength(subject, "utf8"));
  assert.equal(hashed.subjectSha256, sha256(Buffer.from(subject, "utf8")));
  expectCode(STATUS.subjectInvalid, () => hashCertificateSubject(""));
  expectCode(STATUS.subjectInvalid, () => hashCertificateSubject("CN=Adam\nAllcock"));
  expectCode(STATUS.subjectInvalid, () => hashCertificateSubject("CN=Adam\uD800"));
});

test("requires Public Trust, an active profile, and exactly one active certificate", () => {
  expectCode(STATUS.profileInvalid, () => validateCertificateProfileResponse(
    profile({ profileType: "PrivateTrust" }),
    expected(),
  ));
  expectCode(STATUS.profileInactive, () => validateCertificateProfileResponse(
    profile({ status: "Creating" }),
    expected(),
  ));
  expectCode(STATUS.certificateInvalid, () => validateCertificateProfileResponse(
    profile({ certificates: [certificate(SUBJECT, "Revoked")] }),
    expected(),
  ));
  expectCode(STATUS.certificateInvalid, () => validateCertificateProfileResponse(
    profile({ certificates: [certificate(), certificate("CN=Rotated")] }),
    expected(),
  ));
  expectCode(STATUS.subjectInvalid, () => validateCertificateProfileResponse(
    profile({ certificates: [certificate("")] }),
    expected(),
  ));
});

test("certificate rotation mismatch fails closed without exposing either Subject", () => {
  const oldSubject = "CN=Adam Allcock, O=Adam Allcock";
  const rotatedSubject = "CN=Adam Allcock, O=Adam Allcock, SERIAL=rotated";
  expectCode(STATUS.mismatch, () => validateCertificateProfileResponse(
    profile({ subject: rotatedSubject }),
    expected(oldSubject),
  ));
  const calls = [];
  expectCode(STATUS.azQueryFailed, () => runWindowsCertificateSubjectPreflight({
    expectedSubjectSha256: expected(oldSubject),
    spawn: (...args) => {
      calls.push(args);
      return { status: 1, stdout: "", stderr: rotatedSubject };
    },
  }));
  assert.equal(calls.length, 1);
});

test("rejects malformed, duplicate-key, forbidden, and oversized Azure responses", () => {
  const expectedSubject = expected();
  const malformed = [
    "not-json",
    "{\"properties\": {\"profileType\": \"PublicTrust\"}",
    `{"properties":{"profileType":"PublicTrust","status":"Active","certificates":[{"status":"Active","subjectName":"${SUBJECT}","subjectName":"CN=attacker"}]}}`,
  ];
  for (const stdout of malformed) {
    expectCode(STATUS.responseInvalid, () => runWindowsCertificateSubjectPreflight({
      expectedSubjectSha256: expectedSubject,
      spawn: () => ({ status: 0, stdout }),
    }));
  }
  expectCode(STATUS.azQueryFailed, () => runWindowsCertificateSubjectPreflight({
    expectedSubjectSha256: expectedSubject,
    spawn: () => ({ status: 1, stdout: "", stderr: "403" }),
  }));
  expectCode(STATUS.expectedInvalid, () => runWindowsCertificateSubjectPreflight({
    expectedSubjectSha256: "A".repeat(64),
    spawn: () => ({ status: 0, stdout: JSON.stringify(profile()) }),
  }));
  expectCode(STATUS.mismatch, () => runWindowsCertificateSubjectPreflight({
    expectedSubjectSha256: "0".repeat(64),
    spawn: () => ({ status: 0, stdout: JSON.stringify(profile()) }),
  }));
  expectCode(STATUS.responseInvalid, () => runWindowsCertificateSubjectPreflight({
    expectedSubjectSha256: expectedSubject,
    spawn: () => ({
      status: 0,
      stdout: `${JSON.stringify(profile())}${" ".repeat(256 * 1024)}`,
    }),
  }));
  expectCode(STATUS.azQueryFailed, () => runWindowsCertificateSubjectPreflight({
    expectedSubjectSha256: expectedSubject,
    spawn: (command, args, options) => {
      assert.equal(options.maxBuffer, 256 * 1024);
      return {
        error: Object.assign(new Error("maxBuffer exceeded"), { code: "ENOBUFS" }),
        status: null,
        stdout: "",
      };
    },
  }));
});
