import { createRoot } from "react-dom/client"

import "@/index.css"
import { FullApp } from "@/components/app/full-app"
import { createLanguage } from "@/core/language.js"
import { createSettings } from "@/core/settings.js"
import { I18nProvider } from "@/hooks/use-i18n"
import { getEnv } from "@/lib/env"

const env = getEnv()
// One settings controller per page: the form state lives in it, so it survives switching between the panels.
const settings = createSettings({ chrome: env.chrome, FolderPath: env.FolderPath })
void settings.load()
// The interface language: a switch re-renders the texts only; the settings form above keeps its unsaved edits.
const language = createLanguage({ chrome: env.chrome, navigator: env.navigator })

createRoot(document.getElementById("root")!).render(
  <I18nProvider language={language} titleKey="app.title">
    <FullApp settings={settings} />
  </I18nProvider>,
)
