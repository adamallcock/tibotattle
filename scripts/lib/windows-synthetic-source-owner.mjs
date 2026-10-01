import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

const trustedFailures = new WeakSet();

function fail(category) {
  const error = new Error(`synthetic_owner_${category}`);
  error.code = `synthetic_owner_${category}`;
  trustedFailures.add(error);
  throw error;
}

export function classifyWindowsSyntheticSourceOwnerFailure(error) {
  return error && trustedFailures.has(error) ? error.code : null;
}

const MAX_SYNTHETIC_SOURCE_BYTES = 1_048_576;

// Create the fixture while the isolated process token has the desired owner.
// A post-create owner change can rewrite the file's access descriptor, whereas
// ordinary creation retains the directory's inherited/default DACL.
export function createWindowsSyntheticOwnedSource(path, contents, {
  run = spawnSync, environment = process.env,
} = {}) {
  if (typeof path !== 'string' || !win32.isAbsolute(path) || path.includes('\0')) {
    fail('create_invalid_path');
  }
  if (typeof contents !== 'string') fail('create_invalid_contents');
  const input = Buffer.from(contents, 'utf8');
  if (input.length > MAX_SYNTHETIC_SOURCE_BYTES) fail('create_input_too_large');

  const childEnvironment = {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    TIBOTATTLE_SYNTHETIC_SOURCE_FILE: path,
    TIBOTATTLE_SYNTHETIC_SOURCE_LENGTH: String(input.length),
  };
  let result;
  try {
    result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $stage = 41
      try {
        $path = $env:TIBOTATTLE_SYNTHETIC_SOURCE_FILE
        $expectedLength = [int64]$env:TIBOTATTLE_SYNTHETIC_SOURCE_LENGTH
        $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($null -eq $owner) { exit 41 }
        $stage = 42
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TiboTattleSyntheticSourceCreator {
  private const uint TokenQuery = 0x0008;
  private const uint TokenAdjustDefault = 0x0080;
  private const int TokenOwner = 4;
  private const int FileObject = 1;
  private const uint DaclSecurityInformation = 0x00000004;

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetCurrentProcess();

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess,
    out IntPtr tokenHandle);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool SetTokenInformation(IntPtr tokenHandle, int tokenInformationClass,
    IntPtr tokenInformation, uint tokenInformationLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("advapi32.dll", EntryPoint = "GetNamedSecurityInfoW",
    CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  public static extern uint GetNamedSecurityInfo(string objectName, int objectType,
    uint securityInfo, out IntPtr owner, out IntPtr group, out IntPtr dacl,
    out IntPtr sacl, out IntPtr securityDescriptor);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool GetSecurityDescriptorDacl(IntPtr securityDescriptor,
    out bool daclPresent, out IntPtr dacl, out bool daclDefaulted);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr LocalFree(IntPtr handle);

  public static bool SetCurrentTokenOwner(byte[] sid) {
    if (sid == null || sid.Length == 0) return false;
    IntPtr token = IntPtr.Zero;
    IntPtr sidPointer = IntPtr.Zero;
    IntPtr ownerPointer = IntPtr.Zero;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenAdjustDefault, out token)) return false;
      sidPointer = Marshal.AllocHGlobal(sid.Length);
      Marshal.Copy(sid, 0, sidPointer, sid.Length);
      ownerPointer = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(ownerPointer, sidPointer);
      return SetTokenInformation(token, TokenOwner, ownerPointer, (uint)IntPtr.Size);
    } finally {
      if (ownerPointer != IntPtr.Zero) Marshal.FreeHGlobal(ownerPointer);
      if (sidPointer != IntPtr.Zero) Marshal.FreeHGlobal(sidPointer);
      if (token != IntPtr.Zero) CloseHandle(token);
    }
  }

  public static bool HasNonNullDacl(string path) {
    IntPtr owner;
    IntPtr group;
    IntPtr dacl;
    IntPtr sacl;
    IntPtr securityDescriptor;
    var status = GetNamedSecurityInfo(path, FileObject, DaclSecurityInformation,
      out owner, out group, out dacl, out sacl, out securityDescriptor);
    if (status != 0 || securityDescriptor == IntPtr.Zero) return false;
    try {
      bool present;
      bool defaulted;
      IntPtr descriptorDacl;
      if (!GetSecurityDescriptorDacl(securityDescriptor, out present, out descriptorDacl,
        out defaulted)) return false;
      return present && descriptorDacl != IntPtr.Zero;
    } finally {
      LocalFree(securityDescriptor);
    }
  }
}
'@
        $ownerBytes = New-Object byte[] ($owner.BinaryLength)
        $owner.GetBinaryForm($ownerBytes, 0)
        $stage = 43
        if (-not [TiboTattleSyntheticSourceCreator]::SetCurrentTokenOwner($ownerBytes)) { exit 43 }

        $stage = 44
        $inputStream = [Console]::OpenStandardInput()
        $fileStream = $null
        $buffer = New-Object byte[] 8192
        $written = [int64]0
        try {
          $fileStream = [System.IO.FileStream]::new(
            $path,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::Read,
            8192,
            [System.IO.FileOptions]::SequentialScan)
          while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $written += $read
            if ($written -gt $expectedLength) { exit 45 }
            $fileStream.Write($buffer, 0, $read)
          }
          if ($written -ne $expectedLength) { exit 45 }
        } catch {
          exit 44
        } finally {
          if ($null -ne $fileStream) {
            try { $fileStream.Dispose() } catch { exit 46 }
          }
          if ($null -ne $inputStream) {
            try { $inputStream.Dispose() } catch { exit 46 }
          }
        }

        $stage = 47
        $acl = Get-Acl -LiteralPath $path
        $actualOwner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
        if ($null -eq $actualOwner) { exit 48 }
        if ($actualOwner.Value -ne $owner.Value) { exit 49 }

        $stage = 50
        if (-not [TiboTattleSyntheticSourceCreator]::HasNonNullDacl($path)) { exit 50 }

        $stage = 51
        $length = (Get-Item -LiteralPath $path).Length
        if ([int64]$length -ne $expectedLength) { exit 51 }
        exit 0
      } catch { exit $stage }
    `], {
      encoding: 'utf8', env: childEnvironment, input,
      windowsHide: true, timeout: 10_000, maxBuffer: 4_096,
    });
  } catch {
    fail('create_launch_failed');
  }
  const category = result?.error
    ? result.error.code === 'ETIMEDOUT' ? 'create_timed_out' : 'create_launch_failed'
    : ({
      41: 'create_identity_failed', 42: 'create_native_setup_failed',
      43: 'create_token_owner_failed', 44: 'create_file_write_failed',
      45: 'create_input_length_failed', 46: 'create_close_failed',
      47: 'create_owner_read_failed', 48: 'create_owner_missing',
      49: 'create_owner_mismatch', 50: 'create_dacl_failed',
      51: 'create_content_length_failed',
    }[result?.status] ?? 'create_unexpected_exit');
  if (result?.status !== 0 || result?.error || result.stdout?.length || result.stderr?.length) {
    fail(category);
  }
}
