import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(ROOT, "test/fixtures/macos-keychain-migration");
const COMMON = join(ROOT, "apps/macos/Sources/KeychainMigration.swift");
const SCHEMA = "tibotattle-signed-synthetic-keychain-migration-v1";
const SIGNING_VARIABLE = "TIBOTATTLE_MIGRATION_SIGNING_IDENTITY";
const HELPER_RELATIVE = "Contents/Helpers/TiboTattleKeychainMigration";
const APP_IDENTIFIER = "com.usagemonitor.local";
const SOURCE_NAMES = [
  "OwnershipPolicy.swift", "OwnershipPolicyTests.swift", "FixtureSupport.swift",
  "CreatorMain.swift", "HelperMain.swift", "HostMain.swift", "RawPeerMain.swift",
];
const LIMITATIONS = [
  "Synthetic Security-API/default-ACL and signed-identity approximation; not an existing user's ACL.",
  "No old Node/keytar process reads an actual user item; fixtures never read application credentials from the login Keychain.",
  "Explicit codesign operations may use the operator's approved signing key; this is separate from fixture access.",
  "Not an installed, notarized, or updater old-to-new replacement proof.",
];

class ProbeError extends Error {
  constructor(code) { super(code); this.name = "ProbeError"; this.code = code; }
}

export function parseArguments(args) {
  const options = { mode: "plan", legacyApp: null };
  if (args.includes("--help")) {
    if (args.length !== 1) throw new ProbeError("HELP_MUST_BE_USED_ALONE");
    return options;
  }
  let selected = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--run-signed" || argument === "--compile-only") {
      if (selected) throw new ProbeError("ONE_EXECUTION_MODE_REQUIRED");
      selected = true;
      options.mode = argument === "--run-signed" ? "signed" : "compile";
    } else if (argument === "--legacy-app") {
      if (options.legacyApp !== null || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new ProbeError("LEGACY_APP_ARGUMENT_INVALID");
      }
      options.legacyApp = args[++index];
    } else {
      throw new ProbeError("UNKNOWN_ARGUMENT");
    }
  }
  if (options.mode === "signed" && !options.legacyApp) {
    throw new ProbeError("EXPLICIT_LEGACY_APP_REQUIRED");
  }
  if (options.mode === "compile" && options.legacyApp) {
    throw new ProbeError("LEGACY_APP_ONLY_FOR_SIGNED_RUN");
  }
  return options;
}

export function inspectionPlan() {
  return {
    schema: SCHEMA,
    mode: "plan",
    signingPerformed: false,
    keychainAccessPerformed: false,
    applicationLoginKeychainItemAccess: false,
    instructions: [
      "Review this helper and its Swift fixtures before an explicitly authorized signed run.",
      "--compile-only compiles synthetic fixtures without signing or executing them.",
      `Set only a signing label in ${SIGNING_VARIABLE}; never put it in an argument or receipt.`,
      "Invoke --run-signed --legacy-app <explicit old signed app path> to run the synthetic probe.",
      "The signing tool may require approval for its private key; fixture reads never enable prompts.",
    ],
    checks: [
      "Verify the selected legacy Node's actual Developer ID designated requirement.",
      "Compile and sign a historical-identity creator/helper and a distinct native app identity.",
      "Create random synthetic evidence in one private file-based Keychain using the old default ACL.",
      "Require native legacy-read denial, trusted-helper exact read, shared adoption and modern readback.",
      "Require legacy retention, no-clobber repeated adoption and helper denial of the modern item.",
      "Require a differently built same-identity app to read the modern item without the helper.",
      "Reject untrusted parents, invalid capability/frames/continuation and invalid stored values.",
      "Verify a timed-out helper is killed and reaped within the shared bounded deadline.",
      "Verify a stalled helper exits on its own kernel timer after its authenticated parent dies.",
      "Compare default/search lists without printing paths; remove only the owned disposable Keychain.",
    ],
    limitations: LIMITATIONS,
  };
}

function childEnvironment() {
  const allowed = ["HOME", "USER", "LOGNAME", "TMPDIR", "DEVELOPER_DIR", "SDKROOT"];
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
  for (const name of allowed) if (process.env[name]) env[name] = process.env[name];
  return env;
}

