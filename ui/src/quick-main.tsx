import { createRoot } from "react-dom/client"

import "@/index.css"
import { QuickApp } from "@/components/app/quick-app"
import { createLanguage } from "@/core/language.js"
import { createQuick } from "@/core/quick.js"
import { I18nProvider } from "@/hooks/use-i18n"
import { getEnv } from "@/lib/env"

const env = getEnv()
// Navigation is independent of recording preferences; the manager owns its live subscription.
const quick = createQuick({ chrome: env.chrome, window: env.window })
// The interface language (saved preference, else the browser language); it changes live with the other extension pages.
const language = createLanguage({ chrome: env.chrome, navigator: env.navigator })

createRoot(document.getElementById("root")!).render(
  <I18nProvider language={language}>
    <QuickApp quick={quick} />
  </I18nProvider>,
)
