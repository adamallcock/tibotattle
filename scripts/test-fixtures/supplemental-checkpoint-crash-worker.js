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

function selectedSource(kind) {
  if (kind === "collector") {
    return {
      collectorPath: requiredEnvironment("SUPPLEMENTAL_COLLECTOR_PATH"),
      collectorCandidatesPerBatch: 1,
      checkpointStage: "after_collector_checkpoint_batch",
    };
  }
  if (kind === "claude") {
    return {
      claudeStateDirectory: requiredEnvironment("SUPPLEMENTAL_CLAUDE_STATE_DIRECTORY"),
      claudeRecordsPerBatch: 1,
      checkpointStage: "after_claude_status_checkpoint_batch",
    };
  }
  if (kind === "claude-transcript") {
    return {
      claudeProjectsDirectory: requiredEnvironment("SUPPLEMENTAL_CLAUDE_PROJECTS_DIRECTORY"),
      claudeTranscriptRecordsPerBatch: 1,
      checkpointStage: "after_claude_transcript_checkpoint_batch",
    };
  }
  throw new Error("Unknown supplemental checkpoint source");
}

const mode = requiredEnvironment("SUPPLEMENTAL_WORKER_MODE");
const kind = requiredEnvironment("SUPPLEMENTAL_SOURCE_KIND");
const selected = selectedSource(kind);
const { checkpointStage, ...sourceOptions } = selected;
const common = {
  directory: requiredEnvironment("SUPPLEMENTAL_WORKSPACE_DIRECTORY"),
  codexHome: requiredEnvironment("SUPPLEMENTAL_CODEX_HOME"),
  secret: Buffer.from(requiredEnvironment("SUPPLEMENTAL_SECRET_HEX"), "hex"),
};

if (mode === "create-and-await-kill") {
  const crashMarker = requiredEnvironment("SUPPLEMENTAL_CRASH_MARKER");
  await createLocalExportWorkspace({
    ...common,
    ...sourceOptions,
    startAt: requiredEnvironment("SUPPLEMENTAL_START_AT"),
    endAt: requiredEnvironment("SUPPLEMENTAL_END_AT"),
    createdAt: requiredEnvironment("SUPPLEMENTAL_CREATED_AT"),
    async failpoint(stage) {
      if (stage !== checkpointStage || await markerWasAlreadyWritten(crashMarker)) return;
      await writeFile(crashMarker, "supplemental checkpoint crash injected\n", { flag: "wx", mode: 0o600 });
      // The acknowledgement follows the SQLite commit and lets the parent
      // terminate this process without running JavaScript cleanup paths.
      await new Promise((resolve, reject) => {
        process.stdout.write("supplemental_checkpoint_committed\n", (error) => error ? reject(error) : resolve());
      });
      await new Promise(() => {});
    },
  });
  process.stdout.write("unexpected_complete\n");
} else if (mode === "resume") {
  const result = await resumeLocalExportWorkspace({ ...common, ...sourceOptions });
  process.stdout.write(`${JSON.stringify({ scanComplete: result.status.scanComplete, recordCounts: result.status.recordCounts })}\n`);
} else {
  throw new Error("Unknown supplemental checkpoint worker mode");
}
