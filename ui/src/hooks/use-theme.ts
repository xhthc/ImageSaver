import { useEffect, useState } from "react"
import { createTheme } from "@/core/theme.js"
import { getEnv } from "@/lib/env"

export function useTheme() {
  const [controller, setController] = useState<ReturnType<typeof createTheme> | null>(null)
  useEffect(() => {
    const env = getEnv()
    const theme = createTheme({ chrome: env.chrome, document: env.window.document })
    setController(theme)
    return () => theme.dispose()
  }, [])
  return controller
}
