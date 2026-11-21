<#
.SYNOPSIS
  Removes clearly disposable, regenerable files from the NEXUS development computer.
  DRY RUN by default: nothing is deleted without -Apply.

.DESCRIPTION
  Categories (choose with -Categories; default: caches,tests,temp):
    caches  .next .turbo .vite .parcel-cache __pycache__ .pytest_cache coverage ... not changed for -MinAgeHours
    tests   playwright-report, test-results, blob-report not changed for -TestRetainDays
    temp    Claude Code session folders under %LOCALAPPDATA%\Temp\claude not changed for -TempRetainDays
    logs    *.log files ignored by Git (or outside repos) not changed for -LogRetainDays
    shots   *.png/*.jpg/*.webm/*.zip in folders named shots/screenshots/traces/videos older than
            -TestRetainDays, keeping the newest -KeepShots per folder (Git-ignored or outside repos only)
    deps    node_modules of checkouts with no changes for -InactiveDays and a clean Git status
            (opt-in: costs an npm ci the next time that checkout is used)
  Worktrees are never removed by category. -RemoveWorktree <path> removes one worktree only if it is
  clean, has no stash and every commit is pushed (git worktree remove, then git worktree prune).

  Safeguards, always on:
    - only below the given roots; never a root itself; never follows junctions or symlinks
    - inside a Git checkout, only paths Git ignores (git check-ignore) are deleted
    - never anything matching credential/database/backup names, nor any folder containing one
    - never .git, source files, release or rollback archives, production backups
    - every deletion is logged with its size to <ReportDir>\clean-<time>.log
  Free space is measured before and after.

.EXAMPLE
  .\dev-clean.ps1                                   # dry run, default categories
.EXAMPLE
  .\dev-clean.ps1 -Apply                            # delete caches, test output, old agent temp
.EXAMPLE
  .\dev-clean.ps1 -Categories deps -InactiveDays 21 # dry run for old node_modules
.EXAMPLE
  .\dev-clean.ps1 -RemoveWorktree D:\2906\wt-old -Apply
#>
param(
  [string[]]$Roots,
  [string[]]$Categories = @('caches', 'tests', 'temp'),
  [switch]$Apply,
  [string]$ReportDir,
  [int]$MinAgeHours = 24,
  [int]$TestRetainDays = 14,
  [int]$TempRetainDays = 7,
  [int]$LogRetainDays = 30,
  [int]$KeepShots = 20,
  [int]$InactiveDays = 14,
  [string[]]$RemoveWorktree
)
$ErrorActionPreference = 'Continue'
Import-Module (Join-Path $PSScriptRoot 'DevHygiene.psm1') -Force -DisableNameChecking

function SplitList($v) { if (-not $v) { return @() }; return @($v | ForEach-Object { $_ -split '[,;]' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$Roots = SplitList $Roots; $Categories = @(SplitList $Categories | ForEach-Object { $_.ToLowerInvariant() }); $RemoveWorktree = SplitList $RemoveWorktree
$known = @('caches', 'tests', 'temp', 'logs', 'shots', 'deps')
foreach ($c in $Categories) { if ($known -notcontains $c) { Write-Error "Unknown category '$c' (known: $($known -join ', '))"; exit 2 } }
if ($Roots.Count -eq 0) { $Roots = Get-DefaultRoots }
$Roots = @($Roots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { (Resolve-Path -LiteralPath $_).ProviderPath.TrimEnd('\', '/') })
if ($Roots.Count -eq 0) { Write-Error 'No existing roots.'; exit 2 }
if (-not (Test-GitAvailable)) { Write-Error 'git is required (it decides what is ignored).'; exit 2 }
if (-not $ReportDir) { $ReportDir = Join-Path $Roots[0] '_hygiene' }
New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$mode = 'DRY RUN'; if ($Apply) { $mode = 'APPLY' }
$log = Join-Path $ReportDir ("clean-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Log([string]$s) { Add-Content -LiteralPath $log -Value $s; Write-Host $s }
$now = (Get-Date).ToUniversalTime()
$before = Get-FreeSpace $Roots
Log "dev-clean $mode $(Get-Date -Format s) roots=$($Roots -join ';') categories=$($Categories -join ',')"
foreach ($f in $before) { Log ("free before {0}: {1}" -f $f.Drive, (Format-Size $f.Free)) }

$plan = New-Object System.Collections.Generic.List[object]
$skipped = New-Object System.Collections.Generic.List[object]
function Add-Plan($path, $bytes, $cat, $why, $isFile) { $plan.Add([pscustomobject]@{ Path = $path; Bytes = [long]$bytes; Category = $cat; Why = $why; IsFile = [bool]$isFile }) }
function Skip($path, $why) { $skipped.Add([pscustomobject]@{ Path = $path; Why = $why }) }
function Older($utc, [double]$days) { return ($utc -eq [datetime]::MinValue) -or (($now - $utc).TotalDays -ge $days) }

# Common checks for anything we might delete.
$reportFull = (Resolve-Path -LiteralPath $ReportDir).ProviderPath.TrimEnd('\', '/')
function Allowed([string]$path, [string[]]$repos, [bool]$needIgnored) {
  if (-not (Test-UnderRoots $path $Roots)) { return 'outside the roots' }
  if ($path -eq $reportFull -or $path.StartsWith($reportFull + [System.IO.Path]::DirectorySeparatorChar)) { return 'hygiene reports (own retention)' }
  if (Test-Protected $path) { return 'protected name' }
  if ($needIgnored) {
    $ig = Test-GitIgnored $path $repos
    if ($ig -eq $false) { return 'tracked or not ignored by Git' }
  }
  return $null
}
function Contains-Protected([string]$dir) {
  try {
    foreach ($f in [System.IO.Directory]::EnumerateFiles($dir, '*', [System.IO.SearchOption]::AllDirectories)) { if (Test-Protected $f) { return $true } }
  } catch { return $true }   # cannot verify -> treat as protected
  return $false
}

$scans = @(); foreach ($r in $Roots) { Write-Host "scanning $r ..."; $scans += Measure-Tree -Root $r -BigFile ([long]::MaxValue) }
$repos = @($scans | ForEach-Object { $_.Repos } | Sort-Object -Unique)
$gitBy = @{}; foreach ($p in $repos) { $gitBy[$p] = Get-GitState $p }
$dirs = @($scans | ForEach-Object { $_.Dirs })

foreach ($d in $dirs) {
  if ($d.Depth -lt 1) { continue }
  $name = Split-Path -Leaf $d.Path
  # caches / tests
  if ($d.Kind -and $d.Kind -ne '.git') {
    $cat = $null
    switch -regex ($d.Kind) {
      '^(node_modules|\.pnpm-store)$' { $cat = 'deps' }
      '^(playwright-report|test-results|blob-report)$' { $cat = 'tests' }
      default { $cat = 'caches' }
    }
    if ($Categories -notcontains $cat) { continue }
    $why = Allowed $d.Path $repos $true; if ($why) { Skip $d.Path $why; continue }
    if ($cat -eq 'caches' -and -not (Older $d.NewestUtc ($MinAgeHours / 24.0))) { Skip $d.Path "changed within $MinAgeHours h (may be in use)"; continue }
    if ($cat -eq 'tests' -and -not (Older $d.NewestUtc $TestRetainDays)) { Skip $d.Path "newer than $TestRetainDays days"; continue }
    if ($cat -eq 'deps') {
      $proj = Split-Path -Parent $d.Path
      $owner = $null; foreach ($r in $repos) { if ($proj -eq $r -or $proj.StartsWith($r + [System.IO.Path]::DirectorySeparatorChar)) { if (-not $owner -or $r.Length -gt $owner.Length) { $owner = $r } } }
      if (-not $owner) { Skip $d.Path 'not inside a Git checkout'; continue }
      $g = $gitBy[$owner]
      if ($g.Dirty -gt 0 -or $g.Stashes -gt 0) { Skip $d.Path 'checkout has uncommitted or stashed work'; continue }
      $lastUse = $g.LastCommitUtc; if (-not $lastUse) { $lastUse = [datetime]::MinValue }
      if (-not (Older $lastUse $InactiveDays)) { Skip $d.Path "checkout active within $InactiveDays days"; continue }
      Add-Plan $d.Path $d.Total 'deps' "node_modules of a checkout idle for $([int]($now - $lastUse).TotalDays) days (npm ci restores it)" $false; continue
    }
    Add-Plan $d.Path $d.Total $cat (Get-DirKindWhy $d.Kind) $false; continue
  }
  # Claude Code temp: one folder per session (...\Temp\claude\<project>\<session>)
  if ($Categories -contains 'temp' -and $d.Path -match '(?i)[\\/]Temp[\\/]claude[\\/][^\\/]+[\\/][^\\/]+$') {
    if (-not (Older $d.NewestUtc $TempRetainDays)) { Skip $d.Path "session temp newer than $TempRetainDays days"; continue }
    $why = Allowed $d.Path $repos $false; if ($why) { Skip $d.Path $why; continue }
    if (Contains-Protected $d.Path) { Skip $d.Path 'contains a protected-looking file'; continue }
    Add-Plan $d.Path $d.Total 'temp' "Claude Code session temp, unchanged for $([int]($now - $d.NewestUtc).TotalDays) days" $false
  }
}

# Files: logs and screenshot retention.
if ($Categories -contains 'logs' -or $Categories -contains 'shots') {
  foreach ($d in $dirs) {
    if ($d.Kind) { continue }
    $leaf = Split-Path -Leaf $d.Path
    $isShots = @('shots', 'screenshots', 'traces', 'videos') -contains $leaf.ToLowerInvariant()
    try { $files = @((New-Object System.IO.DirectoryInfo $d.Path).GetFiles()) } catch { continue }
    if ($Categories -contains 'logs') {
      foreach ($f in $files) {
        if ($f.Extension -ne '.log') { continue }
        if (-not (Older $f.LastWriteTimeUtc $LogRetainDays)) { continue }
        $why = Allowed $f.FullName $repos $true; if ($why) { Skip $f.FullName $why; continue }
        Add-Plan $f.FullName $f.Length 'logs' "log unchanged for $([int]($now - $f.LastWriteTimeUtc).TotalDays) days" $true
      }
    }
    if ($isShots -and $Categories -contains 'shots') {
      $media = @($files | Where-Object { @('.png', '.jpg', '.jpeg', '.webm', '.mp4', '.zip') -contains $_.Extension.ToLowerInvariant() } | Sort-Object LastWriteTimeUtc -Descending)
      $i = 0
      foreach ($f in $media) {
        $i++; if ($i -le $KeepShots) { continue }
        if (-not (Older $f.LastWriteTimeUtc $TestRetainDays)) { continue }
        $why = Allowed $f.FullName $repos $true; if ($why) { Skip $f.FullName $why; continue }
        Add-Plan $f.FullName $f.Length 'shots' "screenshot/trace beyond the newest $KeepShots and older than $TestRetainDays days" $true
      }
    }
  }
}

# Worktrees: only those named explicitly, only when clean and fully pushed.
$wtPlan = @()
foreach ($w in $RemoveWorktree) {
  if (-not (Test-Path -LiteralPath $w)) { Skip $w 'worktree path not found'; continue }
  $wp = (Resolve-Path -LiteralPath $w).ProviderPath.TrimEnd('\', '/')
  $g = Get-GitState $wp
  if (-not $g.IsWorktree) { Skip $wp 'not a linked worktree (main checkouts are never removed)'; continue }
  if ($g.Dirty -gt 0 -or $g.Untracked -gt 0) { Skip $wp "has $($g.Dirty) changed and $($g.Untracked) untracked files"; continue }
  if ($g.Stashes -gt 0) { Skip $wp 'repository has stashes'; continue }
  if (-not $g.Upstream) { Skip $wp 'branch has no upstream (not pushed)'; continue }
  if ($g.Unpushed -gt 0) { Skip $wp "$($g.Unpushed) unpushed commit(s)"; continue }
  $m = Measure-Sum $wp
  $wtPlan += [pscustomobject]@{ Path = $wp; Bytes = $m.Bytes; Branch = $g.Branch }
}

# Do not plan anything nested inside something already planned.
$ordered = @($plan | Sort-Object { $_.Path.Length })
$final = New-Object System.Collections.Generic.List[object]
foreach ($p in $ordered) {
  $nested = $false
  foreach ($q in $final) { if (-not $q.IsFile -and $p.Path.StartsWith($q.Path + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { $nested = $true; break } }
  if (-not $nested) { $final.Add($p) }
}

$total = [long](($final | Measure-Object Bytes -Sum).Sum) + [long](($wtPlan | Measure-Object Bytes -Sum).Sum)
Log ""
Log ("{0}: {1} item(s), {2}" -f $mode, ($final.Count + $wtPlan.Count), (Format-Size $total))
foreach ($c in ($final | Group-Object Category)) { Log ("  {0,-7} {1,5} item(s)  {2}" -f $c.Name, $c.Count, (Format-Size (($c.Group | Measure-Object Bytes -Sum).Sum))) }
$removed = [long]0; $failed = 0
foreach ($p in ($final | Sort-Object Bytes -Descending)) {
  $line = "{0,10}  {1,-7} {2}" -f (Format-Size $p.Bytes), $p.Category, $p.Path
  if (-not $Apply) { Log "  would remove $line"; continue }
  $ok = $false
  try { if ($p.IsFile) { $ok = Remove-SafeFile $p.Path } else { $ok = Remove-SafeDirectory $p.Path } } catch { $ok = $false }
  if ($ok) { $removed += $p.Bytes; Log "  removed $line" } else { $failed++; Log "  FAILED  $line" }
}
foreach ($w in $wtPlan) {
  $line = "{0,10}  worktree {1} ({2})" -f (Format-Size $w.Bytes), $w.Path, $w.Branch
  if (-not $Apply) { Log "  would remove $line"; continue }
  $main = (& git --no-optional-locks -C $w.Path rev-parse --path-format=absolute --git-common-dir 2>$null)
  & git -C $w.Path worktree remove -- $w.Path 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0 -and -not (Test-Path -LiteralPath $w.Path)) {
    if ($main) { & git --git-dir $main worktree prune 2>&1 | Out-Null }
    $removed += $w.Bytes; Log "  removed $line (branch $($w.Branch) is kept on the remote)"
  } else { $failed++; Log "  FAILED  $line" }
}
if ($skipped.Count) {
  Log ""; Log "kept on purpose ($($skipped.Count)):"
  foreach ($s in ($skipped | Select-Object -First 60)) { Log "  kept  $($s.Path)  ($($s.Why))" }
  if ($skipped.Count -gt 60) { Log "  ... $($skipped.Count - 60) more" }
}
$after = Get-FreeSpace $Roots
Log ""
foreach ($f in $after) {
  $b = $before | Where-Object { $_.Drive -eq $f.Drive } | Select-Object -First 1
  $delta = 0; if ($b) { $delta = $f.Free - $b.Free }
  Log ("free after  {0}: {1} (change {2}{3})" -f $f.Drive, (Format-Size $f.Free), $(if ($delta -ge 0) { '+' } else { '-' }), (Format-Size ([math]::Abs($delta))))
}
if ($Apply) {
  # Own reports: keep the newest 20 of each kind.
  foreach ($pat in @('clean-*.log', 'audit-*.md', 'audit-*.json')) {
    foreach ($dir in @($reportFull, (Join-Path $reportFull 'reports'))) {
      if (-not (Test-Path -LiteralPath $dir)) { continue }
      Get-ChildItem -LiteralPath $dir -Filter $pat -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 20 | ForEach-Object { Remove-SafeFile $_.FullName | Out-Null }
    }
  }
  Log ("removed {0}; failures: {1}" -f (Format-Size $removed), $failed)
} else { Log 'dry run: nothing was deleted. Re-run with -Apply to delete the items above.' }
Log "log: $log"
if ($failed -gt 0) { exit 1 }
