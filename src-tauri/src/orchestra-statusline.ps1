# Orchestra statusline wrapper (PowerShell 5.1). ASCII-only on purpose: PS 5.1 reads
# BOM-less files as ANSI. Claude Code pipes a JSON to this script on stdin.
#  1) it saves the usage limits (rate_limits) to ..\quota\<account>.json for Orchestra;
#  2) it runs the user's ORIGINAL statusline command with the same stdin and relays its
#     stdout bytes untouched.
# It never throws: on any error it just behaves like the original statusline.
# Speed: when the original is "powershell ... -File x.ps1" and reads stdin with
# [Console]::OpenStandardInput() (as the usual PowerShell statuslines do), it is run in this
# same process (no second PowerShell start-up); otherwise it runs as a child process.
$ErrorActionPreference = 'SilentlyContinue'
$inv  = [System.Globalization.CultureInfo]::InvariantCulture
$utf8 = New-Object System.Text.UTF8Encoding($false)

# --- raw stdin bytes (relayed as they are) ---
$bytes = New-Object byte[] 0
try {
    $ms = New-Object System.IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($ms)
    $bytes = $ms.ToArray()
} catch { }

$d = $null
try {
    $txt = $utf8.GetString($bytes).TrimStart([char]0xFEFF)
    if ($txt.Trim()) { $d = $txt | ConvertFrom-Json }
} catch { $d = $null }

# --- the user's own statusline command: project settings first, then the account folder ---
$cfg = $env:CLAUDE_CONFIG_DIR
if (-not $cfg) { $cfg = Join-Path $env:USERPROFILE '.claude' }
$files = @()
try {
    $proj = $null
    if ($d -and $d.workspace -and $d.workspace.project_dir) { $proj = [string]$d.workspace.project_dir }
    elseif ($d -and $d.cwd) { $proj = [string]$d.cwd }
    if ($proj) {
        $files += (Join-Path $proj '.claude\settings.local.json')
        $files += (Join-Path $proj '.claude\settings.json')
    }
} catch { }
$files += (Join-Path $cfg 'settings.json')
$orig = $null
foreach ($f in $files) {
    try {
        if (Test-Path -LiteralPath $f) {
            $s = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($s.statusLine -and $s.statusLine.command) { $orig = [string]$s.statusLine.command; break }
        }
    } catch { }
}

# --- fast path: original is a PowerShell -File script that reads stdin the usual way ---
$code = $null
try {
    if ($orig -and ($orig -imatch '^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:.*?\s)?-File\s+(?:"([^"]+)"|(\S+))\s*$') -and ($orig -inotmatch '-Command')) {
        $path = $(if ($Matches[1]) { $Matches[1] } else { $Matches[2] })
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $src = [System.IO.File]::ReadAllText($path, $utf8)
            $idiom = '[Console]::OpenStandardInput()'
            $hits = ($src.Split(@($idiom), [System.StringSplitOptions]::None).Count - 1)
            if (($hits -eq 1) -and ($src -inotmatch 'PSScriptRoot|PSCommandPath|MyInvocation|\$args|\$input')) {
                $code = [scriptblock]::Create($src.Replace($idiom, '$global:OrchIn'))
            }
        }
    }
} catch { $code = $null }

# --- start the original as a child now so it runs while we save the quota ---
$p = $null
if ($orig -and -not $code) {
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $(if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' })
        $psi.Arguments = '/d /s /c "' + $orig + '"'
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $p.StandardInput.Close()
    } catch { }
}

# --- save the usage limits ---
function Read-Win($w, $old) {
    if ($null -eq $w) { return $old }
    try {
        $u = [double]$w.used_percentage
        $r = [double]$w.resets_at
        if ([double]::IsNaN($u) -or [double]::IsNaN($r) -or $r -le 0) { return $old }
        if ($r -gt 100000000000) { $r = $r / 1000 }
        if ($u -lt 0) { $u = 0 }
        if ($u -gt 100) { $u = 100 }
        return [pscustomobject]@{ used = $u; resetsAt = [math]::Floor($r) }
    } catch { return $old }
}
function Win-Json($w) {
    return '{"used":' + $w.used.ToString('0.##', $inv) + ',"resetsAt":' + $w.resetsAt.ToString('0', $inv) + '}'
}
try {
    if ($d -and $null -ne $d.rate_limits) {
        $acct = $env:ORCHESTRA_ACCOUNT
        if (-not $acct -and $env:CLAUDE_CONFIG_DIR) { $acct = (Split-Path -Leaf $env:CLAUDE_CONFIG_DIR).ToLower() }
        $acct = (([string]$acct) -replace '[^A-Za-z0-9_-]+', '-').Trim('-')
        if ($acct) {
            $dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'quota'
            [void](New-Item -ItemType Directory -Force -Path $dir)
            $dest = Join-Path $dir ($acct + '.json')
            $oldFive = $null; $oldSeven = $null; $oldLimits = $null
            try {
                if (Test-Path -LiteralPath $dest) {
                    $o = Get-Content -LiteralPath $dest -Raw -Encoding UTF8 | ConvertFrom-Json
                    $oldFive = Read-Win ([pscustomobject]@{ used_percentage = $o.fiveHour.used; resets_at = $o.fiveHour.resetsAt }) $null
                    $oldSeven = Read-Win ([pscustomobject]@{ used_percentage = $o.sevenDay.used; resets_at = $o.sevenDay.resetsAt }) $null
                    # extra limits come only from Orchestra's optional usage query; keep them as they are
                    if ($o.limits) { $oldLimits = ConvertTo-Json -InputObject @($o.limits) -Compress -Depth 5 }
                }
            } catch { }
            $five = Read-Win $d.rate_limits.five_hour $oldFive
            $seven = Read-Win $d.rate_limits.seven_day $oldSeven
            if ($five -or $seven) {
                $parts = @()
                if ($five) { $parts += '"fiveHour":' + (Win-Json $five) }
                if ($seven) { $parts += '"sevenDay":' + (Win-Json $seven) }
                if ($oldLimits) { $parts += '"limits":' + $oldLimits }
                $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
                $parts += '"at":' + $now.ToString('0', $inv)
                $tmp = $dest + '.' + $PID + '.tmp'
                [System.IO.File]::WriteAllText($tmp, '{' + ($parts -join ',') + '}', $utf8)
                Move-Item -LiteralPath $tmp -Destination $dest -Force
                # last raw rate_limits block, to check the real payload shape by eye
                [System.IO.File]::WriteAllText((Join-Path $dir ($acct + '.raw.txt')), ($d.rate_limits | ConvertTo-Json -Compress -Depth 6), $utf8)
            }
        }
    }
} catch { }

# --- run the original / relay its stdout bytes unchanged ---
try {
    if ($code) {
        $global:OrchIn = New-Object System.IO.MemoryStream(, $bytes)
        & $code
    } elseif ($p) {
        $out = [Console]::OpenStandardOutput()
        $p.StandardOutput.BaseStream.CopyTo($out)
        $out.Flush()
        $p.WaitForExit()
    }
} catch { }
exit 0
