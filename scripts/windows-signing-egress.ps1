param([Parameter(Mandatory=$true)][ValidateSet('restrict','restore')][string]$Mode)
$ErrorActionPreference = 'Stop'
# This runs on the disposable GitHub-hosted Windows signer only. Save the
# previous policy before changing it and restore it even if signing fails.
$statePath = Join-Path $env:GITHUB_WORKSPACE '.release-build/windows-signing-egress-state.json'
$group = 'TiboTattle isolated signing egress'
if ($Mode -eq 'restore') {
  if (-not (Test-Path -LiteralPath $statePath)) { exit 0 }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  foreach ($profile in $state.profiles) {
    Set-NetFirewallProfile -Name $profile.name -DefaultOutboundAction $profile.outbound -Enabled $profile.enabled
  }
  foreach ($name in $state.disabledAllowRules) { Enable-NetFirewallRule -Name $name }
  Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Remove-Item -LiteralPath $statePath
  exit 0
}
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows'
    -or -not $env:ACTIONS_ID_TOKEN_REQUEST_URL) { throw 'WINDOWS_SIGNING_EGRESS_HOST_INVALID' }
if (Test-Path -LiteralPath $statePath) { throw 'WINDOWS_SIGNING_EGRESS_STATE_EXISTS' }
$oidc = [Uri]$env:ACTIONS_ID_TOKEN_REQUEST_URL
if ($oidc.Scheme -cne 'https' -or -not $oidc.DnsSafeHost.EndsWith('.actions.githubusercontent.com')
    -or $oidc.UserInfo -or -not $oidc.IsDefaultPort) { throw 'WINDOWS_SIGNING_EGRESS_OIDC_INVALID' }
$hosts = @($oidc.DnsSafeHost, 'login.microsoftonline.com', 'eus.codesigning.azure.net', 'timestamp.acs.microsoft.com')
$addresses = @()
foreach ($hostName in $hosts) {
  $resolved = @([System.Net.Dns]::GetHostAddresses($hostName) | ForEach-Object { $_.IPAddressToString })
  if ($resolved.Count -eq 0) { throw 'WINDOWS_SIGNING_EGRESS_RESOLUTION_FAILED' }
  $addresses += $resolved
}
$addresses = @($addresses | Sort-Object -Unique)
$dns = @(Get-DnsClientServerAddress | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ } | Sort-Object -Unique)
if ($dns.Count -eq 0) { throw 'WINDOWS_SIGNING_EGRESS_DNS_UNAVAILABLE' }
$profiles = @(Get-NetFirewallProfile | ForEach-Object { @{ name = [string]$_.Name; outbound = [string]$_.DefaultOutboundAction; enabled = [string]$_.Enabled } })
$rules = @(Get-NetFirewallRule -Enabled True -Direction Outbound -Action Allow | ForEach-Object { $_.Name })
$state = @{ profiles = $profiles; disabledAllowRules = $rules }
$bytes = [Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 4))
$stream = [System.IO.File]::Open($statePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
foreach ($name in $rules) { Disable-NetFirewallRule -Name $name }
New-NetFirewallRule -DisplayName 'TiboTattle signing service HTTPS' -Group $group -Direction Outbound -Action Allow -Protocol TCP -RemotePort 443 -RemoteAddress $addresses | Out-Null
New-NetFirewallRule -DisplayName 'TiboTattle timestamp HTTP' -Group $group -Direction Outbound -Action Allow -Protocol TCP -RemotePort 80 -RemoteAddress ([System.Net.Dns]::GetHostAddresses('timestamp.acs.microsoft.com') | ForEach-Object { $_.IPAddressToString }) | Out-Null
New-NetFirewallRule -DisplayName 'TiboTattle signing DNS UDP' -Group $group -Direction Outbound -Action Allow -Protocol UDP -RemotePort 53 -RemoteAddress $dns | Out-Null
New-NetFirewallRule -DisplayName 'TiboTattle signing DNS TCP' -Group $group -Direction Outbound -Action Allow -Protocol TCP -RemotePort 53 -RemoteAddress $dns | Out-Null
Set-NetFirewallProfile -Name Domain,Private,Public -Enabled True -DefaultOutboundAction Block
if (@(Get-NetFirewallProfile | Where-Object { $_.DefaultOutboundAction -ne 'Block' -or $_.Enabled -ne 'True' }).Count -ne 0) { throw 'WINDOWS_SIGNING_EGRESS_NOT_ENFORCED' }
