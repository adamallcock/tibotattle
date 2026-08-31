import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { generateEnvelopeKeys } from "./generate-dev-keys.mjs";
import { localErasureOrigin } from "./local-owner-erasure.mjs";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));

function privateDirectory(path) {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("The local owner fixture requires a real owner-only state directory.");
  }
  return realpathSync(resolved);
}

function hashCapability(kind, id, secret) {
  return createHash("sha256").update(`app-usagemonitor/${kind}/v1\0${id}\0${secret}`).digest();
}

// Mirror only the existing session wire format. No existing participant is
// promoted, no enrollment policy is widened, and no fixture identity is fixed.
export function localOwnerFixtureMaterial(origin, nowEpoch = Date.now()) {
  const participantId = `participant:${randomUUID()}`;
  const identityKey = randomBytes(32).toString("hex");
  const sessionId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const csrfToken = `um_csrf_${hashCapability("csrf", sessionId, secret).toString("base64url")}`;
  const createdAt = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + 24 * 60 * 60 * 1000).toISOString();
  const access = {
    schemaVersion: "local-backend-owner-access-v0.1",
    origin: localErasureOrigin(origin),
    participantId,
    sessionCookie: `__Host-usage_monitor_session=um_session_${sessionId}.${secret}`,
    csrfToken,
    expiresAt,
  };
  const sql = `
INSERT INTO participants (
  id, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash,
  state, consent_version, consented_at, created_at, identity_link_key
) SELECT
  '${participantId}', '${randomUUID()}', x'${randomBytes(32).toString("hex")}',
  '${randomUUID()}', x'${randomBytes(32).toString("hex")}',
  'active', 'synthetic-preview-v0.1', '${createdAt}', '${createdAt}', '${identityKey}'
WHERE NOT EXISTS (SELECT 1 FROM participants);
INSERT INTO web_sessions (
  id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at
) SELECT
  '${sessionId}', '${participantId}', x'${hashCapability("session", sessionId, secret).toString("hex")}',
  x'${hashCapability("csrf-binding", sessionId, csrfToken).toString("hex")}',
  'personal', 'active', '${createdAt}', '${expiresAt}', '${createdAt}'
WHERE EXISTS (SELECT 1 FROM participants WHERE id = '${participantId}' AND identity_link_key = '${identityKey}');
SELECT COUNT(*) AS owner_fixture_sessions FROM web_sessions WHERE id = '${sessionId}';
`.trim();
  return { access, identityKey, sql };
}

export function localOwnerWorkerConfig(base, { workerDirectory = workerRoot, identityKey } = {}) {
  if (!/^[0-9a-f]{64}$/u.test(identityKey)
      || base?.name !== "app-usagemonitor-synthetic"
      || base?.vars?.ENVIRONMENT !== "synthetic-development"
      || base.d1_databases?.length !== 2
      || base.d1_databases.some((binding) => !/^00000000-0000-0000-0000-00000000000[01]$/u.test(binding.database_id))
      || base.r2_buckets?.length !== 1
      || base.r2_buckets[0].bucket_name !== "app-usagemonitor-synthetic-quarantine") {
    throw new Error("The owner fixture requires the repository's synthetic local Worker configuration.");
  }
  const { env: _hostedEnvironments, ...config } = base;
  // --local is mandatory as well; reject explicit remote bindings defensively.
  function rejectRemote(value) {
    if (!value || typeof value !== "object") return;
    if (value.remote === true) throw new Error("Remote bindings are forbidden in a local owner fixture.");
    for (const child of Object.values(value)) rejectRemote(child);
  }
  rejectRemote(config);
  if (config.services || config.ai || config.browser || config.vectorize || config.hyperdrive) {
    throw new Error("Remote-capable service bindings are forbidden in a local owner fixture.");
  }
  return {
    ...config,
    main: resolve(workerDirectory, config.main),
    vars: {
      ...config.vars,
      ENVIRONMENT: "local-development",
      ENROLLMENT_MODE: "local_open",
      ADMIN_IDENTITY_LINK_KEY: identityKey,
    },
    // Disposable local fixtures serve working-tree assets; production assets
    // still require the separate, guarded release-staging workflow.
    assets: { ...config.assets, directory: resolve(workerDirectory, "..", "web", "public") },
    d1_databases: config.d1_databases.map((binding) => ({
      ...binding,
      migrations_dir: resolve(workerDirectory, binding.migrations_dir),
    })),
  };
}

