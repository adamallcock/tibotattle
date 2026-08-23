import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, run } from "../src/cli.js";

const START_AT = "2026-07-24T11:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";

function tokenUsage(input) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 10,
    reasoning_output_tokens: 2,
    total_tokens: input + 10,
  };
}

async function pluralCommandFixture() {
  const base = await mkdtemp(join(tmpdir(), "usage-monitor-plural-cli-"));
  const roots = [join(base, "codex-one"), join(base, "codex-two")];
  const activityFile = join(base, "activity.jsonl");
  await writeFile(activityFile, "", { mode: 0o600 });
  for (const [index, codexHome] of roots.entries()) {
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    await mkdir(join(codexHome, "archived_sessions"), {
      recursive: true,
      mode: 0o700,
    });
    const minute = String(index).padStart(2, "0");
    const timestamp = `2026-07-24T12:0${index}:00.000Z`;
    const total = tokenUsage(100 + index);
    const records = [
      {
        timestamp,
        type: "session_meta",
        payload: {
          id: index === 0
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
          origin: "terminal",
        },
      },
      {
        timestamp,
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: "{}",
          call_id: `call-${index}`,
        },
      },
      {
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: total,
            last_token_usage: total,
          },
          rate_limits: {
            limit_id: "codex",
            plan_type: "pro",
            primary: {
              used_percent: index + 1,
              window_minutes: 300,
              resets_at: 1_784_912_400,
            },
          },
        },
      },
    ];
    await writeFile(
      join(
        sessions,
        `rollout-2026-07-24T12-${minute}-00-root-${index}.jsonl`,
      ),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      { mode: 0o600 },
    );
  }
  return { activityFile, base, roots };
}

function injectedIdentity() {
  const identityOptions = Object.freeze({ source: "multi-root-cli-test" });
  let leases = 0;
  return {
    dependencies: {
      selectParticipantIdentity({ explicitSecretFile }) {
        assert.equal(explicitSecretFile, null);
        return {
          mode: "owner_file_override",
          identityOptions,
        };
      },
      async withIdentityLease(options, callback) {
        assert.equal(options, identityOptions);
        const secret = Buffer.alloc(32, 71);
        leases += 1;
        try {
          return await callback({ secret });
        } finally {
          secret.fill(0);
        }
      },
    },
    leases: () => leases,
  };
}

async function captureConsole(callback) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.map(String).join(" "));
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

test("CLI parsing preserves bounded repeated activity roots and singleton compatibility", () => {
  const roots = [resolve("codex-one"), resolve("codex-two")];
  const plural = parseArgs([
    "transitions",
    "--codex-home", roots[0],
    "--codex-home", roots[1],
  ]);
  assert.deepEqual(plural.codexHomes, roots);
  assert.equal(plural.codexHome, null);
  assert.equal(plural.primaryCodexHome, null);

  const explicitPrimary = parseArgs([
    "transitions",
    "--codex-home", roots[0],
    "--codex-home", roots[1],
    "--primary-codex-home", roots[1],
  ]);
  assert.deepEqual(explicitPrimary.codexHomes, roots);
  assert.equal(explicitPrimary.codexHome, null);
  assert.equal(explicitPrimary.primaryCodexHome, roots[1]);

  const singleton = parseArgs(["collect-once", "--codex-home", roots[0]]);
  assert.deepEqual(singleton.codexHomes, [roots[0]]);
  assert.equal(singleton.codexHome, roots[0]);
  assert.equal(singleton.primaryCodexHome, roots[0]);

  assert.throws(
    () => parseArgs([
      "transitions",
      "--codex-home", roots[0],
      "--codex-home", roots[0],
    ]),
    /paths must be unique/u,
  );
  assert.throws(
    () => parseArgs([
      "transitions",
      ...Array.from(
        { length: 9 },
        (_, index) => ["--codex-home", resolve(`codex-${index}`)],
      ).flat(),
    ]),
    /at most eight/u,
  );
});

