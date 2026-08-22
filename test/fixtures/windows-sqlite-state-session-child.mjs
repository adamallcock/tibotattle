import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import {
  WINDOWS_SQLITE_STATE_FIXTURE_TABLE,
} from "./windows-sqlite-state-session-values.mjs";

const require = createRequire(import.meta.url);
const [mode, bindingPath, rootPath, rootIdentityJson, databaseName] = process.argv.slice(2);

const STATUS = Object.freeze({
  ready: "WINDOWS_SQLITE_STATE_CHILD_READY\n",
  released: "WINDOWS_SQLITE_STATE_CHILD_RELEASED\n",
  prepared: "WINDOWS_SQLITE_STATE_CHILD_PREPARED\n",
  failed: "WINDOWS_SQLITE_STATE_CHILD_FAILED\n",
});

function fixedExit(status, code = 1) {
  process.stdout.write(status, () => {
    process.exitCode = code;
  });
}

function loadInputs() {
  if ((mode !== "hold" && mode !== "crash" && mode !== "lease")
      || typeof bindingPath !== "string"
      || typeof rootPath !== "string"
      || typeof rootIdentityJson !== "string"
      || typeof databaseName !== "string") {
    throw new Error("invalid_input");
  }
  const binding = require(bindingPath);
  const rootIdentity = JSON.parse(rootIdentityJson);
  if (typeof binding?.acquireSqliteStateLease !== "function"
      || typeof binding?.releaseSqliteStateLease !== "function") {
    throw new Error("binding_unavailable");
  }
  return { binding, rootIdentity };
}

function configureDatabase(database) {
  database.enableDefensive(true);
  const journalMode = database.prepare("PRAGMA journal_mode=PERSIST;").get();
  if (String(journalMode?.journal_mode ?? "").toLowerCase() !== "persist") {
    throw new Error("journal_mode_refused");
  }
  database.exec("PRAGMA synchronous=FULL;");
  database.exec("PRAGMA foreign_keys=ON;");
  database.exec("PRAGMA trusted_schema=OFF;");
  database.exec("PRAGMA temp_store=MEMORY;");
  database.exec("PRAGMA mmap_size=0;");
}

function run() {
  const { binding, rootIdentity } = loadInputs();
  const lease = binding.acquireSqliteStateLease(rootPath, rootIdentity, databaseName);

  if (mode === "lease") {
    process.stdout.write(STATUS.ready, () => {
      process.stdin.once("data", () => {
        try {
          binding.releaseSqliteStateLease(lease.lease);
          process.stdout.write(STATUS.released, () => {
            process.exitCode = 0;
          });
        } catch {
          fixedExit(STATUS.failed);
        }
      });
      process.stdin.resume();
    });
    return;
  }

  let database;
  try {
    database = new DatabaseSync(join(rootPath, databaseName));
    configureDatabase(database);
    if (mode === "crash") {
      database.exec(
        `CREATE TABLE IF NOT EXISTS ${WINDOWS_SQLITE_STATE_FIXTURE_TABLE} (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);`,
      );
      database.exec("BEGIN IMMEDIATE;");
      database.prepare(
        `INSERT INTO ${WINDOWS_SQLITE_STATE_FIXTURE_TABLE}(marker) VALUES ('crash-marker');`,
      ).run();
      process.stdout.write(STATUS.prepared, () => {
        // Abrupt process termination is intentional: the open transaction and
        // persistent rollback journal are the recovery fixture. Do not close
        // SQLite or release the native lease before the process exits.
        process.exit(17);
      });
      return;
    }

    process.stdout.write(STATUS.ready, () => {
      process.stdin.once("data", () => {
        try {
          database.close();
          database = null;
          binding.releaseSqliteStateLease(lease.lease);
          process.stdout.write(STATUS.released, () => {
            process.exitCode = 0;
          });
        } catch {
          fixedExit(STATUS.failed);
        }
      });
      process.stdin.resume();
    });
  } catch {
    if (database !== undefined && database !== null) {
      try {
        database.close();
      } catch {
        // The fixed status below remains authoritative.
      }
    }
    try {
      binding.releaseSqliteStateLease(lease.lease);
    } catch {
      // Keep child diagnostics content-free even when cleanup also fails.
    }
    fixedExit(STATUS.failed);
  }
}

try {
  run();
} catch {
  fixedExit(STATUS.failed);
}
