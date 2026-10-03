import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStatus, checkLocal, CONFIG } from "../scripts/check-http-cache-exception.mjs";

const status = () => ({ now: new Date("2026-10-03T22:00:00Z"), latest: { name: "http-cache-semantics", version: "4.2.0" }, advisory: { ghsa_id: "GHSA-ch52-4w7c-c8xp", withdrawn_at: null, vulnerabilities: [{ package: { ecosystem: "npm", name: "http-cache-semantics" }, vulnerable_version_range: "<= 4.2.0", first_patched_version: null }] } });
test("temporary status accepts current scope and refuses exact expiry", () => {
  checkStatus(status());
  for (const date of ["2026-10-10T00:00:00Z", "2026-10-11", "invalid", "2026-10-02"]) assert.throws(() => checkStatus({ ...status(), now: new Date(date) }));
});
test("published fix, new release, withdrawal and advisory scope drift invalidate exception", () => {
  const cases = [s => { s.latest.version = "4.2.1"; }, s => { s.advisory.withdrawn_at = "2026-10-04"; }, s => { s.advisory.vulnerabilities[0].first_patched_version = "4.2.1"; }, s => { s.advisory.vulnerabilities[0].vulnerable_version_range = "< 5"; }, s => { s.advisory.ghsa_id = "GHSA-unrelated"; }];
  for (const mutate of cases) { const input = status(); mutate(input); assert.throws(() => checkStatus(input)); }
});
test("only one exact advisory is configured; child locks never receive a global config", async () => {
  assert.equal((CONFIG.match(/\[\[IgnoredVulns\]\]/g) || []).length, 1);
  assert.match(CONFIG, /id = "GHSA-ch52-4w7c-c8xp"/);
  assert.doesNotMatch(CONFIG, /PackageOverrides/);
  const workflow = await readFile(new URL("../.github/workflows/osv-scanner.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /--config|fail-on-vuln=false|continue-on-error/);
  assert.match(workflow, /--fail-on-vuln=true/);
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
