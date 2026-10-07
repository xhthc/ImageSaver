import { createRoot } from "react-dom/client"

import "@/index.css"
import { QuickApp } from "@/components/app/quick-app"
import { createQuick } from "@/core/quick.js"
import { getEnv } from "@/lib/env"

const env = getEnv()
// One controller per popup: it owns the storage listener and the preference read; React only renders it.
const quick = createQuick({ chrome: env.chrome, window: env.window })

createRoot(document.getElementById("root")!).render(<QuickApp quick={quick} />)
