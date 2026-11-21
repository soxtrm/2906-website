<#
.SYNOPSIS
  Read-only storage audit of the NEXUS development computer. Changes nothing.

.DESCRIPTION
  Measures the given roots (default: D:\2906, ~\.claude, ~\.codex, %LOCALAPPDATA%\Temp\claude,
  %LOCALAPPDATA%\ms-playwright, %LOCALAPPDATA%\npm-cache) without following junctions, and writes
  a Markdown and a JSON report:
    - free space per drive
    - the 20 largest directories (up to 3 levels below each root) and files, with why they exist
    - the 20 largest regenerable folders (node_modules, .next, test-results, agent temp ...)
    - every Git checkout/worktree with changed/untracked/unpushed/stash counts
    - totals per class: Safe (regenerable) / Verify / Important / Protected
  Credentials, databases and backups are listed by path only, never opened.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\dev-hygiene\dev-audit.ps1
.EXAMPLE
  .\dev-audit.ps1 -Roots D:\2906 -ReportDir D:\2906\_hygiene\reports -Top 30
#>
param(
  [string[]]$Roots,
  [string]$ReportDir,
  [int]$Top = 20,
  [long]$BigFileMB = 25
)
$ErrorActionPreference = 'Continue'
Import-Module (Join-Path $PSScriptRoot 'DevHygiene.psm1') -Force -DisableNameChecking

