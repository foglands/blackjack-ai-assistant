param([string] $SdkDirectory)

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The x64 .NET Framework C# compiler is unavailable.'
}

$assemblyNames = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')
$loaderRelativePath = 'runtimes\win-x64\native\WebView2Loader.dll'
if (-not $SdkDirectory) {
    $appDataRoots = @($env:LOCALAPPDATA, (Join-Path $env:USERPROFILE 'AppData\Local')) | Select-Object -Unique
    $SdkDirectory = $appDataRoots | ForEach-Object {
        $teamsAddIn = Join-Path $_ 'Microsoft\TeamsMeetingAdd-in'
        if (Test-Path -LiteralPath $teamsAddIn -PathType Container) {
            Get-ChildItem -LiteralPath $teamsAddIn -Directory |
                Where-Object Name -Match '^\d+(\.\d+){1,3}$' |
                Sort-Object { [version] $_.Name } -Descending |
                ForEach-Object { Join-Path $_.FullName 'x64' }
        }
    } | Where-Object { Test-Path -LiteralPath (Join-Path $_ $loaderRelativePath) -PathType Leaf } |
        Select-Object -First 1
}

if (-not $SdkDirectory) {
    throw 'No local WebView2 SDK was found. Pass -SdkDirectory with the path to the x64 SDK assemblies and loader.'
}

$sdkFiles = foreach ($name in ($assemblyNames + $loaderRelativePath)) {
    $path = Join-Path $SdkDirectory $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing SDK file: $path" }
    Get-Item -LiteralPath $path
}

$target = Join-Path $PSScriptRoot 'BlackjackLab.exe'
$source = Join-Path $PSScriptRoot 'BlackjackLab.cs'
$references = @('/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll') + @(
    $sdkFiles | Where-Object Name -In $assemblyNames | ForEach-Object { "/reference:$($_.FullName)" }
)
& $compiler /nologo /target:winexe /platform:x64 /codepage:65001 /optimize+ "/out:$target" @references $source
if ($LASTEXITCODE -ne 0) { throw "C# compilation failed with exit code $LASTEXITCODE." }

foreach ($file in $sdkFiles) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $PSScriptRoot $file.Name) -Force
}

Write-Output $target
