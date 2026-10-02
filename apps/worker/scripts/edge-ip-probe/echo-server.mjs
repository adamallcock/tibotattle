// Header-shape echo for the edge IP probe. Returns header NAMES and, for
// address-like headers only, booleans: equals Cloudflare's Worker placeholder,
// or contains a token whose salted hash equals the visitor hash the caller sent.
// Never returns, logs or stores a header value.
//
// Owner-run tooling, deployed only as a temporary Cloud Run service in a test
// project (see README.md). describeHeaders is exported for the offline check
// (echo-server.check.mjs); the server starts only when this file is the entry.
import http from "node:http";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER = "2a06:98c0:3600::103";
export const ADDRESS = /(^|-)(ip|ipv6|for|forwarded|client|address|addr|real)($|-)/i;
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** The echo's whole answer for one request's (lower-cased) header map. */
export function describeHeaders(headers) {
  const salt = headers["x-probe-salt"];
  const visitorHash = headers["x-probe-visitor-hash"];
  const names = Object.keys(headers).sort();
  const address = {};
  for (const name of names) {
    if (!ADDRESS.test(name) || name.startsWith("x-probe-")) continue;
    const raw = String(headers[name]);
    const tokens = raw.split(/[,\s;=]+/).map((t) => t.replace(/^"|"$/g, "").replace(/^\[|\]$/g, "")).filter(Boolean);
    address[name] = {
      equalsPlaceholder: raw.trim() === PLACEHOLDER,
      containsPlaceholder: tokens.includes(PLACEHOLDER),
      containsVisitor: typeof salt === "string" && typeof visitorHash === "string"
        && tokens.some((t) => sha(salt + t) === visitorHash),
      tokenCount: tokens.length,
    };
  }
  return { headerNames: names, address };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  http.createServer((req, res) => {
    const body = JSON.stringify(describeHeaders(req.headers));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
  }).listen(Number(process.env.PORT || 8080), "0.0.0.0");
}
