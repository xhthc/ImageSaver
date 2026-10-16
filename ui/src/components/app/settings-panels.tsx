import { useEffect, useRef, useState } from "react"
import { ArrowUpCircle, CheckCircle2, ChevronDown, CircleDot, CircleHelp, ExternalLink, Folder, FolderOpen, LoaderCircle, PackageCheck, RotateCcw, Save, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Panel, SectionHeader, SettingRow } from "@/components/app/section"
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
    <p id={id} className={cn("text-xs leading-[18px] text-muted-foreground", secondary && "max-w-[72ch]")}>
      {children}
    </p>
  )
}

const LOAD_ERROR = "settings.error.load"

/** Saving/Embed before their values are read: a loading line, or the read failure with a retry through the same load(). */
function LoadState({ settings, s }: { settings: SettingsController; s: any }) {
  const { t, msg } = useI18n()
  if (s.loaded) return null
  if (s.status.type === "error" && s.status.message === LOAD_ERROR)
    return (
      <Alert variant="destructive" data-slot="settings-load-error">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{msg(s.status.message)}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async (e) => {
              // the alert (and this button) disappears after a successful read: focus moves to the panel
              const panel = e.currentTarget.closest<HTMLElement>('[role="tabpanel"]')
              await settings.load()
              if (settings.store.getState().loaded) panel?.focus()
            }}
          >
            <RotateCcw aria-hidden="true" />
            {t("settings.retryLoad")}
          </Button>
        </AlertDescription>
      </Alert>
    )
  return <p role="status" className="text-sm text-muted-foreground" data-slot="settings-loading">{t("settings.loading")}</p>
}

/** "Saving": destination, subfolder and folder organization. Edited here, written by the explicit save action. */
export function SavingPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { t, msg, lang } = useI18n()
  const preview = settings.preview(lang)
  const destination = s.saveDirectoryId ? s.directoryName || t('saving.selectedFolder') : t('saving.browserFolder')
  return (
    <section data-slot="saving" className="space-y-4">
      <SectionHeader title={t("tab.saving")} description={t("section.saving")} />
      <LoadState settings={settings} s={s} />
      <Panel>
        <section aria-labelledby="destinationLabel" className="space-y-3 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-ring" aria-hidden="true"><Folder className="size-4" /></span>
              <div className="min-w-0 space-y-0.5">
                <Label id="destinationLabel" className="text-xs font-normal text-muted-foreground">{t('saving.baseFolder')}</Label>
                <p className="text-sm font-medium wrap-anywhere">{destination}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {s.saveDirectoryId?<Button type="button" variant="ghost" disabled={s.saving || s.picking} onClick={()=>settings.resetDirectory()}>{t('saving.useBrowserFolder')}</Button>:null}
              <Button type="button" variant="outline" disabled={!s.loaded || s.saving || s.picking} onClick={()=>void settings.pickDirectory()}><FolderOpen/>{t('saving.chooseFolder')}</Button>
            </div>
          </div>
          <Hint>{t('saving.baseFolderHint')}</Hint>
          {s.directoryError?<Alert variant="destructive"><AlertDescription>{msg(s.directoryError)}</AlertDescription></Alert>:null}
        </section>
        <div className="space-y-2 px-4 py-4 sm:px-5">
          <Label htmlFor="subfolderInput">{t("saving.folderLabel")}</Label>
          <div className="flex h-9 items-stretch overflow-hidden rounded-md border border-input focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40 hover:border-ring/60">
            <span className="flex max-w-[45%] items-center gap-1 border-r bg-muted px-2.5 text-xs text-muted-foreground"><span className="truncate">{s.saveDirectoryId?s.directoryName || t('saving.selectedFolder'):t("saving.downloads")}</span>/</span>
            <Input
              id="subfolderInput"
              type="text"
              value={s.subfolder}
              placeholder="SavedImages"
              spellCheck={false}
              disabled={!s.loaded}
              aria-describedby="folderPreviewHint"
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              onChange={(e) => settings.setField("subfolder", e.target.value)}
            />
          </div>
          <Hint>{t("saving.folderHint")}</Hint>
        </div>
      </Panel>

      <Panel>
        <section aria-labelledby="folderModeLabel" className="space-y-3 px-4 py-4 sm:px-5">
          <Label id="folderModeLabel">{t("saving.modeLabel")}</Label>
          <RadioGroup
            aria-labelledby="folderModeLabel"
            value={s.folderOrganizationMode}
            onValueChange={(v) => settings.setField("folderOrganizationMode", v)}
            disabled={!s.loaded}
            className="grid gap-2 sm:grid-cols-2"
          >
            <div className="flex items-center gap-3 rounded-lg border px-3 hover:bg-accent has-[[data-state=checked]]:border-ring has-[[data-state=checked]]:bg-selected">
              <RadioGroupItem value="single" id="folderModeSingle" />
              <Label htmlFor="folderModeSingle" className="min-h-11 flex-1 cursor-pointer py-2 font-normal">{t("saving.modeSingle")}</Label>
            </div>
            <div className="flex items-center gap-3 rounded-lg border px-3 hover:bg-accent has-[[data-state=checked]]:border-ring has-[[data-state=checked]]:bg-selected">
              <RadioGroupItem value="by_site_and_type" id="folderModeBySiteType" />
              <Label htmlFor="folderModeBySiteType" className="min-h-11 flex-1 cursor-pointer py-2 font-normal">{t("saving.modeBySite")}</Label>
            </div>
          </RadioGroup>
          <Hint secondary>{t("saving.modeHint")}</Hint>
        </section>
        <AuthorFolders settings={settings} s={s} />
      </Panel>

      <div className="rounded-xl border border-dashed bg-muted/50 px-4 py-3 sm:px-5">
        <Hint id="folderPreviewHint">
          {t("saving.example")}{" "}
          <span
            id="folderPreviewPath"
            data-error={preview.error ? "true" : "false"}
            className={cn("mt-1 block font-mono text-[13px] leading-5 break-all", preview.error ? "text-danger" : "text-foreground")}
          >
            {preview.text}
          </span>
        </Hint>
      </div>
    </section>
  )
}

