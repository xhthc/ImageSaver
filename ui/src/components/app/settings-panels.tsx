import { useEffect, useState } from "react"
import { CheckCircle2, FolderOpen, Save, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { createSettings } from "@/core/settings.js"
import { createUpdates, isNewer, RELEASES_URL } from "@/core/updates.js"
import { getEnv } from "@/lib/env"
import { useStore } from "@/hooks/use-store"
import { cn } from "@/lib/utils"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SettingsController = ReturnType<typeof createSettings>

function Hint({ children, secondary = false, id }: { children: React.ReactNode; secondary?: boolean; id?: string }) {
  return (
    <p id={id} className={cn("text-xs leading-relaxed", secondary ? "text-muted-foreground/90" : "text-muted-foreground")}>
      {children}
    </p>
  )
}

/** "Сохранение": subfolder and folder organization. Edited here, written by the explicit save action. */
export function SavingPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const preview = settings.preview()
  return (
    <Card data-slot="saving">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderOpen className="size-4 text-muted-foreground" aria-hidden="true" />
          Сохранение
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="subfolderInput">Подпапка для сохранения:</Label>
          <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background/40 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40">
            <span className="flex items-center border-r bg-muted px-2.5 text-xs whitespace-nowrap text-muted-foreground">Загрузки /</span>
            <Input
              id="subfolderInput"
              type="text"
              value={s.subfolder}
              placeholder="SavedImages"
              spellCheck={false}
              disabled={!s.loaded}
              aria-describedby="folderPreviewHint"
              className="min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              onChange={(e) => settings.setField("subfolder", e.target.value)}
            />
          </div>
          <Hint>Файлы сохраняются в вашей системной папке «Загрузки». Вы можете указать имя любой подпапки внутри неё.</Hint>
        </div>

        <div className="space-y-2">
          <Label id="folderModeLabel">Организация скачиваний:</Label>
          <RadioGroup
            aria-labelledby="folderModeLabel"
            value={s.folderOrganizationMode}
            onValueChange={(v) => settings.setField("folderOrganizationMode", v)}
            disabled={!s.loaded}
            className="gap-2"
          >
            <div className="flex items-center gap-2.5">
              <RadioGroupItem value="single" id="folderModeSingle" />
              <Label htmlFor="folderModeSingle" className="cursor-pointer font-normal">В одну папку (по умолчанию)</Label>
            </div>
            <div className="flex items-center gap-2.5">
              <RadioGroupItem value="by_site_and_type" id="folderModeBySiteType" />
              <Label htmlFor="folderModeBySiteType" className="cursor-pointer font-normal">По сайтам и типам медиа</Label>
            </div>
          </RadioGroup>
          <Hint id="folderPreviewHint">
            Пример пути:{" "}
            <span
              id="folderPreviewPath"
              data-error={preview.error ? "true" : "false"}
              className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] break-all", preview.error ? "text-danger" : "text-foreground")}
            >
              {preview.text}
            </span>
          </Hint>
          <Hint secondary>Папки сайтов и типов создаются автоматически только при первом сохранении соответствующего медиа.</Hint>
        </div>

      </CardContent>
    </Card>
  )
}

