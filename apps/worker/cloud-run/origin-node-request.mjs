/**
 * CR-7: the Node-to-EP-6 request adapter of the Cloud Run origin.
 *
 * The one Node adapter in front of EP-6, for the production host and the
 * edge-test origin (D-CRB moved it here from origin-edge-test-mode.mjs and
 * deleted the copies there):
 * - originRequestFromNode accepts a Host equal to HOST_ORIGIN's host and,
 *   with acceptRevisionTags, a Cloud Run revision-tag Host
 *   '<tag>---<that host>' (tag: a lowercase letter, then at most 45 of
 *   [a-z0-9-], not ending in '-'); the Request is always built on
 *   HOST_ORIGIN, so EP-6 sees one canonical origin;
 * - the URL is HOST_ORIGIN plus the raw path and query, at most
 *   MAX_EDGE_ORIGIN_URL_LENGTH characters, path starting with '/';
 * - every raw header is copied for EP-6 (it needs x-serverless-authorization
 *   and the x-tibotattle-* headers, and strips them before inner);
 * - a body is streamed lazily, so a refusal never reads a byte of it;
 * - anything else throws OriginBoundaryRefusal with one constant reason
 *   (ORIGIN_REQUEST_REFUSAL_REASONS), which the host answers with EP-6's
 *   unmarked 421 and connection: close (writeOriginBoundaryRefusal) and logs
 *   with logOriginBoundaryRefusal.
 *
 * isEdgeOriginBoundaryRefusal reads the origin marker on EP-6's response;
 * test/edge-request-header-allowlist.spec.ts reviews that read for this file
 * (RESPONSE_HEADER_READS).
 *
 * Plain ESM. It opens no pool, reads no network and logs nothing but the
 * refusal lines it is asked to write.
 */

import { EDGE_HEADERS, ORIGIN_BOUNDARY_ERROR_BODY } from "../src/edge-origin-contract.ts";
import {
  EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS,
  EDGE_ORIGIN_INVOKER_SCHEME_KINDS,
  EDGE_ORIGIN_INVOKER_TOKEN_REFUSAL_REASONS,
  MAX_EDGE_ORIGIN_INVOKER_SEPARATOR_SPACES,
  MAX_EDGE_ORIGIN_INVOKER_SHAPE_SEGMENTS,
  MAX_EDGE_ORIGIN_URL_LENGTH,
  ORIGIN_BOUNDARY_ERROR_HEADERS,
} from "./postgres-edge-origin-dispatch.mjs";

/** EP-6's constant refusal: a 421 without the origin marker. */
export function isEdgeOriginBoundaryRefusal(response) {
  return response instanceof Response
    && response.status === 421
    && !response.headers.has(EDGE_HEADERS.originMarker);
}

/**
 * The constant reason of each originRequestFromNode refusal site, for
 * diagnostics only (the answer is EP-6's 421 for every one). The same
 * strings as the edge-test adapter, so both modes log the same vocabulary;
 * they never overlap EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS.
 * request_target_unparseable and request_target_origin guard what the URL
 * parser already ensures for a target starting with '/'.
 */
export const ORIGIN_REQUEST_REFUSAL_REASONS = Object.freeze([
  "host_origin_invalid",
  "host_origin_not_canonical",
  "host_header_missing",
  "host_mismatch",
  "request_target_invalid",
  "request_target_too_long",
  "request_target_unparseable",
  "request_target_origin",
  "raw_headers_invalid",
  "node_request_invalid",
]);

/** The event of the one log line each boundary refusal writes. */
export const ORIGIN_BOUNDARY_REFUSAL_EVENT = "edge_origin_boundary_refusal";

/** How long a connection lingers for the rest of a body after an early answer. */
export const ORIGIN_LINGER_MAX_MILLISECONDS = 15_000;

/** A Cloud Run revision tag, before the '---' that joins it to the service host. */
export const CLOUD_RUN_REVISION_TAG_PATTERN = /^[a-z](?:[a-z0-9-]{0,44}[a-z0-9])?$/u;

const REVISION_TAG_SEPARATOR = "---";
const LOGGED_REFUSAL_REASONS = new Set([
  ...ORIGIN_REQUEST_REFUSAL_REASONS,
  ...EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS,
]);
const SHAPED_REFUSAL_REASONS = new Set(EDGE_ORIGIN_INVOKER_TOKEN_REFUSAL_REASONS);
const UNCLASSIFIED_REFUSAL_REASON = "unclassified";

