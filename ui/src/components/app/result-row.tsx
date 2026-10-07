import { useEffect, useRef, useState } from "react"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/skiper/tooltip"
import { PENDING_STATES, formatDateTime, formatTime, rowParts } from "@/core/present.js"
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
}: {
  record: any
  env: DetailsEnv
  unread?: boolean
  defaultOpen?: boolean
  dateTime?: boolean
  showPost?: boolean
  onOpenFull?: (record: any) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const item = useRef<HTMLLIElement>(null)
  const parts = rowParts(env.FB, record)
  const summary = env.FB.summarize(record)
  const time = dateTime ? formatDateTime(record.updatedAt) : formatTime(record.updatedAt)

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
      data-state-kind={record.state}
      data-unread={unread ? "true" : "false"}
      className={cn(
        "overflow-hidden rounded-lg border bg-card transition-colors",
        unread && "border-l-4 border-l-destructive",
      )}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <CollapsibleTrigger
              className="group flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/50 focus-visible:bg-accent/50"
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
                  новое
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
        <CollapsibleContent className="px-3 pb-3">
          <ResultDetails record={record} env={env} showPost={showPost} onOpenFull={onOpenFull} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
