// Deep-dive privacy and boundary coverage for
// src/platform/codex-config-service-tier.js, on top of the end-to-end
// coverage already in test/fast-mode-accounting.test.js.
//
// This reader is PRIVACY CRITICAL: the same ~/.codex/config.toml file carries
// MCP server blocks that can hold secrets. These tests pin three independent
// safety properties documented in the module:
//   1. the scan never matches anything past the first `[table]` header;
//   2. the file is opened with O_NOFOLLOW, so a symlink is refused outright;
//   3. at most a bounded prefix of the file is ever read, regardless of how
//      large the file is or where the root table actually ends.
// Each is exercised independently so a regression in one can't hide behind
// the others still passing.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CODEX_CONFIG_RETAINED_KEYS,
  CODEX_CONFIG_SERVICE_TIER_STATUSES,
  readCodexConfigServiceTier,
} from "../src/platform/codex-config-service-tier.js";

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "codex-config-service-tier-"));
}

async function fixture(contents) {
  const root = await tempRoot();
  const configFile = join(root, "config.toml");
  if (contents !== null) {
    await writeFile(configFile, contents, { mode: 0o600 });
  }
  return { configFile, root };
}

test("the status and retained-key vocabularies are frozen and exact", () => {
  assert.deepEqual([...CODEX_CONFIG_SERVICE_TIER_STATUSES], [
    "declared",
    "absent",
    "missing",
    "unreadable",
  ]);
  assert.equal(Object.isFrozen(CODEX_CONFIG_SERVICE_TIER_STATUSES), true);
  assert.deepEqual([...CODEX_CONFIG_RETAINED_KEYS], ["service_tier"]);
  assert.equal(Object.isFrozen(CODEX_CONFIG_RETAINED_KEYS), true);
});

