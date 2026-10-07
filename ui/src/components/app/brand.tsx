import { ImageDown } from "lucide-react"

/** The Image Saver mark: a rounded tile with the save-image glyph, kept in the extension's blue accent. */
export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-gradient-to-br from-primary/90 to-primary/50 text-primary-foreground shadow-sm ${className}`}
    >
      <ImageDown className="size-5" />
    </div>
  )
}
