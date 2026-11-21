<#
  Dedicated Vercel release credential for the Claude release workflow (2906-website-6zbi).

  The token lives DPAPI-encrypted (Windows user kevin) in C:\Users\kevin\.claude-release\vercel-release.dpapi.
  That folder has no inheritance, grants only kevin + SYSTEM and explicitly DENIES the Codex sandbox
  accounts (group CodexSandboxUsers), so a sandboxed Codex session can neither read nor decrypt it.
  The shared Vercel CLI login (auth.json) is not used by any release script anymore.

  Usage
    .\release-token.ps1 install            Kev: paste the token created at vercel.com/account/settings/tokens
                                           (hidden prompt, never echoed, never written in clear text)
    .\release-token.ps1 check              shows who the token belongs to + expiry (never the token)
    .\release-token.ps1 vercel <args...>   runs the Vercel CLI with the release token and an empty,
                                           throw-away CLI config (never reads/writes the shared auth.json)
    .\release-token.ps1 run <cmd> <args>   runs any command with VERCEL_TOKEN set for that process only
#>
param([Parameter(Position = 0)][string]$Action = 'check', [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
$Dir = 'C:\Users\kevin\.claude-release'
$File = Join-Path $Dir 'vercel-release.dpapi'
$Team = 'team_0up4qnkl9UNhd83TueDmBOY0'
$Project = '2906-website-6zbi'
$CliVersion = '66.6.0'

function Lock-Folder {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  icacls $Dir /inheritance:r /grant:r "kevmain\kevin:(OI)(CI)F" "NT AUTHORITY\SYSTEM:(OI)(CI)F" /deny "kevmain\CodexSandboxUsers:(OI)(CI)F" | Out-Null
}
function Get-Plain([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Get-Token {
  if (-not (Test-Path -LiteralPath $File)) { throw "No release token installed ($File). Run: .\release-token.ps1 install" }
  Get-Plain (ConvertTo-SecureString (Get-Content -LiteralPath $File -Raw).Trim())
}
function Test-Token([string]$tok) {
  $h = @{ Authorization = "Bearer $tok" }
  $u = Invoke-RestMethod -Headers $h -Uri 'https://api.vercel.com/v2/user'
  $p = Invoke-RestMethod -Headers $h -Uri "https://api.vercel.com/v9/projects/$Project`?teamId=$Team"
  $t = Invoke-RestMethod -Headers $h -Uri 'https://api.vercel.com/v5/user/tokens/current'
  $exp = if ($t.token.expiresAt) { [DateTimeOffset]::FromUnixTimeMilliseconds($t.token.expiresAt).UtcDateTime.ToString('yyyy-MM-dd') } else { 'NEVER (create one with an expiry)' }
  [pscustomobject]@{ user = $u.user.username; tokenName = $t.token.name; tokenId = $t.token.id; expires = $exp; scopes = (($t.token.scopes | ForEach-Object { "$($_.type):$($_.teamId)" }) -join ','); project = $p.name; autoAssignCustomDomains = $p.autoAssignCustomDomains }
}

switch ($Action) {
  'install' {
    Lock-Folder
    $sec = Read-Host -AsSecureString 'Paste the Vercel release token (input stays hidden)'
    $info = Test-Token (Get-Plain $sec)
    ConvertFrom-SecureString -SecureString $sec | Set-Content -LiteralPath $File -Encoding ascii
    "Release token stored encrypted in $File"
    $info | Format-List
  }
  'check' { Test-Token (Get-Token) | Format-List }
  'vercel' {
    $tok = Get-Token
    $cfg = Join-Path $env:TEMP ("vercel-release-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $cfg | Out-Null
    try {
      $env:VERCEL_TOKEN = $tok
      & npx --yes "vercel@$CliVersion" --global-config $cfg --scope $Team @Rest
      $code = $LASTEXITCODE
    } finally { Remove-Item Env:\VERCEL_TOKEN -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force $cfg -ErrorAction SilentlyContinue }
    exit $code
  }
  'run' {
    if (-not $Rest) { throw 'usage: release-token.ps1 run <command> [args]' }
    $tok = Get-Token
    try { $env:VERCEL_TOKEN = $tok; & $Rest[0] @($Rest | Select-Object -Skip 1); $code = $LASTEXITCODE }
    finally { Remove-Item Env:\VERCEL_TOKEN -ErrorAction SilentlyContinue }
    exit $code
  }
  default { throw "unknown action $Action (install | check | vercel | run)" }
}
