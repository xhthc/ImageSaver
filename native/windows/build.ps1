param([string]$Output = (Join-Path $PSScriptRoot '../../local-notes/checks/explorer-location02/host'))
$ErrorActionPreference='Stop'
$taskOutput=[IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(-not (Test-Path -LiteralPath $taskCompiler)){throw '.NET Framework C# compiler is unavailable'}
$taskArguments=@('/nologo','/target:exe','/optimize+','/r:System.Web.Extensions.dll','/r:System.Windows.Forms.dll',('/out:'+(Join-Path $taskOutput 'MediaLatchExplorer.exe')),(Join-Path $PSScriptRoot 'ExplorerHost.cs'))
& $taskCompiler @taskArguments
if($LASTEXITCODE -ne 0){throw 'Native helper compilation failed'}
Write-Output ('Built '+(Join-Path $taskOutput 'MediaLatchExplorer.exe'))