// Author folders (PIXIV-SAVING-POLISH-01): one service menu in the Embed control style; each choice is a Saving draft written by Save.
const AUTHOR_SERVICES = [
  ["xAuthorFolders", "x.com"],
  ["redditAuthorFolders", "Reddit"],
  ["pixivAuthorFolders", "Pixiv"],
] as const

function AuthorFolders({ settings, s }: { settings: SettingsController; s: any }) {
  const { t } = useI18n()
  const chosen = AUTHOR_SERVICES.filter(([key]) => s[key] === true).map(([, name]) => name)
  return (
    <div className="grid items-center gap-x-6 gap-y-2 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)]">
      <div className="space-y-1.5">
        <Label id="authorFoldersLabel" htmlFor="authorFoldersTrigger">{t("saving.authorFolders")}</Label>
        <Hint id="authorFoldersHint">{t("saving.authorFoldersHint")}</Hint>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!s.loaded || s.saving}>
          <button
            id="authorFoldersTrigger"
            type="button"
            aria-labelledby="authorFoldersLabel authorFoldersSummary"
            aria-describedby="authorFoldersHint"
            className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm transition-[color,box-shadow] outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span id="authorFoldersSummary" className={cn("truncate", !chosen.length && "text-muted-foreground")}>{chosen.length ? chosen.join(", ") : t("saving.authorFoldersNone")}</span>
            <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-labelledby="authorFoldersLabel">
          {AUTHOR_SERVICES.map(([key, name]) => (
            <DropdownMenuCheckboxItem
              key={key}
              data-service={key}
              checked={s[key] === true}
              // keep the menu open while several services are checked; Escape, Tab or a click outside closes it
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(value) => settings.setField(key, value === true)}
            >
              {name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** "Notifications": the independent success-notification preference, applied immediately. */
export function NotificationsPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { t, msg } = useI18n()
  return (
    <section data-slot="notifications" className="space-y-4">
      <SectionHeader title={t("tab.notifications")} description={t("section.notifications")} />
      <Panel>
        <SettingRow
          label={<Label htmlFor="notifySuccessSectionSwitch" className="cursor-pointer leading-5">{t("notify.switch")}</Label>}
          hint={<Hint>{t("notify.hint")}</Hint>}
          className="md:grid-cols-[minmax(0,1fr)_auto]"
        >
          <Switch
            id="notifySuccessSectionSwitch"
            checked={s.notify.checked}
            onCheckedChange={(v) => { void settings.setNotifySuccess(v) }}
          />
        </SettingRow>
        <div className="flex gap-3 px-4 py-3.5 sm:px-5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <Hint secondary>{t("notify.hintErrors")}</Hint>
        </div>
      </Panel>
      {s.notify.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{msg(s.notify.error)}</AlertDescription>
        </Alert>
      ) : null}
    </section>
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
  const StatusIcon = s.checking ? LoaderCircle : s.error ? TriangleAlert : newer ? ArrowUpCircle : PackageCheck
  return (
    <section data-slot="updates" className="space-y-4">
      <SectionHeader title={t("tab.updates")} description={t("section.updates")} />
      <Panel>
        <div className="flex flex-wrap items-start gap-4 px-4 py-4 sm:px-5">
          <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted", s.error ? "text-danger" : newer ? "text-ring" : "text-muted-foreground")} aria-hidden="true">
            <StatusIcon className={cn("size-5", s.checking && "motion-safe:animate-spin")} />
          </span>
          <div className="min-w-0 flex-1 basis-60 space-y-1">
            <p className="text-xs text-muted-foreground tabular-nums">{t("updates.installed", { version: s.currentVersion })}</p>
            <div role="status" aria-live="polite" data-slot="update-status" className={cn("text-sm font-medium", s.error && "text-danger")}>
              {s.checking ? t("updates.checking") : s.error ? msg(s.error) : !s.checkedAt ? t("updates.notChecked") : newer
                ? t(s.release.prerelease ? "updates.availableBeta" : "updates.available", { version: s.release.version })
                : s.release ? t("updates.none") : t("updates.noReleases")}
            </div>
            {s.checkedAt ? <Hint>{t("updates.lastCheck", { time: new Date(s.checkedAt).toLocaleString(locale) })}</Hint> : null}
            {s.notice ? <p role="alert" className="text-xs text-danger">{msg(s.notice)}</p> : null}
          </div>
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <Button id="checkUpdatesButton" disabled={!s.loaded || s.checking} onClick={() => { void updates.check(true) }}>{t("updates.checkNow")}</Button>
          </div>
        </div>
        <div className="px-4 py-3 sm:px-5">
          <a href={s.release?.url || RELEASES_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-ring underline underline-offset-2 hover:text-foreground">
            {newer ? t("updates.openRelease") : t("updates.openReleases")}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        </div>
        <SettingRow label={<Label htmlFor="releaseChannelSelect">{t("updates.channel")}</Label>} hint={<Hint>{t("updates.betaHint")}</Hint>}>
          <Select value={s.channel} disabled={!s.loaded || s.checking} onValueChange={(v) => { void updates.setChannel(v) }}>
            <SelectTrigger id="releaseChannelSelect" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="stable">{t("updates.stable")}</SelectItem>
              <SelectItem value="beta">{t("updates.beta")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </Panel>
      <Panel>
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <p className="text-sm font-semibold">{t("updates.howTo")}</p>
          <ol className="space-y-2 text-sm">
            {["updates.step1", "updates.step2", "updates.step3"].map((key, i) => (
              <li key={key} className="flex gap-3">
                <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 leading-5">{t(key)}</span>
              </li>
            ))}
          </ol>
          <Hint>{t("updates.noAuto")}</Hint>
          <Hint>{t("updates.cadence")}</Hint>
        </div>
      </Panel>
    </section>
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
      ["kkclip.com", "embed.backup"],
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

/**
 * The question icon beside a share-host label: a floating bubble (portal, so the grid, the selects and the Save bar never move).
 * Radix opens it on hover and keyboard focus and closes it on Escape; it ignores touch and closes on a press, so the press
 * toggles it explicitly: a tap, Enter or Space opens a closed bubble and closes an open one.
 */
function EmbedHelp({ label, hint }: { label: string; hint: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const wasOpen = useRef(false) // the bubble's state when the current press began (Radix closes an open bubble on press)
  const trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelLeave = () => clearTimeout(leaveTimer.current)
  // Radix can miss the last move after a fast exit; recheck hover after the icon-to-bubble grace period.
  const checkLeave = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return
    cancelLeave()
    leaveTimer.current = setTimeout(() => {
      if (!trigger.current?.matches(":hover, :focus-visible") && !content.current?.matches(":hover")) setOpen(false)
    }, 180)
  }
  useEffect(() => () => clearTimeout(leaveTimer.current), [])
  useEffect(() => { if (!open) clearTimeout(leaveTimer.current) }, [open])
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("embed.help") + ": " + label}
          className="not-data-[state=closed]:text-ring pointer-coarse:size-11"
          ref={trigger}
          onPointerEnter={cancelLeave}
          onPointerLeave={checkLeave}
          onPointerDown={() => { wasOpen.current = open }}
          onClick={(e) => { e.preventDefault(); setOpen(!(e.detail ? wasOpen.current : open)) }}
        >
          <CircleHelp aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent ref={content} onPointerEnter={cancelLeave} onPointerLeave={checkLeave} side="top" collisionPadding={8} className="max-w-[min(20rem,var(--radix-tooltip-content-available-width))] leading-[18px]">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

/** "Embed": the four share hosts. Edited here, written by the explicit save action. */
export function EmbedPanel({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { t } = useI18n()
  // a catalogue key is translated with its host; a fixed service name is shown as it is
  const optionText = (host: string, text: string) => (text.startsWith("embed.") ? t(text, { host }) : text)
  return (
    <section data-slot="embed" className="@container space-y-4">
      <SectionHeader title={t("embed.title")} description={t("embed.desc")} />
      <div className="empty:hidden"><LoadState settings={settings} s={s} /></div>
      <Panel>
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 p-4 sm:p-5 @min-[36rem]:grid-cols-2">
          {EMBED_FIELDS.map((f) => (
            <div key={f.key} className="min-w-0">
              <div className="mb-2 flex items-center justify-between gap-2">
                <Label htmlFor={f.id}>{t(f.label)}</Label>
                <EmbedHelp label={t(f.label)} hint={t(f.hint)} />
              </div>
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
      </Panel>
      <Hint secondary>{t("embed.services")}</Hint>
    </section>
  )
}

/** The explicit save action of "Saving" and "Embed", with its live status. */
export function SaveBar({ settings }: { settings: SettingsController }) {
  const s: any = useStore(settings.store)
  const { t, msg } = useI18n()
  // One line for the whole lifecycle: reading, saving, an error (kept until the next attempt), unsaved edits, then success.
  // A success message never hides a draft that differs from storage. A read failure is shown with its retry in the panels.
  const { message, type } = s.status
  const state = !s.loaded ? (type === "error" ? "" : "loading") : s.saving ? "saving" : type === "error" ? "error" : s.dirty ? "dirty" : message ? type : ""
  const text = state === "loading" ? t("settings.loading") : state === "saving" ? t("settings.saving") : state === "dirty" ? t("settings.unsaved") : state ? msg(message) : ""
  return (
    <div
      id="settingsSaveBar"
      data-state={state}
      className={cn(
        "sticky bottom-3 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card/95 px-4 py-3 shadow-float backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:px-5",
        state === "dirty" && "border-ring/60",
      )}
    >
      <p className="min-w-0 flex-1 basis-56 text-xs leading-[18px] text-muted-foreground">{t("savebar.hint")}</p>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
        <div
          id="statusMessage"
          aria-live="polite"
          data-type={state}
          className={cn("flex min-h-5 items-center gap-1.5 text-xs", state === "success" && "text-success", state === "error" && "text-danger", state === "dirty" && "font-medium text-foreground")}
        >
          {state === "success" ? <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {state === "error" ? <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {state === "dirty" ? <CircleDot className="size-3.5 shrink-0 text-ring" aria-hidden="true" /> : null}
          {state === "saving" || state === "loading" ? <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" /> : null}
          {text}
        </div>
        <Button id="saveButton" type="button" disabled={!s.loaded || s.saving || s.picking} onClick={() => { void settings.save() }}>
          <Save />
          {t("savebar.save")}
        </Button>
      </div>
    </div>
  )
}
