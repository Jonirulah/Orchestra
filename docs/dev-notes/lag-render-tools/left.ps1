$p = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*emu.cjs*') -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*lagr-test*') -or $_.Name -like 'orch-*' }
"quedan: " + @($p).Count
$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }