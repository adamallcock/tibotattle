import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ACTIONS = new Set([
  "inspect",
  "contain-all",
  "pause-enrollment",
  "pause-upload-registration",
  "pause-processing",
  "pause-publication",
  "resume-enrollment",
  "resume-upload-registration",
  "resume-processing",
  "resume-publication",
  "restore-all",
]);
const RESTORE_CONFIRMATION = "RESTORE_COLLECTION";
const FIELDS = {
  enrollment: "enrollment_enabled",
  "upload-registration": "upload_registration_enabled",
  processing: "processing_enabled",
  publication: "publication_enabled",
};

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    process.stderr.write(`${name} requires a value\n`);
    process.exit(2);
  }
  return value;
}

const action = optionValue("--action");
const persistTo = optionValue("--persist-to");
const confirmation = optionValue("--confirm");
if (process.argv.includes("--remote")) {
  process.stderr.write(
    "Remote collection control is deliberately unsupported\n",
  );
  process.exit(2);
}
if (!action || !ACTIONS.has(action)) {
  process.stderr.write("A reviewed --action is required\n");
  process.exit(2);
}
if (action.startsWith("resume-") || action === "restore-all") {
  if (confirmation !== RESTORE_CONFIRMATION) {
    process.stderr.write(
      `Restoration requires --confirm ${RESTORE_CONFIRMATION}\n`,
    );
    process.exit(2);
  }
} else if (confirmation !== null) {
  process.stderr.write("--confirm is available only for restoration\n");
  process.exit(2);
}

const selected = {
  enrollment: "enrollment_enabled",
  "upload-registration": "upload_registration_enabled",
  processing: "processing_enabled",
  publication: "publication_enabled",
};

function flagExpression(field) {
  if (action === "contain-all") return "0";
  if (action === "restore-all") return "1";
  const match = /^(pause|resume)-(.+)$/u.exec(action);
  if (match && selected[match[2]] === field) {
    return match[1] === "pause" ? "0" : "1";
  }
  return field;
}

const flagExpressions = Object.fromEntries(
  Object.entries(FIELDS).map(([name, field]) => [
    name,
    flagExpression(field),
  ]),
);
const allEnabled = Object.values(flagExpressions)
  .map((value) => `(${value}) = 1`)
  .join(" AND ");
const allDisabled = Object.values(flagExpressions)
  .map((value) => `(${value}) = 0`)
  .join(" AND ");
const reasonCode = action === "contain-all"
  ? "drill_containment"
  : action === "restore-all" || action.startsWith("resume-")
    ? "drill_restore"
    : "maintenance";
const update = action === "inspect" ? "" : `
UPDATE collection_controls
   SET enrollment_enabled = ${flagExpressions.enrollment},
       upload_registration_enabled = ${flagExpressions["upload-registration"]},
       processing_enabled = ${flagExpressions.processing},
       publication_enabled = ${flagExpressions.publication},
       control_state = CASE
         WHEN ${allEnabled} THEN 'operational'
         WHEN ${allDisabled} THEN 'contained'
         ELSE 'degraded'
       END,
       revision = revision + 1,
       reason_code = '${reasonCode}',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE singleton = 1;
`;
const sql = `${update}
SELECT schema_version,
       control_state,
       revision,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled
  FROM collection_controls
 WHERE singleton = 1;`;

const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(workerDirectory, "node_modules", ".bin", "wrangler");
const result = spawnSync(
  wrangler,
  [
    "d1", "execute", "USAGE_MONITOR_DB",
    "--local",
    ...(persistTo ? ["--persist-to", persistTo] : []),
    "--command", sql,
    "--json",
  ],
  {
    cwd: workerDirectory,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  },
);
if (result.status !== 0) {
  process.stderr.write("Collection control operation failed\n");
  process.exit(result.status ?? 1);
}

let row;
try {
  const parsed = JSON.parse(result.stdout);
  const statements = Array.isArray(parsed) ? parsed : [];
  const selectedResult = statements.findLast(
    (entry) => Array.isArray(entry?.results) && entry.results.length === 1,
  );
  row = selectedResult?.results?.[0];
} catch {
  row = null;
}
if (row?.schema_version !== "collection-controls-v0.1"
    || !["operational", "degraded", "contained"].includes(row.control_state)
    || !Number.isSafeInteger(row.revision)
    || row.revision < 1
    || ![
      row.enrollment_enabled,
      row.upload_registration_enabled,
      row.processing_enabled,
      row.publication_enabled,
    ].every((value) => value === 0 || value === 1)) {
  process.stderr.write("Collection control state was invalid\n");
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: row.schema_version,
  state: row.control_state,
  revision: row.revision,
  enrollment: row.enrollment_enabled === 1,
  uploadRegistration: row.upload_registration_enabled === 1,
  processing: row.processing_enabled === 1,
  publication: row.publication_enabled === 1,
  target: "local",
}, null, 2)}\n`);
