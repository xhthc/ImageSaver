$ErrorActionPreference='Stop'
$taskManifest=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MediaLatch/Explorer/MediaLatchExplorer.json'
foreach($taskBrowser in @('Google\Chrome','Chromium')){
    $taskName='Software\'+$taskBrowser+'\NativeMessagingHosts\net.medialatch.explorer'
    $taskKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($taskName)
    try{$taskOwned=$taskKey -and $taskKey.GetValue('') -eq $taskManifest}finally{if($taskKey){$taskKey.Dispose()}}
    if($taskOwned){[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($taskName,$false)}
}
Write-Output 'Removed native host registration; saved media and companion files are retained'
