import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useI18n } from "@/hooks/use-i18n"
import { cn } from "@/lib/utils"

/* eslint-disable @typescript-eslint/no-explicit-any */
const TILE_TONE: Record<string, string> = {
  success: "text-success",
  failed: "text-danger",
}

/** Statistics over the retained history. The view model is built by statsView(); unknown stays unknown. */
export function StatsCard({ view }: { view: any }) {
  const { t, locale } = useI18n()
  const count = (n: number) => (Number.isFinite(n) ? n.toLocaleString(locale) : String(n))
  return (
    <Card data-slot="stats" aria-live="polite">
      <CardHeader>
        <CardTitle className="text-base">
          {t("stats.title")}
        </CardTitle>
        <CardDescription className="text-xs" data-slot="scope-note">
          {view.note}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {view.disabledNote ? (
          <Alert>
            <AlertDescription className="text-xs" data-slot="disabled-note">
              {view.disabledNote}
            </AlertDescription>
          </Alert>
        ) : null}
        {view.state === "loading" ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-4 w-40" />
            <div className="grid grid-cols-3 gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
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
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-slot="stat-tiles">
              {view.tiles.map((tile: any) => (
                <li key={tile.key} className={cn("rounded-lg border bg-background/40 px-3 py-2", tile.key === "unknown" && "col-span-2 sm:col-span-1")} data-stat={tile.key}>
                  <p className={cn("text-xl font-semibold tabular-nums", TILE_TONE[tile.key])} data-slot="value">
                    {count(tile.value)}
                  </p>
                  <p className="text-xs text-muted-foreground" data-slot="label">
                    {tile.label}
                  </p>
                </li>
              ))}
            </ul>
            <ul className="divide-y rounded-lg border text-sm" data-slot="type-rows">
              {view.types.map((row: any) => (
                <li key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5" data-type={row.key}>
                  <span>{row.label}</span>
                  <span className="text-right">
                    <span className="font-semibold tabular-nums">{count(row.value)}</span>
                    {row.detail ? <span className="block text-xs text-muted-foreground">{row.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground" data-slot="size-text">
              {view.sizeText}
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
