// Offline checks for the edge IP probe (README.md): no server, no network.
//
// They prove the echo's classification can fail: a visitor address in any
// address-like header is reported, the observed 2026-10-02 header shape is
// not, and the answer never carries a header value, the salt or the hash.
// Every address here is from the documentation ranges (RFC 5737, RFC 3849).
// They also pin the probe's placeholder to the edge's x-real-ip constant and
// keep the example Worker config off the production Worker's name.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { ADDRESS, PLACEHOLDER, describeHeaders } from "./echo-server.mjs";

const VISITOR = "203.0.113.9";
const VISITOR_V6 = "2001:db8::9";
const EGRESS = "198.51.100.7";
const SALT = "00000000-0000-4000-8000-000000000000";
const hashOf = (address) => createHash("sha256").update(SALT + address).digest("hex");
const probeHeaders = (visitor) => ({ "x-probe-salt": SALT, "x-probe-visitor-hash": hashOf(visitor) });

test("the observed shape reports the placeholder and no visitor", () => {
  const result = describeHeaders({
    ...probeHeaders(VISITOR),
    host: "echo.invalid",
    "cf-ray": "0000000000000000-XXX",
    "x-forwarded-for": `${PLACEHOLDER}, ${EGRESS}`,
    forwarded: `for="${EGRESS}";proto=https`,
  });
  assert.deepEqual(result.headerNames,
    ["cf-ray", "forwarded", "host", "x-forwarded-for", "x-probe-salt", "x-probe-visitor-hash"]);
  assert.deepEqual(result.address, {
    forwarded: { equalsPlaceholder: false, containsPlaceholder: false, containsVisitor: false, tokenCount: 4 },
    "x-forwarded-for": { equalsPlaceholder: false, containsPlaceholder: true, containsVisitor: false, tokenCount: 2 },
  });
});

test("a visitor address in any address-like header is reported", () => {
  const leaked = describeHeaders({
    ...probeHeaders(VISITOR),
    "cf-connecting-ip": VISITOR,
    "true-client-ip": ` ${VISITOR} `,
    "x-forwarded-for": `${VISITOR}, ${EGRESS}`,
    "x-real-ip": PLACEHOLDER,
  });
  assert.equal(leaked.address["cf-connecting-ip"].containsVisitor, true);
  assert.equal(leaked.address["true-client-ip"].containsVisitor, true);
  assert.equal(leaked.address["x-forwarded-for"].containsVisitor, true);
  assert.deepEqual(leaked.address["x-real-ip"],
    { equalsPlaceholder: true, containsPlaceholder: true, containsVisitor: false, tokenCount: 1 });

  const bracketed = describeHeaders({ ...probeHeaders(VISITOR_V6), forwarded: `for="[${VISITOR_V6}]";proto=https` });
  assert.equal(bracketed.address.forwarded.containsVisitor, true);
});

test("without the salt and hash nothing is reported as the visitor", () => {
  const result = describeHeaders({ "cf-connecting-ip": VISITOR, "x-probe-salt": SALT });
  assert.equal(result.address["cf-connecting-ip"].containsVisitor, false);
});

test("classification is by name: probe headers and other names get no entry", () => {
  for (const name of ["cf-connecting-ip", "x-real-ip", "x-forwarded-for", "forwarded", "true-client-ip", "x-client-ip"]) {
    assert.equal(ADDRESS.test(name), true, name);
  }
  // cf-ipcountry is address-derived but not matched: README.md says to read the names list for it.
  for (const name of ["cf-ipcountry", "cf-ray", "cf-worker", "x-probe-salt", "host"]) {
    const result = describeHeaders({ ...probeHeaders(VISITOR), [name]: VISITOR });
    assert.equal(name in result.address, false, name);
  }
});

test("the answer carries no header value, salt or hash", () => {
  const result = JSON.stringify(describeHeaders({
    ...probeHeaders(VISITOR),
    "cf-connecting-ip": VISITOR,
    "x-forwarded-for": `${PLACEHOLDER}, ${EGRESS}`,
    "x-real-ip": PLACEHOLDER,
  }));
  for (const value of [VISITOR, EGRESS, PLACEHOLDER, SALT, hashOf(VISITOR)]) {
    assert.equal(result.includes(value), false, value);
  }
});

test("the probe's placeholder is the edge's x-real-ip constant, and the example config is not production's", async () => {
  const edge = await readFile(new URL("../../src/edge-google-subrequest.ts", import.meta.url), "utf8");
  assert.equal(edge.match(/EDGE_SUBREQUEST_REAL_IP = "([^"]+)"/u)?.[1], PLACEHOLDER);
  const worker = await readFile(new URL("./probe-worker.mjs", import.meta.url), "utf8");
  assert.equal(worker.match(/const PLACEHOLDER = "([^"]+)"/u)?.[1], PLACEHOLDER);
  assert.match(worker, /"x-real-ip": PLACEHOLDER/u);

  const errors = [];
  const config = parse(await readFile(new URL("./wrangler.example.jsonc", import.meta.url), "utf8"), errors);
  assert.deepEqual(errors, []);
  assert.equal(config.main, "probe-worker.mjs");
  assert.equal(config.name, "tibotattle-edge-ip-probe");
  const production = parse(await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
  const productionNames = [production.name, ...Object.values(production.env ?? {}).map((env) => env.name)];
  assert.equal(productionNames.includes(config.name), false);
  assert.equal(config.routes, undefined);
});
