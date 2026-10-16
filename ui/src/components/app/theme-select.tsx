import { Palette } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createTheme, THEMES } from "@/core/theme.js"
import { useI18n } from "@/hooks/use-i18n"
import { useStore } from "@/hooks/use-store"

export function ThemeSelect({ theme }: { theme: ReturnType<typeof createTheme> }) {
  const s = useStore(theme.store)
  const { t, msg } = useI18n()
  return (
    <div className="flex flex-col items-end gap-1" data-slot="theme">
      <div className="flex items-center gap-2">
        <Palette className="size-4 text-muted-foreground" aria-hidden="true" />
        <Label htmlFor="themeSelect" className="pointer-events-none text-xs font-normal text-muted-foreground max-sm:sr-only">{t("theme.label")}</Label>
        <Select value={s.theme} disabled={!s.ready || s.saving} onValueChange={v => { void theme.setTheme(v) }}>
          <SelectTrigger id="themeSelect" size="sm" className="w-[136px]"><SelectValue /></SelectTrigger>
          <SelectContent>{THEMES.map(value => <SelectItem key={value} value={value}>{t(`theme.${value}`)}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {s.error ? <p role="status" className="text-xs text-danger">{msg(s.error)}</p> : null}
    </div>
  )
}
