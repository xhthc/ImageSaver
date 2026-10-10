import { useId } from "react"

export function BrandMark({ className = "" }: { className?: string }) {
  const gradient = useId()
  return (
    <svg aria-hidden="true" viewBox="16 16 96 96" className={`size-10 shrink-0 rounded-xl shadow-sm ${className}`}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#4f46e5" />
          <stop offset="1" stopColor="#2456d4" />
        </linearGradient>
      </defs>
      <rect x="16" y="16" width="96" height="96" rx="24" fill={`url(#${gradient})`} />
      <g fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M38 78V45L64 67L90 45V78" />
        <path d="M64 67V88M55 79L64 88L73 79" />
      </g>
    </svg>
  )
}