export function createLocalOwnerFixture({
  origin, persistTo, directory, workerDirectory = workerRoot, spawn = spawnSync,
} = {}) {
  localErasureOrigin(origin);
  if (!isAbsolute(persistTo ?? "") || !isAbsolute(directory ?? "")) {
    throw new Error("Local owner fixture paths must be explicit absolute paths.");
  }
  const state = privateDirectory(persistTo);
  const configErrors = [];
  const base = parse(readFileSync(join(workerDirectory, "wrangler.jsonc"), "utf8"), configErrors);
  if (configErrors.length) throw new Error("The synthetic Worker configuration is invalid.");
  const material = localOwnerFixtureMaterial(origin);
  const config = localOwnerWorkerConfig(base, { workerDirectory, identityKey: material.identityKey });
  const wrangler = join(workerDirectory, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  function execute(extra) {
    const result = spawn(wrangler, [
      "d1", "execute", "USAGE_MONITOR_DB", "--local", "--env", "",
      "--config", join(workerDirectory, "wrangler.jsonc"), "--persist-to", state, "--json", ...extra,
    ], { cwd: workerDirectory, encoding: "utf8", maxBuffer: 1024 * 1024,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
    if (result.error || result.status !== 0) throw new Error("Local owner fixture D1 setup failed; state is retained for inspection.");
    try { return JSON.parse(result.stdout); } catch { throw new Error("Local owner fixture D1 receipt was invalid."); }
  }
  const empty = execute(["--command", "SELECT COUNT(*) AS participants FROM participants;"]);
  if (empty?.[0]?.results?.[0]?.participants !== 0) {
    throw new Error("Refusing to seed an owner into nonempty local participant state. Create a fresh isolated lab.");
  }
  // Exclusive creation preserves any existing owner configuration or authority.
  mkdirSync(directory, { mode: 0o700 });
  privateDirectory(directory);
  const configFile = join(directory, "wrangler.local-owner.json");
  const varsFile = join(directory, "owner.env");
  const accessFile = join(directory, "owner-access.json");
  const sqlFile = join(directory, "owner-fixture.sql");
  const write = (path, text) => writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  write(configFile, `${JSON.stringify(config, null, 2)}\n`);
  if (!generateEnvelopeKeys(varsFile).ok) throw new Error("Local owner fixture envelope keys already exist.");
  write(sqlFile, material.sql);
  const seeded = execute(["--file", sqlFile]);
  if (seeded?.at(-1)?.results?.[0]?.owner_fixture_sessions !== 1) {
    throw new Error("The dedicated local owner was not seeded; no ordinary participant was promoted.");
  }
  write(accessFile, `${JSON.stringify(material.access, null, 2)}\n`);
  return Object.freeze({ configFile, varsFile, accessFile });
}

function main(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--origin", "--persist-to", "--directory"].includes(name)
        || values.has(name) || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error("Use --origin, --persist-to, and --directory for a fresh migrated local state; remote targets are unsupported.");
    }
    values.set(name, args[index + 1]);
  }
  const files = createLocalOwnerFixture({
    origin: values.get("--origin"), persistTo: values.get("--persist-to"), directory: values.get("--directory"),
  });
  process.stdout.write(`${JSON.stringify({ status: "created", target: "local", ...files, containsOwnerOnlyCapabilities: true })}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(process.argv.slice(2)); } catch {
    process.stderr.write("Local owner fixture setup failed. Use a fresh migrated local state and a new owner-only fixture directory; no existing participant may be promoted.\n");
    process.exitCode = 1;
  }
}