/** "Уведомления": the independent success-notification preference, applied immediately. */
export function NotificationsPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  return (
    <Card data-slot="notifications">
      <CardHeader>
        <CardTitle className="text-base">Уведомления</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border bg-background/40 p-3">
          <Switch
            id="notifySuccessSectionSwitch"
            checked={s.notify.checked}
            onCheckedChange={(v) => { void settings.setNotifySuccess(v) }}
            className="mt-0.5"
          />
          <Label htmlFor="notifySuccessSectionSwitch" className="cursor-pointer text-sm leading-snug font-normal">
            Уведомлять об успешных сохранениях
          </Label>
        </div>
        <Hint>
          Настройка применяется сразу, кнопка «Сохранить настройки» для неё не нужна. Уведомление об успехе приходит только после того, как Chrome завершил загрузку файла.
        </Hint>
        <Hint secondary>
          Ошибки сохранения остаются видимыми всегда: они показываются уведомлением, в списке недавних результатов и значком «!» на иконке расширения, даже если уведомления об успехе выключены или заблокированы в системе.
        </Hint>
        {s.notify.error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{s.notify.error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** Checks release metadata only; package download and installation are explicit manual actions. */
export function UpdatesPanel({ active }: { active: boolean }) {
  const [updates] = useState(() => createUpdates({ chrome: getEnv().chrome }))
  const s: any = useStore(updates.store)
  useEffect(() => { if (active) void updates.check() }, [active, updates])
  useEffect(() => () => updates.dispose(), [updates])
  const newer = s.release && isNewer(s.release.version, s.currentVersion)
  return (
    <Card data-slot="updates">
      <CardHeader>
        <CardTitle className="text-base">Обновления</CardTitle>
        <CardDescription>Установленная версия: {s.currentVersion}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="releaseChannelSelect">Канал обновлений</Label>
          <Select value={s.channel} disabled={!s.loaded || s.checking} onValueChange={(v) => { void updates.setChannel(v) }}>
            <SelectTrigger id="releaseChannelSelect" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="stable">Обычные релизы</SelectItem>
              <SelectItem value="beta">Обычные и beta-релизы</SelectItem>
            </SelectContent>
          </Select>
          <Hint>Beta-версии могут содержать ошибки. Канал применяется сразу.</Hint>
        </div>
        <div role="status" aria-live="polite" data-slot="update-status">
          {s.checking ? "Проверяем релизы на GitHub…" : s.error ? s.error : !s.checkedAt ? "Проверка ещё не выполнена." : newer
            ? `Доступна версия ${s.release.version}${s.release.prerelease ? " (beta)" : ""}. Установите её вручную.`
            : s.release ? "Новых версий в этом канале нет." : "Опубликованных релизов с номером версии в этом канале пока нет."}
        </div>
        {s.checkedAt ? <Hint>Последняя успешная проверка: {new Date(s.checkedAt).toLocaleString()}</Hint> : null}
        {s.notice ? <p role="alert" className="text-xs text-danger">{s.notice}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button id="checkUpdatesButton" disabled={!s.loaded || s.checking} onClick={() => { void updates.check(true) }}>Проверить сейчас</Button>
          <a href={s.release?.url || RELEASES_URL} target="_blank" rel="noopener noreferrer" className="text-sm text-ring underline underline-offset-2">{newer ? "Открыть релиз на GitHub" : "Открыть релизы на GitHub"}</a>
        </div>
        <Hint>При открытии этой вкладки проверяем GitHub не чаще раза в сутки. Кнопка запускает проверку сразу. Пока вкладка закрыта, фоновых проверок нет.</Hint>
        <div className="space-y-2 text-sm">
          <p className="font-medium">Как обновить распакованное расширение</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Откройте релиз и скачайте готовый ZIP расширения из раздела Assets.</li>
            <li>Дождитесь завершения сохранений. Распакуйте ZIP и замените файлы в той же папке, из которой установлено расширение.</li>
            <li>На странице расширений браузера нажмите «Перезагрузить» у Image Saver. Не удаляйте установленное расширение.</li>
          </ol>
          <Hint>Расширение не скачивает и не устанавливает обновления автоматически.</Hint>
        </div>
      </CardContent>
    </Card>
  )
}

const EMBED_FIELDS = [
  {
    key: "xShareHost",
    id: "xShareHostSelect",
    label: "Ссылка на пост X (Embed-превью)",
    options: [
      ["x.com", "x.com (оригинал, по умолчанию)"],
      ["fixupx.com", "fixupx.com (основной)"],
      ["cunnyx.com", "cunnyx.com (резерв)"],
    ],
    hint: "Выберите адрес, который копирует кнопка у поста. x.com — оригинал; fixupx.com и cunnyx.com — дополнительные варианты для Embed-превью в мессенджерах.",
  },
  {
    key: "igShareHost",
    id: "igShareHostSelect",
    label: "Ссылка на пост Instagram (Embed-превью)",
    options: [
      ["instagram.com", "instagram.com (оригинал, по умолчанию)"],
      ["oginstagram.com", "oginstagram.com (основной)"],
      ["kirkstagram.com", "kirkstagram.com (резерв)"],
    ],
    hint: "Выберите адрес, который копирует кнопка у поста или Reel. instagram.com — оригинал; oginstagram.com и kirkstagram.com — сторонние сервисы для Embed-превью в мессенджерах (работают не для всех публикаций).",
  },
  {
    key: "ttShareHost",
    id: "ttShareHostSelect",
    label: "Ссылка на видео TikTok (Embed-превью)",
    options: [
      ["tiktok.com", "tiktok.com (оригинал, по умолчанию)"],
      ["tnktok.com", "tnktok.com (основной)"],
      ["d.tnktok.com", "d.tnktok.com (резерв)"],
    ],
    hint: "Выберите адрес, который копирует кнопка у видео. Альтернативные домены — пользовательские сторонние сервисы для превью в мессенджерах; d.tnktok.com формирует direct media embed (не скачивание MP4).",
  },
  {
    key: "youtubeShareHost",
    id: "youtubeShareHostSelect",
    label: "Ссылка на YouTube Shorts (Embed-превью)",
    options: [
      ["youtube.com", "youtube.com (оригинал, по умолчанию)"],
      ["yfxtube.com", "yfxtube.com (FxYouTube)"],
      ["koutube.com", "koutube.com (Koutube)"],
    ],
    hint: "Выберите адрес, который копирует кнопка у YouTube Short. youtube.com — оригинал; yfxtube.com и koutube.com — дополнительные варианты для Embed-превью в мессенджерах.",
  },
] as const

/** "Embed": the four share hosts. Edited here, written by the explicit save action. */
export function EmbedPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  return (
    <Card data-slot="embed">
      <CardHeader>
        <CardTitle className="text-base">Embed</CardTitle>
        <CardDescription className="text-xs leading-relaxed">
          Эти настройки меняют только ссылки, которые копируют кнопки «Копировать ссылку» на страницах X, Instagram, TikTok и YouTube Shorts. Ссылки собираются локально; сохранение медиа не затрагивается.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {EMBED_FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={f.id}>{f.label}</Label>
            <Select value={s[f.key]} onValueChange={(v) => settings.setField(f.key, v)} disabled={!s.loaded}>
              <SelectTrigger id={f.id} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {f.options.map(([value, text]) => (
                  <SelectItem key={value} value={value}>
                    {text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Hint>{f.hint}</Hint>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/** The explicit save action of "Сохранение" and "Embed", with its live status. */
export function SaveBar({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { text, type } = s.status
  return (
    <div
      id="settingsSaveBar"
      className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
        Кнопка сохраняет настройки вкладок «Сохранение» и «Embed». Остальные настройки (история, уведомления) применяются сразу.
      </p>
      <div className="flex items-center gap-3">
        <div
          id="statusMessage"
          aria-live="polite"
          data-type={type}
          className={cn("flex min-h-5 items-center gap-1.5 text-xs", type === "success" && "text-success", type === "error" && "text-danger")}
        >
          {type === "success" ? <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {type === "error" ? <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {text}
        </div>
        <Button id="saveButton" type="button" disabled={!s.loaded || s.saving} onClick={() => { void settings.save() }}>
          <Save />
          Сохранить настройки
        </Button>
      </div>
    </div>
  )
}
