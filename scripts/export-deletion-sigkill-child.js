import { deleteLocalExport, recoverLocalExportDeletion } from "../src/export-deletion-executor.js";

const [
  , , action, workspaceDirectory, outputDirectory, confirmationToken, targetStage, targetRole = "", targetOrdinal = "",
] = process.argv;

const options = {
  workspaceDirectory,
  outputDirectory,
  async failpoint(stage, detail) {
    if (stage === targetStage
        && (!targetRole || detail?.role === targetRole)
        && (!targetOrdinal || detail?.ordinal === Number(targetOrdinal))) {
      process.kill(process.pid, "SIGKILL");
    }
  },
};

if (action === "delete") await deleteLocalExport({ ...options, confirmationToken });
else if (action === "recover") await recoverLocalExportDeletion(options);
else throw new Error("Unknown deletion crash-fixture action");

// The parent expects every selected failpoint to terminate this process.
process.exitCode = 23;
