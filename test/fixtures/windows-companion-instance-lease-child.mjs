import { createWindowsCompanionInstanceLeaseContext } from "../../src/platform/windows-companion-instance-lease.js";

const mode = process.argv[2] ?? "once";
const context = createWindowsCompanionInstanceLeaseContext();

try {
  const lease = context.acquire();
  if (mode === "hold") {
    process.stdout.write("WINDOWS_COMPANION_INSTANCE_CHILD_ACQUIRED\n");
    setInterval(() => lease, 1_000);
  } else if (mode === "crash") {
    process.stdout.write("WINDOWS_COMPANION_INSTANCE_CHILD_ACQUIRED\n", () => {
      process.exit(17);
    });
  } else {
    process.stdout.write("WINDOWS_COMPANION_INSTANCE_CHILD_ACQUIRED\n");
    context.release(lease);
  }
} catch (error) {
  if (error?.code === "windows_companion_instance_lease_contended") {
    process.stdout.write("WINDOWS_COMPANION_INSTANCE_CHILD_CONTENDED\n");
    process.exitCode = 2;
  } else {
    process.stdout.write("WINDOWS_COMPANION_INSTANCE_CHILD_FAILED\n");
    process.exitCode = 1;
  }
}
