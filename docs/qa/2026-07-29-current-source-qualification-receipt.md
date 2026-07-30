---
title: Current-Source Qualification Receipt
date: 2026-07-29
type: verification-receipt
status: development-verified
---

# Current-source qualification receipt

## Scope and source identity

This receipt binds the July 29, 2026 development qualification to the current
implementation source, rather than to an uncommitted chat summary or an older
report. It does not certify a public release, remote deployment, Developer ID
signature, Apple notarization, clean-Mac Gatekeeper behavior, or authorization
to collect participant data.

The checkout was intentionally dirty and included existing tracked and
untracked work. Nothing was staged, committed, reset, or discarded. The
underlying Git commit was
`4c715b2220cd86d2025ba310d82ea18cc6c4fa79`.

The qualified implementation set was selected as:

```text
package.json
pnpm-lock.yaml
README.md
apps/**
src/**
scripts/**
schemas/**
test/**
generated/**
```

Only tracked or untracked, non-ignored regular files were included. Dated
verification reports and ignored build artifacts were deliberately excluded,
so adding this receipt does not invalidate the implementation fingerprint.
Files were sorted and hashed with
`sha256(length-framed path, byte-length, file-sha256)`.

| Property | Value |
| --- | --- |
| Files | 418 |
| Bytes | 7,143,958 |
| Implementation-set SHA-256 | `64304c8f2cf7edb087a185780ce72b71094e7863a78e3fa5bab65c6018b19d0f` |
| `package.json` SHA-256 | `a926ab74ac402bcf20a42be7255946dc0fb6a6aa64ce9ee97e3dcc72be8fbd8b` |
| `pnpm-lock.yaml` SHA-256 | `51428ce11844ba945292190486b5fa6ac14e36300f47af8d69581d0bb69aced3` |
| Worker lock SHA-256 | `fbc88b2d6bc2d67ea3168bd75f0f05493654e5448267c6227f2dc623302bd138` |
| Cloud Run lock SHA-256 | `1e4b373b6debf200c8886b858355015647a1878216b533a637e69ea99a562867` |

The exact reproduction command is:

```bash
node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const listed = execFileSync("git", [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
]).toString("utf8").split("\0").filter(Boolean);

const selected = listed.filter((path) =>
  path === "package.json"
  || path === "pnpm-lock.yaml"
  || path === "README.md"
  || path.startsWith("apps/")
  || path.startsWith("src/")
  || path.startsWith("scripts/")
  || path.startsWith("schemas/")
  || path.startsWith("test/")
  || path.startsWith("generated/"));

const files = selected
  .filter((path) => {
    try { return statSync(path).isFile(); }
    catch { return false; }
  })
  .sort();

let bytes = 0;
const aggregate = createHash("sha256");
for (const path of files) {
  const body = readFileSync(path);
  const digest = createHash("sha256").update(body).digest("hex");
  bytes += body.length;
  aggregate.update(String(Buffer.byteLength(path)));
  aggregate.update(":");
  aggregate.update(path);
  aggregate.update("\0");
  aggregate.update(String(body.length));
  aggregate.update(":");
  aggregate.update(digest);
  aggregate.update("\0");
}

console.log(JSON.stringify({
  files: files.length,
  bytes,
  digest: aggregate.digest("hex"),
}, null, 2));
'
```

Paths are sorted with JavaScript's default UTF-16 code-unit ordering. Path
length is UTF-8 byte length; file length is raw byte length. Each path and
file-digest record is terminated by one zero byte, exactly as shown.

## Dual-runtime repository qualification

The same implementation set passed the complete repository suite under both
supported qualification runtimes.

### Node 24.14.0

```text
Executable:
$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node
Executable SHA-256:
20a18709f0154d668f1bd6f6ea8c2a7ae001447b4b2c339732f22e57a8767a55
Started: 2026-07-29T12:09:08Z
Finished: 2026-07-29T12:10:48Z
Tests: 1,040 total; 1,026 passed; 14 skipped; 0 failed
Duration reported by the test runner: 99,392.357833 ms
Telemetry contract: 11 passed; 0 failed
```

The 14 skips were the expected macOS Node-26-builder and Node-26-only
regeneration/recovery cases.

### Node 26.2.0