/** Thrown by originRequestFromNode; the host answers it with the boundary refusal. */
export class OriginBoundaryRefusal extends Error {
  constructor(reason) {
    super("ORIGIN_REQUEST_BOUNDARY_REFUSED");
    this.name = "OriginBoundaryRefusal";
    this.code = "ORIGIN_REQUEST_BOUNDARY_REFUSED";
    this.reason = reason;
  }
}

function boundaryRefusal(reason) {
  throw new OriginBoundaryRefusal(reason);
}

/**
 * Whether host (already lowercase) names expected: exactly, or, when tags
 * are accepted, as '<tag>---<expected>' with a valid tag.
 */
function hostMatches(host, expected, acceptRevisionTags) {
  if (host === expected) return true;
  if (acceptRevisionTags !== true || !host.endsWith(REVISION_TAG_SEPARATOR + expected)) return false;
  const tag = host.slice(0, host.length - REVISION_TAG_SEPARATOR.length - expected.length);
  return CLOUD_RUN_REVISION_TAG_PATTERN.test(tag);
}

/**
 * Whether the request's framing carries a body: chunked, or a declared
 * length other than zero. Node presents an empty stream for every other
 * request, which the Worker sees as no body (request.body null).
 */
function hasRequestBody(req) {
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const declared = req.headers["content-length"];
  return declared !== undefined && declared !== "0";
}

/**
 * The raw body as a web stream that touches the Node request only when it
 * is first read (high-water mark 0), so a refusal or a limited admission
 * never pulls a byte off the socket. Cancelling it stops reading without
 * destroying the request; the unread rest is drained so the answer is
 * followed by a clean close, not a reset.
 */
function lazyRequestBody(req) {
  let iterator = null;
  return new ReadableStream({
    async pull(controller) {
      iterator ??= req.iterator({ destroyOnReturn: false });
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    },
    async cancel() {
      if (iterator !== null) await iterator.return();
      req.resume();
    },
  }, { highWaterMark: 0 });
}

/**
 * The Request for EP-6, built from the raw Node request. hostOrigin must be
 * a canonical http(s) origin (production: the service's run.app origin;
 * locally: http://127.0.0.1:<port>); acceptRevisionTags is honoured only
 * for an https hostOrigin. An AbortController follows the request's abort
 * and the response's close. Every refusal throws OriginBoundaryRefusal.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ hostOrigin: string, acceptRevisionTags?: boolean }} options
 */
export function originRequestFromNode(req, res, { hostOrigin, acceptRevisionTags = false } = {}) {
  let base;
  try { base = new URL(hostOrigin); } catch { boundaryRefusal("host_origin_invalid"); }
  if (base.protocol !== "https:" && base.protocol !== "http:") boundaryRefusal("host_origin_invalid");
  if (base.origin !== hostOrigin) boundaryRefusal("host_origin_not_canonical");
  const host = req.headers.host;
  if (typeof host !== "string") boundaryRefusal("host_header_missing");
  if (!hostMatches(host.toLowerCase(), base.host, acceptRevisionTags === true && base.protocol === "https:")) {
    boundaryRefusal("host_mismatch");
  }
  const path = req.url;
  if (typeof path !== "string" || !path.startsWith("/")) boundaryRefusal("request_target_invalid");
  const href = hostOrigin + path;
  if (href.length > MAX_EDGE_ORIGIN_URL_LENGTH) boundaryRefusal("request_target_too_long");
  let url;
  try { url = new URL(href); } catch { boundaryRefusal("request_target_unparseable"); }
  if (url.origin !== hostOrigin || !url.pathname.startsWith("/")) boundaryRefusal("request_target_origin");
  const headers = new Headers();
  try {
    const raw = req.rawHeaders;
    for (let index = 0; index + 1 < raw.length; index += 2) headers.append(raw[index], raw[index + 1]);
  } catch {
    boundaryRefusal("raw_headers_invalid");
  }
  const method = req.method ?? "GET";
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD" && hasRequestBody(req)) {
    init.body = lazyRequestBody(req);
    init.duplex = "half";
  }
  const controller = new AbortController();
  init.signal = controller.signal;
  let request;
  try { request = new Request(url.href, init); } catch { boundaryRefusal("node_request_invalid"); }
  req.once("aborted", () => controller.abort());
  req.once("close", () => {
    if (!req.complete) controller.abort();
  });
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return request;
}