let interrupted = false;
let activeChild = null;
let cleaning = false;

function interrupt() {
  interrupted = true;
  if (!cleaning) activeChild?.kill("SIGTERM");
}

async function run(executable, args, { input, timeout = 30_000, allowFailure = false } = {}) {
  if (interrupted && !cleaning) throw new ProbeError("RUN_INTERRUPTED");
  return await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd: ROOT, env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    activeChild = child;
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let exceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    function collect(target, chunk) {
      bytes += chunk.length;
      if (bytes > 512 * 1024) { exceeded = true; child.kill("SIGKILL"); return; }
      target.push(chunk);
    }
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      reject(new ProbeError("SUBPROCESS_UNAVAILABLE"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      const result = {
        code, signal, stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut || exceeded) reject(new ProbeError(timedOut ? "SUBPROCESS_TIMEOUT" : "OUTPUT_LIMIT"));
      else if (!allowFailure && (code !== 0 || signal)) reject(new ProbeError("SUBPROCESS_FAILED"));
      else resolveResult(result);
    });
    child.stdin.end(input);
  });
}

function normalizeRequirement(value) {
  return value.replace(/\/\*\s*exists\s*\*\//gu, "exists").replace(/\s+/gu, " ").trim()
    // These are the three fixed signing identities used by this fixture. Only
    // normalize codesign's quoted/bare spelling of the complete leading token.
    .replace(/^identifier (node|com\.usagemonitor\.(?:local|migration-probe\.wrong-parent))(?= and )/u,
      'identifier "$1"');
}

function expectedRequirement(identifier, team) {
  return `identifier "${identifier}" and anchor apple generic `
    + "and certificate 1[field.1.2.840.113635.100.6.2.6] exists "
    + "and certificate leaf[field.1.2.840.113635.100.6.1.13] exists "
    + `and certificate leaf[subject.OU] = "${team}"`;
}

export function matchesReviewedMigrationRequirement(value, identifier, team) {
  return typeof value === "string"
    && ["node", APP_IDENTIFIER, "com.usagemonitor.migration-probe.wrong-parent"].includes(identifier)
    && typeof team === "string" && /^[A-Z0-9]{10}$/u.test(team)
    && normalizeRequirement(value) === expectedRequirement(identifier, team);
}

async function signature(executable, identifier, { requireRuntime = true } = {}) {
  await run("/usr/bin/codesign", ["--verify", "--strict", executable]);
  const result = await run("/usr/bin/codesign", ["--display", "--requirements", "-", "--verbose=4", executable]);
  const description = `${result.stdout}\n${result.stderr}`;
  const foundIdentifier = /^Identifier=(.+)$/mu.exec(description)?.[1];
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(description)?.[1];
  const requirement = /^designated => (.+)$/mu.exec(description)?.[1];
  const cdhash = /^CDHash=([a-f0-9]+)$/mu.exec(description)?.[1];
  const flags = /flags=0x([a-f0-9]+)/iu.exec(description)?.[1];
  if (foundIdentifier !== identifier || !team || !requirement || !cdhash
    || !/^Authority=Developer ID Application:/mu.test(description)
    || (requireRuntime && (!flags || (Number.parseInt(flags, 16) & 0x10000) === 0))
    || !matchesReviewedMigrationRequirement(requirement, identifier, team)) {
    throw new ProbeError("SIGNATURE_IDENTITY_CONTRACT_FAILED");
  }
  return { team, requirement, cdhash };
}

async function assertNoEntitlements(executable) {
  const result = await run("/usr/bin/codesign", ["--display", "--entitlements", ":-", executable]);
  if (/<key>/u.test(`${result.stdout}\n${result.stderr}`)) {
    throw new ProbeError("FIXTURE_ENTITLEMENTS_REFUSED");
  }
}

async function privateWrite(file, value) {
  await writeFile(file, value, { mode: 0o600, flag: "wx" });
}

async function freezeSources(root) {
  const directory = join(root, "source-snapshot");
  await mkdir(directory, { mode: 0o700 });
  const common = await readFile(COMMON);
  const fixtures = await Promise.all(SOURCE_NAMES.map((name) => readFile(join(FIXTURES, name))));
  await privateWrite(join(directory, "KeychainMigration.swift"), common);
  for (let index = 0; index < SOURCE_NAMES.length; index += 1) {
    await privateWrite(join(directory, SOURCE_NAMES[index]), fixtures[index]);
  }
  return {
    directory,
    commonSHA256: createHash("sha256").update(common).digest("hex"),
    fixtureSHA256: createHash("sha256").update(Buffer.concat(fixtures)).digest("hex"),
  };
}

async function assertSourcesUnchanged(snapshot) {
  const current = createHash("sha256").update(await readFile(COMMON)).digest("hex");
  const fixtures = createHash("sha256").update(Buffer.concat(
    await Promise.all(SOURCE_NAMES.map((name) => readFile(join(FIXTURES, name)))),
  )).digest("hex");
  if (current !== snapshot.commonSHA256 || fixtures !== snapshot.fixtureSHA256) {
    throw new ProbeError("SOURCE_CHANGED_DURING_PROBE");
  }
}

async function compileFixtures(root, snapshot) {
  const swift = (await run("/usr/bin/xcrun", ["--find", "swiftc"])).stdout.trim();
  const sdk = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"])).stdout.trim();
  if (!swift.startsWith("/") || !sdk.startsWith("/")) throw new ProbeError("SWIFT_TOOLCHAIN_UNAVAILABLE");
  const configuration = join(root, "ProbeConfiguration.swift");
  const marker = JSON.parse(await readFile(join(root, "owner.json"), "utf8"));
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(root)) throw new ProbeError("FIXTURE_ROOT_ENCODING_REFUSED");
  await privateWrite(configuration,
    `enum ProbeConfiguration {\n    static let root = ${JSON.stringify(root)}\n`
    + `    static let nonce = ${JSON.stringify(marker.nonce)}\n}\n`);
  const creator = join(root, "legacy-creator");
  const host = join(root, "Host.app/Contents/MacOS/Probe");
  const replacement = join(root, "Replacement.app/Contents/MacOS/Probe");
  const rawSigned = join(root, "raw-parent-signed");
  const rawWrong = join(root, "raw-parent-wrong");
  const rawAdHoc = join(root, "raw-parent-ad-hoc");
  const ownershipPolicy = join(root, "ownership-policy-tests");
  const helpers = Object.fromEntries(["Host", "Modern", "Timeout", "InvalidValue", "Orphan"].map(
    (kind) => [kind, join(root, `${kind}.app`, HELPER_RELATIVE)],
  ));
  const builds = [
    [creator, "CreatorMain.swift", []],
    [host, "HostMain.swift", []],
    [replacement, "HostMain.swift", ["-D", "PROBE_REPLACEMENT"]],
    [rawAdHoc, "RawPeerMain.swift", []],
    [helpers.Host, "HelperMain.swift", []],
    [helpers.Modern, "HelperMain.swift", ["-D", "PROBE_MODERN_READ"]],
    [helpers.Timeout, "HelperMain.swift", ["-D", "PROBE_TIMEOUT"]],
    [helpers.InvalidValue, "HelperMain.swift", ["-D", "PROBE_INVALID_VALUE"]],
    [helpers.Orphan, "HelperMain.swift", ["-D", "PROBE_PARENT_EXIT"]],
  ];
  for (const [output, source, definitions] of builds) {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const result = await run(swift, [
      "-parse-as-library", "-O", "-sdk", sdk, "-target", "arm64-apple-macosx13.0",
      "-module-cache-path", join(root, "module-cache"),
      "-framework", "Foundation", "-framework", "Security", "-framework", "CryptoKit",
      "-lbsm",
      ...definitions, configuration, join(snapshot.directory, "KeychainMigration.swift"),
      join(snapshot.directory, "OwnershipPolicy.swift"),
      join(snapshot.directory, "FixtureSupport.swift"), join(snapshot.directory, source), "-o", output,
    ], { timeout: 120_000, allowFailure: true });
    if (result.code !== 0 || result.signal) {
      // Only compile diagnostics are retained; signing/tool errors are never
      // persisted because they can contain an identity or private-key label.
      await privateWrite(join(root, "compile-diagnostics.txt"), result.stderr);
      throw new ProbeError("SWIFT_FIXTURE_COMPILATION_FAILED");
    }
    await chmod(output, 0o700);
  }
  // This regression executable has no Security, shared migration, fixture
  // support, generated path, or signing dependency. Compile-only never runs it.
  const ownershipBuild = await run(swift, [
    "-parse-as-library", "-O", "-sdk", sdk, "-target", "arm64-apple-macosx13.0",
    "-module-cache-path", join(root, "module-cache"), "-framework", "Foundation",
    join(snapshot.directory, "OwnershipPolicy.swift"),
    join(snapshot.directory, "OwnershipPolicyTests.swift"), "-o", ownershipPolicy,
  ], { timeout: 120_000, allowFailure: true });
  if (ownershipBuild.code !== 0 || ownershipBuild.signal) {
    await privateWrite(join(root, "compile-diagnostics.txt"), ownershipBuild.stderr);
    throw new ProbeError("SWIFT_OWNERSHIP_POLICY_COMPILATION_FAILED");
  }
  await chmod(ownershipPolicy, 0o700);
  await copyFile(rawAdHoc, rawSigned);
  await copyFile(rawAdHoc, rawWrong);
  for (const path of [rawSigned, rawWrong]) await chmod(path, 0o700);
  for (const kind of ["Host", "Replacement"]) {
    await privateWrite(join(root, `${kind}.app/Contents/Info.plist`),
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
      + '<plist version="1.0"><dict><key>CFBundleIdentifier</key>'
      + `<string>${APP_IDENTIFIER}</string><key>CFBundleExecutable</key><string>Probe</string>`
      + '<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key>'
      + '<string>1</string></dict></plist>\n');
  }
  return { creator, host, replacement, rawSigned, rawWrong, rawAdHoc, helpers, ownershipPolicy };
}

