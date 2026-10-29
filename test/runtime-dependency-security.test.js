import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

// Exercise the URI parser actually resolved by the shipped schema validator.
const require = createRequire(import.meta.url);
const uri = createRequire(require.resolve("ajv/package.json"))("fast-uri");

test("schema URI normalization rejects encoded schemes and malformed authorities", () => {
  for (const value of ["%6Aavascript:alert(1)", "j%61vascript:alert(1)", "%u006Aavascript:alert(1)"]) {
    assert.ok(uri.parse(value).error);
    assert.doesNotMatch(uri.normalize(value), /^javascript:/i);
    assert.throws(() => uri.resolve("https://example.test/", value), /URI scheme is malformed/);
  }
  assert.equal(uri.equal("%68ttp://example.test/", "http://example.test/"), false);
  for (const value of ["http://a@b@evil.example/", "http://exa\tmple.test/"]) {
    assert.ok(uri.parse(value).error);
  }
});

test("schema URI normalization preserves ordinary URLs and relative resolution", () => {
  assert.equal(uri.normalize("HTTP://EXAMPLE.TEST/a"), "http://example.test/a");
  const base = "https://example.test/a/b/";
  for (const value of ["../x", "../../x", "./a/b:c"]) {
    assert.equal(uri.resolve(base, uri.normalize(value)), uri.resolve(base, value));
    assert.equal(uri.parse(value).scheme, undefined);
  }
});
