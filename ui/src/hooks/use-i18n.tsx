import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"

import { createLanguage } from "@/core/language.js"
import { translator } from "@/core/i18n.js"
import { useStore } from "@/hooks/use-store"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type LanguageController = ReturnType<typeof createLanguage>
type Translator = ReturnType<typeof translator> & { language: LanguageController | null }

const I18nContext = createContext<Translator>({ ...translator("en"), language: null })

/**
 * Provides the page language to every component. The document language and (optionally) the page title follow it, so screen
 * readers and the browser switch together with the visible text.
 */
export function I18nProvider({ language, titleKey, children }: { language: LanguageController; titleKey?: string; children: ReactNode }) {
  const s: any = useStore(language.store)
  const value = useMemo(() => ({ ...translator(s.lang), language }), [s.lang, language])
  useEffect(() => {
    try {
      document.documentElement.lang = value.lang
      if (titleKey) document.title = value.t(titleKey)
    } catch {
      /* no document (tests): nothing to update */
    }
  }, [value, titleKey])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** The current language: `t(key, vars)`, `msg(storedMessage)`, `lang`, `locale` and the language controller. */
export function useI18n(): Translator {
  return useContext(I18nContext)
}
