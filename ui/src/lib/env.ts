// The extension globals the pages rely on. lib/folder_path.js and lib/feedback.js are classic scripts that the page HTML
// loads before the bundle: the background uses the very same files, so the rules are never duplicated in the UI.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Env = {
  chrome: any
  FB: any
  FolderPath: any
  navigator: any
  window: any
  location: Location
}

export function getEnv(): Env {
  const g = globalThis as any
  return {
    chrome: g.chrome,
    FB: g.ImageSaverFeedback,
    FolderPath: g.ImageSaverFolderPath,
    navigator: g.navigator,
    window: g.window ?? g,
    location: g.location,
  }
}
