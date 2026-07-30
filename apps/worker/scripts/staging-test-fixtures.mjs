import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

export const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const checkedInConfig = parse(
  await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8"),
);

export function provisionedConfig() {
  const config = structuredClone(checkedInConfig);
  config.env.staging.d1_databases[0].database_id =
    "12345678-1234-4234-8234-1234567890ab";
  config.env.staging.d1_databases[1].database_id =
    "abcdefab-cdef-4def-8def-abcdefabcdef";
  return config;
}

export function successSpawn(config, calls) {
  return (_command, args) => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined === "whoami") return { status: 0, stdout: "authenticated", stderr: "" };
    if (joined === "d1 list --json") {
      return {
        status: 0,
        stdout: JSON.stringify(config.env.staging.d1_databases.map((entry) => ({
          uuid: entry.database_id,
          name: entry.database_name,
        }))),
        stderr: "",
      };
    }
    if (joined === "r2 bucket list") {
      return { status: 0, stdout: "bucket list", stderr: "" };
    }
    if (joined.startsWith("r2 bucket info ")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          name: config.env.staging.r2_buckets[0].bucket_name,
        }),
        stderr: "",
      };
    }
    if (joined === "secret list --env staging --format json") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { name: "ENVELOPE_PRIVATE_JWK", type: "secret_text" },
          { name: "ENVELOPE_PUBLIC_JWK", type: "secret_text" },
        ]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 migrations list ")) {
      return { status: 0, stdout: "No migrations to apply!", stderr: "" };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")
        && joined.includes("sqlite_master")) {
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [{
            admission_table: 1,
            admission_guard: 1,
            admission_counter: 1,
            quarantine_reconciliation: 1,
            lifecycle_status: 1,
          }],
        }]),
        stderr: "",
      };
    }
    if (joined.startsWith("d1 execute USAGE_MONITOR_DB ")) {
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [{
            schema_version: "collection-controls-v0.1",
            control_state: "contained",
            enrollment_enabled: 0,
            upload_registration_enabled: 0,
            processing_enabled: 0,
            publication_enabled: 0,
          }],
        }]),
        stderr: "",
      };
    }
    throw new Error(`Unexpected fake Wrangler call: ${joined}`);
  };
}
