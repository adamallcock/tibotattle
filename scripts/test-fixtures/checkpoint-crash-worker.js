import { access, writeFile } from "node:fs/promises";
import {
  createLocalExportWorkspace,
  resumeLocalExportWorkspace,
} from "../../src/export-set-controller.js";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing worker configuration: ${name}`);
  return value;
}

async function markerWasAlreadyWritten(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const mode = requiredEnvironment("CHECKPOINT_WORKER_MODE");
const directory = requiredEnvironment("CHECKPOINT_WORKSPACE_DIRECTORY");
const codexHome = requiredEnvironment("CHECKPOINT_CODEX_HOME");
const secret = Buffer.from(requiredEnvironment("CHECKPOINT_SECRET_HEX"), "hex");
const common = { directory, codexHome, secret };

if (mode === "create-and-await-kill") {
  const crashMarker = requiredEnvironment("CHECKPOINT_CRASH_MARKER");
  await createLocalExportWorkspace({
    ...common,
    startAt: requiredEnvironment("CHECKPOINT_START_AT"),
    endAt: requiredEnvironment("CHECKPOINT_END_AT"),
    createdAt: requiredEnvironment("CHECKPOINT_CREATED_AT"),
    checkpointLinesPerBatch: 128,
    async failpoint(stage) {
      if (stage !== "after_record_batch" || await markerWasAlreadyWritten(crashMarker)) return;
      await writeFile(crashMarker, "checkpoint crash injected\n", { flag: "wx", mode: 0o600 });
      // Tell the parent only after commitSourceBatch has returned and the
      // durable failpoint has been reached. The parent owns termination so no
      // JavaScript finally block or native process-exit cleanup can run.
      await new Promise((resolve, reject) => {
        process.stdout.write("checkpoint_committed\n", (error) => error ? reject(error) : resolve());
      });
      await new Promise(() => {});
    },
  });
  process.stdout.write("unexpected_complete\n");
} else if (mode === "resume") {
  const result = await resumeLocalExportWorkspace({ ...common, checkpointLinesPerBatch: 128 });
  process.stdout.write(`${JSON.stringify({ scanComplete: result.status.scanComplete, recordCounts: result.status.recordCounts })}\n`);
} else {
  throw new Error("Unknown checkpoint worker mode");
}
