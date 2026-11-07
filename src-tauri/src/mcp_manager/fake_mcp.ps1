# Servidor MCP falso para las pruebas de mcp_manager (stdio, JSON por lineas).
# (Solo ASCII: PowerShell 5.1 lee los .ps1 sin BOM como ANSI.)
# FAKE_MODE: ok | hang (lee y no contesta) | fail (escribe en stderr y sale con 3)
# FAKE_PID_FILE: si existe, lanza un hijo (ping largo) y escribe su PID ahi, para comprobar que se mata el arbol.
$mode = $env:FAKE_MODE
if ($env:FAKE_PID_FILE) {
    $si = New-Object System.Diagnostics.ProcessStartInfo
    $si.FileName = "$env:SystemRoot\System32\PING.EXE"
    $si.Arguments = '-n 120 127.0.0.1'
    $si.UseShellExecute = $false
    $si.CreateNoWindow = $true
    $si.RedirectStandardOutput = $true
    $p = [System.Diagnostics.Process]::Start($si)
    [System.IO.File]::WriteAllText($env:FAKE_PID_FILE, [string]$p.Id)
}
if ($mode -eq 'fail') {
    [Console]::Error.WriteLine("fatal: invalid configuration value $env:FAKE_SECRET")
    exit 3
}
$in = [Console]::In
while ($true) {
    $line = $in.ReadLine()
    if ($null -eq $line) { break }
    if ($mode -eq 'hang') { continue }
    $m = $line | ConvertFrom-Json
    if ($null -eq $m.id) { continue }
    if ($m.method -eq 'initialize') {
        $r = @{ jsonrpc = '2.0'; id = $m.id; result = @{ protocolVersion = '2025-06-18'; capabilities = @{ tools = @{} }; serverInfo = @{ name = 'fake-mcp'; version = '1.2.3' } } }
    } elseif ($m.method -eq 'tools/list') {
        $r = @{ jsonrpc = '2.0'; id = $m.id; result = @{ tools = @(@{ name = 'a' }, @{ name = 'b' }, @{ name = 'c' }) } }
    } else {
        $r = @{ jsonrpc = '2.0'; id = $m.id; error = @{ code = -32601; message = 'nope' } }
    }
    [Console]::Out.WriteLine(($r | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
}
