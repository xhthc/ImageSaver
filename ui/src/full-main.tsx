import { createRoot } from "react-dom/client"

import "@/index.css"
import { FullApp } from "@/components/app/full-app"
import { createSettings } from "@/core/settings.js"
import { getEnv } from "@/lib/env"

const env = getEnv()
// One settings controller per page: the form state lives in it, so it survives switching between the panels.
const settings = createSettings({ chrome: env.chrome, FolderPath: env.FolderPath })
void settings.load()

createRoot(document.getElementById("root")!).render(<FullApp settings={settings} />)
