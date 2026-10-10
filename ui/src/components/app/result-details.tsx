import { useId, useRef, useState } from "react"
import { Check, ClipboardCopy, ExternalLink, Link2 } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  buildReportText,
  copyText,
  filenameLine,
  hasReport,
  postUrlOf,
} from "@/core/present.js"
import { useI18n } from "@/hooks/use-i18n"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type DetailsEnv = { FB: any; navigator: any; version: string; browser: string }

/** Failure report: the notes and the preview are the allow-listed text; it is copied only on a click, never sent. */
function ReportBox({ record, env }: { record: any; env: DetailsEnv }) {
  const notesId = useId()
  const { t } = useI18n()
  const [notes, setNotes] = useState("")
  // the status is kept as a key, so a language change re-renders it
  const [status, setStatus] = useState("")
  const [ok, setOk] = useState(false)
  const preview = useRef<HTMLTextAreaElement>(null)
  // The report time is fixed while the text is shown, so what is previewed is exactly what is copied.
  const [now, setNow] = useState(() => Date.now())
  const text = buildReportText(env.FB, record, notes, env, now)

  async function copy() {
    const fresh = Date.now()
    const current = buildReportText(env.FB, record, notes, env, fresh)
    setNow(fresh)
    try {
      await copyText(current, env.navigator)
      setOk(true)
      setStatus("report.copied")
    } catch {
      // Truthful failure: nothing was copied. Select the text so the user can copy it manually.
      setOk(false)
      setStatus("report.copyFailed")
      try {
        preview.current?.focus()
        preview.current?.select()
      } catch {
        /* selection is a convenience only */
      }
    }
  }

  return (
    <div className="space-y-2" data-slot="report">
      <Alert data-slot="retry-hint">
        <AlertDescription className="text-xs">{t("report.retryHint")}</AlertDescription>
      </Alert>
      <p className="text-xs text-muted-foreground">{t("report.privacy")}</p>
      <Textarea
        id={notesId}
        value={notes}
        maxLength={env.FB.LIMITS.notes}
        rows={2}
        aria-label={t("report.notes")}
        placeholder={t("report.notes")}
        className="min-h-0 text-xs"
        onChange={(e) => setNotes(e.target.value)}
      />
      <Textarea
        ref={preview}
        readOnly
        rows={8}
        value={text}
        aria-label={t("report.preview")}
        className="min-h-0 font-mono text-[11px] leading-snug"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          {ok ? <Check /> : <ClipboardCopy />}
          {t("report.copy")}
        </Button>
        <p role="status" aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
          {status ? t(status) : ""}
        </p>
      </div>
    </div>
  )
}

/** Link to the owning post (history only): a real link only for a validated post URL, otherwise an honest "unknown". */
function PostBlock({ record, env }: { record: any; env: DetailsEnv }) {
  const post = postUrlOf(env.FB, record)
  const { t } = useI18n()
  const [status, setStatus] = useState("") // a catalogue key
  if (!post) {
    return (
      <p className="text-xs text-muted-foreground" data-slot="post">
        {t("post.unknown")}
      </p>
    )
  }
  async function copy() {
    try {
      await copyText(post, env.navigator)
      setStatus("post.copied")
    } catch {
      setStatus("post.copyFailed")
    }
  }
  return (
    <div className="space-y-1.5" data-slot="post">
      <p className="text-xs break-all">
        <span className="text-muted-foreground">{t("post.label")} </span>
        <a
          href={post}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-ring underline underline-offset-2 hover:text-foreground"
        >
          {post}
          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
        </a>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={copy}>
          <Link2 />
          {t("post.copy")}
        </Button>
        <p role="status" aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
          {status ? t(status) : ""}
        </p>
      </div>
    </div>
  )
}

/** Details of one result: summary, the file name and its provenance, and for failures the retry hint and the report. */
export function ResultDetails({
  record,
  env,
  showPost = false,
  onOpenFull,
}: {
  record: any
  env: DetailsEnv
  showPost?: boolean
  onOpenFull?: (record: any) => void
}) {
  const { t, lang } = useI18n()
  const summary = env.FB.summarize(record, lang)
  const nameLine = filenameLine(record, lang)
  return (
    <div className="space-y-3 rounded-lg border bg-background/50 p-3 text-xs" data-slot="result-details">
      <div className="space-y-1">
        <p className="text-sm font-semibold" data-slot="title">
          {summary.title}
        </p>
        {summary.explanation ? <p className="text-muted-foreground">{summary.explanation}</p> : null}
      </div>
      <ul className="space-y-1 break-words">
        {nameLine ? (
          <li data-slot="filename-line" className="break-all font-medium">
            {nameLine}
          </li>
        ) : null}
        {summary.lines.map((line: string, i: number) => (
          <li key={i} className="text-muted-foreground">
            {line}
          </li>
        ))}
      </ul>
      {summary.nextStep ? (
        <p className="rounded-md bg-accent/60 px-2 py-1.5" data-slot="next-step">
          {summary.nextStep}
        </p>
      ) : null}
      {hasReport(record) ? <ReportBox record={record} env={env} /> : null}
      {showPost ? <PostBlock record={record} env={env} /> : null}
      {onOpenFull ? (
        <Button type="button" size="sm" variant="outline" onClick={() => onOpenFull(record)}>
          <ExternalLink />
          {t("details.openFull")}
        </Button>
      ) : null}
    </div>
  )
}
