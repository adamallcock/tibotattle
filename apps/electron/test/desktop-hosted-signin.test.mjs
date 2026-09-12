import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_SIGNIN_MAX_URL_LENGTH,
  validateHostedSignInAuthorizeUrl,
} from "../desktop-hosted-signin.js";
import { createDesktopPlatformServices } from "../desktop-platform-services.js";

const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=opaque";
const APPLE = "https://appleid.apple.com/auth/authorize?client_id=test&state=opaque";

function servicesWithShell(shell) {
  return createDesktopPlatformServices({
    app: { isPackaged: true, getVersion: () => "test" },
    platform: "win32",
    homeDirectory: "/home/adam",
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell,
    Notification: { isSupported: () => false },
  });
}

test("hosted sign-in validator accepts only exact provider endpoints with a query", () => {
  assert.equal(validateHostedSignInAuthorizeUrl(GOOGLE), GOOGLE);
  assert.equal(validateHostedSignInAuthorizeUrl(APPLE), APPLE);
  assert.equal(
    validateHostedSignInAuthorizeUrl(
      "https://accounts.google.com:443/o/oauth2/v2/auth?client_id=test",
    ),
    "https://accounts.google.com:443/o/oauth2/v2/auth?client_id=test",
  );
});

test("hosted sign-in validator rejects lookalike, credential, path, fragment, and parser bypass inputs", () => {
  const invalid = [
    "http://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    "https://accounts.google.com.evil.example/o/oauth2/v2/auth?client_id=test",
    "https://evil.example@accounts.google.com/o/oauth2/v2/auth?client_id=test",
    "https://accounts.google.com:444/o/oauth2/v2/auth?client_id=test",
    "https://accounts.google.com:0443/o/oauth2/v2/auth?client_id=test",
    "https://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth?client_id=test",
    "https://accounts.google.com/o/OAUTH2/v2/auth?client_id=test",
    "https://accounts.google.com/o/oauth2/v2/auth/?client_id=test",
    "https://accounts.google.com/o%2Foauth2%2Fv2%2Fauth?client_id=test",
    "https://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/o/oauth2/v2/auth?#fragment",
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=test#fragment",
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=test\nX: value",
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${"x".repeat(HOSTED_SIGNIN_MAX_URL_LENGTH)}`,
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=%ZZ",
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=test\\",
  ];
  for (const value of invalid) {
    assert.throws(
      () => validateHostedSignInAuthorizeUrl(value),
      (error) => {
        assert.equal(error?.code, "desktop_hosted_signin_url_invalid");
        assert.doesNotMatch(error?.message ?? "", /accounts\.google|appleid|client_id/u);
        return true;
      },
      value,
    );
  }
});

test("platform hosted sign-in handoff validates before opening the default browser", async () => {
  const opened = [];
  const services = servicesWithShell({
    async openExternal(...args) {
      opened.push(args);
    },
  });
  assert.equal(await services.openHostedSignIn(GOOGLE), true);
  assert.deepEqual(opened, [[GOOGLE, { activate: true }]]);
  await assert.rejects(
    services.openHostedSignIn("https://evil.example/?authorize=true"),
    (error) => error?.code === "desktop_hosted_signin_url_invalid",
  );
  assert.deepEqual(opened, [[GOOGLE, { activate: true }]]);
});

test("platform converts browser-open failures to a fixed error without URL details", async () => {
  const services = servicesWithShell({
    async openExternal() {
      throw new Error("provider URL should never cross this boundary");
    },
  });
  await assert.rejects(
    services.openHostedSignIn(APPLE),
    (error) => {
      assert.equal(error?.code, "desktop_hosted_signin_open_failed");
      assert.equal(error?.message, "Desktop platform operation failed");
      assert.doesNotMatch(error?.message ?? "", /appleid|authorize/u);
      return true;
    },
  );
});