/**
 * Lingering close (RFC 9112 section 9.6) under an answer written before the
 * request body has finished arriving (a 413 at a chunked body's limit, or a
 * refusal that never reads the body): the close waits until the rest of the
 * body has been received and discarded, or ORIGIN_LINGER_MAX_MILLISECONDS
 * pass, so the caller does not lose the answer to a reset. Only this
 * request's socket is affected, and only its close is delayed.
 *
 * @param {import("node:http").IncomingMessage} req
 */
export function lingerAfterEarlyAnswer(req) {
  const socket = req.socket;
  if (req.complete || socket === null || typeof socket.destroySoon !== "function") return;
  const destroySoon = socket.destroySoon;
  const received = new Promise((resolveReceived) => {
    const done = () => {
      clearTimeout(timer);
      resolveReceived();
    };
    const timer = setTimeout(done, ORIGIN_LINGER_MAX_MILLISECONDS);
    req.once("end", done);
    req.once("close", done);
    socket.once("close", done);
  });
  socket.destroySoon = function lingeringDestroySoon() {
    void received.then(() => destroySoon.call(socket));
  };
}

/**
 * Writes the constant boundary refusal (421, ORIGIN_BOUNDARY_ERROR_BODY,
 * ORIGIN_BOUNDARY_ERROR_HEADERS with connection: close) and never reads the
 * request body; Node ends the socket once the response is written.
 *
 * @param {import("node:http").ServerResponse} res
 */
export function writeOriginBoundaryRefusal(res) {
  res.writeHead(421, {
    ...ORIGIN_BOUNDARY_ERROR_HEADERS,
    "content-length": String(Buffer.byteLength(ORIGIN_BOUNDARY_ERROR_BODY)),
  });
  res.end(ORIGIN_BOUNDARY_ERROR_BODY);
}

function shapeFlags(value) {
  return Array.isArray(value)
    ? value.slice(0, MAX_EDGE_ORIGIN_INVOKER_SHAPE_SEGMENTS).map((flag) => flag === true)
    : [];
}

function separatorSpaces(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EDGE_ORIGIN_INVOKER_SEPARATOR_SPACES
    ? value : null;
}

/**
 * The log line for one boundary refusal, built field by field from an
 * allowlist: {"event":"edge_origin_boundary_refusal","reason":<code>}, plus,
 * for an EP-6 invoker-token refusal only, the delivered header's
 * content-free "invokerShape". A reason outside the two reason lists is
 * 'unclassified'; nothing else a diagnostic carries can reach the line.
 */
export function originBoundaryRefusalLogLine(diagnostic) {
  const candidate = diagnostic !== null && typeof diagnostic === "object" ? diagnostic.reason : undefined;
  const reason = LOGGED_REFUSAL_REASONS.has(candidate) ? candidate : UNCLASSIFIED_REFUSAL_REASON;
  const line = { event: ORIGIN_BOUNDARY_REFUSAL_EVENT, reason };
  const shape = SHAPED_REFUSAL_REASONS.has(reason) ? diagnostic.invokerShape : null;
  if (shape !== null && typeof shape === "object") {
    line.invokerShape = {
      bearerPrefix: shape.bearerPrefix === true,
      scheme: EDGE_ORIGIN_INVOKER_SCHEME_KINDS.includes(shape.scheme) ? shape.scheme : null,
      separatorSpaces: separatorSpaces(shape.separatorSpaces),
      segments: Number.isSafeInteger(shape.segments) && shape.segments >= 0 ? shape.segments : null,
      segmentEmpty: shapeFlags(shape.segmentEmpty),
      segmentBase64url: shapeFlags(shape.segmentBase64url),
      signatureRemovedByGoogle: shape.signatureRemovedByGoogle === true,
    };
  }
  return JSON.stringify(line);
}

/**
 * Writes originBoundaryRefusalLogLine(diagnostic) as one line through log
 * (console.log, looked up when called, by default). Never throws.
 */
export function logOriginBoundaryRefusal(diagnostic, log = (line) => console.log(line)) {
  try {
    log(originBoundaryRefusalLogLine(diagnostic));
  } catch {
    // The refusal is answered the same way whether or not its line was written.
  }
}
