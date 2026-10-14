import { useCallback, useEffect, useState } from "react"
import { Bell, Bug, ChartColumn, FolderCog, Download, Link2, PackageCheck } from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { BrandMark } from "@/components/app/brand"
import { DebugPanel } from "@/components/app/debug-panel"
import { StatisticsPanel } from "@/components/app/statistics-panel"
import { LanguageSelect } from "@/components/app/language-select"
import { ThemeSelect } from "@/components/app/theme-select"
import { DownloadsPanel } from "@/components/app/downloads-panel"
import { WelcomeScreen, useOnboarding } from "@/components/app/onboarding-panel"
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
import { welcomeFromLocation } from "@/core/onboarding.js"
import { useI18n } from "@/hooks/use-i18n"
import { useStore } from "@/hooks/use-store"
import { useTheme } from "@/hooks/use-theme"
import { getEnv } from "@/lib/env"

// Stands in for the guide controller until the page has created it (hooks cannot be conditional).
const NO_GUIDE_STATE = { open: false, ready: false }
const NO_GUIDE = { getState: () => NO_GUIDE_STATE, subscribe: () => () => {} }
const TAB_ICONS: Record<string, typeof Download> = { history: ChartColumn, downloads: Download, saving: FolderCog, notifications: Bell, embed: Link2, updates: PackageCheck, debug: Bug }
// The first section of each navigation group (work, preferences, maintenance) is set apart in the vertical list.
const GROUP_START = new Set(["saving", "updates"])
const WIDE = "(min-width: 768px)"

/** Whether the page is wide enough for the vertical navigation; without matchMedia the horizontal row is used. */
function useWide() {
  const query = getEnv().window?.matchMedia?.(WIDE)
  const [wide, setWide] = useState(() => !!query?.matches)
  useEffect(() => {
    if (!query) return
    const update = () => setWide(query.matches)
    query.addEventListener?.("change", update)
    return () => query.removeEventListener?.("change", update)
    // the media query is fixed for the page lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return wide
}

/**
 * The full extension page. Deep links: popup.html#<section>, popup.html?section=<section>,
 * popup.html?op=<operation id> (Downloads, that operation is opened).
 * All panels stay mounted (hidden when inactive) so unsaved edits survive a tab switch and a language change, and a results
 * list that was rendered while hidden acknowledges its failures only after Downloads is actually shown.
 * The install welcome replaces the tabs, panels, Save bar and footer; they stay mounted but hidden.
 */
export function FullApp({ settings }: { settings: SettingsController }) {
  const env = getEnv()
  const theme = useTheme()
  const { t } = useI18n()
  const [section, setSection] = useState<string>(() => sectionFromLocation(env.location))
  const focusId = focusIdFromLocation(env.location)
  const onboarding = useOnboarding()
  const [closed, setClosed] = useState(0)
  const wide = useWide()

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

  const guide = useStore(onboarding ? onboarding.store : NO_GUIDE) as { open: boolean; ready: boolean }
  // Continue leads to Saving: it is selected behind the welcome while that is open, so the first frame after a successful
  // marker write already shows Saving (never the previous section, which could acknowledge hidden Downloads failures).
  useEffect(() => {
    if (guide.open) select("saving")
  }, [guide.open, select])
  // Its panel is focused once the main interface is shown again.
  useEffect(() => {
    if (closed) env.window?.document?.querySelector('[role="tabpanel"][data-state="active"]')?.focus()
    // env is stable for the page lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed])
  // The install URL keeps the main interface hidden until the marker read decided whether the welcome screen is due.
  const welcome = guide.open || (welcomeFromLocation(env.location) && !guide.ready)

  const showSave = (SETTINGS_SECTIONS as readonly string[]).includes(section)

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col" data-popup="full">
        <header className="border-b bg-card">
          <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
            <BrandMark className="size-9" />
            <div className="min-w-0 flex-1">
              <h1 className="text-base leading-[22px] font-semibold tracking-[-0.01em]">MediaLatch</h1>
              <p className="truncate text-xs text-muted-foreground">{t("app.subtitle")}</p>
            </div>
            <div className="flex flex-wrap items-start justify-end gap-x-3 gap-y-2">
              {theme ? <ThemeSelect theme={theme} /> : null}
              <LanguageSelect />
            </div>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col px-4 py-5 sm:px-6 md:py-7">
          {onboarding ? (
            <WelcomeScreen
              onboarding={onboarding}
              onClosed={() => setClosed((n) => n + 1)}
            />
          ) : null}
          {welcome && !guide.ready ? <p role="status" className="text-sm text-muted-foreground" data-slot="welcome-loading">{t("onboarding.loading")}</p> : null}

          <div hidden={welcome} className="flex flex-1 flex-col" data-slot="main">
            <Tabs value={section} onValueChange={select} orientation={wide ? "vertical" : "horizontal"} className="flex-1 gap-5 md:gap-8">
              <TabsList aria-label={t("app.sections")} className="-m-1 p-1 md:sticky md:top-6 md:m-0 md:w-52 md:shrink-0 md:self-start md:p-0">
                {SECTIONS.map((name) => {
                  const Icon = TAB_ICONS[name]
                  return (
                    <TabsTrigger
                      key={name}
                      value={name}
                      data-section={name}
                      onFocus={(event) => event.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" })}
                      className={GROUP_START.has(name) ? "md:mt-4" : undefined}
                    >
                      <Icon aria-hidden="true" />
                      {t(`tab.${name}`)}
                    </TabsTrigger>
                  )
                })}
              </TabsList>

              <div className="flex min-w-0 flex-1 flex-col gap-6">
                <TabsContent value="history" forceMount hidden={section !== "history"} className="data-[state=inactive]:hidden" tabIndex={-1}>
                  <StatisticsPanel />
                </TabsContent>
                <TabsContent value="downloads" forceMount hidden={section !== "downloads"} className="data-[state=inactive]:hidden" tabIndex={-1}>
                  <div data-slot="recent">
                    <DownloadsPanel full focusId={focusId} visible={section === "downloads" && !welcome} />
                  </div>
                </TabsContent>
                <TabsContent value="saving" forceMount hidden={section !== "saving"} className="data-[state=inactive]:hidden" tabIndex={-1}>
                  <SavingPanel settings={settings} />
                </TabsContent>
                <TabsContent value="notifications" forceMount hidden={section !== "notifications"} className="data-[state=inactive]:hidden" tabIndex={-1}>
                  <NotificationsPanel settings={settings} />
                </TabsContent>
                <TabsContent value="embed" forceMount hidden={section !== "embed"} className="data-[state=inactive]:hidden" tabIndex={-1}>
                  <EmbedPanel settings={settings} />
                </TabsContent>
                <TabsContent value="updates" forceMount hidden={section !== "updates"} className="data-[state=inactive]:hidden" tabIndex={-1}>
                  <UpdatesPanel active={section === "updates"} />
                </TabsContent>
                <TabsContent value="debug" forceMount hidden={section !== "debug"} className="data-[state=inactive]:hidden" tabIndex={-1}>
                  <DebugPanel />
                </TabsContent>

                {showSave ? <SaveBar settings={settings} /> : null}

                <footer className="mt-auto space-y-1 border-t pt-4 text-xs leading-[18px] text-muted-foreground">
                  <p>
                    <strong className="font-semibold text-foreground">{t("app.howto.label")}</strong> {t("app.howto.text")}{" "}
                    <em className="text-foreground not-italic">{t("app.howto.menu", { title: I18n.MENU_TITLE })}</em>.
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
            </Tabs>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