if ($Roots) { $Roots = @($Roots | ForEach-Object { $_ -split '[,;]' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }   # -File passes "a,b" as one string
if (-not $Roots -or $Roots.Count -eq 0) { $Roots = Get-DefaultRoots }
$Roots = @($Roots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { (Resolve-Path -LiteralPath $_).ProviderPath.TrimEnd('\', '/') })
if ($Roots.Count -eq 0) { Write-Error 'No existing roots to audit.'; exit 2 }
if (-not $ReportDir) { $ReportDir = Join-Path $Roots[0] '_hygiene\reports'; if (-not $Roots[0].Contains('\')) { $ReportDir = Join-Path $Roots[0] '_hygiene/reports' } }
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$started = Get-Date
$git = Test-GitAvailable

Write-Host "Auditing (read-only): $($Roots -join ', ')"
$scans = @()
foreach ($r in $Roots) { Write-Host "  measuring $r ..."; $scans += Measure-Tree -Root $r -BigFile ($BigFileMB * 1MB) }

# Git state of every checkout/worktree found.
$gitBy = @{}
$repoPaths = @($scans | ForEach-Object { $_.Repos } | Sort-Object -Unique)
if ($git) { foreach ($p in $repoPaths) { $gitBy[$p] = Get-GitState $p } }

# Classify all recorded directories once.
$all = New-Object System.Collections.Generic.List[object]
foreach ($s in $scans) {
  foreach ($d in $s.Dirs) {
    $c = Get-Classification $d $gitBy
    $all.Add([pscustomobject]@{ Path = $d.Path; Root = $s.Root; Depth = $d.Depth; Bytes = $d.Total; Files = $d.Files; NewestUtc = $d.NewestUtc; Kind = $d.Kind; Class = $c.Class; Category = $c.Category; Why = $c.Why })
  }
}

# Reclaimable = outermost Safe folders (not counted twice when nested).
$safe = @($all | Where-Object { $_.Class -eq 'Safe' -and $_.Depth -ge 1 } | Sort-Object { $_.Path.Length })
$outer = New-Object System.Collections.Generic.List[object]
foreach ($d in $safe) {
  $inside = $false
  foreach ($o in $outer) { if ($d.Path.StartsWith($o.Path.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { $inside = $true; break } }
  if (-not $inside) { $outer.Add($d) }
}
# Agent temp: one entry per session folder rather than the whole tree.
$outer = @($outer | Where-Object { -not ($_.Category -eq 'agent-temp' -and $_.Depth -lt 2) })
$agentSessions = @($all | Where-Object { $_.Category -eq 'agent-temp' -and $_.Depth -eq 2 })
$reclaim = @($outer + $agentSessions | Sort-Object Path -Unique | Sort-Object Bytes -Descending)

$topDirs = @($all | Where-Object { $_.Depth -ge 1 -and $_.Depth -le 3 } | Sort-Object Bytes -Descending | Select-Object -First $Top)
$bigFiles = @($scans | ForEach-Object { $_.BigFiles } | Sort-Object Bytes -Descending | Select-Object -First $Top)
$protected = @($scans | ForEach-Object { $_.Protected } | Sort-Object -Unique)
$free = Get-FreeSpace $Roots
$now = (Get-Date).ToUniversalTime()
function Age($utc) { if (-not $utc -or $utc -eq [datetime]::MinValue) { return '-' }; $d = [int]($now - $utc).TotalDays; if ($d -le 0) { return 'today' }; return "$d d" }
function FileWhy([string]$p) {
  if (Test-Protected $p) { return 'Protected (credential/database/backup by name)' }
  if ($p -match '(?i)\.(zip|7z|tar|tgz|gz|bundle)$') { return 'Verify: archive (deployment bundle or download?)' }
  if ($p -match '(?i)\.(mp4|webm|mov)$') { return 'Verify: video (test recording or media)' }
  if ($p -match '(?i)\.(log|jsonl)$') { return 'Verify: log/transcript; rotate if still growing' }
  if ($p -match '(?i)[\\/]node_modules[\\/]') { return 'Safe: inside node_modules (dependency binary)' }
  if ($p -match '(?i)[\\/]\.next[\\/]') { return 'Safe: Next.js cache' }
  if ($p -match '(?i)[\\/]\.git[\\/]') { return 'Important: Git object pack' }
  return 'Verify'
}

$rootTotals = @($scans | ForEach-Object { [pscustomobject]@{ Root = $_.Root; Bytes = $_.Dirs[0].Total; Files = $_.Dirs[0].Files } })

# ---- Markdown report ----
$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine("# Development storage audit $stamp")
[void]$md.AppendLine("")
[void]$md.AppendLine("Read-only. Computer: $env:COMPUTERNAME. Git available: $git. Duration: $([int]((Get-Date) - $started).TotalSeconds) s.")
[void]$md.AppendLine("")
[void]$md.AppendLine("## Free space"); [void]$md.AppendLine("")
[void]$md.AppendLine("| Drive | Free | Size |"); [void]$md.AppendLine("|---|---|---|")
foreach ($f in $free) { [void]$md.AppendLine("| $($f.Drive) | $(Format-Size $f.Free) | $(Format-Size $f.Size) |") }
[void]$md.AppendLine("")
[void]$md.AppendLine("## Roots"); [void]$md.AppendLine("")
[void]$md.AppendLine("| Root | Size | Files |"); [void]$md.AppendLine("|---|---|---|")
foreach ($r in $rootTotals) { [void]$md.AppendLine("| ``$($r.Root)`` | $(Format-Size $r.Bytes) | $($r.Files) |") }
[void]$md.AppendLine("")
[void]$md.AppendLine("## Reclaimable without loss (regenerable)"); [void]$md.AppendLine("")
$cat = $reclaim | Group-Object Category | ForEach-Object { [pscustomobject]@{ Category = $_.Name; Count = $_.Count; Bytes = ($_.Group | Measure-Object Bytes -Sum).Sum } } | Sort-Object Bytes -Descending
[void]$md.AppendLine("| Category | Folders | Size |"); [void]$md.AppendLine("|---|---|---|")
foreach ($c in $cat) { [void]$md.AppendLine("| $($c.Category) | $($c.Count) | $(Format-Size $c.Bytes) |") }
[void]$md.AppendLine("")
[void]$md.AppendLine("## Top $Top directories (up to 3 levels below each root)"); [void]$md.AppendLine("")
[void]$md.AppendLine("| Size | Directory | Class | Why it exists | Last change |"); [void]$md.AppendLine("|---|---|---|---|---|")
foreach ($d in $topDirs) { [void]$md.AppendLine("| $(Format-Size $d.Bytes) | ``$($d.Path)`` | $($d.Class) | $($d.Why) | $(Age $d.NewestUtc) |") }
[void]$md.AppendLine("")
[void]$md.AppendLine("## Top $Top regenerable folders"); [void]$md.AppendLine("")
[void]$md.AppendLine("| Size | Folder | Category | Why | Last change |"); [void]$md.AppendLine("|---|---|---|---|---|")
foreach ($d in ($reclaim | Select-Object -First $Top)) { [void]$md.AppendLine("| $(Format-Size $d.Bytes) | ``$($d.Path)`` | $($d.Category) | $($d.Why) | $(Age $d.NewestUtc) |") }
[void]$md.AppendLine("")
[void]$md.AppendLine("## Top $Top files (>= $BigFileMB MB)"); [void]$md.AppendLine("")
[void]$md.AppendLine("| Size | File | Assessment | Last change |"); [void]$md.AppendLine("|---|---|---|---|")
foreach ($f in $bigFiles) { [void]$md.AppendLine("| $(Format-Size $f.Bytes) | ``$($f.Path)`` | $(FileWhy $f.Path) | $(Age $f.LastWriteUtc) |") }
[void]$md.AppendLine("")
[void]$md.AppendLine("## Git checkouts and worktrees"); [void]$md.AppendLine("")
[void]$md.AppendLine("| Checkout | Kind | Branch | Changed | Untracked | Unpushed | Stashes | Upstream | Last commit | Size | Class |"); [void]$md.AppendLine("|---|---|---|---|---|---|---|---|---|---|---|")
foreach ($p in $repoPaths) {
  $g = $gitBy[$p]; $rec = $all | Where-Object { $_.Path -eq $p } | Select-Object -First 1
  $size = '-'; $class = '-'; if ($rec) { $size = Format-Size $rec.Bytes; $class = $rec.Class }
  if ($g) {
    $kind = 'checkout'; if ($g.IsWorktree) { $kind = 'worktree' }
    $up = '-'; if ($g.Upstream) { $up = $g.Upstream }
    [void]$md.AppendLine("| ``$p`` | $kind | $($g.Branch) | $($g.Dirty) | $($g.Untracked) | $($g.Unpushed) | $($g.Stashes) | $up | $(Age $g.LastCommitUtc) | $size | $class |")
  } else { [void]$md.AppendLine("| ``$p`` | ? | (git not available) | | | | | | | $size | $class |") }
}
[void]$md.AppendLine("")
[void]$md.AppendLine("## Classes"); [void]$md.AppendLine("")
[void]$md.AppendLine("- **Safe**: regenerable (dependencies, build caches, test output, old agent temp). dev-clean.ps1 handles these.")
[void]$md.AppendLine("- **Verify**: probably obsolete but needs a decision (clean+pushed worktrees, archives, screenshots, session logs, old Playwright browsers).")
[void]$md.AppendLine("- **Important**: source, Git history, checkouts with uncommitted/unpushed/stashed work. Not touched.")
[void]$md.AppendLine("- **Protected**: credentials, databases, backups by name. Never touched. $($protected.Count) file(s) found:")
foreach ($p in ($protected | Select-Object -First 40)) { [void]$md.AppendLine("  - ``$p``") }
if ($protected.Count -gt 40) { [void]$md.AppendLine("  - ... $($protected.Count - 40) more in the JSON report") }

$mdPath = Join-Path $ReportDir "audit-$stamp.md"
$jsonPath = Join-Path $ReportDir "audit-$stamp.json"
[System.IO.File]::WriteAllText($mdPath, $md.ToString(), (New-Object System.Text.UTF8Encoding $false))
$json = [ordered]@{
  stamp = $stamp; computer = $env:COMPUTERNAME; roots = $rootTotals; free = $free
  topDirectories = $topDirs; reclaimable = $reclaim; bigFiles = $bigFiles
  git = @($repoPaths | ForEach-Object { $gitBy[$_] }); protected = $protected
}
[System.IO.File]::WriteAllText($jsonPath, ($json | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
Write-Host ""
Write-Host "Reclaimable (regenerable): $(Format-Size (($reclaim | Measure-Object Bytes -Sum).Sum)) in $($reclaim.Count) folders"
Write-Host "Report: $mdPath"
Write-Host "JSON:   $jsonPath"
