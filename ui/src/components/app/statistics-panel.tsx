import { useEffect, useState } from "react"
import { Trash2 } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { StatsCard } from "@/components/app/stats-card"
import { createStatistics } from "@/core/statistics.js"
import { statsView } from "@/core/present.js"
import { useI18n } from "@/hooks/use-i18n"
import { useStore } from "@/hooks/use-store"
import { getEnv } from "@/lib/env"

/* eslint-disable @typescript-eslint/no-explicit-any */
function Body({ controller }: { controller: ReturnType<typeof createStatistics> }) {
  const state = useStore(controller.store)
  const { t, lang } = useI18n()
  const view: any = statsView(getEnv().FB, state.stats, state.status === "loading" ? "loading" : state.status === "error" ? "error" : "ok", true, lang)
  view.note = t("statistics.scope")
  for (const tile of view.tiles) if (tile.key === "total") tile.label = t("statistics.total")
  if (view.state === "error") view.message = t("statistics.loadFailed")
  if (!state.enabled) view.disabledNote = t("statistics.disabled")
  if (view.state === "empty") view.message = t("statistics.empty")
  return <div className="space-y-4" data-slot="statistics">
    <StatsCard view={view} />
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-3">
        <Switch id="statisticsEnabled" checked={state.enabled} disabled={!state.prefReady || state.saving} onCheckedChange={v => { void controller.setEnabled(v) }} />
        <Label htmlFor="statisticsEnabled">{t("statistics.record")}</Label>
      </div>
      <Button variant="outline" size="sm" disabled={state.clearing} onClick={() => { void controller.clear() }}><Trash2 />{t("statistics.clear")}</Button>
    </div>
    {state.imported ? <p className="text-xs text-muted-foreground">{t("statistics.imported", { n: state.imported })}</p> : null}
    {state.error ? <Alert variant="destructive" role="alert"><AlertDescription>{t(state.error)}</AlertDescription></Alert> : null}
    <p className="text-xs text-muted-foreground" role="status">{state.cleared ? t("statistics.cleared") : ""}</p>
  </div>
}
export function StatisticsPanel() {
  const [controller, setController] = useState<ReturnType<typeof createStatistics> | null>(null)
  useEffect(() => { const c = createStatistics({ chrome: getEnv().chrome }); setController(c); return () => c.dispose(); }, [])
  return controller ? <Body controller={controller} /> : <Skeleton className="h-40" />
}
