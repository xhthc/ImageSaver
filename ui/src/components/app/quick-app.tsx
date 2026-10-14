import {ArrowUpRight, Settings} from "lucide-react"
import {Button} from "@/components/ui/button"
import {BrandMark} from "@/components/app/brand"
import {DownloadsPanel} from "@/components/app/downloads-panel"
import {createQuick} from "@/core/quick.js"
import {useI18n} from "@/hooks/use-i18n"
import {useTheme} from "@/hooks/use-theme"
export type QuickController=ReturnType<typeof createQuick>
// The toolbar popup (420 px wide, at most 600 px high): header, the scrolling list with hidden rails, and the manager entry.
export function QuickApp({quick}:{quick:QuickController}) {
  useTheme()
  const {t}=useI18n()
  return <div className="flex max-h-[600px] w-[420px] max-w-full flex-col" data-popup="quick">
    <header className="flex shrink-0 items-center gap-2.5 border-b bg-card px-3 py-2.5">
      <BrandMark className="size-8"/>
      <h1 className="min-w-0 flex-1 text-sm leading-5 font-semibold tracking-[-0.01em]">MediaLatch</h1>
      <Button id="openSettingsButton" variant="ghost" size="icon-sm" aria-label={t('quick.settings')} title={t('quick.settings')} onClick={()=>void quick.openSettings('saving')}><Settings/></Button>
    </header>
    <main id="quickMain" tabIndex={0} className="min-h-0 overflow-y-auto px-3 py-3 focus-visible:-outline-offset-2"><DownloadsPanel/></main>
    <footer className="shrink-0 border-t bg-card p-2">
      <Button variant="secondary" size="sm" className="w-full" onClick={()=>void quick.openSettings('downloads')}>{t('downloads.open')}<ArrowUpRight/></Button>
    </footer>
  </div>
}