test("every outcome is a frozen, exactly-three-key, content-free shape", async () => {
  const missing = await fixture(null);
  const declared = await fixture('service_tier = "priority"\n');
  const absent = await fixture('model = "gpt-5.6"\n');
  try {
    for (const { configFile } of [missing, declared, absent]) {
      const outcome = await readCodexConfigServiceTier({ configFile });
      assert.equal(Object.isFrozen(outcome), true);
      assert.deepEqual(Object.keys(outcome).sort(), [
        "retainedKeys",
        "serviceTier",
        "status",
      ]);
      assert.equal(CODEX_CONFIG_SERVICE_TIER_STATUSES.includes(outcome.status), true);
    }
    // A directory is refused the same content-free way.
    const dirOutcome = await readCodexConfigServiceTier({ configFile: missing.root });
    assert.deepEqual(Object.keys(dirOutcome).sort(), [
      "retainedKeys",
      "serviceTier",
      "status",
    ]);
    assert.equal(dirOutcome.status, "unreadable");
  } finally {
    await rm(missing.root, { recursive: true, force: true });
    await rm(declared.root, { recursive: true, force: true });
    await rm(absent.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Property 1: nothing past the first table header is ever matched, even when
// the header shape varies (single table vs. array-of-tables) and the file
// uses CRLF line endings.
// ---------------------------------------------------------------------------

test("a fresh fixture with fake secrets below mixed table headers never leaks them", async () => {
  const CRLF_CONFIG_WITH_SECRETS = [
    "# personal Codex configuration - do not share",
    'model = "gpt-5.5-codex"',
    'service_tier = "priority"',
    "",
    "[[mcp_servers]]",
    'name = "internal-tools"',
    'command = "/opt/tools/bridge"',
    'env = { AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI-not-a-real-key-K7MDENG" }',
    'bearer_token = "Bearer sekret-token-should-never-leak"',
    'service_tier = "default"',
    "",
    "[profiles.personal]",
    'password = "hunter2-should-never-leak"',
    'approval_policy = "never"',
    "",
  ].join("\r\n");
  const { configFile, root } = await fixture(CRLF_CONFIG_WITH_SECRETS);
  try {
    const declaration = await readCodexConfigServiceTier({ configFile });
    assert.equal(declaration.status, "declared");
    // The root-table value survives; the CRLF line endings don't confuse the
    // scan into missing it or, worse, capturing the trailing "\r".
    assert.equal(declaration.serviceTier, "priority");

    const serialized = JSON.stringify(declaration);
    const forbidden = [
      "gpt-5.5-codex",
      "internal-tools",
      "bridge",
      "wJalrXUtnFEMI",
      "AWS_SECRET_ACCESS_KEY",
      "sekret-token-should-never-leak",
      "bearer_token",
      "hunter2-should-never-leak",
      "password",
      "approval_policy",
      "mcp_servers",
      "profiles",
      // The table's own `service_tier = "default"` must never surface either
      // in place of, or alongside, the root-table value.
      "default",
      root,
    ];
    for (const secret of forbidden) {
      assert.equal(serialized.includes(secret), false, `leaked: ${secret}`);
    }
    // Only the fixed vocabulary is present in the whole return value.
    assert.deepEqual(Object.keys(declaration).sort(), [
      "retainedKeys",
      "serviceTier",
      "status",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service_tier declared only inside a table - of either header shape - is not picked up", async () => {
  for (const [label, contents] of [
    ["single-table header", '[profile]\nservice_tier = "priority"\n'],
    [
      "array-of-tables header",
      '[[mcp_servers]]\nservice_tier = "priority"\n',
    ],
    [
      "nested table path",
      '[profiles.work.settings]\nservice_tier = "priority"\n',
    ],
  ]) {
    const { configFile, root } = await fixture(contents);
    try {
      const declaration = await readCodexConfigServiceTier({ configFile });
      assert.equal(declaration.status, "absent", label);
      assert.equal(declaration.serviceTier, null, label);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// Property 2: the file is opened with O_NOFOLLOW, so a symlink - even one
// pointing at an otherwise perfectly valid config - is refused.
// ---------------------------------------------------------------------------

test("reading through a symlink is refused (O_NOFOLLOW), while the real file works", async (t) => {
  if (process.platform === "win32") {
    return t.skip("Windows reparse-point refusal is deferred to the ACL filesystem milestone");
  }
  const root = await tempRoot();
  try {
    const realFile = join(root, "real-config.toml");
    await writeFile(realFile, 'service_tier = "priority"\n', { mode: 0o600 });

    // Control case: the real path is readable and declares the tier.
    const direct = await readCodexConfigServiceTier({ configFile: realFile });
    assert.equal(direct.status, "declared");
    assert.equal(direct.serviceTier, "priority");

    // The same content, reached only through a symlink, must be refused
    // outright rather than silently followed.
    const linkFile = join(root, "config-link.toml");
    await symlink(realFile, linkFile);
    const viaLink = await readCodexConfigServiceTier({ configFile: linkFile });
    assert.equal(viaLink.status, "unreadable");
    assert.equal(viaLink.serviceTier, null);

    // A symlink to a directory is refused the same way, not treated as a
    // readable directory nor crashing.
    const dirLink = join(root, "dir-link");
    await symlink(root, dirLink);
    const viaDirLink = await readCodexConfigServiceTier({ configFile: dirLink });
    assert.equal(viaDirLink.status, "unreadable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Property 3: at most a bounded prefix of the file is ever read. This is
// independent of the table-header stop rule above - it holds even for a
// gigantic root table with no table header in it at all.
// ---------------------------------------------------------------------------

test("only the default 64 KiB prefix is ever read, however large the file is", async () => {
  const root = await tempRoot();
  try {
    const configFile = join(root, "config.toml");
    // A large, header-free root table: > 64 KiB of comment padding, then the
    // real declaration well past the default prefix boundary.
    const padding = `${"# padding line to burn bytes without a table header\n".repeat(1500)}`;
    assert.equal(padding.length > 64 * 1024, true, "padding must exceed the default prefix");
    await writeFile(configFile, `${padding}service_tier = "priority"\n`, { mode: 0o600 });

    const declaration = await readCodexConfigServiceTier({ configFile });
    // The value is real and would be found by an unbounded scan; the bounded
    // reader must still miss it because it never reads that far.
    assert.equal(declaration.status, "absent");
    assert.equal(declaration.serviceTier, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a custom prefix cap is honoured at an exact byte boundary", async () => {
  const root = await tempRoot();
  try {
    const configFile = join(root, "config.toml");
    const padding = "# pad\n";
    const line = 'service_tier = "priority"\n';
    await writeFile(configFile, `${padding}${line}`, { mode: 0o600 });
    const exactBudget = Buffer.byteLength(padding) + Buffer.byteLength(line);

    // The declaration line fits entirely inside the budget: found.
    const exact = await readCodexConfigServiceTier({
      configFile,
      maximumPrefixBytes: exactBudget,
    });
    assert.equal(exact.status, "declared");
    assert.equal(exact.serviceTier, "priority");

    // One byte short cuts into the final line. A truncated last line is
    // dropped whole rather than risking a misparsed value.
    const oneShort = await readCodexConfigServiceTier({
      configFile,
      maximumPrefixBytes: exactBudget - 1,
    });
    assert.equal(oneShort.status, "absent");
    assert.equal(oneShort.serviceTier, null);

    // Comfortably short (mid-value) behaves the same way, not a crash and
    // not a mangled partial token.
    const wayShort = await readCodexConfigServiceTier({
      configFile,
      maximumPrefixBytes: Buffer.byteLength(padding) + 10,
    });
    assert.equal(wayShort.status, "absent");
    assert.equal(wayShort.serviceTier, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The value charset is capped at 32 characters. A longer value is never
// captured - not even truncated to 32 chars - it is simply not a match.
// ---------------------------------------------------------------------------

test("a value at the 32-character cap matches; one character over does not", async () => {
  const atCap = "a".repeat(32);
  const overCap = "a".repeat(33);

  const atCapFixture = await fixture(`service_tier = "${atCap}"\n`);
  const overCapFixture = await fixture(`service_tier = "${overCap}"\n`);
  try {
    const atCapResult = await readCodexConfigServiceTier({
      configFile: atCapFixture.configFile,
    });
    assert.equal(atCapResult.status, "declared");
    assert.equal(atCapResult.serviceTier, atCap);

    const overCapResult = await readCodexConfigServiceTier({
      configFile: overCapFixture.configFile,
    });
    assert.equal(overCapResult.status, "absent");
    assert.equal(overCapResult.serviceTier, null);
    // Critically: never silently truncated to a 32-char prefix of the
    // oversized value either.
    assert.notEqual(overCapResult.serviceTier, atCap);
  } finally {
    await rm(atCapFixture.root, { recursive: true, force: true });
    await rm(overCapFixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parameter validation: an invalid maximumPrefixBytes is refused just as
// fail-closed as a missing or unreadable file, never guessing a fallback.
// ---------------------------------------------------------------------------

test("an invalid maximumPrefixBytes is refused rather than clamped or defaulted", async () => {
  const { configFile, root } = await fixture('service_tier = "priority"\n');
  try {
    for (const badBudget of [0, -1, 1.5, Number.NaN, 8 * 1_024 * 1_024 + 1]) {
      const result = await readCodexConfigServiceTier({
        configFile,
        maximumPrefixBytes: badBudget,
      });
      assert.equal(result.status, "unreadable", String(badBudget));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
