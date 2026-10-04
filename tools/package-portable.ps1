[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ElectronDirectory,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$portableRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$portableElectron = (Resolve-Path -LiteralPath $ElectronDirectory).ProviderPath
$portableOutput = [IO.Path]::GetFullPath($OutputDirectory)
$portableGit = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$portableUtf8Bom = [Text.UTF8Encoding]::new($true)

function Invoke-PortableGit {
    param([string[]]$GitArguments)
    $portableGitOutput = @(& $portableGit -C $portableRepository @GitArguments)
    if ($LASTEXITCODE -ne 0) { throw "git failed: $($GitArguments -join ' ')" }
    return ($portableGitOutput -join "`n").Trim()
}

# Metadata and application files come from the same committed revision.
$portableCommit = Invoke-PortableGit -GitArguments @('rev-parse', '--verify', 'HEAD')
$portablePackage = (Invoke-PortableGit -GitArguments @('show', 'HEAD:package.json')) | ConvertFrom-Json
$portableVersion = [string]$portablePackage.version
if ($portableVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'The committed package version is not a safe release version.'
}
$portableElectronVersion = [IO.File]::ReadAllText((Join-Path $portableElectron 'version')).Trim()
if ($portableElectronVersion -ne [string]$portablePackage.devDependencies.electron) {
    throw 'Electron runtime version must exactly match the committed package.json.'
}
foreach ($portableRequired in @('electron.exe', 'LICENSE', 'LICENSES.chromium.html')) {
    if (-not (Test-Path -LiteralPath (Join-Path $portableElectron $portableRequired) -PathType Leaf)) {
        throw "Missing official Electron runtime file: $portableRequired"
    }
}

# Verify the supplied executable is Windows x64 without launching it.
$portableReader = [IO.BinaryReader]::new([IO.File]::OpenRead((Join-Path $portableElectron 'electron.exe')))
try {
    if ($portableReader.ReadUInt16() -ne 0x5A4D) { throw 'Electron is not a Windows executable.' }
    $portableReader.BaseStream.Position = 0x3C
    $portablePeOffset = $portableReader.ReadInt32()
    if ($portablePeOffset -lt 64 -or $portablePeOffset -gt $portableReader.BaseStream.Length - 6) {
        throw 'Invalid Electron executable header.'
    }
    $portableReader.BaseStream.Position = $portablePeOffset
    if ($portableReader.ReadUInt32() -ne 0x00004550 -or $portableReader.ReadUInt16() -ne 0x8664) {
        throw 'The portable release requires the Windows x64 Electron runtime.'
    }
} finally { $portableReader.Dispose() }

$portableBaseName = "CodexWhiteDragon-v$portableVersion-Windows-x64"
$portableZip = Join-Path $portableOutput ($portableBaseName + '.zip')
$portableChecksums = Join-Path $portableOutput ($portableBaseName + '-SHA256SUMS.txt')
foreach ($portableDestination in @($portableZip, $portableChecksums)) {
    if (Test-Path -LiteralPath $portableDestination) { throw "Output already exists: $portableDestination" }
}
if (Test-Path -LiteralPath $portableOutput) {
    if (-not (Test-Path -LiteralPath $portableOutput -PathType Container)) { throw 'OutputDirectory must be a directory.' }
} else { [void][IO.Directory]::CreateDirectory($portableOutput) }

# A unique staging directory is retained for inspection. No existing directory
# or release is deleted, reused, or overwritten, including after a failed run.
$portableStage = Join-Path $portableOutput ('.portable-stage-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $portableStage) { throw 'Unexpected staging directory collision.' }
[void][IO.Directory]::CreateDirectory($portableStage)
$portableBundle = Join-Path $portableStage 'CodexWhiteDragon'
$portableApp = Join-Path $portableBundle 'resources\app'
[void][IO.Directory]::CreateDirectory($portableApp)

try {
    foreach ($portableItem in (Get-ChildItem -LiteralPath $portableElectron -Force | Sort-Object Name)) {
        # Official resources/default_app.asar is replaced by our committed app.
        if ($portableItem.Name -in @('resources', 'version')) { continue }
        $portableName = $portableItem.Name
        if ($portableName -eq 'electron.exe') { $portableName = 'CodexWhiteDragon.exe' }
        if ($portableName -eq 'LICENSE') { $portableName = 'LICENSE.electron.txt' }
        Copy-Item -LiteralPath $portableItem.FullName -Destination (Join-Path $portableBundle $portableName) -Recurse
    }

    $portableSourceZip = Join-Path $portableStage 'committed-source.zip'
    [void](Invoke-PortableGit -GitArguments @('archive', '--format=zip', "--output=$portableSourceZip", 'HEAD', '--',
        'package.json', 'src', 'assets', 'THIRD-PARTY-NOTICES.txt'))
    $portableArchive = [IO.Compression.ZipFile]::OpenRead($portableSourceZip)
    try {
        $portableAppPrefix = $portableApp + [IO.Path]::DirectorySeparatorChar
        foreach ($portableEntry in $portableArchive.Entries) {
            $portableEntryName = $portableEntry.FullName.Replace('\', '/')
            if ($portableEntryName -notmatch '^(package\.json|THIRD-PARTY-NOTICES\.txt|src/.*|assets/.*)$') {
                throw "Unexpected source archive entry: $portableEntryName"
            }
            if ($portableEntryName -match '(^|/)(\.git|node_modules|auth\.json|settings\.json|history\.json|\.env(?:\.[^/]*)?)(/|$)') {
                throw "Local data must not enter a portable release: $portableEntryName"
            }
            $portableTarget = [IO.Path]::GetFullPath((Join-Path $portableApp $portableEntryName))
            if (-not $portableTarget.StartsWith($portableAppPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Source archive entry leaves the app directory: $portableEntryName"
            }
            if ($portableEntryName.EndsWith('/')) {
                [void][IO.Directory]::CreateDirectory($portableTarget)
                continue
            }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($portableTarget))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($portableEntry, $portableTarget, $false)
        }
    } finally { $portableArchive.Dispose() }

    $portableReadme = @"
Codex 白龙 $portableVersion — Windows x64 解压即用版

1. 将整个 ZIP 解压到一个文件夹，保留里面的目录结构。
2. 双击 CodexWhiteDragon.exe 启动。无需另装 Node.js，也无需运行安装程序。
3. 仍需本机已安装并登录 Codex，才能读取真实订阅额度。没有返回的数据不会估算。

平时只显示白龙；点击打开额度气泡，5秒后收起，再次点击重新计时。
悬停气泡暂停关闭，移开后重新计时；拖动只移动角色，不弹出气泡。
气泡底部的齿轮或右键白龙可打开设置。隐藏后可点击系统托盘图标显示。
要完全退出，请右键白龙或系统托盘图标，选择“退出白龙”。

设置与完成记录保存在当前用户的 %APPDATA%\CodexWhiteDragon。
便携版与安装版共用这些本机数据，并且同时只运行一个白龙实例。
若已有白龙运行，再双击本程序会显示已有实例；要切换版本，请先从托盘退出旧实例。
未绑定并核对账号时，不启动任务日志监控；账号不匹配时隐藏额度。
本包不创建桌面快捷方式、卸载项或开机启动项。
本工具非 OpenAI 官方产品。来源与第三方说明见 resources\app\THIRD-PARTY-NOTICES.txt。
Electron 与 Chromium 的许可文件保留在本目录。
"@
    [IO.File]::WriteAllText((Join-Path $portableBundle '先读我.txt'), $portableReadme, $portableUtf8Bom)
    $portableBuildInfo = @"
Application: Codex White Dragon
Version: $portableVersion
Source commit: $portableCommit
Electron: $portableElectronVersion
Platform: Windows x64
Source: git archive HEAD -- package.json src assets THIRD-PARTY-NOTICES.txt
"@
    [IO.File]::WriteAllText((Join-Path $portableBundle 'BUILD-INFO.txt'), $portableBuildInfo, $portableUtf8Bom)

    # Stable entry ordering and timestamps make repeat builds from the same
    # commit/runtime deterministic on the same PowerShell/.NET toolchain.
    $portableEpoch = [long](Invoke-PortableGit -GitArguments @('show', '-s', '--format=%ct', 'HEAD'))
    $portableZipTime = [DateTimeOffset]::FromUnixTimeSeconds($portableEpoch).ToUniversalTime()
    if ($portableZipTime.Year -lt 1980 -or $portableZipTime.Year -gt 2107) { throw 'Commit date is outside the ZIP timestamp range.' }
    [string[]]$portableFiles = @(Get-ChildItem -LiteralPath $portableBundle -Recurse -File -Force | ForEach-Object { $_.FullName })
    [Array]::Sort($portableFiles, [StringComparer]::Ordinal)
    $portableStream = [IO.File]::Open($portableZip, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $portableZipArchive = [IO.Compression.ZipArchive]::new($portableStream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($portableFile in $portableFiles) {
                $portableRelative = $portableFile.Substring($portableStage.Length + 1).Replace('\', '/')
                $portableZipEntry = $portableZipArchive.CreateEntry($portableRelative, [IO.Compression.CompressionLevel]::Optimal)
                $portableZipEntry.LastWriteTime = $portableZipTime
                $portableInput = [IO.File]::OpenRead($portableFile)
                $portableEntryStream = $portableZipEntry.Open()
                try { $portableInput.CopyTo($portableEntryStream) }
                finally { $portableEntryStream.Dispose(); $portableInput.Dispose() }
            }
        } finally { $portableZipArchive.Dispose() }
    } finally { $portableStream.Dispose() }

    $portableHash = (Get-FileHash -LiteralPath $portableZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $portableChecksumText = "$portableHash  $([IO.Path]::GetFileName($portableZip))`r`n"
    $portableChecksumStream = [IO.File]::Open($portableChecksums, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $portableChecksumBytes = [Text.Encoding]::ASCII.GetBytes($portableChecksumText)
        $portableChecksumStream.Write($portableChecksumBytes, 0, $portableChecksumBytes.Length)
    } finally { $portableChecksumStream.Dispose() }
    Write-Output "ZIP: $portableZip"
    Write-Output "SHA256: $portableChecksums"
    Write-Output "Source commit: $portableCommit"
    Write-Output "Staging retained: $portableStage"
} catch {
    Write-Warning "Packaging failed. Existing output and staging files were preserved: $portableStage"
    throw
}
