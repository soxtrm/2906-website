<#
.SYNOPSIS
  Registers (or removes) a weekly Windows scheduled task that runs dev-clean.ps1 with the
  safe categories only: build caches, old test output, old Claude Code session temp.
  Dependencies (node_modules), logs, screenshots and worktrees are never cleaned automatically.

.EXAMPLE
  .\install-schedule.ps1                 # Sundays 03:30, current user, no admin rights needed
.EXAMPLE
  .\install-schedule.ps1 -Remove
#>
param(
  [string]$TaskName = 'NEXUS dev-clean (safe)',
  [string]$At = '03:30',
  [string]$Roots = '',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName' (if it existed)."
  exit 0
}
$script = Join-Path $PSScriptRoot 'dev-clean.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw "dev-clean.ps1 not found next to this script" }
$taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Apply -Categories caches,tests,temp"
if ($Roots) { $taskArgs += " -Roots `"$Roots`"" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Removes regenerable build caches, old test output and old Claude Code temp (logged in D:\2906\_hygiene). Source, credentials, backups, node_modules and worktrees are never touched.' -Force | Out-Null
Write-Host "Registered '$TaskName': Sundays $At -> powershell.exe $taskArgs"
Write-Host "Run it once now with:  Start-ScheduledTask -TaskName '$TaskName'"
