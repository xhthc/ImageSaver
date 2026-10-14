import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { useI18n } from "@/hooks/use-i18n"
import { cn } from "@/lib/utils"

/* eslint-disable @typescript-eslint/no-explicit-any */
const TILE_TONE: Record<string, string> = {
  success: "text-success",
  failed: "text-danger",
}

/** The statistics figures. The view model is built by statsView(); unknown stays unknown. The section heading and the scope
 * note are drawn by the statistics panel. */
export function StatsCard({ view }: { view: any }) {
  const { locale } = useI18n()
  const count = (n: number) => (Number.isFinite(n) ? n.toLocaleString(locale) : String(n))
  return (
    <div data-slot="stats" aria-live="polite" className="space-y-4">
      {view.disabledNote ? (
        <Alert>
          <AlertDescription className="text-xs" data-slot="disabled-note">
            {view.disabledNote}
          </AlertDescription>
        </Alert>
      ) : null}
      {view.state === "loading" ? (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <div key={i} className="space-y-2 bg-card px-4 py-3"><Skeleton className="h-7 w-16" /><Skeleton className="h-3 w-24" /></div>)}
        </div>
      ) : null}
      {view.state === "loading" || view.state === "empty" ? (
        <p className="text-sm text-muted-foreground" data-slot="stats-message">
          {view.message}
        </p>
      ) : null}
      {view.state === "error" ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{view.message}</AlertDescription>
        </Alert>
      ) : null}
      {view.state === "ok" ? (
        <>
          <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-5" data-slot="stat-tiles">
            {view.tiles.map((tile: any) => (
              <li key={tile.key} className={cn("min-w-0 bg-card px-4 py-3", tile.key === "unknown" && "col-span-2 sm:col-span-1")} data-stat={tile.key}>
                <p className={cn("text-2xl leading-8 font-semibold tracking-[-0.02em] tabular-nums", TILE_TONE[tile.key])} data-slot="value">
                  {count(tile.value)}
                </p>
                <p className="text-xs leading-4 text-muted-foreground" data-slot="label">
                  {tile.label}
                </p>
              </li>
            ))}
          </ul>
          <ul className="divide-y rounded-xl border bg-card text-sm" data-slot="type-rows">
            {view.types.map((row: any) => (
              <li key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 sm:px-5" data-type={row.key}>
                <span>{row.label}</span>
                <span className="text-right">
                  <span className="font-semibold tabular-nums">{count(row.value)}</span>
                  {row.detail ? <span className="block text-xs text-muted-foreground">{row.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-[18px] text-muted-foreground" data-slot="size-text">
            {view.sizeText}
          </p>
        </>
      ) : null}
    </div>
  )
}