async function snapshotKeychainPreferences() {
  // Read-only queries. Values (including paths) exist only in process memory.
  const values = [];
  for (const args of [["list-keychains"], ["list-keychains", "-d", "user"],
    ["default-keychain", "-d", "user"]]) {
    values.push((await run("/usr/bin/security", args)).stdout);
  }
  return values;
}

function samePreferences(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new ProbeError("FIXTURE_FILE_CHECK_FAILED");
  }
}

async function fixture(executable, args, checks, expectedKeys) {
  const result = await run(executable, args, { timeout: 12_000, allowFailure: true });
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new ProbeError("FIXTURE_REPORT_INVALID"); }
  if (result.code !== 0 || result.signal || report?.ok !== true) {
    // Fixture codes are closed constants. Do not forward arbitrary subprocess
    // stdout or Security error text, even when the process was locally signed.
    const code = typeof report?.code === "string" && /^[A-Z_]{3,80}$/u.test(report.code)
      ? report.code : "FIXTURE_ASSERTION_FAILED";
    throw new ProbeError(code);
  }
  for (const key of expectedKeys) {
    if (report[key] !== true) throw new ProbeError("FIXTURE_PROOF_MISSING");
    checks[key] = true;
  }
  return report;
}

async function verifyOrphanExit(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new ProbeError("ORPHAN_PID_INVALID");
  const deadline = performance.now() + 4_000;
  do {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
      throw new ProbeError("ORPHAN_STATUS_UNAVAILABLE");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  } while (performance.now() < deadline);
  // Never signal the PID here: it could have been reused. Failing the probe is
  // safe; the fixture's own kernel timer is the behavior under test.
  throw new ProbeError("HELPER_OUTLIVED_AUTHENTICATED_PARENT_BOUND");
}

