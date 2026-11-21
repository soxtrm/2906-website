# Shared functions for the NEXUS development storage audit and cleanup.
# Windows PowerShell 5.1 compatible (no ?? / ternary / pipeline-chain operators).
# Nothing in this module deletes anything; Remove-SafeDirectory/Remove-SafeFile
# are only called by dev-clean.ps1 when it runs with -Apply.

Set-StrictMode -Version 2

$script:IsWin = [System.IO.Path]::DirectorySeparatorChar -eq '\'

# Directory names with a known, regenerable purpose. They are measured as one
# block (not descended into for the report) and classified by name.
$script:DirKinds = @{
  'node_modules'     = @{ Category = 'deps';           Why = 'npm dependencies of this project/worktree; npm ci recreates them' }
  '.pnpm-store'      = @{ Category = 'deps';           Why = 'pnpm package store' }
  '.next'            = @{ Category = 'build-cache';    Why = 'Next.js build/dev output; next build or next dev recreates it' }
  '.turbo'           = @{ Category = 'build-cache';    Why = 'Turborepo cache' }
  '.vite'            = @{ Category = 'build-cache';    Why = 'Vite dependency pre-bundle cache' }
  '.parcel-cache'    = @{ Category = 'build-cache';    Why = 'Parcel cache' }
  '.nuxt'            = @{ Category = 'build-cache';    Why = 'Nuxt build output' }
  '.svelte-kit'      = @{ Category = 'build-cache';    Why = 'SvelteKit build output' }
  '__pycache__'      = @{ Category = 'build-cache';    Why = 'Python bytecode cache' }
  '.pytest_cache'    = @{ Category = 'build-cache';    Why = 'pytest cache' }
  '.mypy_cache'      = @{ Category = 'build-cache';    Why = 'mypy cache' }
  '.ruff_cache'      = @{ Category = 'build-cache';    Why = 'ruff cache' }
  'coverage'         = @{ Category = 'build-cache';    Why = 'test coverage report' }
  '.nyc_output'      = @{ Category = 'build-cache';    Why = 'nyc coverage data' }
  'playwright-report'= @{ Category = 'test-artifacts'; Why = 'Playwright HTML report from an earlier run' }
  'test-results'     = @{ Category = 'test-artifacts'; Why = 'Playwright traces/screenshots/videos from an earlier run' }
  'blob-report'      = @{ Category = 'test-artifacts'; Why = 'Playwright blob report' }
  '.git'             = @{ Category = 'git';            Why = 'Git history and objects (keep)' }
}
# Generated output whose value is unclear without looking: listed for review only.
$script:ReviewNames = @{
  'dist' = 'build output (may be needed for a release)'; 'build' = 'build output (may be needed for a release)'
  'out' = 'export/build output'; '.output' = 'build output'; 'shots' = 'screenshots from test or demo runs'
  'screenshots' = 'screenshots from test or demo runs'; 'traces' = 'browser traces'; 'videos' = 'recorded test videos'
  'evidence' = 'evidence screenshots/logs referenced by reports (often valuable)'; 'logs' = 'log files'
}

# Never deleted by any rule, and reported only as counts/paths (never contents).
$script:ProtectedPattern = '(?i)(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|known_hosts|.*\.kdbx|.*\.sqlite3?|.*\.db|.*\.sql(\.gz)?|.*\.dump|.*credential.*|.*secret.*|.*backup.*|.*\.bak(\.\d+)?|.*\.bak\..*|\.ssh)$'
$script:ProtectedDirPattern = '(?i)(^|[\\/])(\.ssh|backups?|.*-backups?|db-backups?|.*credentials?.*|secrets?)([\\/]|$)'

function Get-DirKindWhy([string]$Kind) { if ($script:DirKinds.ContainsKey($Kind)) { return $script:DirKinds[$Kind].Why }; return 'generated folder' }

function Test-Protected([string]$Path) {
  return ($Path -match $script:ProtectedPattern) -or ($Path -match $script:ProtectedDirPattern)
}

function Format-Size([double]$Bytes) {
  if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
  if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
  return ('{0} B' -f [long]$Bytes)
}

function Get-FreeSpace([string[]]$Paths) {
  $seen = @{}; $out = @()
  foreach ($p in $Paths) {
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { continue }
    try {
      $root = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $p).ProviderPath)
      if ($seen.ContainsKey($root)) { continue }; $seen[$root] = 1
      $d = New-Object System.IO.DriveInfo $root
      $out += [pscustomobject]@{ Drive = $root; Free = [long]$d.AvailableFreeSpace; Size = [long]$d.TotalSize }
    } catch { }
  }
  return $out
}

