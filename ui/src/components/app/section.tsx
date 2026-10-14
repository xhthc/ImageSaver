import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** The visible heading of a full-page section: title, one line of purpose and, optionally, the section's own controls. */
export function SectionHeader({ title, description, children, descriptionSlot }: { title: ReactNode; description?: ReactNode; children?: ReactNode; descriptionSlot?: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2" data-slot="section-header">
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <h2 className="text-xl leading-[26px] font-semibold tracking-[-0.01em]">{title}</h2>
        {description ? <p className="max-w-[68ch] text-[13px] leading-[18px] text-muted-foreground" data-slot={descriptionSlot}>{description}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  )
}

/** One surface per group of related rows; rows inside are separated by hairlines, never nested cards. */
export function Panel({ children, className = "", slot }: { children: ReactNode; className?: string; slot?: string }) {
  return <div data-slot={slot || "panel"} className={`divide-y rounded-xl border bg-card ${className}`}>{children}</div>
}

/** A setting: label and hint on the left, the control on the right; stacked on narrow pages. */
export function SettingRow({ label, hint, children, className = "" }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("grid items-center gap-x-6 gap-y-2 px-4 py-3.5 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)]", className)}>
      <div className="min-w-0 space-y-1">
        {label}
        {hint}
      </div>
      {children ? <div className="min-w-0">{children}</div> : null}
    </div>
  )
}
