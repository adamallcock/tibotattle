param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$InstallerSha256,
  [Parameter(Mandatory=$true)][string]$SourceRevision,
  [Parameter(Mandatory=$true)][string]$Receipt
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $InstallerSha256 -cnotmatch '^[0-9a-f]{64}$' -or $SourceRevision -cnotmatch '^[0-9a-f]{40}$') { throw 'DIAGNOSTIC_HOST_OR_IDENTITY_INVALID' }
$installerItem = Get-Item -LiteralPath $Installer -Force
if ($installerItem.PSIsContainer -or ($installerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $InstallerSha256) { throw 'DIAGNOSTIC_INSTALLER_INVALID' }
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -cne 'Adam Allcock' -or $null -eq $signature.TimeStamperCertificate) { throw 'DIAGNOSTIC_SIGNATURE_INVALID' }
if (Test-Path -LiteralPath $Receipt) { throw 'DIAGNOSTIC_RECEIPT_EXISTS' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class TiboInstallerWindowProbe {
 public delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr arg);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr arg);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
 static string Text(IntPtr hwnd) { var s=new StringBuilder(4096);GetWindowText(hwnd,s,4096);return s.ToString(); }
 public static string[] Classify(int[] pids) {
  var selected=new HashSet<int>(pids);var results=new HashSet<string>();
  Action<IntPtr> classify=hwnd=> { string t=Text(hwnd).ToLowerInvariant();
   if(t.Contains("error launching installer"))results.Add("launch_error");
   if(t.Contains("integrity check"))results.Add("integrity_check");
   if(t.Contains("already running")||t.Contains("is running")||t.Contains("please close"))results.Add("running_app_prompt");
   if(t.Contains("access denied")||t.Contains("access is denied"))results.Add("access_denied");
   if(t.Contains("administrator")||t.Contains("elevation"))results.Add("elevation_prompt");
   if(t.Contains("smart screen")||t.Contains("smartscreen")||t.Contains("windows protected"))results.Add("windows_protection");
   if(t.Contains("error")||t.Contains("failed"))results.Add("error_text");
   if(t.Contains("install")||t.Contains("tibotattle"))results.Add("installer_text");
  };
  EnumWindows((hwnd,arg)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(selected.Contains((int)pid)){results.Add("owned_window_present");classify(hwnd);EnumChildWindows(hwnd,(child,a)=>{classify(child);return true;},IntPtr.Zero);}return true;},IntPtr.Zero);
  return new List<string>(results).ToArray();
 }
}
'@
$ownedRoot = Join-Path $env:RUNNER_TEMP ('tibotattle-installer-diagnostic-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $ownedRoot
$installRoot = Join-Path $ownedRoot 'app'
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $installerItem.FullName
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.ArgumentList.Add('/S')
$info.ArgumentList.Add('/D=' + $installRoot)
$info.Environment.Clear()
# Match the maintained NSIS lifecycle child environment exactly.
foreach ($key in @('SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','OS','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','ProgramData','ProgramFiles','ProgramW6432','CommonProgramFiles','CommonProgramW6432')) {
 $value = [Environment]::GetEnvironmentVariable($key)
 if (-not [string]::IsNullOrEmpty($value)) { $info.Environment[$key] = $value }
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$result = [ordered]@{schemaVersion='tibotattle-windows-installer-diagnostic-v1';sourceRevision=$SourceRevision;installerSha256=$InstallerSha256;signedInstallerVerified=$true;productionReady=$false;installedJourneyQualified=$false;samples=@();exitCode=$null;qualificationDeadlineExceeded=$false;diagnosticDeadlineExceeded=$false;installedExecutablePresent=$false;errorCode=$null}
try {
 if (-not $process.Start()) { throw 'DIAGNOSTIC_START_FAILED' }
 $watch = [Diagnostics.Stopwatch]::StartNew()
 do {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $ids = [Collections.Generic.HashSet[int]]::new();$null=$ids.Add($process.Id)
  do { $changed=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$changed=$true}} } while($changed)
  $owned = @($all | Where-Object {$ids.Contains([int]$_.ProcessId)})
  $names=@($owned|ForEach-Object {switch -Regex ($_.Name) {'^TiboTattle-.*\.exe$' {'installer';break};'^TiboTattle\.exe$' {'application';break};'^.*\.tmp$' {'installer_clone';break};'^consent\.exe$' {'elevation';break};'^WerFault\.exe$' {'crash_handler';break};default {'other'}}}|Sort-Object -Unique)
  $elapsed=[int]$watch.Elapsed.TotalSeconds
  $result.samples += [ordered]@{elapsedSeconds=$elapsed;parentExited=$process.HasExited;ownedProcessCount=$owned.Count;processClasses=$names;windowClasses=@([TiboInstallerWindowProbe]::Classify([int[]]@($ids)));installedExecutablePresent=(Test-Path -LiteralPath (Join-Path $installRoot 'TiboTattle.exe'))}
  if($elapsed -ge 180 -and -not $process.HasExited){$result.qualificationDeadlineExceeded=$true}
  if($process.HasExited){$result.exitCode=$process.ExitCode;break}
  if($elapsed -ge 240){$result.diagnosticDeadlineExceeded=$true;break}
  Start-Sleep -Seconds 15
 } while($true)
 $result.installedExecutablePresent=Test-Path -LiteralPath (Join-Path $installRoot 'TiboTattle.exe')
} catch { $result.errorCode='DIAGNOSTIC_PROBE_FAILED' }
finally {
 # No uninstaller or deletion runs after an unsettled installation. The owned
 # disposable hosted VM is reclaimed by GitHub; no user installation is touched.
 $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Receipt -Encoding utf8NoBOM
 Write-Host 'WINDOWS_INSTALLER_DIAGNOSTIC_RECORDED'
}
if($null -ne $result.errorCode){exit 1}

exit 0
