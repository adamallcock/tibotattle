import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";

import {
  REPOSITORY_ROOT,
  markdownAnchors,
  markdownLinks,
  parseFrontmatter,
  validateDocumentation,
} from "../tools/operations/validate-documentation.mjs";

const execFile = promisify(execFileCallback);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-doc-policy-"));
  temporaryRoots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const selected = join(root, path);
    await mkdir(dirname(selected), { recursive: true });
    await writeFile(selected, contents, "utf8");
  }
  return Object.freeze({ root, files: Object.keys(files).sort() });
}

function frontmatter({
  title,
  date,
  type,
  status,
  sourceCommit,
  observationDate,
}) {
  return [
    "---",
    `title: ${title}`,
    `date: ${date}`,
    `type: ${type}`,
    `status: ${status}`,
    ...(sourceCommit === undefined ? [] : [`source_commit: ${sourceCommit}`]),
    ...(observationDate === undefined ? [] : [`observation_date: ${observationDate}`]),
    "---",
    "",
  ].join("\n");
}

async function git(root, arguments_) {
  const { stdout } = await execFile("git", ["-C", root, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function commitFixture(root, message) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
  return await git(root, ["rev-parse", "HEAD"]);
}

function currentStatus({
  sourceCommit,
  date = "2026-08-27",
  observationDate = date,
}) {
  return `${frontmatter({
    title: "Current status",
    date,
    type: "status",
    status: "current",
    sourceCommit,
    observationDate,
  })}# Current status\n`;
}

test("link parser ignores examples and finds inline and reference targets", () => {
  const links = markdownLinks(`
[real](./real.md#heading)
[reference]: ./reference.md

\`[inline example](./missing-inline.md)\`

\`\`\`md
[fenced example](./missing-fenced.md)
\`\`\`

<!-- [commented example](./missing-comment.md) -->
`);

  assert.deepEqual(links, [
    { line: 2, target: "./real.md#heading" },
    { line: 3, target: "./reference.md" },
  ]);
});

test("heading anchors match GitHub duplicate and explicit-anchor behavior", () => {
  const anchors = markdownAnchors(`# Café & usage
## Repeat
## Repeat
Setext title
------------
<a id="stable-target"></a>
`);

  assert.deepEqual([...anchors], [
    "café--usage",
    "repeat",
    "repeat-1",
    "setext-title",
    "stable-target",
  ]);
});

test("frontmatter parser returns only explicit top-level scalar fields", () => {
  const parsed = parseFrontmatter(`${frontmatter({
    title: "A retained receipt",
    date: "2026-08-27",
    type: "receipt",
    status: "complete",
  })}\n# Body\n`);
  assert.equal(parsed.get("title"), "A retained receipt");
  assert.equal(parsed.get("date"), "2026-08-27");
  assert.equal(parsed.get("type"), "receipt");
  assert.equal(parsed.get("status"), "complete");
});

test("full policy accepts valid links, snapshot metadata, and indexed authority", async () => {
  const authority = `${frontmatter({
    title: "Current guide",
    date: "2026-08-27",
    type: "guide",
    status: "current",
  })}\n# Current guide\n\n## Repeat\n\n## Repeat\n`;
  const record = `${frontmatter({
    title: "Release receipt",
    date: "2026-08-26",
    type: "receipt",
    status: "complete",
  })}\n# Release receipt\n`;
  const selected = await fixture({
    "README.md": "[Guide](./docs/guide.md#current-guide)\n",
    "docs/README.md": `# Documentation\n\n## Current authoritative operational entry points\n\n| Path | Use |\n|---|---|\n| [Guide](./guide.md) | Current |\n\n## Records\n`,
    "docs/guide.md": authority,
    "docs/receipts/2026-08-26-release.md": record,
    "docs/records.md": "[Second repeated heading](./guide.md#repeat-1)\n",
  });

  const result = await validateDocumentation(selected);
  assert.equal(result.checkedFiles, 5);
  assert.deepEqual(result.failures, []);
});

test("link validation reports missing files, missing anchors, and escapes", async () => {
  const selected = await fixture({
    "README.md": [
      "[missing](./missing.md)",
      "[bad anchor](./target.md#not-there)",
      "[escape](../outside.md)",
    ].join("\n"),
    "target.md": "# Present\n",
  });

  const result = await validateDocumentation({ ...selected, linksOnly: true });
  assert.deepEqual(result.failures, [
    "README.md:1: local link target does not exist: ./missing.md",
    "README.md:2: Markdown anchor does not exist: ./target.md#not-there",
    "README.md:3: local link escapes the repository: ../outside.md",
  ]);
});

test("link validation fails closed on filesystem errors other than absence", async () => {
  const selected = await fixture({
    "README.md": "[Blocked](./blocked/target.md)\n",
    "blocked": "This regular file cannot contain a target.\n",
  });

  await assert.rejects(
    validateDocumentation({
      root: selected.root,
      files: ["README.md"],
      linksOnly: true,
    }),
    (error) => error?.code === "ENOTDIR",
  );
  await assert.rejects(
    validateDocumentation({
      root: selected.root,
      files: ["blocked/removed.md"],
      linksOnly: true,
    }),
    (error) => error?.code === "ENOTDIR",
  );
});

test("tracked non-test source and config cannot retain missing documentation targets", async () => {
  const selected = await fixture({
    "docs/retained.md": "# Retained\n",
    "docs/image.png": "synthetic-image-placeholder\n",
    "scripts/generate.mjs": [
      "const retained = 'docs/retained.md';",
      "const removed = 'docs/removed.md';",
      "const external = 'https://example.invalid/docs/external.md';",
      "const malformed = 'docs/%ZZ.md';",
      "",
    ].join("\n"),
    "apps/example/source.js": "const image = '../../docs/image.png';\n",
    "test/fixtures/deletion.test.js": "const deliberate = 'docs/deliberately-missing.md';\n",
  });

  const result = await validateDocumentation({
    root: selected.root,
    files: ["docs/retained.md"],
    sourceFiles: [
      "apps/example/source.js",
      "scripts/generate.mjs",
      "test/fixtures/deletion.test.js",
    ],
    linksOnly: true,
  });
  assert.equal(result.checkedSourceFiles, 2);
  assert.deepEqual(result.failures, [
    "scripts/generate.mjs:2: hardcoded documentation target does not exist: docs/removed.md",
    "scripts/generate.mjs:4: hardcoded documentation target is not valid URL encoding: docs/%ZZ.md",
  ]);
});

test("an unstaged document deletion is allowed but surviving inbound links fail", async () => {
  const selected = await fixture({
    "README.md": "No retained link.\n",
  });
  const removedPath = "docs/removed.md";

  const cleanDeletion = await validateDocumentation({
    root: selected.root,
    files: [...selected.files, removedPath],
    linksOnly: true,
  });
  assert.deepEqual(cleanDeletion.failures, []);

  await writeFile(join(selected.root, "README.md"), "[Removed](./docs/removed.md)\n");
  const danglingReference = await validateDocumentation({
    root: selected.root,
    files: [...selected.files, removedPath],
    linksOnly: true,
  });
  assert.deepEqual(danglingReference.failures, [
    "README.md:1: local link target does not exist: ./docs/removed.md",
  ]);
});

test("dated retained documents require complete matching snapshot metadata", async () => {
  const selected = await fixture({
    "docs/README.md": "## Current authoritative operational entry points\n\n[Guide](./guide.md)\n",
    "docs/guide.md": `${frontmatter({
      title: "Guide",
      date: "2026-08-27",
      type: "guide",
      status: "current",
    })}\n# Guide\n`,
    "docs/plans/2026-08-27-missing-frontmatter.md": "# Old plan\n",
    "docs/receipts/2026-08-27-wrong-date.md": `${frontmatter({
      title: "Wrong date",
      date: "2026-08-26",
      type: "receipt",
      status: "complete",
    })}\n# Wrong date\n`,
  });

  const result = await validateDocumentation(selected);
  assert.deepEqual(result.failures, [
    "docs/plans/2026-08-27-missing-frontmatter.md:1: dated retained documentation requires YAML frontmatter",
    "docs/receipts/2026-08-27-wrong-date.md:1: frontmatter date 2026-08-26 does not match filename date 2026-08-27",
  ]);
});

test("dated retained documents require real calendar dates", async () => {
  const selected = await fixture({
    "docs/README.md": "## Current authoritative operational entry points\n\n[Guide](./guide.md)\n",
    "docs/guide.md": `${frontmatter({
      title: "Guide",
      date: "2026-08-27",
      type: "guide",
      status: "current",
    })}# Guide\n`,
    "docs/receipts/2026-02-29-impossible-date.md": `${frontmatter({
      title: "Impossible date",
      date: "2026-02-29",
      type: "receipt",
      status: "complete",
    })}# Impossible date\n`,
  });

  const result = await validateDocumentation(selected);
  assert.deepEqual(result.failures, [
    "docs/receipts/2026-02-29-impossible-date.md:1: filename date is not a valid calendar date: 2026-02-29",
    "docs/receipts/2026-02-29-impossible-date.md:1: frontmatter date is not a valid calendar date: 2026-02-29",
  ]);
});

test("authority links use decoded repository-root and Markdown paths", async () => {
  const selected = await fixture({
    "docs/README.md": [
      "## Current authoritative operational entry points",
      "",
      "[Encoded](./space%20guide%2Emd)",
      "[Root relative](/docs/root-guide.md)",
      "",
    ].join("\n"),
    "docs/space guide.md": `${frontmatter({
      title: "Space guide",
      date: "2026-08-27",
      type: "guide",
      status: "current",
    })}# Space guide\n`,
    "docs/root-guide.md": `${frontmatter({
      title: "Root guide",
      date: "2026-08-27",
      type: "guide",
      status: "maintained",
    })}# Root guide\n`,
  });

  const result = await validateDocumentation(selected);
  assert.deepEqual(result.failures, []);
});

test("current status uses an exact local ancestor commit and matching observation date", async () => {
  const selected = await fixture({
    "docs/README.md": "## Current authoritative operational entry points\n\n[Status](./current-status.md)\n",
    "docs/current-status.md": currentStatus({ sourceCommit: "0".repeat(40) }),
  });
  await git(selected.root, ["init", "--initial-branch=main"]);
  await git(selected.root, ["config", "user.name", "Documentation policy test"]);
  await git(selected.root, ["config", "user.email", "documentation-policy@example.invalid"]);
  const snapshotCommit = await commitFixture(selected.root, "initial snapshot");
  await writeFile(
    join(selected.root, "docs/current-status.md"),
    currentStatus({ sourceCommit: snapshotCommit }),
    "utf8",
  );
  await commitFixture(selected.root, "record current status");

  const valid = await validateDocumentation(selected);
  assert.deepEqual(valid.failures, []);

  await writeFile(
    join(selected.root, "docs/current-status.md"),
    currentStatus({ sourceCommit: snapshotCommit.slice(0, 12) }),
    "utf8",
  );
  const abbreviated = await validateDocumentation(selected);
  assert.deepEqual(abbreviated.failures, [
    `docs/current-status.md:1: source_commit must be an exact lowercase 40-character commit identity: ${snapshotCommit.slice(0, 12)}`,
  ]);

  await writeFile(
    join(selected.root, "docs/current-status.md"),
    currentStatus({
      sourceCommit: snapshotCommit,
      observationDate: "2026-02-29",
    }),
    "utf8",
  );
  const invalidObservationDate = await validateDocumentation(selected);
  assert.deepEqual(invalidObservationDate.failures, [
    "docs/current-status.md:1: observation_date 2026-02-29 does not match frontmatter date 2026-08-27",
    "docs/current-status.md:1: observation_date is not a valid calendar date: 2026-02-29",
  ]);

  const unrelatedCommit = await git(selected.root, [
    "commit-tree",
    `${snapshotCommit}^{tree}`,
    "-m",
    "unrelated snapshot",
  ]);
  await writeFile(
    join(selected.root, "docs/current-status.md"),
    currentStatus({ sourceCommit: unrelatedCommit }),
    "utf8",
  );
  const notAncestor = await validateDocumentation(selected);
  assert.deepEqual(notAncestor.failures, [
    `docs/current-status.md:1: source_commit is not an ancestor of HEAD: ${unrelatedCommit}`,
  ]);

  const missingCommit = "f".repeat(40);
  await writeFile(
    join(selected.root, "docs/current-status.md"),
    currentStatus({ sourceCommit: missingCommit }),
    "utf8",
  );
  const unresolved = await validateDocumentation(selected);
  assert.deepEqual(unresolved.failures, [
    `docs/current-status.md:1: source_commit does not resolve to a local commit: ${missingCommit}`,
  ]);
});

test("current authority cannot be obsolete and authority statuses cannot be hidden", async () => {
  const selected = await fixture({
    "docs/README.md": "## Current authoritative operational entry points\n\n[Old](./old.md)\n",
    "docs/old.md": `${frontmatter({
      title: "Old guide",
      date: "2026-08-26",
      type: "guide",
      status: "superseded",
    })}\n# Old\n`,
    "docs/hidden.md": `${frontmatter({
      title: "Hidden canonical guide",
      date: "2026-08-27",
      type: "guide",
      status: "canonical",
    })}\n# Hidden\n`,
    "docs/maintained.md": `${frontmatter({
      title: "Hidden maintained guide",
      date: "2026-08-27",
      type: "guide",
      status: "maintained",
    })}\n# Maintained\n`,
  });

  const result = await validateDocumentation(selected);
  assert.deepEqual(result.failures, [
    "docs/hidden.md:1: status canonical requires listing in docs/README.md current authorities",
    "docs/maintained.md:1: status maintained requires listing in docs/README.md current authorities",
    "docs/old.md:1: obsolete status cannot be current authority: superseded",
  ]);
});

test("package, preflight, and CI all execute the full documentation gate", async () => {
  const [packageJson, testLanes, workflow, releaseWorkflow] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
    readFile(join(REPOSITORY_ROOT, "scripts/test-lanes.mjs"), "utf8"),
    readFile(join(REPOSITORY_ROOT, ".github/workflows/documentation-policy.yml"), "utf8"),
    readFile(join(REPOSITORY_ROOT, ".github/workflows/release-trust-policy.yml"), "utf8"),
  ]);
  const scripts = JSON.parse(packageJson).scripts;

  assert.equal(
    scripts["docs:check"],
    "node ./tools/operations/validate-documentation.mjs",
  );
  assert.equal(
    scripts["docs:links:check"],
    "node ./tools/operations/validate-documentation.mjs --links-only",
  );
  assert.match(scripts.check, /^npm run docs:check &&/u);
  assert.match(testLanes, /\.\/tools\/operations\/validate-documentation\.mjs/u);
  assert.match(testLanes, /test\/documentation-governance\.test\.js/u);
  assert.match(workflow, /- "\*\.md"/u);
  assert.match(workflow, /- "\*\*\/\*\.md"/u);
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u,
  );
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/u);
  for (const sourcePath of [
    "apps/\\*\\*",
    "native/\\*\\*",
    "packages/\\*\\*",
    "schemas/\\*\\*",
    "scripts/\\*\\*",
    "src/\\*\\*",
    "test/\\*\\*",
    "tools/\\*\\*",
  ]) {
    assert.match(workflow, new RegExp(`- "${sourcePath}"`, "u"));
  }
  assert.match(workflow, /run: npm run docs:check/u);
  assert.match(
    workflow,
    /node --test[\s\S]*test\/api-surface-reference\.test\.js[\s\S]*test\/cli-reference\.test\.js[\s\S]*test\/public-documentation-contract\.test\.js[\s\S]*test\/macos-localization\.test\.js/u,
  );
  assert.match(releaseWorkflow, /fetch-depth: 0/u);
  assert.match(releaseWorkflow, /name: Check documentation governance\n\s+run: npm run docs:check/u);
});
