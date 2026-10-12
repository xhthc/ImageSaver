# MediaLatch Explorer companion

Optional Windows companion for opening the actual parent folder of a completed
file saved through File System Access. Ordinary Chrome Downloads already use
`downloads.show` and do not require it. Both manager surfaces share the action;
it is independent of the site and media type.

The extension needs `nativeMessaging`. This companion has no service, admin
requirement, download transport or HTTP client. Its only desktop launch is the
Windows `explorer.exe` at a validated parent directory. It never opens media or
runs message-provided commands.

## Install for your extension

Download and extract `MediaLatch-Explorer-Windows-2.0.0.31-*.zip` from the
same GitHub release as the extension. Open PowerShell in the extracted companion
folder, then install for your actual extension ID:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId YOUR_32_LETTER_ID
```

The companion ZIP includes the executable, GPL licence, sources and build
instructions. For a source checkout, build with the Windows .NET Framework compiler:

```powershell
./native/windows/build.ps1 -Output ./local-notes/explorer-companion
./native/windows/install.ps1 -ExtensionId YOUR_32_LETTER_ID -HostExecutable ./local-notes/explorer-companion/MediaLatchExplorer.exe
```

Find the actual installed extension ID in `chrome://extensions` or Saving
settings. Installation allows only that exact origin; there are no wildcards.
It copies the executable and manifest under `%LOCALAPPDATA%/MediaLatch/Explorer`
and registers its own host name in the current user's Chrome/Chromium registry.
Saved media and browser preferences are not changed. Re-run for a changed ID.

Reload the extension. Save the chosen destination in Saving, then use **Link
folder to Explorer** and select the same base folder once. A temporary random
proof file in the browser-granted folder verifies the binding and is removed by
the worker even if the popup closes. Each destination has its own binding.

An optional `-RootPath 'D:\Media'` during installation sets a candidate base:
the first reveal binds it only when the fresh proof is present there. A name
alone never identifies a folder. Without a valid binding, a reveal shows recovery
instructions and does not fall back to the browser's file picker.

Relative path traversal, absolute file paths, invalid Windows components and
reparse points are refused. The relative file must still exist. Binding paths
stay in the companion's private local file; reports and statistics exclude them.
Moving a destination requires linking it again. Browser read/write access must
still be granted for the proof.

`uninstall.ps1` removes only registrations that point to this companion. It
retains helper files/bindings and all saved media. The companion sources are
GPL-3.0-only, as is the extension.
