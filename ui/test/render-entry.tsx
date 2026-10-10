// Entry of the jsdom render tests (test_ui_render.js): bundles the real components with React into one classic script that the
// test evaluates in a jsdom window. Test-only; not part of the extension build.
import * as React from "react"
import { createRoot } from "react-dom/client"

import { QuickApp } from "@/components/app/quick-app"
import { FullApp } from "@/components/app/full-app"
import { ResultsList } from "@/components/app/results-list"
import { createLanguage } from "@/core/language.js"
import { createQuick } from "@/core/quick.js"
import { createSettings } from "@/core/settings.js"
import { I18nProvider } from "@/hooks/use-i18n"

/* eslint-disable @typescript-eslint/no-explicit-any */
;(globalThis as any).__ui = {
  React,
  createRoot,
  act: (React as any).act,
  QuickApp,
  FullApp,
  ResultsList,
  createQuick,
  createSettings,
  createLanguage,
  I18nProvider,
}