test("legacy collector commands receive one selected root and reject plural roots explicitly", async () => {
  const roots = [resolve("codex-one"), resolve("codex-two")];
  let collectorOptions = null;
  const originalLog = console.log;
  console.log = () => {};
  try {
    await run(
      ["collect-once", "--codex-home", roots[0]],
      {
        selectAccountObservationSecret: () => ({
          loadAccountObservationSecret: null,
        }),
        runCollectorOnceCommand: async (options) => {
          collectorOptions = options;
          return {
            rolloutRecordsWritten: 0,
            refresh: {
              attempted: false,
              recordWritten: false,
              errorCode: null,
            },
            stateFile: options.stateFile,
          };
        },
      },
    );
    assert.equal(collectorOptions.codexHome, roots[0]);

    await assert.rejects(
      run([
        "collect-once",
        "--codex-home", roots[0],
        "--codex-home", roots[1],
        "--primary-codex-home", roots[0],
      ], {
        runCollectorOnceCommand: async () => {
          throw new Error("collector must not run");
        },
      }),
      /collect-once does not support multiple --codex-home activity roots/u,
    );
  } finally {
    console.log = originalLog;
  }
});

test("activity-only CLI commands admit plural roots without requiring a primary", async () => {
  const roots = [resolve("codex-one"), resolve("codex-two")];
  await assert.rejects(
    run([
      "transitions",
      "--codex-home", roots[0],
      "--codex-home", roots[1],
    ]),
    /transitions requires --since and --until/u,
  );
});

test("activity CLI call sites forward plural roots without a scalar alias", async (t) => {
  const fixture = await pluralCommandFixture();
  t.after(() => rm(fixture.base, { recursive: true, force: true }));
  const identity = injectedIdentity();
  const rootArgs = fixture.roots.flatMap((root) => ["--codex-home", root]);

  // The shared discovery boundary rejects simultaneous codexHome+codexHomes.
  // Successful commands with two independently observable sources therefore
  // prove both that the plural list arrived and that no scalar alias followed.

  await t.test("transitions", async () => {
    const outputFile = join(fixture.base, "transitions.json");
    await captureConsole(() => run([
      "transitions",
      "--since", START_AT,
      "--until", END_AT,
      ...rootArgs,
      "--offline",
      "--output", outputFile,
      "--audit-file", join(fixture.base, "transitions.md"),
    ]));
    const dataset = JSON.parse(await readFile(outputFile, "utf8"));
    assert.equal(dataset.summary.usageEvents, 2);
    assert.equal(dataset.summary.transitions, 1);
  });

  await t.test("tools", async () => {
    const outputFile = join(fixture.base, "tools.json");
    await captureConsole(() => run([
      "tools",
      "--since", START_AT,
      "--until", END_AT,
      ...rootArgs,
      "--output", outputFile,
      "--report-file", join(fixture.base, "tools.md"),
    ]));
    const analysis = JSON.parse(await readFile(outputFile, "utf8"));
    assert.equal(analysis.summary.totalClientEventCount, 2);
    assert.equal(analysis.localObservationDiagnostics.toolCallsByClass.local_shell, 2);
  });

  await t.test("inspect-export", async () => {
    const output = await captureConsole(() => run([
      "inspect-export",
      "--since", START_AT,
      "--until", END_AT,
      ...rootArgs,
      "--activity-file", fixture.activityFile,
    ], identity.dependencies));
    assert.match(output, /^Usage events: 2$/mu);
    assert.match(output, /^Source files scanned: 2$/mu);
  });

  await t.test("export-local", async () => {
    const outputFile = join(fixture.base, "bundle.json");
    await captureConsole(() => run([
      "export-local",
      "--since", START_AT,
      "--until", END_AT,
      ...rootArgs,
      "--activity-file", fixture.activityFile,
      "--output", outputFile,
      "--receipt", join(fixture.base, "bundle.receipt.json"),
    ], identity.dependencies));
    const bundle = JSON.parse(await readFile(outputFile, "utf8"));
    assert.equal(bundle.recordCounts.usageEvents, 2);
    assert.equal(bundle.diagnostics.sourceFilesScanned, 2);
  });

  await t.test("export-set", async () => {
    const outputDirectory = join(fixture.base, "export-set");
    await captureConsole(() => run([
      "export-set",
      "--since", START_AT,
      "--until", END_AT,
      ...rootArgs,
      "--activity-file", fixture.activityFile,
      "--workspace", join(fixture.base, "workspace"),
      "--directory", outputDirectory,
    ], identity.dependencies));
    const manifest = JSON.parse(await readFile(
      join(outputDirectory, "export-set-manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.totals.recordCounts.usageEvents, 2);
    assert.equal(manifest.sourcePlan.sourceFiles, 2);
  });

  assert.equal(identity.leases(), 3);
});
