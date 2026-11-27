import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAXIMUM_PACKAGES = 8;
const packageQuery = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "$locations = @(Appx\\Get-AppxPackage -Name 'OpenAI.Codex' -PackageTypeFilter Main"
    + " | Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' }"
    + " | Sort-Object { [version]$_.Version } -Descending"
    + " | Select-Object -First " + MAXIMUM_PACKAGES + " -ExpandProperty InstallLocation)",
  "[Console]::Out.Write((ConvertTo-Json -InputObject $locations -Compress))",
].join("\n");

function isAbsoluteDrivePath(value) {
  return typeof value === "string"
    && /^[a-z]:\\[^\\]/iu.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && win32.normalize(value) === value;
}

/** Return candidates for the currently registered Codex package, newest first. */
export async function readWindowsCodexPackageBinaries({
  environment = process.env,
  runFile = execFileAsync,
} = {}) {
  const systemRoot = environment.SystemRoot;
  if (!isAbsoluteDrivePath(systemRoot)) return [];

  const system32 = win32.join(systemRoot, "System32");
  const powerShell = win32.join(system32, "WindowsPowerShell", "v1.0");
  try {
    const { stdout } = await runFile(win32.join(powerShell, "powershell.exe"), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(packageQuery, "utf16le").toString("base64"),
    ], {
      cwd: powerShell,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATH: [system32, systemRoot].join(";"),
        PSModulePath: win32.join(powerShell, "Modules"),
      },
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 5_000,
      windowsHide: true,
    });
    const locations = JSON.parse(stdout);
    if (!Array.isArray(locations) || locations.length > MAXIMUM_PACKAGES) return [];
    return locations.filter(isAbsoluteDrivePath).map((location) => (
      win32.join(location, "app", "resources", "codex.exe")
    ));
  } catch {
    // PowerShell or package registration can be unavailable. Leave CLI
    // discovery to the caller without exposing a private path or error text.
    return [];
  }
}
