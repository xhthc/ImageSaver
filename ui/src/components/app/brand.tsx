import { useId } from "react"
import { cn } from "@/lib/utils"

/** Shared M/download geometry and theme gradients match the generated toolbar icons. */
export function BrandMark({ className = "" }: { className?: string }) {
  const gradient = useId()
  const rim = gradient + "-rim"
  return (
    <svg aria-hidden="true" viewBox="16 16 96 96" className={cn("size-10 shrink-0 rounded-[25%]", className)}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0.85" y2="1">
          <stop stopColor="var(--brand-start, #aa4be6)" />
          <stop offset="0.52" stopColor="var(--brand-mid, #793ad6)" />
          <stop offset="1" stopColor="var(--brand-end, #462196)" />
        </linearGradient>
        <linearGradient id={rim} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#fff" stopOpacity="0.3" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <rect x="16" y="16" width="96" height="96" rx="24" fill={`url(#${gradient})`} />
      <rect x="16.75" y="16.75" width="94.5" height="94.5" rx="23.25" fill="none" stroke={`url(#${rim})`} strokeWidth="1.5" />
      <g fill="none" stroke="var(--brand-foreground, #fff)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M38 78V45L64 67L90 45V78" />
        <path d="M64 67V88M55 79L64 88L73 79" />
      </g>
    </svg>
  )
}
