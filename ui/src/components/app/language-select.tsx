import { Languages } from "lucide-react"

import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useI18n } from "@/hooks/use-i18n"
import { useStore } from "@/hooks/use-store"

/* eslint-disable @typescript-eslint/no-explicit-any */
// Language names are shown in their own language, so they are found whatever language is active.
const LANGUAGE_NAMES: [string, string, string][] = [
  ["en", "English", "en"],
  ["ru", "Русский", "ru"],
]

/**
 * English / Русский. Applies immediately (no "Save settings"): the choice is shown only after it was saved, and a failed
 * read or write is reported instead of pretending success. Unsaved edits of the other settings are not touched.
 */
export function LanguageSelect() {
  const { t, msg, language } = useI18n()
  const s: any = useStore(language!.store)
  return (
    <div className="flex flex-col items-end gap-1" data-slot="language">
      <div className="flex items-center gap-2">
        <Languages className="size-4 text-muted-foreground" aria-hidden="true" />
        <Label htmlFor="languageSelect" className="text-xs font-normal text-muted-foreground max-sm:sr-only">
          {t("lang.label")}
        </Label>
        <Select value={s.lang} disabled={!s.ready || s.saving} onValueChange={(v) => { void language!.setLanguage(v) }}>
          <SelectTrigger id="languageSelect" size="sm" className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_NAMES.map(([value, name, tag]) => (
              <SelectItem key={value} value={value} lang={tag}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p role="status" aria-live="polite" className="min-h-0 text-right text-xs text-danger" data-slot="language-status">
        {s.saving ? <span className="text-muted-foreground">{t("lang.saving")}</span> : msg(s.error)}
      </p>
    </div>
  )
}
