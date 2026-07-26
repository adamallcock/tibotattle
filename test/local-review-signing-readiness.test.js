import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCodeSignature,
  parseDeveloperIdentitySummary,
} from "../scripts/check-local-review-signing-readiness.js";

test("Developer ID readiness parsing returns counts without identity details", () => {
  const summary = parseDeveloperIdentitySummary(`
    1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "3rd Party Mac Developer Application: PRIVATE OWNER (PRIVATE1)"
    2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Developer ID Application: PRIVATE OWNER (PRIVATE2)"
       2 valid identities found
  `);
  assert.deepEqual(summary, {
    developerIdApplication: 1,
    thirdPartyMacDeveloperApplication: 1,
    identityDetailsIncluded: false,
  });
  assert.equal(JSON.stringify(summary).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(summary).includes("BBBB"), false);
});

test("signature classification distinguishes upstream Developer ID and ad hoc", () => {
  assert.deepEqual(
    classifyCodeSignature(`
      CodeDirectory flags=0x10000(runtime)
      Authority=Developer ID Application: Node.js Foundation (PRIVATE)
      TeamIdentifier=PRIVATE
    `),
    {
      origin: "upstream_node_foundation",
      developerId: true,
      hardenedRuntime: true,
      adHoc: false,
      authorityDetailsIncluded: false,
    },
  );
  assert.deepEqual(
    classifyCodeSignature(`
      CodeDirectory flags=0x20002(adhoc,linker-signed)
      Signature=adhoc
    `),
    {
      origin: "adhoc",
      developerId: false,
      hardenedRuntime: false,
      adHoc: true,
      authorityDetailsIncluded: false,
    },
  );
});

test("non-Developer distribution identities are not accepted as Developer ID", () => {
  const summary = parseDeveloperIdentitySummary(`
    1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: PRIVATE"
    2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "3rd Party Mac Developer Application: PRIVATE"
  `);
  assert.equal(summary.developerIdApplication, 0);
  assert.equal(summary.thirdPartyMacDeveloperApplication, 1);
});
