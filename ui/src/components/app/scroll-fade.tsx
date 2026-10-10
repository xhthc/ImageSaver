import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A bounded, natively scrolling region (keyboard and wheel scrolling stay the browser's own). While more content is
 * hidden below the visible part, a CSS gradient fades the bottom edge without intercepting the pointer.
 */
export function ScrollFade({
  children,
  className,
  maxHeight = 430,
}: {
  children: ReactNode
  className?: string
  maxHeight?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
  }, [])

  useEffect(() => {
    measure()
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [measure, children])

  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={measure}
        style={{ maxHeight }}
        className={cn("overflow-y-auto overscroll-contain pr-1 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]", className)}
      >
        {children}
      </div>
      {more ? <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-7 bg-gradient-to-t from-background to-transparent" /> : null}
    </div>
  )
}
