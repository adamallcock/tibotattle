import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

const FAILURE = Object.freeze({
  31: 'current_owner_read_failed', 32: 'acl_before_read_failed',
  33: 'acl_before_snapshot_failed', 34: 'owner_tool_invocation_failed',
  35: 'owner_tool_exit_failed', 36: 'acl_after_read_failed',
  37: 'owner_after_read_failed', 38: 'owner_readback_mismatch',
  39: 'acl_after_snapshot_failed', 40: 'dacl_changed',
});

// Hosted Windows tokens can create a disposable source with a group owner.
// Normalize only that fixture to the current user; preserve its inherited
// DACL and never expose the file path, SID, or child output in a failure.
export function ensureWindowsSyntheticSourceOwner(path, {
  run = spawnSync, environment = process.env,
} = {}) {
  if (typeof path !== 'string' || !win32.isAbsolute(path) || path.includes('\0')) {
    throw new Error('synthetic_owner_invalid_path');
  }
  const childEnvironment = {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    TIBOTATTLE_SYNTHETIC_SOURCE_FILE: path,
  };
  let result;
  try {
    result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $stage = 31
      try {
        $path = $env:TIBOTATTLE_SYNTHETIC_SOURCE_FILE
        $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $stage = 32
        $acl = Get-Acl -LiteralPath $path
        $stage = 33
        $access = [System.Security.AccessControl.AccessControlSections]::Access
        $before = $acl.GetSecurityDescriptorSddlForm($access)
        $stage = 34
        $ownerTool = Join-Path $env:SystemRoot 'System32/icacls.exe'
        & $ownerTool $path '/setowner' ('*' + $owner.Value) '/Q' *> $null
        if ($LASTEXITCODE -ne 0) { exit 35 }
        $stage = 36
        $after = Get-Acl -LiteralPath $path
        $stage = 37
        $actualOwner = $after.GetOwner([System.Security.Principal.SecurityIdentifier])
        if ($actualOwner.Value -ne $owner.Value) { exit 38 }
        $stage = 39
        $afterAccess = $after.GetSecurityDescriptorSddlForm($access)
        if ($afterAccess -cne $before) { exit 40 }
        exit 0
      } catch { exit $stage }
    `], {
      encoding: 'utf8', env: childEnvironment, windowsHide: true,
      timeout: 10_000, maxBuffer: 4_096,
    });
  } catch {
    throw new Error('synthetic_owner_setup_launch_failed');
  }
  const category = result?.error
    ? result.error.code === 'ETIMEDOUT' ? 'setup_timed_out' : 'setup_launch_failed'
    : FAILURE[result?.status] ?? 'unexpected_setup_exit';
  if (result?.status !== 0 || result?.error || result.stdout?.length || result.stderr?.length) {
    throw new Error(`synthetic_owner_${category}`);
  }
}
