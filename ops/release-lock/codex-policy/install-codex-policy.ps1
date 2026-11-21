<#
  Kev runs this ONCE in an administrator PowerShell:
    powershell -ExecutionPolicy Bypass -File install-codex-policy.ps1
  It installs the enforced Codex policy (no "Full access" mode) where only administrators can change it.
  Undo: delete C:\ProgramData\OpenAI\Codex\requirements.toml (as administrator) and restart Codex.
#>
$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Please start PowerShell with "Run as administrator".' }
$src = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'requirements.toml'
$dir = Join-Path $env:ProgramData 'OpenAI\Codex'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -LiteralPath $src -Destination (Join-Path $dir 'requirements.toml') -Force
# only administrators + SYSTEM may change it; everyone (incl. Codex sandbox accounts) may read it
icacls (Join-Path $env:ProgramData 'OpenAI') /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
icacls (Join-Path $dir 'requirements.toml')
'Installed. Please quit and restart the Codex app so it picks up the policy.'
