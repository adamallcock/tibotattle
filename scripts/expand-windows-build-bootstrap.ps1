param([Parameter(Mandatory=$true)][string]$BootstrapRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# PowerShell and .NET come from the trusted hosted runner. No downloaded binary
# is launched until the reviewed archive digest and every extraction path pass.
if ($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN -or $env:ACTIONS_ID_TOKEN_REQUEST_URL) { throw 'WINDOWS_BUILD_MUST_NOT_HAVE_OIDC' }
$policyPath = Join-Path $PSScriptRoot '../config/windows-build-bootstrap.json'
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
if ($policy.schemaVersion -cne 'tibotattle-windows-build-bootstrap-v1'
    -or $policy.node.version -cne '26.2.0'
    -or $policy.node.archiveRoot -cne 'node-v26.2.0-win-x64'
    -or $policy.node.archiveSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'WINDOWS_BUILD_NODE_POLICY_INVALID' }
$root = [IO.Path]::GetFullPath($BootstrapRoot)
$archivePath = Join-Path $root 'node.zip'
$destination = Join-Path $root 'node'
if (Test-Path -LiteralPath $destination) { throw 'WINDOWS_BUILD_NODE_OUTPUT_EXISTS' }
$archiveInfo = Get-Item -LiteralPath $archivePath -Force
if ($archiveInfo.PSIsContainer -or ($archiveInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)
    -or $archiveInfo.Length -ne $policy.node.archiveBytes) { throw 'WINDOWS_BUILD_NODE_ARCHIVE_INVALID' }
$archiveStream = [IO.File]::Open($archivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = [Convert]::ToHexString($sha.ComputeHash($archiveStream)).ToLowerInvariant() } finally { $sha.Dispose() }
  if ($digest -cne $policy.node.archiveSha256) { throw 'WINDOWS_BUILD_NODE_ARCHIVE_DIGEST_MISMATCH' }
  $archiveStream.Position = 0
  $zip = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    $paths = [Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::OrdinalIgnoreCase)
    $entries = @()
    [long]$expandedBytes = 0
    if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 8192) { throw 'WINDOWS_BUILD_NODE_ARCHIVE_ENTRY_LIMIT' }
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      $isDirectory = $name.EndsWith('/')
      $relative = $name.TrimEnd('/')
      if ($relative.Length -gt 512 -or $relative.Contains('\') -or $relative.StartsWith('/')
          -or -not ($relative -ceq $policy.node.archiveRoot -or $relative.StartsWith($policy.node.archiveRoot + '/', [StringComparison]::Ordinal))) {
        throw 'WINDOWS_BUILD_NODE_ARCHIVE_PATH_INVALID'
      }
      foreach ($part in $relative.Split('/')) {
        if ($part -cin @('', '.', '..') -or $part -match '[\x00-\x1f<>:"|?*]' -or $part -match '[. ]$'
            -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'WINDOWS_BUILD_NODE_ARCHIVE_PATH_INVALID' }
      }
      if ($paths.ContainsKey($relative)) { throw 'WINDOWS_BUILD_NODE_ARCHIVE_DUPLICATE_PATH' }
      $paths.Add($relative, $isDirectory)
      $kind = ($entry.ExternalAttributes -shr 16) -band 0xf000
      if ($kind -notin @(0, 0x4000, 0x8000) -or ($entry.ExternalAttributes -band 0x400)
          -or ($kind -eq 0x4000 -and -not $isDirectory) -or ($kind -eq 0x8000 -and $isDirectory)
          -or $entry.Length -lt 0 -or $entry.Length -gt 268435456 -or ($isDirectory -and $entry.Length -ne 0)) {
        throw 'WINDOWS_BUILD_NODE_ARCHIVE_ENTRY_INVALID'
      }
      $expandedBytes += $entry.Length
      if ($expandedBytes -gt 536870912) { throw 'WINDOWS_BUILD_NODE_ARCHIVE_SIZE_LIMIT' }
      $entries += @{ entry = $entry; relative = $relative; directory = $isDirectory }
    }
    foreach ($item in $entries) {
      $parent = $item.relative
      while ($parent.Contains('/')) {
        $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
        if ($paths.ContainsKey($parent) -and -not $paths[$parent]) { throw 'WINDOWS_BUILD_NODE_ARCHIVE_PATH_COLLISION' }
      }
    }
    if (-not $paths.ContainsKey($policy.node.archiveRoot + '/node.exe')
        -or $paths[$policy.node.archiveRoot + '/node.exe']) { throw 'WINDOWS_BUILD_NODE_BINARY_MISSING' }
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    $buffer = [byte[]]::new(65536)
    foreach ($item in $entries) {
      $target = Join-Path $destination $item.relative
      if ($item.directory) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      $inputStream = $item.entry.Open()
      try {
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
          [long]$copied = 0
          while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $copied += $count
            if ($copied -gt $item.entry.Length) { throw 'WINDOWS_BUILD_NODE_ARCHIVE_LENGTH_MISMATCH' }
            $outputStream.Write($buffer, 0, $count)
          }
          if ($copied -ne $item.entry.Length) { throw 'WINDOWS_BUILD_NODE_ARCHIVE_LENGTH_MISMATCH' }
        } finally { $outputStream.Dispose() }
      } finally { $inputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
} finally { $archiveStream.Dispose() }
Write-Output 'WINDOWS_BUILD_NODE_ARCHIVE_VERIFIED_AND_EXTRACTED'
