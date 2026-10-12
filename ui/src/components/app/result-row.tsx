import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Loader2,
  TriangleAlert,
  XCircle,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PENDING_STATES, formatDateTime, formatTime, rowParts } from "@/core/present.js"
import { useI18n } from "@/hooks/use-i18n"
import { cn } from "@/lib/utils"
import { ResultDetails, type DetailsEnv } from "@/components/app/result-details"

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The state of a result as an icon: colour is never the only signal (the label is in the row text and aria-label). */
export function StateIcon({ state, className }: { state: string; className?: string }) {
  const common = cn("size-[18px] shrink-0", className)
  if (state === "complete") return <CheckCircle2 className={cn(common, "text-success")} aria-hidden="true" />
  if (state === "failed") return <XCircle className={cn(common, "text-danger")} aria-hidden="true" />
  if (state === "interrupted") return <TriangleAlert className={cn(common, "text-warning")} aria-hidden="true" />
  if (state === "cancelled") return <Ban className={cn(common, "text-muted-foreground")} aria-hidden="true" />
  if (PENDING_STATES.includes(state))
    return <Loader2 className={cn(common, "animate-spin text-ring motion-reduce:animate-none")} aria-hidden="true" />
  return <CircleHelp className={cn(common, "text-muted-foreground")} aria-hidden="true" />
}

export function ResultRow({
  record,
  env,
  unread = false,
  defaultOpen = false,
  dateTime = false,
  showPost = false,
  onOpenFull,
  children,
  actions,
  jobId,
}: {
  record: any
  env: DetailsEnv
  unread?: boolean
  defaultOpen?: boolean
  dateTime?: boolean
  showPost?: boolean
  onOpenFull?: (record: any) => void
  children?: ReactNode
  actions?: ReactNode
  jobId?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const item = useRef<HTMLLIElement>(null)
  const { t, lang, locale } = useI18n()
  // the record keeps structured fields only, so an older record is shown in the language selected now
  const parts = rowParts(env.FB, record, lang)
  const summary = env.FB.summarize(record, lang)
  const time = dateTime ? formatDateTime(record.updatedAt, locale) : formatTime(record.updatedAt, locale)

  // A deep link (?op=<id>) opens this row and brings it into view.
  useEffect(() => {
    if (defaultOpen && typeof item.current?.scrollIntoView === "function") {
      try {
        item.current.scrollIntoView({ block: "start" })
      } catch {
        /* scrolling is a convenience only */
      }
    }
  }, [defaultOpen])

  const full = parts.name ? `${parts.name} — ${parts.meta}` : parts.legacy
  return (
    <li
      ref={item}
      data-slot="result-item"
      data-job={jobId}
      data-state-kind={record.state}
      data-unread={unread ? "true" : "false"}
      className={cn(
        "overflow-hidden rounded-lg border bg-card transition-colors",
        unread && "border-l-4 border-l-destructive",
      )}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <CollapsibleTrigger
              className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-left focus-visible:-outline-offset-2"
              aria-label={`${summary.title}: ${full}`}
            >
              <StateIcon state={record.state} />
              <span className="min-w-0 flex-1">
                {parts.name ? (
                  <>
                    <span className="block truncate text-[13px] font-medium" data-slot="name">
                      {parts.name}
                    </span>
                    <span className="line-clamp-2 text-xs leading-snug text-muted-foreground" data-slot="meta">
                      {parts.meta}
                    </span>
                  </>
                ) : (
                  <span className="line-clamp-2 text-[13px] leading-snug" data-slot="legacy">
                    {parts.legacy}
                  </span>
                )}
              </span>
              {unread ? (
                <Badge variant="destructive" className="shrink-0 px-1.5 py-0 text-[10px]">
                  {t("row.new")}
                </Badge>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-slot="time">
                {time}
              </span>
              <ChevronDown
                className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </CollapsibleTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-[320px]">
            {full}
          </TooltipContent>
        </Tooltip>
        {actions}
        </div>
        {children}
        <CollapsibleContent>
          <div className="px-3 pb-3"><ResultDetails record={record} env={env} showPost={showPost} onOpenFull={onOpenFull} /></div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
