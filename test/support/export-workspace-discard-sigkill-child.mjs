import { discardLocalExportWorkspace } from "../../src/export-workspace-discard-executor.js";

const [workspaceDirectory, confirmationToken] = process.argv.slice(2);
if (typeof workspaceDirectory !== "string" || typeof confirmationToken !== "string") process.exit(64);

await discardLocalExportWorkspace({
  workspaceDirectory,
  confirmationToken,
  async failpoint(stage) {
    if (stage !== "after_journal_commit") return;
    process.send?.({ type: "committed" });
    await new Promise(() => {});
  },
});
