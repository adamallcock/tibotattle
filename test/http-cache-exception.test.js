import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStatus, checkLocal, CONFIG, PUBLISHED_VERSIONS } from "../scripts/check-http-cache-exception.mjs";

const status = () => ({ now: new Date("2026-10-04T04:00:00Z"), latest: { name: "http-cache-semantics", version: "4.3.0" }, registry: { versions: Object.fromEntries(PUBLISHED_VERSIONS.map(version => [version, {}])) }, advisory: { ghsa_id: "GHSA-ch52-4w7c-c8xp", withdrawn_at: null, vulnerabilities: [{ package: { ecosystem: "npm", name: "http-cache-semantics" }, vulnerable_version_range: "<= 4.2.0", first_patched_version: null }] } });
test("temporary status accepts current scope and refuses exact expiry", () => {
  checkStatus(status());
  for (const date of ["2026-10-10T00:00:00Z", "2026-10-11", "invalid", "2026-10-02"]) assert.throws(() => checkStatus({ ...status(), now: new Date(date) }));
});
test("published inventory, latest tag, fix, withdrawal and advisory scope drift invalidate exception", () => {
  const cases = [
    ["next latest release", s => { s.latest.version = "4.3.1"; }],
    ["latest tag rollback", s => { s.latest.version = "4.2.0"; }],
    ["new regular release with latest unchanged", s => { s.registry.versions["4.3.1"] = {}; }],
    ["new beta release with latest unchanged", s => { s.registry.versions["4.4.0-beta.1"] = {}; }],
    ["published release removed with latest unchanged", s => { delete s.registry.versions["4.2.0"]; }],
    ["advisory withdrawal", s => { s.advisory.withdrawn_at = "2026-10-04"; }],
    ["declared published fix", s => { s.advisory.vulnerabilities[0].first_patched_version = "4.3.0"; }],
    ["advisory scope change", s => { s.advisory.vulnerabilities[0].vulnerable_version_range = "< 5"; }],
    ["advisory identity change", s => { s.advisory.ghsa_id = "GHSA-unrelated"; }],
  ];
  for (const [name, mutate] of cases) { const input = status(); mutate(input); assert.throws(() => checkStatus(input), undefined, name); }
});
test("only one exact advisory is configured; child locks never receive a global config", async () => {
  assert.equal((CONFIG.match(/\[\[IgnoredVulns\]\]/g) || []).length, 1);
  assert.match(CONFIG, /id = "GHSA-ch52-4w7c-c8xp"/);
  assert.doesNotMatch(CONFIG, /PackageOverrides/);
  const workflow = await readFile(new URL("../.github/workflows/osv-scanner.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /--config|fail-on-vuln=false|continue-on-error/);
  assert.doesNotMatch(workflow, /google\/osv-scanner-action|osv-reporter|GOTOOLCHAIN/);
  assert.match(workflow, /"\$scanner" scan source --all-vulns --recursive \.\//);
  assert.ok(workflow.indexOf("node scripts/check-http-cache-exception.mjs") < workflow.indexOf("name: Run scanner"));
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("name: Run scanner")), /continue-on-error: true/);
});
test("changed config or additional root lock refuses before installed proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-cache-exception-test-"));
  try {
    await writeFile(join(root, "pnpm-lock.yaml"), "synthetic");
    await writeFile(join(root, "osv-scanner.toml"), CONFIG + "# drift\n");
    await assert.rejects(checkLocal(root), /scope\/config drift/);
    await writeFile(join(root, "osv-scanner.toml"), CONFIG);
    await assert.rejects(checkLocal(root), /Reviewed input drift/);
    await writeFile(join(root, "package-lock.json"), "{}");
    await assert.rejects(checkLocal(root), /only to reviewed root lock/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scanner executable is pinned and verification precedes execution", async () => {
  const workflow = await readFile(new URL("../.github/workflows/osv-scanner.yml", import.meta.url), "utf8");
  const scanner = workflow.slice(workflow.indexOf("      - name: Run scanner"));
  assert.match(scanner, /shell: bash/);
  assert.match(scanner, /set -euo pipefail/);
  assert.match(scanner, /https:\/\/github\.com\/google\/osv-scanner\/releases\/download\/v2\.5\.1\/osv-scanner_linux_amd64/);
  assert.match(scanner, /f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be/);
  assert.match(scanner, /sha256sum --check --strict/);
  assert.ok(scanner.indexOf("sha256sum --check --strict") < scanner.indexOf('chmod 0700 "$scanner"'));
  assert.ok(scanner.indexOf('chmod 0700 "$scanner"') < scanner.indexOf('"$scanner" scan source --all-vulns --recursive ./'));
  assert.doesNotMatch(scanner, /\|\||set \+e|exit 0|continue-on-error|--config|--no-ignore/);
});
