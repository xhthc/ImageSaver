import { useEffect, useState } from "react"
import { CheckCircle2, ChevronDown, FolderOpen, Save, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { createSettings } from "@/core/settings.js"
import { createUpdates, isNewer, RELEASES_URL } from "@/core/updates.js"
import { useI18n } from "@/hooks/use-i18n"
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

/** "Saving": subfolder and folder organization. Edited here, written by the explicit save action. */
export function SavingPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { t, msg, lang } = useI18n()
  const preview = settings.preview(lang)
  return (
    <Card data-slot="saving">
      <CardHeader>
        <CardTitle className="text-base">
          {t("tab.saving")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="destinationLabel" className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label id="destinationLabel">{t('saving.baseFolder')}</Label>
              <p className="break-all text-sm text-muted-foreground">{s.saveDirectoryId?s.directoryName || t('saving.selectedFolder'):t('saving.browserFolder')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={!s.loaded || s.saving || s.picking} onClick={()=>void settings.pickDirectory()}><FolderOpen/>{t('saving.chooseFolder')}</Button>
              {s.saveDirectoryId?<Button type="button" variant="ghost" disabled={s.saving || s.picking} onClick={()=>settings.resetDirectory()}>{t('saving.useBrowserFolder')}</Button>:null}
            </div>
          </div>
          <Hint>{t('saving.baseFolderHint')}</Hint>
          {s.saveDirectoryId?<div className="space-y-2"><Button type="button" variant="outline" disabled={!s.loaded || s.saving || s.picking || s.linking} onClick={()=>void settings.linkExplorer()}><FolderOpen/>{t('saving.linkExplorer')}</Button><Hint>{t('saving.explorerHint')}</Hint><p className="break-all text-xs text-muted-foreground">{t('saving.extensionId')}: {getEnv().chrome.runtime.id}</p></div>:null}
          {s.directoryError?<Alert variant="destructive"><AlertDescription>{msg(s.directoryError)}</AlertDescription></Alert>:null}
          <div className="space-y-1.5">
            <Label htmlFor="subfolderInput">{t("saving.folderLabel")}</Label>
            <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background/40 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40">
              <span className="flex max-w-[40%] items-center border-r bg-muted px-2.5 text-xs text-muted-foreground"><span className="truncate">{s.saveDirectoryId?s.directoryName || t('saving.selectedFolder'):t("saving.downloads")}</span> /</span>
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
            <Hint>{t("saving.folderHint")}</Hint>
          </div>
        </section>

        <section aria-labelledby="folderModeLabel" className="space-y-3 border-t pt-5">
          <Label id="folderModeLabel">{t("saving.modeLabel")}</Label>
          <RadioGroup
            aria-labelledby="folderModeLabel"
            value={s.folderOrganizationMode}
            onValueChange={(v) => settings.setField("folderOrganizationMode", v)}
            disabled={!s.loaded}
            className="grid gap-2 sm:grid-cols-2"
          >
            <div className="flex items-center gap-2.5 rounded-lg border bg-background/40 px-3 has-[[data-state=checked]]:border-ring">
              <RadioGroupItem value="single" id="folderModeSingle" />
              <Label htmlFor="folderModeSingle" className="min-h-11 flex-1 cursor-pointer py-2 font-normal">{t("saving.modeSingle")}</Label>
            </div>
            <div className="flex items-center gap-2.5 rounded-lg border bg-background/40 px-3 has-[[data-state=checked]]:border-ring">
              <RadioGroupItem value="by_site_and_type" id="folderModeBySiteType" />
              <Label htmlFor="folderModeBySiteType" className="min-h-11 flex-1 cursor-pointer py-2 font-normal">{t("saving.modeBySite")}</Label>
            </div>
          </RadioGroup>
          <Hint secondary>{t("saving.modeHint")}</Hint>

          <div className="flex items-center justify-between gap-4 border-t pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="xAuthorFolders" className="cursor-pointer">{t('saving.xAuthor')}</Label>
              <Hint id="xAuthorHint">{t('saving.xAuthorHint')}</Hint>
            </div>
            <Switch id="xAuthorFolders" checked={s.xAuthorFolders} disabled={!s.loaded || s.saving} onCheckedChange={v=>settings.setField('xAuthorFolders',v)} aria-describedby="xAuthorHint"/>
          </div>
        </section>

        <div className="rounded-lg border bg-muted/40 p-3">
          <Hint id="folderPreviewHint">
            {t("saving.example")}{" "}
            <span
              id="folderPreviewPath"
              data-error={preview.error ? "true" : "false"}
              className={cn("mt-1.5 block font-mono text-xs break-all", preview.error ? "text-danger" : "text-foreground")}
            >
              {preview.text}
            </span>
          </Hint>
        </div>

      </CardContent>
    </Card>
  )
}

/** "Notifications": the independent success-notification preference, applied immediately. */
export function NotificationsPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { t, msg } = useI18n()
  return (
    <Card data-slot="notifications">
      <CardHeader>
        <CardTitle className="text-base">{t("tab.notifications")}</CardTitle>
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
            {t("notify.switch")}
          </Label>
        </div>
        <Hint>{t("notify.hint")}</Hint>
        <Hint secondary>{t("notify.hintErrors")}</Hint>
        {s.notify.error ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{msg(s.notify.error)}</AlertDescription>
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
  const { t, msg, locale } = useI18n()
  useEffect(() => { if (active) void updates.check() }, [active, updates])
  useEffect(() => () => updates.dispose(), [updates])
  const newer = s.release && isNewer(s.release.version, s.currentVersion)
  return (
    <Card data-slot="updates">
      <CardHeader>
        <CardTitle className="text-base">{t("tab.updates")}</CardTitle>
        <CardDescription>{t("updates.installed", { version: s.currentVersion })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="releaseChannelSelect">{t("updates.channel")}</Label>
          <Select value={s.channel} disabled={!s.loaded || s.checking} onValueChange={(v) => { void updates.setChannel(v) }}>
            <SelectTrigger id="releaseChannelSelect" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="stable">{t("updates.stable")}</SelectItem>
              <SelectItem value="beta">{t("updates.beta")}</SelectItem>
            </SelectContent>
          </Select>
          <Hint>{t("updates.betaHint")}</Hint>
        </div>
        <div role="status" aria-live="polite" data-slot="update-status">
          {s.checking ? t("updates.checking") : s.error ? msg(s.error) : !s.checkedAt ? t("updates.notChecked") : newer
            ? t(s.release.prerelease ? "updates.availableBeta" : "updates.available", { version: s.release.version })
            : s.release ? t("updates.none") : t("updates.noReleases")}
        </div>
        {s.checkedAt ? <Hint>{t("updates.lastCheck", { time: new Date(s.checkedAt).toLocaleString(locale) })}</Hint> : null}
        {s.notice ? <p role="alert" className="text-xs text-danger">{msg(s.notice)}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button id="checkUpdatesButton" disabled={!s.loaded || s.checking} onClick={() => { void updates.check(true) }}>{t("updates.checkNow")}</Button>
          <a href={s.release?.url || RELEASES_URL} target="_blank" rel="noopener noreferrer" className="text-sm text-ring underline underline-offset-2">{newer ? t("updates.openRelease") : t("updates.openReleases")}</a>
        </div>
        <Hint>{t("updates.cadence")}</Hint>
        <div className="space-y-2 text-sm">
          <p className="font-medium">{t("updates.howTo")}</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>{t("updates.step1")}</li>
            <li>{t("updates.step2")}</li>
            <li>{t("updates.step3")}</li>
          </ol>
          <Hint>{t("updates.noAuto")}</Hint>
        </div>
      </CardContent>
    </Card>
  )
}

// Each option names its host as it is; only the role (original, primary, backup) or the service name is translated.
const EMBED_FIELDS = [
  {
    key: "xShareHost",
    id: "xShareHostSelect",
    label: "embed.x.label",
    options: [
      ["fixupx.com", "embed.primary"],
      ["x.com", "embed.original"],
      ["cunnyx.com", "embed.backup"],
    ],
    hint: "embed.x.hint",
  },
  {
    key: "igShareHost",
    id: "igShareHostSelect",
    label: "embed.ig.label",
    options: [
      ["oginstagram.com", "embed.primary"],
      ["instagram.com", "embed.original"],
      ["kirkstagram.com", "embed.backup"],
    ],
    hint: "embed.ig.hint",
  },
  {
    key: "ttShareHost",
    id: "ttShareHostSelect",
    label: "embed.tt.label",
    options: [
      ["tnktok.com", "embed.primary"],
      ["tiktok.com", "embed.original"],
      ["d.tnktok.com", "embed.backup"],
    ],
    hint: "embed.tt.hint",
  },
  {
    key: "youtubeShareHost",
    id: "youtubeShareHostSelect",
    label: "embed.yt.label",
    options: [
      ["koutube.com", "embed.primary"],
      ["youtube.com", "embed.original"],
      ["yfxtube.com", "yfxtube.com (FxYouTube)"],
    ],
    hint: "embed.yt.hint",
  },
] as const

/** "Embed": the four share hosts. Edited here, written by the explicit save action. */
export function EmbedPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { t } = useI18n()
  // a catalogue key is translated with its host; a fixed service name is shown as it is
  const optionText = (host: string, text: string) => (text.startsWith("embed.") ? t(text, { host }) : text)
  return (
    <Card data-slot="embed">
      <CardHeader>
        <CardTitle className="text-base">{t("embed.title")}</CardTitle>
        <CardDescription className="text-xs leading-relaxed">{t("embed.desc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
        {EMBED_FIELDS.map((f) => (
          <div key={f.key} className="grid items-center gap-2 py-3 first:pt-0 sm:grid-cols-[1fr_18rem]">
            <Label htmlFor={f.id}>{t(f.label)}</Label>
            <Select value={s[f.key]} onValueChange={(v) => settings.setField(f.key, v)} disabled={!s.loaded}>
              <SelectTrigger id={f.id} className="w-full">
                <SelectValue>{s[f.key]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {f.options.map(([value, text]) => (
                  <SelectItem key={value} value={value}>
                    {optionText(value, text)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
        </div>
        <Collapsible className="mt-2 border-t pt-3">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group -ml-2 text-muted-foreground">
              {t("embed.help")}
              <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 pt-3">
              <Hint>{t("embed.services")}</Hint>
              {EMBED_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1">
                  <p className="text-xs font-medium">{t(f.label)}</p>
                  <Hint>{t(f.hint)}</Hint>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}

/** The explicit save action of "Saving" and "Embed", with its live status. */
export function SaveBar({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { t, msg } = useI18n()
  const { message, type } = s.status
  return (
    <div
      id="settingsSaveBar"
      className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">{t("savebar.hint")}</p>
      <div className="flex items-center gap-3">
        <div
          id="statusMessage"
          aria-live="polite"
          data-type={type}
          className={cn("flex min-h-5 items-center gap-1.5 text-xs", type === "success" && "text-success", type === "error" && "text-danger")}
        >
          {type === "success" ? <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {type === "error" ? <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {msg(message)}
        </div>
        <Button id="saveButton" type="button" disabled={!s.loaded || s.saving || s.picking} onClick={() => { void settings.save() }}>
          <Save />
          {t("savebar.save")}
        </Button>
      </div>
    </div>
  )
}
