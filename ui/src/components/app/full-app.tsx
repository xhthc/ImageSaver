import { useCallback, useEffect, useState } from "react"
import { Bell, Bug, FolderOpen, History, Share2, RefreshCw } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { BrandMark } from "@/components/app/brand"
import { DebugPanel } from "@/components/app/debug-panel"
import { HistoryPanel } from "@/components/app/history-panel"
import { LanguageSelect } from "@/components/app/language-select"
import { ResultsList } from "@/components/app/results-list"
import {
  EmbedPanel,
  NotificationsPanel,
  SaveBar,
  SavingPanel,
  UpdatesPanel,
  type SettingsController,
} from "@/components/app/settings-panels"
import { I18n } from "@/core/i18n.js"
import { DEFAULT_SECTION, SECTIONS, SETTINGS_SECTIONS, focusIdFromLocation, sectionFromLocation } from "@/core/nav.js"
import { uiLog } from "@/core/debuglog.js"
import { useI18n } from "@/hooks/use-i18n"
import { getEnv } from "@/lib/env"

const TAB_ICONS: Record<string, typeof History> = { history: History, saving: FolderOpen, notifications: Bell, embed: Share2, updates: RefreshCw, debug: Bug }

/**
 * The full extension page. Six sections as an accessible tab list. Deep links: popup.html#<section>,
 * popup.html?section=<section>, popup.html?op=<operation id> (history section, that operation is opened).
 * All panels stay mounted (hidden when inactive) so unsaved edits survive a tab switch and a language change, and a results
 * list that was rendered while hidden acknowledges its failures only after the History panel is actually shown.
 */
export function FullApp({ settings }: { settings: SettingsController }) {
  const env = getEnv()
  const { t } = useI18n()
  const [section, setSection] = useState<string>(() => sectionFromLocation(env.location))
  const focusId = focusIdFromLocation(env.location)

  const select = useCallback((name: string) => {
    const next = (SECTIONS as readonly string[]).includes(name) ? name : DEFAULT_SECTION
    setSection(next)
    uiLog("page", "section", "ok", undefined, { which: next })
    try {
      env.window?.history?.replaceState?.(null, "", `#${next}`)
    } catch {
      /* the URL is a convenience only */
    }
    // env is stable for the page lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onHash = () => setSection(sectionFromLocation(env.location))
    env.window?.addEventListener?.("hashchange", onHash)
    return () => env.window?.removeEventListener?.("hashchange", onHash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showSave = (SETTINGS_SECTIONS as readonly string[]).includes(section)

  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-screen w-full max-w-[880px] flex-col gap-4 px-4 py-5 sm:px-6" data-popup="full">
        <header className="flex flex-wrap items-center gap-3 border-b pb-4">
          <BrandMark className="size-11" />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold tracking-tight">MediaLatch</h1>
            <p className="text-xs text-muted-foreground">{t("app.subtitle")}</p>
          </div>
          <LanguageSelect />
        </header>

        <Tabs value={section} onValueChange={select} className="flex-1 gap-4">
          <TabsList variant="line" aria-label={t("app.sections")} className="h-auto w-full flex-wrap justify-start gap-1 border-b pb-0">
            {SECTIONS.map((name) => {
              const Icon = TAB_ICONS[name]
              return (
                <TabsTrigger
                  key={name}
                  value={name}
                  data-section={name}
                  className="h-9 flex-none px-3 data-[state=active]:text-foreground data-[state=active]:after:opacity-100 after:!bottom-[-1px]"
                >
                  <Icon aria-hidden="true" />
                  {t(`tab.${name}`)}
                </TabsTrigger>
              )
            })}
          </TabsList>

          <TabsContent value="history" forceMount hidden={section !== "history"} className="space-y-4 data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">{t("tab.history")}</h2>
            <Card data-slot="recent">
              <CardContent>
                <ResultsList compact={false} focusId={focusId} visible={section === "history"} />
              </CardContent>
            </Card>
            <HistoryPanel />
          </TabsContent>
          <TabsContent value="saving" forceMount hidden={section !== "saving"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">{t("tab.saving")}</h2>
            <SavingPanel settings={settings} />
          </TabsContent>
          <TabsContent value="notifications" forceMount hidden={section !== "notifications"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">{t("tab.notifications")}</h2>
            <NotificationsPanel settings={settings} />
          </TabsContent>
          <TabsContent value="embed" forceMount hidden={section !== "embed"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">{t("tab.embed")}</h2>
            <EmbedPanel settings={settings} />
          </TabsContent>
          <TabsContent value="updates" forceMount hidden={section !== "updates"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">{t("tab.updates")}</h2>
            <UpdatesPanel active={section === "updates"} />
          </TabsContent>
          <TabsContent value="debug" forceMount hidden={section !== "debug"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">{t("tab.debug")}</h2>
            <DebugPanel />
          </TabsContent>
        </Tabs>

        {showSave ? <SaveBar settings={settings} /> : null}

        <footer className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
          <p>
            <strong className="font-semibold text-foreground">{t("app.howto.label")}</strong> {t("app.howto.text")}{" "}
            <em>{t("app.howto.menu", { title: I18n.MENU_TITLE })}</em>.
          </p>
          <p data-slot="credits">
            {t("app.credits.label")} <span>shadcn/ui</span>, <span>Radix UI</span> {t("app.credits.and")} <span>Lucide</span>. {t("app.credits.licenses")}{" "}
            <a href="./THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer" className="text-ring underline underline-offset-2 hover:text-foreground">
              THIRD_PARTY_NOTICES.txt
            </a>
            .
          </p>
        </footer>
      </div>
    </TooltipProvider>
  )
}
