$ErrorActionPreference = 'Stop'
$whiteDragonInstall = [IO.Path]::GetFullPath($PSScriptRoot)
$whiteDragonExpected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\CodexWhiteDragon'))
if ($whiteDragonInstall -ne $whiteDragonExpected) { throw 'Uninstaller is not in the registered installation directory.' }
$whiteDragonExe = Join-Path $whiteDragonInstall 'CodexWhiteDragon.exe'
Get-CimInstance Win32_Process -Filter "Name='CodexWhiteDragon.exe'" | Where-Object { $_.ExecutablePath -eq $whiteDragonExe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$whiteDragonShell = New-Object -ComObject WScript.Shell
foreach ($whiteDragonFolder in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))) {
    $whiteDragonLink = Join-Path $whiteDragonFolder 'Codex 白龙.lnk'
    if (Test-Path -LiteralPath $whiteDragonLink) {
        if ($whiteDragonShell.CreateShortcut($whiteDragonLink).TargetPath -eq $whiteDragonExe) { Remove-Item -LiteralPath $whiteDragonLink -Force }
    }
}
$whiteDragonRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexWhiteDragon'
if (Test-Path -LiteralPath $whiteDragonRegistry) { Remove-Item -LiteralPath $whiteDragonRegistry -Recurse -Force }
# The resolved target was checked against the exact per-user installation above.
Remove-Item -LiteralPath $whiteDragonInstall -Recurse -Force
Write-Host 'Codex 白龙已卸载。本机设置和完成记录已保留。'
