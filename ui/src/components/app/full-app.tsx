import { useCallback, useEffect, useState } from "react"
import { Bell, FolderOpen, History, Share2, RefreshCw } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/skiper/tooltip"
import { BrandMark } from "@/components/app/brand"
import { HistoryPanel } from "@/components/app/history-panel"
import { ResultsList } from "@/components/app/results-list"
import {
  EmbedPanel,
  NotificationsPanel,
  SaveBar,
  SavingPanel,
  UpdatesPanel,
  type SettingsController,
} from "@/components/app/settings-panels"
import { DEFAULT_SECTION, SECTIONS, SETTINGS_SECTIONS, focusIdFromLocation, sectionFromLocation } from "@/core/nav.js"
import { getEnv } from "@/lib/env"

const TAB_LABELS: Record<string, string> = {
  history: "Статистика и история",
  saving: "Сохранение",
  notifications: "Уведомления",
  embed: "Embed",
  updates: "Обновления",
}
const TAB_ICONS: Record<string, typeof History> = { history: History, saving: FolderOpen, notifications: Bell, embed: Share2, updates: RefreshCw }

/**
 * The full extension page. Four sections as an accessible tab list. Deep links: popup.html#<section>,
 * popup.html?section=<section>, popup.html?op=<operation id> (history section, that operation is opened).
 * All panels stay mounted (hidden when inactive) so unsaved edits survive a tab switch and a results list that was
 * rendered while hidden acknowledges its failures only after the History panel is actually shown.
 */
export function FullApp({ settings }: { settings: SettingsController }) {
  const env = getEnv()
  const [section, setSection] = useState<string>(() => sectionFromLocation(env.location))
  const focusId = focusIdFromLocation(env.location)

  const select = useCallback((name: string) => {
    const next = (SECTIONS as readonly string[]).includes(name) ? name : DEFAULT_SECTION
    setSection(next)
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
        <header className="flex items-center gap-3 border-b pb-4">
          <BrandMark className="size-11" />
          <div>
            <h1 className="text-lg font-bold tracking-tight">Image Saver</h1>
            <p className="text-xs text-muted-foreground">История, статистика и настройки</p>
          </div>
        </header>

        <Tabs value={section} onValueChange={select} className="flex-1 gap-4">
          <TabsList variant="line" aria-label="Разделы" className="h-auto w-full flex-wrap justify-start gap-1 border-b pb-0">
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
                  {TAB_LABELS[name]}
                </TabsTrigger>
              )
            })}
          </TabsList>

          <TabsContent value="history" forceMount hidden={section !== "history"} className="space-y-4 data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">Статистика и история</h2>
            <Card data-slot="recent">
              <CardContent>
                <ResultsList compact={false} focusId={focusId} visible={section === "history"} />
              </CardContent>
            </Card>
            <HistoryPanel />
          </TabsContent>
          <TabsContent value="saving" forceMount hidden={section !== "saving"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">Сохранение</h2>
            <SavingPanel settings={settings} />
          </TabsContent>
          <TabsContent value="notifications" forceMount hidden={section !== "notifications"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">Уведомления</h2>
            <NotificationsPanel settings={settings} />
          </TabsContent>
          <TabsContent value="embed" forceMount hidden={section !== "embed"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">Embed</h2>
            <EmbedPanel settings={settings} />
          </TabsContent>
          <TabsContent value="updates" forceMount hidden={section !== "updates"} className="data-[state=inactive]:hidden" tabIndex={-1}>
            <h2 className="sr-only">Обновления</h2>
            <UpdatesPanel active={section === "updates"} />
          </TabsContent>
        </Tabs>

        {showSave ? <SaveBar settings={settings} /> : null}

        <footer className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
          <p>
            <strong className="font-semibold text-foreground">Как пользоваться:</strong> нажмите правой кнопкой мыши по любой картинке на странице и выберите <em>«Сохранить картинку»</em>.
          </p>
          <p data-slot="credits">
            Интерфейс: <span>shadcn/ui</span>; компоненты Custom tooltip и Progressive Blur — <span>Skiper UI</span> (skiper-ui.com). Лицензии —{" "}
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
