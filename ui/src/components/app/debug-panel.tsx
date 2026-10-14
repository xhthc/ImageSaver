import { useEffect, useState } from "react"
import { Copy, Download, RefreshCw, Trash2 } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Panel, SectionHeader, SettingRow } from "@/components/app/section"
import { LEVELS, SOURCES, clock, createDebug } from "@/core/debug.js"
import { useI18n } from "@/hooks/use-i18n"
import { useStore } from "@/hooks/use-store"
import { getEnv } from "@/lib/env"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Controller = ReturnType<typeof createDebug>

const MAX_ROWS = 500
const LEVEL_TONE: Record<string, string> = { debug: "text-muted-foreground", info: "", warn: "text-warning", error: "text-danger" }

function EventRow({ ev }: { ev: any }) {
  const { t } = useI18n()
  const details = ev.d ? Object.entries(ev.d) : []
  const ids = [ev.cid ? ["click", ev.cid] : null, ev.op ? ["op", ev.op] : null, ev.tab !== undefined ? ["tab", ev.tab] : null, ev.frame !== undefined ? ["frame", ev.frame] : null, ev.page ? ["page", ev.page] : null].filter(Boolean) as [string, any][]
  return (
    <li className="px-3 py-1.5 text-xs hover:bg-accent/50" data-slot="debug-event" data-out={ev.out}>
      <details>
        <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 [&::-webkit-details-marker]:hidden">
          <span className="font-mono text-muted-foreground">{clock(ev.t)}</span>
          <span className={`font-semibold ${LEVEL_TONE[ev.lvl] || ""}`}>{t(`debug.level.${ev.lvl}`)}</span>
          <span className="text-muted-foreground">{t(`debug.source.${ev.src}`)}</span>
          <span className="font-mono">{ev.comp}.{ev.act}</span>
          <span className={ev.out === "failed" || ev.out === "refused" ? "font-semibold text-danger" : ev.out === "ok" ? "text-success" : ""}>{ev.out}</span>
          {ev.why ? <span className="font-mono">{ev.why}</span> : null}
        </summary>
        <dl className="mt-1.5 mb-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 rounded-md bg-muted/60 px-2.5 py-2 font-mono" aria-label={t("debug.details")}>
          {ids.concat(details).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all">{String(v)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </li>
  )
}

function DebugBody({ controller }: { controller: Controller }) {
  const s: any = useStore(controller.store)
  const { t, msg } = useI18n()
  const shown = controller.visible()
  const rows = shown.slice(0, MAX_ROWS)

  return (
    <section data-slot="debug" className="space-y-4">
      <SectionHeader title={t("debug.title")} description={t("section.debug")}>
        <Badge variant="outline" className={s.enabled ? "border-ring/60 text-foreground" : "text-muted-foreground"} data-slot="debug-recording">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${s.enabled ? "bg-ring" : "bg-muted-foreground"}`} />
          {s.enabled ? t("debug.recording") : t("debug.notRecording")}
        </Badge>
      </SectionHeader>
      <Panel>
        <SettingRow
          label={<Label htmlFor="debugEnabledSwitch" className="cursor-pointer leading-5">{t("debug.switch")}</Label>}
          hint={<p className="max-w-[72ch] text-xs leading-[18px] text-muted-foreground">{t("debug.desc")}</p>}
          className="md:grid-cols-[minmax(0,1fr)_auto]"
        >
          <Switch id="debugEnabledSwitch" checked={s.enabled} disabled={!s.prefReady} onCheckedChange={(v) => { void controller.setEnabled(v) }} />
        </SettingRow>
        <p className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground tabular-nums sm:px-5" data-slot="debug-counts">
          {t("debug.counts", { retained: s.retained, dropped: s.dropped, expired: s.expired })}
          {s.retained > s.persisted ? <> · {t("debug.unsaved", { n: s.retained - s.persisted })}</> : null}
        </p>
      </Panel>
      {s.prefError ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{msg(s.prefError)}</AlertDescription></Alert>
      ) : null}
      {s.storageError ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{t("debug.error.storage")}</AlertDescription></Alert>
      ) : null}

      <Panel>
        <div className="space-y-3 px-4 py-3.5 sm:px-5">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr]">
            <div className="space-y-1.5">
              <Label htmlFor="debugSource" className="text-xs font-normal text-muted-foreground">{t("debug.filter.source")}</Label>
              <Select value={s.filters.source} onValueChange={(v) => controller.setFilters({ source: v })}>
                <SelectTrigger id="debugSource" size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("debug.filter.all")}</SelectItem>
                  {SOURCES.map((x: string) => <SelectItem key={x} value={x}>{t(`debug.source.${x}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="debugLevel" className="text-xs font-normal text-muted-foreground">{t("debug.filter.level")}</Label>
              <Select value={s.filters.level} onValueChange={(v) => controller.setFilters({ level: v })}>
                <SelectTrigger id="debugLevel" size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("debug.filter.all")}</SelectItem>
                  {LEVELS.map((x: string) => <SelectItem key={x} value={x}>{t(`debug.level.${x}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="debugSearch" className="text-xs font-normal text-muted-foreground">{t("debug.search")}</Label>
              <Input id="debugSearch" type="search" value={s.filters.q} className="h-8" onChange={(e) => controller.setFilters({ q: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => { void controller.sync(false) }}><RefreshCw />{t("debug.refresh")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={!shown.length} onClick={() => { void controller.copyReport(t) }}><Copy />{t("debug.copy")}</Button>
            <Button type="button" variant="outline" size="sm" disabled={!shown.length} onClick={() => { controller.downloadJson() }}><Download />{t("debug.export")}</Button>
            <p role="status" aria-live="polite" data-slot="debug-notice" className={`text-xs ${s.noticeType === "error" ? "text-danger" : "text-muted-foreground"}`}>{msg(s.notice)}</p>
            <Button type="button" variant="ghost" size="sm" className="sm:ml-auto" disabled={s.clearing} onClick={() => { void controller.clear() }}><Trash2 />{t("debug.clear")}</Button>
          </div>
        </div>
      </Panel>
      {s.error ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{msg(s.error)}</AlertDescription></Alert>
      ) : null}

      <div data-slot="debug-list" aria-live="off">
        {s.status === "loading" ? (
          <div className="space-y-2" aria-hidden="true"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
        ) : null}
        {s.status !== "loading" && !s.events.length ? <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-slot="debug-empty">{t("debug.empty")}</p> : null}
        {s.events.length && !shown.length ? <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-slot="debug-nomatch">{t("debug.noMatch")}</p> : null}
        {rows.length ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground tabular-nums" data-slot="debug-shown">{t("debug.shown", { n: rows.length, total: s.events.length })}</p>
            <ul className="divide-y overflow-hidden rounded-xl border bg-card" data-slot="debug-events">{rows.map((ev: any) => <EventRow key={`${ev.seq || ev.t}-${ev.comp}-${ev.act}`} ev={ev} />)}</ul>
          </>
        ) : null}
      </div>
    </section>
  )
}

/** The opt-in debug journal (DEBUG-MENU-01): live events, filters, readable copy, JSON export and clear. */
export function DebugPanel() {
  const [controller, setController] = useState<Controller | null>(null)
  useEffect(() => {
    const env = getEnv()
    const c = createDebug({ chrome: env.chrome, navigator: env.navigator, document: env.window?.document, URL: env.window?.URL })
    setController(c)
    void c.start().catch(() => {})
    return () => c.dispose()
  }, [])
  if (!controller) return <Skeleton className="h-40 w-full" aria-hidden="true" />
  return <DebugBody controller={controller} />
}
