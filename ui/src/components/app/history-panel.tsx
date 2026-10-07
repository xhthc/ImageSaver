import { useEffect, useState } from "react"
import { History as HistoryIcon, Inbox, Trash2 } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ResultRow } from "@/components/app/result-row"
import { StatsCard } from "@/components/app/stats-card"
import { browserLabel } from "@/core/feedbackList.js"
import { createHistory } from "@/core/history.js"
import { statsView } from "@/core/present.js"
import { useStore } from "@/hooks/use-store"
import { getEnv } from "@/lib/env"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Controller = ReturnType<typeof createHistory>

function HistoryBody({ controller }: { controller: Controller }) {
  const state: any = useStore(controller.store)
  const env = getEnv()
  const detailsEnv = {
    FB: env.FB,
    navigator: env.navigator,
    version: (() => { try { return env.chrome.runtime.getManifest().version } catch { return "" } })(),
    browser: browserLabel(env.navigator),
  }
  const view = statsView(env.FB, state.records, state.status === "loading" ? "loading" : state.status === "error" ? "error" : "ok", state.enabled)

  return (
    <div className="space-y-4">
      <StatsCard view={view} />
      <Card data-slot="history">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HistoryIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            История сохранений
          </CardTitle>
          <CardDescription className="text-xs">
            Хранится только на этом устройстве: не более 50 записей и не дольше 7 дней. В истории нет ссылок на файлы, медиа и подписанных адресов; ссылка на пост показывается, только если пост удалось определить надёжно.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border bg-background/40 p-3">
            <Switch
              id="historyEnabledSwitch"
              checked={state.enabled}
              disabled={!state.prefReady}
              onCheckedChange={(v) => { void controller.setEnabled(v) }}
              className="mt-0.5"
            />
            <Label htmlFor="historyEnabledSwitch" className="cursor-pointer text-sm leading-snug font-normal">
              Вести историю сохранений (по умолчанию выключено; выключение не удаляет уже записанное)
            </Label>
          </div>
          {state.prefError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.prefError}</AlertDescription>
            </Alert>
          ) : null}

          <div aria-live="polite" data-slot="history-list">
            {state.status === "loading" ? (
              <div className="space-y-2" aria-hidden="true">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : null}
            {state.status === "ready" && !state.records.length ? (
              <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground" data-slot="empty">
                <Inbox className="size-4 shrink-0" aria-hidden="true" />
                История пуста.
              </p>
            ) : null}
            {state.status === "ready" && state.records.length ? (
              <ul className="space-y-1.5" data-slot="results">
                {state.records.map((r: any) => (
                  <ResultRow key={r.id} record={r} env={detailsEnv} dateTime showPost />
                ))}
              </ul>
            ) : null}
          </div>
          {state.error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" disabled={state.clearing} onClick={() => { void controller.clear() }}>
              <Trash2 />
              Очистить историю
            </Button>
            <p role="status" aria-live="polite" className="min-h-4 text-xs text-muted-foreground" data-slot="clear-status">
              {state.clearStatus}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** Statistics and the bounded local history with its explicit opt-in (UX-03). */
export function HistoryPanel() {
  const [controller, setController] = useState<Controller | null>(null)
  useEffect(() => {
    const env = getEnv()
    const c = createHistory({ chrome: env.chrome, FB: env.FB })
    setController(c)
    void c.start().catch(() => {})
    return () => c.dispose()
  }, [])
  if (!controller) return <Skeleton className="h-40 w-full" aria-hidden="true" />
  return <HistoryBody controller={controller} />
}
