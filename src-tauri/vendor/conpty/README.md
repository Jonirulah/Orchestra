# ConPTY (vendored)

Binaries from the official NuGet package **Microsoft.Windows.Console.ConPTY** (Microsoft, MIT license), from
the Windows Terminal project: https://github.com/microsoft/terminal

- Package version: **1.25.261109001** (file version 1.25.2611.09001), x64
- Source: https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/1.25.261109001/microsoft.windows.console.conpty.1.25.261109001.nupkg
- Both files carry a valid Authenticode signature from Microsoft Corporation (`Get-AuthenticodeSignature` = Valid).

| File | Path inside the package | SHA-256 |
| --- | --- | --- |
| `conpty.dll` | `runtimes/win-x64/native/conpty.dll` | `e971856f89748dc3b458125e9afdd79b5e9574a7c937676116d3cbbd3b71f492` |
| `OpenConsole.exe` | `build/native/runtimes/x64/OpenConsole.exe` | `b17e48b07ef153b420f0a6e178bacd31fb4c3390e21ae746586213fc0719a775` |

Why this version: newest stable (non-preview) release when it was vendored (2026-11). The package says it works on
Windows 10.0.17763 and later; the binaries only import inbox DLLs (API sets, UCRT, `icu.dll` from Windows 10 1903).

Why they are here: the console host of Windows 10 (builds 19041-19045) predates mouse support in ConPTY, so mouse
clicks never reach terminal apps. Orchestra embeds these two files in its executable and, on Windows 10, extracts
them to its data folder and uses them instead of the system ones (see `src/conpty_bundle.rs`).

To update: download the new package, check both signatures, replace the two files, and update the version and the
hashes here and in `src/conpty_bundle.rs` (a test fails if they disagree).

License: see `LICENSE` in this folder.
