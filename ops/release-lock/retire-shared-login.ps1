<#
  Step 3 of the credential hardening (run only after "release-token.ps1 check" works):
   1. verifies the dedicated release token (identity, expiry, project access, alias read)
   2. logs the shared Vercel CLI login out (revokes that token server side, empties auth.json)
   3. revokes dashboard login sessions idle for more than $IdleDays days (Kev's recent ones stay)
   4. proves that without the release token the CLI and the API refuse to work
  Production is not touched: no deployment, no alias, no project setting changes.
#>
param([int]$IdleDays = 30, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Team = 'team_0up4qnkl9UNhd83TueDmBOY0'
$CliVersion = '66.6.0'
$auth = Join-Path $env:APPDATA 'com.vercel.cli\Data\auth.json'

"== 1. release token"
$check = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'release-token.ps1') check
if ($LASTEXITCODE -ne 0) { throw 'release token check failed - nothing was changed' }
$check
$sec = ConvertTo-SecureString (Get-Content -Raw 'C:\Users\kevin\.claude-release\vercel-release.dpapi').Trim()
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); $rel = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
$H = @{ Authorization = "Bearer $rel" }
$alias = Invoke-RestMethod -Headers $H -Uri "https://api.vercel.com/v4/aliases/www.2906.estate?teamId=$Team"
"release token reads aliases: www.2906.estate -> $($alias.deploymentId)"
$relId = (Invoke-RestMethod -Headers $H -Uri 'https://api.vercel.com/v5/user/tokens/current').token.id

"== 2. shared CLI login"
$hasCli = (Test-Path $auth) -and ((Get-Content -Raw $auth | ConvertFrom-Json).token)
if (-not $hasCli) { "shared CLI login already gone" }
elseif ($DryRun) { "DRY RUN: would run vercel logout (revokes the shared CLI token)" }
else {
  & npx --yes "vercel@$CliVersion" logout
  $left = (Test-Path $auth) -and ((Get-Content -Raw $auth | ConvertFrom-Json).token)
  if ($left) { throw 'auth.json still holds a token after logout' } else { "shared CLI token revoked and removed from auth.json" }
}

"== 3. idle dashboard sessions (> $IdleDays days)"
$list = (Invoke-RestMethod -Headers $H -Uri 'https://api.vercel.com/v5/user/tokens?limit=100').tokens
$cut = [DateTimeOffset]::UtcNow.AddDays(-$IdleDays).ToUnixTimeMilliseconds()
foreach ($t in $list) {
  $last = if ($t.activeAt) { $t.activeAt } else { $t.createdAt }
  $when = [DateTimeOffset]::FromUnixTimeMilliseconds($last).UtcDateTime.ToString('yyyy-MM-dd')
  if ($t.id -eq $relId) { "keep    $($t.name)  (this release token)"; continue }
  if ($last -ge $cut) { "keep    $($t.name)  last active $when"; continue }
  if ($DryRun) { "WOULD REVOKE  $($t.name)  last active $when"; continue }
  try { Invoke-RestMethod -Method Delete -Headers $H -Uri "https://api.vercel.com/v3/user/tokens/$($t.id)" | Out-Null; "REVOKED $($t.name)  last active $when" }
  catch { "could not revoke $($t.name): $($_.Exception.Message) - revoke it at vercel.com/account/settings/tokens" }
}

"== 4. without the release token nothing works"
$cfg = Join-Path $env:TEMP ("vercel-noauth-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $cfg | Out-Null
$env:CI = '1'
$out = (& npx --yes "vercel@$CliVersion" --global-config $cfg alias ls --scope $Team 2>&1 | Out-String)
Remove-Item Env:\CI; Remove-Item -Recurse -Force $cfg
"CLI without token (alias ls): exit $LASTEXITCODE  " + (($out -split "`n" | Where-Object { $_ -match 'Error|log in|login|credentials|token' } | Select-Object -First 1))
try { Invoke-RestMethod -Uri "https://api.vercel.com/v9/projects/2906-website-6zbi?teamId=$Team" | Out-Null; 'API without token: UNEXPECTEDLY ALLOWED' } catch { "API without token: refused ($($_.Exception.Response.StatusCode.value__))" }
