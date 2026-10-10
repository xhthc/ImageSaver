import { useEffect, useState } from "react"
import { Eraser, Inbox } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ResultRow } from "@/components/app/result-row"
import { ScrollFade } from "@/components/app/scroll-fade"
import { createFeedbackList } from "@/core/feedbackList.js"
import { useI18n } from "@/hooks/use-i18n"
import { useStore } from "@/hooks/use-store"
import { getEnv } from "@/lib/env"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Controller = ReturnType<typeof createFeedbackList>

function ListBody({ controller, compact }: { controller: Controller; compact: boolean }) {
  const state: any = useStore(controller.store)
  const { t, msg } = useI18n()
  const env = { FB: getEnv().FB, navigator: controller.env.navigator, version: controller.env.version, browser: controller.env.browser }
  const unread = new Set<string>(state.unreadIds)
  const openFull = controller.canOpenFull ? (record: any) => { void controller.openFull(record) } : undefined

  let body
  if (state.status === "loading") {
    body = (
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-4/5" />
      </div>
    )
  } else if (state.status === "error") {
    body = null // the failure text below says so; no list is invented
  } else if (!state.records.length) {
    body = (
      <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground" data-slot="empty">
        <Inbox className="size-4 shrink-0" aria-hidden="true" />
        {t("results.empty")}
      </p>
    )
  } else {
    const list = (
      <ul className="space-y-1.5" data-slot="results">
        {state.records.map((r: any) => (
          <ResultRow
            key={r.id}
            record={r}
            env={env}
            unread={unread.has(r.id)}
            defaultOpen={state.focusId === r.id}
            onOpenFull={openFull}
          />
        ))}
      </ul>
    )
    body = compact ? <ScrollFade>{list}</ScrollFade> : list
  }

  return (
    <>
      <div aria-live="polite" data-slot="listbox">{body}</div>
      {state.error ? (
        <Alert variant="destructive" role="alert" className="mt-2">
          <AlertDescription>{msg(state.error)}</AlertDescription>
        </Alert>
      ) : null}
      {!compact ? (
        <div className="mt-3">
          <Button type="button" variant="outline" size="sm" disabled={state.clearing} onClick={() => { void controller.clear() }}>
            <Eraser />
            {t("results.clear")}
          </Button>
        </div>
      ) : null}
    </>
  )
}

/**
 * Recent save results. `visible` says whether the list is displayed (a hidden History panel keeps unread failures pending);
 * `isActive` lets a caller supersede the mount (the compact popup while history is off).
 */
export function ResultsList({
  compact = true,
  limit,
  focusId = "",
  openFull = false,
  visible = true,
  isActive,
  heading = true,
}: {
  compact?: boolean
  limit?: number
  focusId?: string
  openFull?: boolean
  visible?: boolean
  isActive?: () => boolean
  heading?: boolean
}) {
  const [controller, setController] = useState<Controller | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    const env = getEnv()
    const c = createFeedbackList(
      { chrome: env.chrome, FB: env.FB, navigator: env.navigator },
      { limit: limit ?? (compact ? 5 : env.FB.LIMITS.maxOps), focusId, openFull, isActive, visible },
    )
    setController(c)
    void c.start().catch(() => {})
    return () => c.dispose()
    // The mount is created once; the visibility is forwarded below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    controller?.setVisible(visible)
  }, [controller, visible])

  return (
    <section aria-label={t("results.aria")} data-slot="results-section">
      {heading ? (
        <h2 className="mb-2 text-sm font-semibold tracking-tight" data-slot="heading">
          {compact ? t("quick.recent") : t("results.heading")}
        </h2>
      ) : null}
      {controller ? (
        <ListBody controller={controller} compact={compact} />
      ) : (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
    </section>
  )
}