async function performSigned(root, files, old, signingLabel, checks) {
  await fixture(files.ownershipPolicy, [], checks, ["ownershipPolicyPassed"]);
  async function sign(executable, identifier, requirement = null) {
    const args = ["--force", "--sign", signingLabel, "--options", "runtime", "--timestamp=none",
      "--identifier", identifier];
    if (requirement) args.push("--requirements", `=designated => ${requirement}`);
    args.push(executable);
    await run("/usr/bin/codesign", args);
    const info = await signature(executable, identifier);
    await assertNoEntitlements(executable);
    if (info.team !== old.team) throw new ProbeError("SIGNING_TEAM_CHANGED");
    return info;
  }
  const creator = await sign(files.creator, "node", old.requirement);
  for (const helper of Object.values(files.helpers)) {
    const found = await sign(helper, "node", old.requirement);
    if (normalizeRequirement(found.requirement) !== normalizeRequirement(old.requirement)) {
      throw new ProbeError("HELPER_LEGACY_REQUIREMENT_CHANGED");
    }
  }
  if (normalizeRequirement(creator.requirement) !== normalizeRequirement(old.requirement)) {
    throw new ProbeError("CREATOR_LEGACY_REQUIREMENT_CHANGED");
  }
  const host = await sign(files.host, APP_IDENTIFIER);
  const replacement = await sign(files.replacement, APP_IDENTIFIER);
  await sign(files.rawSigned, APP_IDENTIFIER);
  await sign(files.rawWrong, "com.usagemonitor.migration-probe.wrong-parent");
  checks.legacyRequirementPreserved = true;
  checks.sameDeveloperIDTeam = true;
  checks.fixtureEntitlementsAbsent = true;
  checks.hardenedRuntime = true;
  if (host.cdhash === replacement.cdhash
    || normalizeRequirement(host.requirement) !== normalizeRequirement(replacement.requirement)) {
    throw new ProbeError("REPLACEMENT_IDENTITY_PROOF_FAILED");
  }
  checks.replacementDifferentBytesSameRequirement = true;
  let before = null;
  let creationAttempted = false;
  let originalFailure = null;
  try {
    before = await snapshotKeychainPreferences();
    creationAttempted = true;
    await fixture(files.creator, ["--create-synthetic-keychain"], checks, ["legacySeedCreated"]);
    if (!samePreferences(before, await snapshotKeychainPreferences())) {
      throw new ProbeError("KEYCHAIN_PREFERENCES_CHANGED_DURING_CREATION");
    }
    const shell = await run("/bin/sh", ["-c", 'exec "$1"', "migration-probe", files.helpers.Host], {
      input: '{"v":1,"capability":"account_observation"}\n', allowFailure: true, timeout: 4_000,
    });
    if (shell.code !== 1 || shell.signal || shell.stdout !== "" || shell.stderr !== "") {
      throw new ProbeError("DIRECT_SHELL_NOT_REJECTED");
    }
    checks.directShellRejected = true;
    const negatives = [
      [files.rawWrong, "valid-request", "wrongParentRejected"],
      [files.rawAdHoc, "valid-request", "adHocParentRejected"],
      [files.rawSigned, "invalid-capability", "invalidCapabilityRejected"],
      [files.rawSigned, "malformed-frame", "malformedFrameRejected"],
      [files.rawSigned, "oversized-frame", "oversizedFrameRejected"],
      [files.rawSigned, "wrong-continue", "invalidContinuationRejected"],
      [files.rawSigned, "no-frame", "missingRequestBounded"],
    ];
    for (const [executable, mode, name] of negatives) {
      await fixture(executable, [mode, files.helpers.Host], {}, ["peerRejected", "noSecretFrame", "childReaped"]);
      if (await exists(join(root, "reader-legacy.json"))) {
        throw new ProbeError("REJECTED_PARENT_INVOKED_SECRET_READER");
      }
      checks[name] = true;
    }
    checks.negativeReadersNeverInvoked = true;
    await fixture(files.host, ["--migrate"], checks, [
      "appLegacyReadDenied", "helperReadExactSeed", "sharedAdoptionPassed", "modernReadBackExact",
      "repeatAdoptionPassed", "legacyItemRetained", "differentExistingValueNotClobbered",
    ]);
    await fixture(files.host, ["--verify-modern-denial"], checks, ["helperModernReadDenied"]);
    await fixture(files.host, ["--verify-invalid-value"], checks, ["invalidValueRejected"]);
    await fixture(files.host, ["--verify-timeout"], checks, ["timeoutBounded", "childReaped"]);
    const orphan = await fixture(files.rawSigned,
      ["parent-exits-during-reader", files.helpers.Orphan], checks, ["parentExitedDuringReader"]);
    await verifyOrphanExit(orphan.helperPID);
    checks.orphanHelperExitedWithinBound = true;
    await fixture(files.replacement, ["--verify-upgrade"], checks,
      ["modernReadWithoutHelper", "syntheticKeyUnchanged"]);
    checks.preferencesUnchangedBeforeCleanup = samePreferences(before, await snapshotKeychainPreferences());
    if (!checks.preferencesUnchangedBeforeCleanup) throw new ProbeError("KEYCHAIN_PREFERENCES_CHANGED");
  } catch (error) { originalFailure = error; }
  finally {
    cleaning = true;
    try {
      if (creationAttempted) {
        await fixture(files.creator, ["--cleanup-synthetic-keychain"], checks, ["disposableKeychainRemoved"]);
        if ((await readdir(root)).some((name) => name.startsWith("synthetic.keychain"))) {
          throw new ProbeError("SYNTHETIC_KEYCHAIN_STORAGE_REMAINS");
        }
      }
      if (before) {
        checks.defaultAndSearchListsUnchanged = samePreferences(before, await snapshotKeychainPreferences());
        if (!checks.defaultAndSearchListsUnchanged) throw new ProbeError("KEYCHAIN_PREFERENCES_CHANGED");
      }
    } catch (error) {
      checks.cleanupVerified = false;
      originalFailure ??= error;
    } finally { cleaning = false; }
  }
  if (originalFailure) throw originalFailure;
  checks.cleanupVerified = true;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.mode === "plan") return inspectionPlan();
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.versions.node !== "26.2.0") {
    throw new ProbeError("PINNED_MACOS_ARM64_NODE_26_2_0_REQUIRED");
  }
  let signingLabel;
  let old;
  if (options.mode === "signed") {
    signingLabel = process.env[SIGNING_VARIABLE];
    if (!signingLabel || /[\r\n\0]/u.test(signingLabel)) throw new ProbeError("SIGNING_LABEL_REQUIRED");
    const legacy = await realpath(resolve(options.legacyApp));
    const node = join(legacy, "Contents/Resources/runtime/bin/node");
    const metadata = await lstat(node);
    if (!legacy.endsWith(".app") || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ProbeError("EXPLICIT_LEGACY_APP_INVALID");
    }
    old = await signature(node, "node");
  }
  const root = await mkdtemp(join(await realpath(tmpdir()), "tibotattle-keychain-probe."));
  await chmod(root, 0o700);
  const owner = await lstat(root);
  await privateWrite(join(root, "owner.json"), JSON.stringify({
    nonce: randomUUID(), uid: process.getuid(), inode: owner.ino,
  }));
  const checks = {};
  const snapshot = await freezeSources(root);
  const report = {
    schema: SCHEMA, mode: options.mode, ok: false, fixtureDirectory: root,
    applicationLoginKeychainItemAccess: false, installedAppModified: false,
    sourceSHA256: snapshot.commonSHA256,
    fixtureSourceSHA256: snapshot.fixtureSHA256,
    checks, limitations: LIMITATIONS,
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const files = await compileFixtures(root, snapshot);
    checks.fixtureCompilation = true;
    await assertSourcesUnchanged(snapshot);
    if (options.mode === "signed") {
      await performSigned(root, files, old, signingLabel, checks);
    } else {
      report.signingPerformed = false;
      report.keychainAccessPerformed = false;
    }
    await assertSourcesUnchanged(snapshot);
    report.ok = true;
  } catch (error) {
    report.code = error instanceof ProbeError ? error.code : "PROBE_FAILED";
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await privateWrite(join(root, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schema: SCHEMA, ok: false, code: error instanceof ProbeError ? error.code : "PROBE_FAILED",
    })}\n`);
    process.exitCode = 1;
  }
}
