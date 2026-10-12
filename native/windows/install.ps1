param([Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,[string]$RootPath='',[string]$HostExecutable=(Join-Path $PSScriptRoot 'MediaLatchExplorer.exe'))
$ErrorActionPreference='Stop'
if(-not (Test-Path -LiteralPath $HostExecutable)){throw 'Build or extract MediaLatchExplorer.exe first'}
if($RootPath){$RootPath=(Get-Item -LiteralPath $RootPath).FullName;if(-not (Test-Path -LiteralPath $RootPath -PathType Container)){throw 'Destination must be an existing directory'}}
$taskHome=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MediaLatch/Explorer'
New-Item -ItemType Directory -Force -Path $taskHome | Out-Null
$taskExe=Join-Path $taskHome 'MediaLatchExplorer.exe';$taskManifest=Join-Path $taskHome 'MediaLatchExplorer.json'
Copy-Item -LiteralPath $HostExecutable -Destination $taskExe -Force
@{name='net.medialatch.explorer';description='MediaLatch Explorer folder reveal';path=$taskExe;type='stdio';allowed_origins=@('chrome-extension://'+$ExtensionId+'/');default_root=$RootPath} | ConvertTo-Json | Set-Content -LiteralPath $taskManifest -Encoding utf8
foreach($taskBrowser in @('Google\Chrome','Chromium')){
    $taskKey=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\'+$taskBrowser+'\NativeMessagingHosts\net.medialatch.explorer')
    try{$taskKey.SetValue('',$taskManifest,[Microsoft.Win32.RegistryValueKind]::String)}finally{$taskKey.Dispose()}
}
Write-Output ('Installed Explorer helper for '+$ExtensionId+'; no admin/service/network required')
