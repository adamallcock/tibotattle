<#!
.SYNOPSIS
  Bounded, content-free transport for the signed-finalizer preparation manifest.

The prepare job uses Encode to append fixed metadata and at most sixteen
24 KiB base64 chunks to GITHUB_OUTPUT. The protected sign job uses Decode to
reconstruct the same bytes from the corresponding process environment
variables. This helper intentionally emits only fixed error codes; it never
prints manifest bytes, paths, or PowerShell diagnostics.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Mode,

  [Parameter(Mandatory = $false)]
  [string]$InputPath,

  [Parameter(Mandatory = $false)]
  [string]$OutputPath,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedSha256,

  [Parameter(Mandatory = $false)]
  [string]$OutputFile
)

$ErrorActionPreference = 'Stop'

$MaximumRawBytes = 262144
$MaximumBase64Bytes = 393216
$ChunkMaximumBytes = 24576
$MaximumChunks = 16
$ChunkVariablePrefix = 'PREPARATION_HANDOFF_CHUNK_'

function Fail([string]$Code) {
  [Console]::Error.WriteLine($Code)
  exit 1
}

function IsRegularFile([string]$Path) {
  if ([string]::IsNullOrEmpty($Path)) { return $false }
  try {
    $item = Get-Item -LiteralPath $Path -Force
    return $item -is [IO.FileInfo] -and
      -not $item.PSIsContainer -and
      (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::None)
  } catch {
    return $false
  }
}

function Sha256Hex([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function WriteOutputLines([string]$Path, [string[]]$Lines) {
  if (-not (IsRegularFile $Path)) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_OUTPUT_DESTINATION_INVALID'
  }
  $stream = $null
  $writer = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false), 4096, $false)
    foreach ($line in $Lines) {
      if ($line -match '[\r\n]') {
        Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_OUTPUT_LINE_INVALID'
      }
      $writer.WriteLine($line)
    }
    $writer.Flush()
    $stream.Flush($true)
  } finally {
    if ($null -ne $writer) { $writer.Dispose() }
    elseif ($null -ne $stream) { $stream.Dispose() }
  }
}

function EncodeManifest {
  if (-not (IsRegularFile $InputPath)) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_INPUT_INVALID'
  }
  $item = Get-Item -LiteralPath $InputPath -Force
  if ($item.Length -le 0 -or $item.Length -gt $MaximumRawBytes) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_INPUT_BOUNDS_INVALID'
  }
  if ([string]::IsNullOrEmpty($OutputFile)) {
    $OutputFile = [Environment]::GetEnvironmentVariable('GITHUB_OUTPUT', 'Process')
  }
  if ([string]::IsNullOrEmpty($OutputFile)) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_OUTPUT_DESTINATION_INVALID'
  }

  try {
    $bytes = [IO.File]::ReadAllBytes($InputPath)
  } catch {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_INPUT_READ_FAILED'
  }
  if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumRawBytes) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_INPUT_BOUNDS_INVALID'
  }
  $base64 = [Convert]::ToBase64String($bytes)
  if ($base64.Length -le 0 -or $base64.Length -gt $MaximumBase64Bytes -or
      ($base64.Length % 4) -ne 0 -or $base64 -match '[\r\n]') {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_ENCODED_BOUNDS_INVALID'
  }
  $chunkCount = [int][Math]::Ceiling($base64.Length / $ChunkMaximumBytes)
  if ($chunkCount -lt 1 -or $chunkCount -gt $MaximumChunks) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_CHUNK_COUNT_INVALID'
  }

  $lines = [Collections.Generic.List[string]]::new()
  [void]$lines.Add("manifest-chunk-count=$chunkCount")
  [void]$lines.Add("manifest-bytes=$($bytes.Length)")
  [void]$lines.Add("manifest-encoded-bytes=$($base64.Length)")
  [void]$lines.Add("manifest-sha256=$(Sha256Hex $bytes)")
  for ($index = 0; $index -lt $MaximumChunks; $index++) {
    $name = 'manifest-chunk-{0:D2}' -f $index
    if ($index -lt $chunkCount) {
      $start = $index * $ChunkMaximumBytes
      $length = [Math]::Min($ChunkMaximumBytes, $base64.Length - $start)
      $chunk = $base64.Substring($start, $length)
      if ($chunk.Length -le 0 -or $chunk.Length -gt $ChunkMaximumBytes -or
          $chunk -match '[\r\n]' -or $chunk -notmatch '^[A-Za-z0-9+/=]+$' -or
          ($index -lt ($chunkCount - 1) -and $chunk.Length -ne $ChunkMaximumBytes)) {
        Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_CHUNK_INVALID'
      }
      [void]$lines.Add("$name=$chunk")
    } else {
      [void]$lines.Add("$name=")
    }
  }
  WriteOutputLines $OutputFile $lines.ToArray()
}