# Sum of a subtree without recording its directories; never follows links/junctions.
function Measure-Sum([string]$Path) {
  $total = [long]0; $files = 0; $newest = [datetime]::MinValue; $errors = 0
  $stack = New-Object System.Collections.Generic.Stack[string]
  $stack.Push($Path)
  while ($stack.Count -gt 0) {
    $p = $stack.Pop()
    try {
      foreach ($e in (New-Object System.IO.DirectoryInfo $p).EnumerateFileSystemInfos()) {
        if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        if ($e -is [System.IO.DirectoryInfo]) { $stack.Push($e.FullName); continue }
        $total += $e.Length; $files++
        if ($e.LastWriteTimeUtc -gt $newest) { $newest = $e.LastWriteTimeUtc }
      }
    } catch { $errors++ }
  }
  return [pscustomobject]@{ Bytes = $total; Files = $files; NewestUtc = $newest; Errors = $errors }
}

# Walks a root once. Records every ordinary directory with its subtree size,
# measures known generated folders as single blocks, keeps files >= BigFile,
# and notes Git repositories/worktrees. Never follows reparse points.
function Measure-Tree([string]$Root, [long]$BigFile = 25MB) {
  $dirs = New-Object System.Collections.Generic.List[object]
  $big = New-Object System.Collections.Generic.List[object]
  $repos = New-Object System.Collections.Generic.List[string]
  $protected = New-Object System.Collections.Generic.List[string]
  $stack = New-Object System.Collections.Generic.Stack[object]
  $rootFull = (Resolve-Path -LiteralPath $Root).ProviderPath.TrimEnd('\', '/')
  $stack.Push(@($rootFull, -1, 0))
  while ($stack.Count -gt 0) {
    $t = $stack.Pop(); $path = $t[0]; $parent = $t[1]; $depth = $t[2]
    $name = Split-Path -Leaf $path
    $rec = [pscustomobject]@{ Path = $path; Parent = $parent; Depth = $depth; Own = [long]0; Total = [long]0; Files = 0; NewestUtc = [datetime]::MinValue; Kind = $null; Errors = 0 }
    $idx = $dirs.Count; $dirs.Add($rec)
    if ($depth -gt 0 -and $script:DirKinds.ContainsKey($name)) {
      $s = Measure-Sum $path
      $rec.Kind = $name; $rec.Own = $s.Bytes; $rec.Files = $s.Files; $rec.NewestUtc = $s.NewestUtc; $rec.Errors = $s.Errors
      if ($name -eq '.git') { $repos.Add((Split-Path -Parent $path)) }
      continue
    }
    try {
      foreach ($e in (New-Object System.IO.DirectoryInfo $path).EnumerateFileSystemInfos()) {
        if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        if ($e -is [System.IO.DirectoryInfo]) { $stack.Push(@($e.FullName, $idx, ($depth + 1))); continue }
        if ($e.Name -eq '.git') { $repos.Add($path) }   # worktree: .git is a file
        $rec.Own += $e.Length; $rec.Files++
        if ($e.LastWriteTimeUtc -gt $rec.NewestUtc) { $rec.NewestUtc = $e.LastWriteTimeUtc }
        if ($e.Length -ge $BigFile) { $big.Add([pscustomobject]@{ Path = $e.FullName; Bytes = [long]$e.Length; LastWriteUtc = $e.LastWriteTimeUtc }) }
        if (Test-Protected $e.FullName) { $protected.Add($e.FullName) }
      }
    } catch { $rec.Errors++ }
  }
  # Children always come after their parent, so one reverse pass sums subtrees.
  for ($i = $dirs.Count - 1; $i -ge 0; $i--) {
    $d = $dirs[$i]; $d.Total += $d.Own
    if ($d.Parent -ge 0) {
      $p = $dirs[$d.Parent]; $p.Total += $d.Total; $p.Files += $d.Files
      if ($d.NewestUtc -gt $p.NewestUtc) { $p.NewestUtc = $d.NewestUtc }
    }
  }
  return [pscustomobject]@{ Root = $rootFull; Dirs = $dirs; BigFiles = $big; Repos = $repos; Protected = $protected }
}

function Test-GitAvailable { return [bool](Get-Command git -ErrorAction SilentlyContinue) }

# State of one checkout; never changes anything.
function Get-GitState([string]$Path) {
  $r = [ordered]@{ Path = $Path; IsWorktree = $false; Branch = $null; Dirty = $null; Untracked = $null; Unpushed = $null; Upstream = $null; Stashes = $null; LastCommitUtc = $null; Error = $null }
  try {
    $r.IsWorktree = (Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Leaf)
    $r.Branch = (& git --no-optional-locks -C $Path rev-parse --abbrev-ref HEAD 2>$null)
    $st = @(& git --no-optional-locks -C $Path status --porcelain --untracked-files=normal 2>$null)
    $r.Dirty = @($st | Where-Object { $_ -and -not $_.StartsWith('??') }).Count
    $r.Untracked = @($st | Where-Object { $_ -and $_.StartsWith('??') }).Count
    $up = (& git --no-optional-locks -C $Path rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $up) { $r.Upstream = $up; $r.Unpushed = [int](& git --no-optional-locks -C $Path rev-list --count '@{u}..HEAD' 2>$null) }
    $r.Stashes = @(& git --no-optional-locks -C $Path stash list 2>$null).Count
    $ts = (& git --no-optional-locks -C $Path log -1 --format=%ct 2>$null)
    if ($ts) { $r.LastCommitUtc = ([datetime]'1970-01-01').AddSeconds([double]$ts) }
  } catch { $r.Error = $_.Exception.Message }
  return [pscustomobject]$r
}

# Is this path ignored by the Git checkout that contains it? $null when not in a repo.
function Test-GitIgnored([string]$Path, [string[]]$Repos) {
  $repo = $null
  foreach ($r in $Repos) {
    $prefix = $r.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if ($Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { if (-not $repo -or $r.Length -gt $repo.Length) { $repo = $r } }
  }
  if (-not $repo) { return $null }
  & git --no-optional-locks -C $repo check-ignore -q -- $Path 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Test-UnderRoots([string]$Path, [string[]]$Roots) {
  foreach ($r in $Roots) {
    $prefix = $r.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if ($Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# Deletes a directory without following junctions/symlinks (removes the link, not the target).
function Remove-SafeDirectory([string]$Path) {
  if ($script:IsWin) {
    $long = $Path; if (-not $long.StartsWith('\\?\')) { $long = '\\?\' + $Path }
    & cmd.exe /d /c "rmdir /s /q `"$long`"" 2>$null | Out-Null
    return -not (Test-Path -LiteralPath $Path)
  }
  [System.IO.Directory]::Delete($Path, $true)
  return -not (Test-Path -LiteralPath $Path)
}

function Remove-SafeFile([string]$Path) {
  [System.IO.File]::Delete($Path)
  return -not (Test-Path -LiteralPath $Path)
}

function Get-DefaultRoots {
  $roots = @()
  if ($script:IsWin) {
    $roots += 'D:\2906'
    if ($env:USERPROFILE) { $roots += (Join-Path $env:USERPROFILE '.claude'); $roots += (Join-Path $env:USERPROFILE '.codex') }
    if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'Temp\claude'); $roots += (Join-Path $env:LOCALAPPDATA 'ms-playwright'); $roots += (Join-Path $env:LOCALAPPDATA 'npm-cache') }
  }
  return @($roots | Where-Object { Test-Path -LiteralPath $_ })
}

# What a directory is and how to treat it.
#   Class: Safe (regenerable) | Verify | Important | Protected
function Get-Classification($Rec, [hashtable]$GitByPath) {
  $p = $Rec.Path; $name = Split-Path -Leaf $p
  if (Test-Protected $p) { return @{ Class = 'Protected'; Category = 'protected'; Why = 'credentials, database or backup by name: never deleted' } }
  if ($Rec.Kind) {
    $k = $script:DirKinds[$Rec.Kind]
    $class = 'Safe'; if ($k.Category -eq 'git') { $class = 'Important' }
    return @{ Class = $class; Category = $k.Category; Why = $k.Why }
  }
  if ($p -match '(?i)[\\/]Temp[\\/]claude[\\/]') { return @{ Class = 'Safe'; Category = 'agent-temp'; Why = 'Claude Code scratchpad/task output from a session' } }
  if ($p -match '(?i)[\\/]\.claude[\\/]projects([\\/]|$)') { return @{ Class = 'Verify'; Category = 'session-logs'; Why = 'Claude Code conversation transcripts (history; Claude prunes them after cleanupPeriodDays)' } }
  if ($p -match '(?i)[\\/]\.codex[\\/](sessions|log|logs)([\\/]|$)') { return @{ Class = 'Verify'; Category = 'session-logs'; Why = 'Codex session logs' } }
  if ($p -match '(?i)[\\/]ms-playwright([\\/]|$)') { return @{ Class = 'Verify'; Category = 'browsers'; Why = 'Playwright browser downloads (old versions can go once no project pins them)' } }
  if ($p -match '(?i)[\\/]npm-cache([\\/]|$)') { return @{ Class = 'Safe'; Category = 'pkg-cache'; Why = 'npm download cache; npm cache clean --force or npm cache verify' } }
  if ($GitByPath -and $GitByPath.ContainsKey($p)) {
    $g = $GitByPath[$p]
    $kind = 'Git checkout'; if ($g.IsWorktree) { $kind = 'Git worktree' }
    if (($g.Dirty -gt 0) -or ($g.Untracked -gt 0) -or ($g.Unpushed -gt 0) -or ($g.Stashes -gt 0) -or (-not $g.Upstream)) {
      return @{ Class = 'Important'; Category = 'repo'; Why = ('{0} ({1}): {2} changed, {3} untracked, {4} unpushed, {5} stashes{6}' -f $kind, $g.Branch, $g.Dirty, $g.Untracked, $g.Unpushed, $g.Stashes, $(if (-not $g.Upstream) { ', no upstream' } else { '' })) }
    }
    return @{ Class = 'Verify'; Category = 'repo'; Why = ('{0} ({1}): clean and pushed; removable only after confirming it is not in use' -f $kind, $g.Branch) }
  }
  if ($script:ReviewNames.ContainsKey($name)) { return @{ Class = 'Verify'; Category = 'review'; Why = $script:ReviewNames[$name] } }
  return @{ Class = 'Important'; Category = 'source'; Why = 'project files' }
}

Export-ModuleMember -Function *
