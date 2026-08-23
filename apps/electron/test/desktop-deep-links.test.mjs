import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopDeepLinkQueue,
  DESKTOP_DEEP_LINK_CANONICAL_URL,
  DESKTOP_DEEP_LINK_HOST,
  DESKTOP_DEEP_LINK_MAX_BYTES,
  DESKTOP_DEEP_LINK_QUEUE_LIMIT,
  DESKTOP_DEEP_LINK_SCHEME,
  DESKTOP_DEEP_LINK_TARGETS,
  extractDesktopDeepLinks,
  isDesktopDeepLink,
  normalizeDesktopDeepLink,
  parseDesktopDeepLink,
} from "../desktop-deep-links.js";

const EXPECTED_TARGET = Object.freeze({
  target: "open",
  canonicalURL: "usagemonitor://open",
});
test("the app-link contract is one frozen content-free semantic target", () => {
  assert.equal(DESKTOP_DEEP_LINK_SCHEME, "usagemonitor");
  assert.equal(DESKTOP_DEEP_LINK_HOST, "open");
  assert.equal(DESKTOP_DEEP_LINK_CANONICAL_URL, "usagemonitor://open");
  assert.deepEqual(DESKTOP_DEEP_LINK_TARGETS, ["open"]);
  assert.equal(Object.isFrozen(DESKTOP_DEEP_LINK_TARGETS), true);
  assert.ok(DESKTOP_DEEP_LINK_MAX_BYTES > 0);
  assert.equal(DESKTOP_DEEP_LINK_QUEUE_LIMIT, 8);
});

test("native-compatible root links normalize to one fixed target", () => {
  for (const value of [
    "usagemonitor://open",
    "usagemonitor://open/",
    "USAGEMONITOR://OPEN",
    "UsAgEmOnItOr://OpEn/",
  ]) {
    const parsed = parseDesktopDeepLink(value);
    assert.deepEqual(parsed, EXPECTED_TARGET);
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(normalizeDesktopDeepLink(value), parsed);
    assert.equal(isDesktopDeepLink(value), true);
  }
});

test("links carrying credentials, tokens, ports, or navigation data fail closed", () => {
  const rejected = [
    "",
    "usagemonitor:",
    "usagemonitor:/open",
    "usagemonitor:///open",
    "usagemonitor://",
    "usagemonitor://evil",
    "usagemonitor://open.evil",
    "usagemonitor://open:443",
    "usagemonitor://user@open",
    "usagemonitor://user:secret@open",
    "usagemonitor://open?code=token",
    "usagemonitor://open#token",
    "usagemonitor://open/path",
    "usagemonitor://open//",
    "usagemonitor://open/%2e%2e",
    "usagemonitor://open%2f",
    "usagemonitor://open%2F",
    "usagemonitor://open%40evil",
    "usagemonitor://open\\evil",
    "usagemonitor://open\u0000",
    "usagemonitor://open\n",
    " usagemonitor://open",
    "usagemonitor://open ",
    "tibotattle://open",
    "https://open",
    "file:///tmp/private",
    "--open=usagemonitor://open",
    null,
    undefined,
    42,
    new String("usagemonitor://open"),
    { href: "usagemonitor://open" },
  ];
  for (const value of rejected) {
    assert.equal(parseDesktopDeepLink(value), null, JSON.stringify(value));
    assert.equal(normalizeDesktopDeepLink(value), null, JSON.stringify(value));
    assert.equal(isDesktopDeepLink(value), false, JSON.stringify(value));
  }
});

test("the parser bounds oversized input before retaining or normalizing it", () => {
  const oversized = `usagemonitor://open${"x".repeat(DESKTOP_DEEP_LINK_MAX_BYTES)}`;
  assert.ok(oversized.length > DESKTOP_DEEP_LINK_MAX_BYTES);
  assert.equal(parseDesktopDeepLink(oversized), null);
});

test("argv extraction accepts only semantic links and returns an immutable snapshot", () => {
  const extracted = extractDesktopDeepLinks([
    "/Applications/TiboTattle Dev.app/Contents/MacOS/TiboTattle Dev",
    "--no-sandbox",
    "usagemonitor://open/",
    "https://example.test/?next=usagemonitor://open",
    "usagemonitor://open?token=secret",
    "USAGEMONITOR://OPEN",
  ]);
  assert.deepEqual(extracted, [EXPECTED_TARGET, EXPECTED_TARGET]);
  assert.equal(Object.isFrozen(extracted), true);
  assert.equal(Object.isFrozen(extracted[0]), true);
  assert.throws(() => extractDesktopDeepLinks(null), TypeError);
  assert.throws(() => extractDesktopDeepLinks("usagemonitor://open"), TypeError);
});

test("the pending queue is FIFO, hides raw values, and drains atomically", () => {
  const queue = createDesktopDeepLinkQueue({ maxSize: 3 });
  assert.equal(queue.size, 0);
  assert.equal(queue.maxSize, 3);
  assert.equal(queue.peek(), null);

  const first = queue.enqueue("USAGEMONITOR://OPEN/");
  assert.deepEqual(first, EXPECTED_TARGET);
  assert.equal(queue.size, 1);
  assert.deepEqual(queue.peek(), EXPECTED_TARGET);
  assert.equal(queue.enqueue("https://attacker.example"), null);
  assert.equal(queue.size, 1);

  const accepted = queue.enqueueMany([
    "usagemonitor://open",
    "usagemonitor://open/",
    "usagemonitor://open?credential=secret",
  ]);
  assert.deepEqual(accepted, [EXPECTED_TARGET, EXPECTED_TARGET]);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(queue.size, 3);
  assert.deepEqual(queue.drain(), [EXPECTED_TARGET, EXPECTED_TARGET, EXPECTED_TARGET]);
  assert.equal(queue.size, 0);
  assert.equal(queue.peek(), null);
  assert.deepEqual(queue.drain(), []);
});

test("queue overflow is bounded and retains the newest semantic events", () => {
  const queue = createDesktopDeepLinkQueue({ maxSize: 2 });
  queue.enqueueMany([
    "usagemonitor://open",
    "USAGEMONITOR://OPEN",
    "usagemonitor://open/",
  ]);
  assert.equal(queue.size, 2);
  assert.deepEqual(queue.drain(), [EXPECTED_TARGET, EXPECTED_TARGET]);
  assert.equal(queue.size, 0);
});

test("queue limits and mutation inputs are validated", () => {
  for (const options of [
    null,
    [],
    { maxSize: 0 },
    { maxSize: -1 },
    { maxSize: 1.5 },
    { maxSize: DESKTOP_DEEP_LINK_QUEUE_LIMIT + 1 },
    { maxSize: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => createDesktopDeepLinkQueue(options), TypeError);
  }

  const queue = createDesktopDeepLinkQueue();
  assert.throws(() => queue.enqueueMany(null), TypeError);
  queue.enqueue("usagemonitor://open");
  queue.clear();
  assert.equal(queue.size, 0);
});
