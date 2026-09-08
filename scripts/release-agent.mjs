#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import { resolveSignedMacOSBundleVersion } from "./macos-bundle-version.js";
import { readMacOSReleaseSourceProvenance, readMacOSReleaseBuildConfiguration,
  readStableReleaseManifest } from "./macos-release-core.js";
import { identityDigest, operationError, readOperation } from "./lib/release-operation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA = /^[a-f0-9]{40}$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

async function readJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw operationError("RELEASE_INPUT_FILE_INVALID");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await file.stat();
    if (actual.ino !== info.ino || actual.dev !== info.dev) throw operationError("RELEASE_INPUT_FILE_CHANGED");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export function validateReleasePlan(value) {
  if (!object(value) || Object.keys(value).sort().join() !== "baseCommit,channel,schema,sourceCommit,targets"
      || value.schema !== 1 || !SHA.test(value.sourceCommit ?? "") || !SHA.test(value.baseCommit ?? "")
      || !["stable", "internal-dogfood"].includes(value.channel)
      || !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 2) throw operationError("RELEASE_PLAN_INVALID");
  const seen = new Set();
  for (const target of value.targets) {
    if (!object(target) || Object.keys(target).some((key) => !["architecture", "app", "nodeRuntime", "previousManifest", "output"].includes(key))
        || !["arm64", "x64"].includes(target.architecture) || seen.has(target.architecture)) throw operationError("RELEASE_PLAN_TARGET_INVALID");
    seen.add(target.architecture);
    for (const name of ["app", "nodeRuntime", "previousManifest", "output"]) {
      if (target[name] !== undefined && (typeof target[name] !== "string" || !target[name] || target[name].includes("\0"))) throw operationError("RELEASE_PLAN_PATH_INVALID");
    }
  }
  return value;
}

export async function releaseOperationStatus(directory) {
  const { kind, createdAt, updatedAt, state } = await readOperation(resolve(directory));
  if (kind === "production") {
    if (!["not_started", "outcome_unknown", "deployed_unverified", "verified"].includes(state.outcome)
        || !["not_acquired", "uncertain", "held", "released"].includes(state.lock)) throw operationError("RELEASE_STATUS_INVALID");
    return { schema: 1, kind, createdAt, updatedAt, outcome: state.outcome, coordination: state.lock,
      remoteState: "not_rechecked", nextAction: state.outcome === "verified" && state.lock === "released"
        ? "verify_publication_surfaces" : state.outcome === "not_started" && ["not_acquired", "released"].includes(state.lock)
          ? "inspect_preflight_failure_then_start_reviewed_new_operation" : "reconcile_existing_deployment_do_not_redeploy" };
  }
  if (!object(state.phases) || !object(state.notary)) throw operationError("RELEASE_STATUS_INVALID");
  const phases = ["build", "sign-app", "archive", "staple-app", "package", "sign-dmg", "staple-dmg"].map((phase) => ({
    phase, state: state.phases[phase] ? "recorded_requires_revalidation" : "not_recorded",
  }));
  const uncertain = ["app", "dmg"].some((name) => state.notary[name]?.status === "submitting");
  return { schema: 1, kind, createdAt, updatedAt, phases,
    outcome: state.install?.status === "complete" ? "completion_recorded" : "incomplete",
    remoteState: "not_rechecked", nextAction: uncertain ? "reconcile_unknown_apple_submission_do_not_resubmit" : "resume_exact_native_operation" };
}

