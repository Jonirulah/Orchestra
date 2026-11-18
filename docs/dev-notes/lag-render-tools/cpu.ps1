param([string]$Tag, [int]$Secs = 10)
# CPU (% de un núcleo) del renderizador y del navegador de WebView2 de la instancia <Tag>, y de orchestra.
$ps = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like "*run-$Tag\wv2*" }
$ids = @{}
foreach ($p in $ps) { $t = if ($p.CommandLine -match '--type=(\S+)') { $Matches[1] } else { 'browser' }; $ids[$p.ProcessId] = $t }
$a = @{}; foreach ($k in $ids.Keys) { try { $a[$k] = (Get-Process -Id $k).TotalProcessorTime.TotalMilliseconds } catch {} }
Start-Sleep -Seconds $Secs
$out = @{}
foreach ($k in $a.Keys) { try { $p = Get-Process -Id $k; $v = ($p.TotalProcessorTime.TotalMilliseconds - $a[$k]) / ($Secs * 10); $n = $ids[$k]; if ($out[$n]) { $out[$n] += $v } else { $out[$n] = $v }; if ($n -eq 'renderer') { $out['rendererMB'] = [math]::Round($p.WorkingSet64/1MB) } } catch {} }
($out.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$([math]::Round($_.Value,1))" }) -join ' '