function ReadRequiredEnvironment([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ($null -eq $value) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_METADATA_MISSING'
  }
  return $value
}

function DecodeManifest {
  if ([string]::IsNullOrEmpty($OutputPath)) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_OUTPUT_PATH_INVALID'
  }
  if (-not [string]::IsNullOrEmpty($ExpectedSha256) -and
      $ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$') {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_EXPECTED_DIGEST_INVALID'
  }
  if (-not [string]::IsNullOrEmpty($ExpectedSha256)) {
    $expectedDigest = $ExpectedSha256
  } else {
    $expectedDigest = ReadRequiredEnvironment 'PREPARATION_HANDOFF_SHA256'
  }
  if ($expectedDigest -cnotmatch '^[0-9a-f]{64}$') {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_EXPECTED_DIGEST_INVALID'
  }

  $countText = ReadRequiredEnvironment 'PREPARATION_HANDOFF_CHUNK_COUNT'
  $rawBytesText = ReadRequiredEnvironment 'PREPARATION_HANDOFF_MANIFEST_BYTES'
  $encodedBytesText = ReadRequiredEnvironment 'PREPARATION_HANDOFF_ENCODED_BYTES'
  if ($countText -cnotmatch '^[1-9][0-9]?$' -or
      $rawBytesText -cnotmatch '^[1-9][0-9]{0,5}$' -or
      $encodedBytesText -cnotmatch '^[1-9][0-9]{0,5}$') {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_METADATA_INVALID'
  }
  $chunkCount = [int]$countText
  $rawBytes = [int]$rawBytesText
  $encodedBytes = [int]$encodedBytesText
  if ($chunkCount -lt 1 -or $chunkCount -gt $MaximumChunks -or
      $rawBytes -le 0 -or $rawBytes -gt $MaximumRawBytes -or
      $encodedBytes -le 0 -or $encodedBytes -gt $MaximumBase64Bytes -or
      ($encodedBytes % 4) -ne 0 -or
      $chunkCount -ne [int][Math]::Ceiling($encodedBytes / $ChunkMaximumBytes)) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_BOUNDS_INVALID'
  }

  $environmentNames = @([Environment]::GetEnvironmentVariables('Process').Keys | ForEach-Object { [string]$_ })
  foreach ($name in $environmentNames) {
    if ($name -match '^PREPARATION_HANDOFF_CHUNK_[0-9]+$' -and
        $name -notmatch '^PREPARATION_HANDOFF_CHUNK_(?:0[0-9]|1[0-5])$') {
      Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_UNEXPECTED_CHUNK'
    }
  }
  $chunks = [Collections.Generic.List[string]]::new()
  for ($index = 0; $index -lt $MaximumChunks; $index++) {
    $name = '{0}{1:D2}' -f $ChunkVariablePrefix, $index
    $chunk = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -eq $chunk) { $chunk = '' }
    if ($index -ge $chunkCount) {
      if ($chunk.Length -ne 0) {
        Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_UNEXPECTED_CHUNK'
      }
      continue
    }
    if ($chunk.Length -le 0 -or $chunk.Length -gt $ChunkMaximumBytes -or
        $chunk -match '[\r\n]' -or $chunk -notmatch '^[A-Za-z0-9+/=]+$' -or
        ($index -lt ($chunkCount - 1) -and $chunk.Length -ne $ChunkMaximumBytes)) {
      Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_CHUNK_INVALID'
    }
    [void]$chunks.Add($chunk)
  }
  $base64 = [string]::Join('', $chunks)
  if ($base64.Length -ne $encodedBytes) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_CHUNK_TOTAL_MISMATCH'
  }
  try {
    $bytes = [Convert]::FromBase64String($base64)
  } catch {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_BASE64_INVALID'
  }
  if ($bytes.Length -ne $rawBytes -or $bytes.Length -le 0 -or $bytes.Length -gt $MaximumRawBytes) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_RAW_BOUNDS_INVALID'
  }
  if ((Sha256Hex $bytes) -cne $expectedDigest) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_DIGEST_MISMATCH'
  }
  if (Test-Path -LiteralPath $OutputPath) {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_OUTPUT_PREEXISTS'
  }
  $created = $false
  try {
    $stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $created = $true
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
  } catch {
    if ($created -and (Test-Path -LiteralPath $OutputPath)) {
      Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
    }
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_OUTPUT_WRITE_FAILED'
  }
}

try {
  if ($Mode -cne 'Encode' -and $Mode -cne 'Decode') {
    Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_MODE_INVALID'
  }
  if ($Mode -ceq 'Encode') { EncodeManifest }
  else { DecodeManifest }
  exit 0
} catch {
  Fail 'WINDOWS_PREPARATION_MANIFEST_TRANSPORT_FAILED'
}
