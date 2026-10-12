import '../../../lib/folder_path.js';
import '../../../lib/export_directory.js';

export async function openStoredLocation(exportId) {
  const directory=globalThis.MediaLatchDirectory;
  const exporter=directory.createExporter({store:directory.database(globalThis.indexedDB),FolderPath:globalThis.ImageSaverFolderPath});
  const parent=await exporter.location(exportId);
  // shortcut: File System Access cannot reveal Explorer; use its native picker until a native host is explicitly requested.
  await globalThis.showOpenFilePicker({id:'medialatch-location',startIn:parent,multiple:false});
}