export async function inspectRelease({ repositoryRoot = ROOT, plan = null, environment = process.env,
  spawn = spawnSync, platform = process.platform, architecture = process.arch, nodeVersion = process.versions.node,
  sourceProvenance = readMacOSReleaseSourceProvenance,
  buildConfiguration = readMacOSReleaseBuildConfiguration, previousManifestReader = readStableReleaseManifest,
  receiptCheck = null } = {}) {
  if (plan !== null) validateReleasePlan(plan);
  const root = resolve(repositoryRoot);
  const checks = [];
  const add = (name, state, nextAction) => checks.push({ name, state, nextAction });
  const git = (args) => {
    const result = spawn("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
    return result.error || result.status !== 0 ? null : String(result.stdout ?? "").trim();
  };
  const commit = git(["rev-parse", "HEAD"]);
  add("requested_source", plan && commit === plan.sourceCommit ? "passed" : "blocked", "select_exact_reviewed_source_in_plan");
  add("clean_checkout", git(["status", "--porcelain=v1", "--untracked-files=all"]) === "" ? "passed" : "blocked", "freeze_owned_clean_candidate");
  add("reviewed_base", plan && git(["merge-base", "--is-ancestor", plan.baseCommit, commit ?? "HEAD"]) === "" ? "passed" : "blocked", "reconcile_reviewed_base_before_release");
  const divergence = git(["rev-list", "--left-right", "--count", "origin/main...HEAD"]);
  const counts = /^\d+\s+\d+$/.test(divergence ?? "") ? divergence.split(/\s+/).map(Number) : null;
  add("remote_baseline", "not_exercised", "verify_remote_base_and_existing_release_read_only");
  const channel = plan?.channel ?? "stable";
  try { sourceProvenance({ repositoryRoot: root, expectedVersion: RELEASE_MANIFEST.version, channel }); add("annotated_source_tag", "passed", "none"); }
  catch { add("annotated_source_tag", "blocked", "verify_clean_exact_annotated_source_tag"); }
  add("pinned_builder", platform === "darwin" && architecture === "arm64" && nodeVersion === "26.2.0" ? "passed" : "blocked", "use_pinned_native_builder");
  add("build_allocation", resolveSignedMacOSBundleVersion(RELEASE_MANIFEST.version, channel) ? "passed" : "blocked", "allocate_reviewed_channel_build_number");
  for (const [name, variable, pattern] of [
    ["developer_id_reference", "USAGE_MONITOR_DEVELOPER_ID_APPLICATION", /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/],
    ["notary_profile_reference", "USAGE_MONITOR_NOTARY_PROFILE", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/],
  ]) add(name, pattern.test(environment[variable] ?? "") ? "configured_not_exercised" : "blocked", "configure_reference_without_accessing_keys");
  const targets = plan?.targets ?? [{ architecture: "arm64" }, { architecture: "x64" }];
  for (const target of targets) {
    const prefix = target.architecture;
    const selected = (name) => target[name] ? resolve(root, target[name]) : null;
    try { buildConfiguration(environment, channel, { architecture: prefix }); add(`${prefix}_configuration`, "passed", "none"); }
    catch { add(`${prefix}_configuration`, "blocked", "configure_reviewed_framework_public_key_and_channel_inputs"); }
    if (prefix === "x64") {
      let present = false;
      if (selected("nodeRuntime")) { try { const info = await lstat(selected("nodeRuntime")); present = info.isFile() && info.nlink === 1; } catch {} }
      add("x64_runtime", present ? "present_unverified" : "blocked", "verify_pinned_intel_runtime_hash_and_architecture");
    }
    let candidate = null;
    if (selected("app")) { try { candidate = await readJson(join(selected("app"), "Contents/Resources/build-manifest.json")); } catch {} }
    add(`${prefix}_candidate`, candidate?.release?.source?.commit === commit && candidate?.application?.architecture === prefix ? "present_unverified" : "blocked", "prepare_and_validate_exact_architecture_candidate");
    let previous = false;
    if (selected("previousManifest")) { try { const value = await previousManifestReader(selected("previousManifest")); previous = value.application?.architecture === prefix; } catch {} }
    add(`${prefix}_previous_release`, previous ? "present_unverified" : "blocked", "verify_previous_stable_artifact_or_review_bootstrap");
    const output = selected("output");
    let exists = !output;
    if (output) for (const path of [output, `${output}.release.json`, `${output}.operation`]) {
      try { await lstat(path); exists = true; } catch (error) { if (error.code !== "ENOENT") exists = true; }
    }
    add(`${prefix}_output`, exists ? "blocked" : "passed", "select_unoccupied_output_or_inspect_existing_operation");
    for (const gate of ["installed_upgrade", "login_item", "physical_hardware"]) add(`${prefix}_${gate}`, "not_exercised", "review_exact_artifact_evidence_or_release_specific_owner_decision");
  }
  let receipts = false;
  try {
    if (receiptCheck) receipts = await receiptCheck();
    else {
      const { validateR7ReleaseEvidenceReceipt } = await import("../src/r7-release-evidence-schema.js");
      const profiles = ["synthetic-semantics", "synthetic-pressure", "materialized-boundaries", "real-local-history", "decision"];
      const names = profiles.flatMap((profile) => ["24.14.0", "26.2.0"].map((version) => `r7-release-${profile}-node${version}-v0.1.json`)).sort();
      const actual = (await readdir(join(root, "generated"))).filter((name) => /^r7-release-.*\.json$/.test(name)).sort();
      receipts = JSON.stringify(names) === JSON.stringify(actual);
      for (const name of names) receipts = validateR7ReleaseEvidenceReceipt(await readJson(join(root, "generated", name))).valid && receipts;
    }
  } catch { receipts = false; }
  add("r7_receipt_contract", receipts ? "passed" : "blocked", "inspect_workload_invalidation_without_regenerating_receipts");
  for (const name of ["test_lanes", "signed_trust", "installed_qualification", "hosted_lineage", "hosted_compatibility", "production_recovery", "distribution_surfaces"]) add(name, "not_exercised", "run_owning_gate_under_existing_authority");
  return { schema: 1, mode: "doctor", readOnly: true, version: RELEASE_MANIFEST.version, channel,
    sourceCommit: SHA.test(commit ?? "") ? commit : null, planDigest: plan ? identityDigest(plan) : null,
    localTrackingDivergence: counts ? { mainOnly: counts[0], checkoutOnly: counts[1], remoteFetched: false } : null,
    readyToRelease: false, checks, nextAction: checks.find((check) => check.state === "blocked")?.nextAction ?? "review_remaining_unexercised_gates" };
}

export function parseReleaseAgentArgs(argv) {
  const mode = argv[0];
  if (!["doctor", "status"].includes(mode)) throw operationError("RELEASE_AGENT_USAGE");
  const result = { mode, json: false, plan: null, operation: null };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--json" && !result.json) { result.json = true; continue; }
    const name = argv[i] === "--plan" ? "plan" : argv[i] === "--operation" ? "operation" : null;
    const value = argv[++i];
    if (!name || result[name] !== null || !value || value.startsWith("--") || value.includes("\0")) throw operationError("RELEASE_AGENT_USAGE");
    result[name] = resolve(value);
  }
  if ((mode === "doctor" && result.operation) || (mode === "status" && (!result.operation || result.plan))) throw operationError("RELEASE_AGENT_USAGE");
  return result;
}

export async function main(argv) {
  const options = parseReleaseAgentArgs(argv);
  const result = options.mode === "doctor" ? await inspectRelease({ plan: options.plan ? await readJson(options.plan) : null }) : await releaseOperationStatus(options.operation);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Release ${options.mode}: read-only; no release/deployment actions performed.\n`);
    for (const check of result.checks ?? result.phases ?? []) process.stdout.write(`${check.name ?? check.phase}: ${check.state}\n`);
    if (result.outcome) process.stdout.write(`Recorded outcome: ${result.outcome}; remote state not rechecked.\n`);
    process.stdout.write(`Next: ${result.nextAction}\n`);
  }
  if (result.checks?.some(({ state }) => state === "blocked")) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${/^RELEASE_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "RELEASE_INSPECTION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
