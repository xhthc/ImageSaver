import {Settings} from "lucide-react"
import {Button} from "@/components/ui/button"
import {BrandMark} from "@/components/app/brand"
import {DownloadsPanel} from "@/components/app/downloads-panel"
import {createQuick} from "@/core/quick.js"
import {useI18n} from "@/hooks/use-i18n"
import {useTheme} from "@/hooks/use-theme"
export type QuickController=ReturnType<typeof createQuick>
export function QuickApp({quick}:{quick:QuickController}) {
  useTheme()
  const {t}=useI18n()
  return <div className="w-[400px] max-w-full space-y-3 p-4" data-popup="quick">
    <header className="flex items-center gap-3 border-b pb-3">
      <BrandMark/>
      <div className="min-w-0 flex-1"><h1 className="text-base font-bold tracking-tight">MediaLatch</h1><p className="text-xs text-muted-foreground">{t('downloads.heading')}</p></div>
      <Button id="openSettingsButton" variant="ghost" size="icon" aria-label={t('quick.settings')} onClick={()=>void quick.openSettings('saving')}><Settings/></Button>
    </header>
    <main id="quickMain" className="max-h-[470px] overflow-y-auto"><DownloadsPanel/></main>
    <Button variant="ghost" size="sm" className="w-full" onClick={()=>void quick.openSettings('downloads')}>{t('downloads.open')}</Button>
  </div>
}
