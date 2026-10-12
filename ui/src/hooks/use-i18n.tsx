import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react"

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
  const previous = useRef<{ lang: string; ready: boolean } | null>(null)
  useLayoutEffect(() => {
    const changed = previous.current?.ready && previous.current.lang !== value.lang
    previous.current = { lang: value.lang, ready: s.ready }
    try {
      document.documentElement.lang = value.lang
      if (titleKey) document.title = value.t(titleKey)
      const page = document.querySelector<HTMLElement>("[data-popup]")
      if (!changed || !page?.animate) return
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
      if (reduced.matches) return
      const style = getComputedStyle(page)
      const duration = style.getPropertyValue("--motion-normal").trim() || "180ms"
      // Animate the committed text, preserving mounted controls and their focus/drafts.
      const animation = page.animate([{ opacity: 0.65 }, { opacity: 1 }], {
        duration: parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000),
        easing: style.getPropertyValue("--motion-enter").trim() || "ease-out",
      })
      const stop = () => { if (reduced.matches) animation.cancel() }
      reduced.addEventListener("change", stop)
      return () => {
        reduced.removeEventListener("change", stop)
        animation.cancel()
      }
    } catch {
      /* Presentation is optional when the document or animation API is unavailable. */
    }
  }, [value, titleKey, s.ready])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** The current language: `t(key, vars)`, `msg(storedMessage)`, `lang`, `locale` and the language controller. */
export function useI18n(): Translator {
  return useContext(I18nContext)
}