```text
Executable:
$HOME/.nvm/versions/node/v26.2.0/bin/node
Executable SHA-256:
b276251704734604aad4ab2dc4a07892565baea39400f6422abeb1fe39637440
Started: 2026-07-29T12:11:01Z
Finished: 2026-07-29T12:13:19Z
Tests: 1,042 passed; 0 skipped; 0 failed
Duration reported by the test runner: 138,102.061416 ms
Telemetry contract: 11 passed; 0 failed
```

## Integrated product qualification

The current source also passed the integrated product gate:

| Surface | Result |
| --- | --- |
| Local companion and privacy-safe contribution code | 103 passed |
| Consumer UI | 57 passed |
| Public release site | 6 passed |
| Worker operator scripts | 67 passed |
| Worker runtime | 86 passed |
| Collection-disabled Cloud Run/GCS package | 12 passed |
| macOS application bundle | 11 passed |

Worker types, TypeScript checking, dry deployment configuration, and
fail-closed staging configuration passed. The final `git diff --check` was
clean.

Gitleaks 8.30.1 was downloaded to an owner-only temporary directory from its
official release and its Darwin arm64 archive SHA-256
`b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`
was verified against the official checksum list. A Gitleaks
`--redact=100` secret-field-redacted scan covered the complete Git history and
a separate copy of all 418 qualified source files.
The scanner reported nine historical and seven current `generic-api-key`
matches. Redacted review found only fixed test fixtures
(`deviceSecretHash`, deletion/workspace confirmation tokens, and CLI option
tokens) plus two historical prose references to secret scanning; there was no
actionable credential finding. The scan reports and
binary remained outside the repository and were moved recoverably to Trash
after review. The
macOS builder independently repeated its narrower prohibited-path, credential,
and private-key artifact checks.

## Retained R7 evidence

Exactly ten mode-`0600` R7 receipts were regenerated from 151 frozen workload
files with source SHA-256
`0453b0e44c8782326dae92a5ac5731585f03e933bc0e3f3987316f79487d7464`.
Both runtime decisions remain deliberately `release_open`.

| Runtime | Decision JSON SHA-256 | Embedded `receiptSha256` provenance |
| --- | --- | --- |
| Node 24.14.0 | `836ce6247062655a1fd3e07d35fbaaded5590f83716516f83bcea7a23047c048` | `2f39fb04da6cabc10d35f9c7073c00b4f59d686552df9236d29e55daa6b160f8` |
| Node 26.2.0 | `ce3b304fe5408249db7e939d1acbc79787b4e94491628fa6b5ff350b0195b3d3` | `09544eb23c75b389776d8e5627392af65d2dcae059f11454474c53a91fba1d76` |

A second bounded Apple-silicon machine-class measurement and approval of the
engineering ceiling/rounding policy remain human gates.

## Development artifacts

The final development app and deterministic-layout DMG were validated without
rebuilding them after their digests were recorded:

| Artifact property | Value |
| --- | --- |
| App payload SHA-256 | `38ff6b66b80704e3744ae43b05a9835fcfe86bc6c1bea00afd7b5ee106dd1b03` |
| App source SHA-256 | `408f6a54cac79d5a5b186733347fee17701baf96f15bfc7d1f6ba3749829516b` |
| App payload bytes | 145,889,238 |
| DMG path | `.release-build/macos/UsageMonitor-0.0.1-macOS-arm64.dmg` |
| DMG bytes | 45,657,009 |
| DMG SHA-256 | `2a6ab3796e773bf71e60fa6a6f2e17bd27613784885b5674b0e171be80f75e0c` |
| Static-site manifest SHA-256 | `e082586cfffad3074dcb55b85513ca0d4dca514e0540c580f3e3ac5ae92db050` |
| Social-preview PNG SHA-256 | `ef643f7f4a8058c43f0c89b92b3cb83fc48319f8383c3bfb8deda4f16f8a5e7d` |

The app-source digest is emitted by the bundle builder over its own release
input manifest. It uses a different selection and framing scheme from the
broader implementation-set fingerprint above, so the two values are not
expected to match.

The app is ad-hoc signed and has no central service configured. The DMG
validator passed in development mode. Apple's disk-image tooling gives each
image fresh filesystem metadata, so byte-for-byte DMG reproducibility is not
claimed.

## External boundary

The final read-only staging probe performed no remote mutation and returned:

```text
state: blocked
collectionAuthorized: false
authenticated: true
D1 reachable: true
blockers:
  - STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED
  - R2_NOT_ENABLED
```

Production resource creation, secrets, migrations, domain routing,
publication, deployment, signing, notarization, and real-user collection
remain human-authorized actions.
