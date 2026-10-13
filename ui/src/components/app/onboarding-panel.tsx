import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { createOnboarding } from "@/core/onboarding.js"
import { I18n } from "@/core/i18n.js"
import { useI18n } from "@/hooks/use-i18n"
import { useStore } from "@/hooks/use-store"
import { getEnv } from "@/lib/env"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type OnboardingController = ReturnType<typeof createOnboarding>

/** One guide controller per page (like the theme): it reads the dismissed marker once and never writes it on load. */
export function useOnboarding() {
  const [controller, setController] = useState<OnboardingController | null>(null)
  useEffect(() => {
    const env = getEnv()
    const onboarding = createOnboarding({ chrome: env.chrome, location: env.location })
    setController(onboarding)
    return () => onboarding.dispose()
  }, [])
  return controller
}

const GUIDE_ID = "onboarding"
const GUIDE_TITLE_ID = "onboardingTitle"

/**
 * The install welcome: shown instead of the main interface (the page hides its tabs, panels and Save bar meanwhile).
 * Three short steps and one Continue; nothing here picks a folder, asks for a permission or starts a download.
 * `onClosed()` runs only after the marker was written.
 */
export function WelcomeScreen({ onboarding, onClosed }: { onboarding: OnboardingController; onClosed: () => void }) {
  const s: any = useStore(onboarding.store)
  const { t, msg } = useI18n()
  if (!s.open) return null
  const close = async () => {
    if (await onboarding.dismiss()) onClosed()
  }
  return (
    <section id={GUIDE_ID} aria-labelledby={GUIDE_TITLE_ID} data-slot="onboarding" className="flex flex-1 items-start justify-center sm:pt-6">
      <Card className="w-full max-w-xl gap-4 py-5">
        <CardHeader className="gap-1">
          <CardTitle id={GUIDE_TITLE_ID} role="heading" aria-level={2} className="text-lg">
            {t("onboarding.title")}
          </CardTitle>
          <CardDescription>{t("onboarding.intro")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol aria-label={t("onboarding.steps")} className="space-y-4">
            <GuideStep n={1} title={t("onboarding.step1.title")} text={t("onboarding.step1.text", { title: I18n.MENU_TITLE })} />
            <GuideStep n={2} title={t("onboarding.step2.title")} text={t("onboarding.step2.text")} />
            <GuideStep n={3} title={t("onboarding.step3.title")} text={t("onboarding.step3.text")} />
          </ol>
          {s.error ? (
            <Alert variant="destructive" data-slot="onboarding-error">
              <AlertDescription>{msg(s.error)}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="button" disabled={s.saving} onClick={() => void close()}>{t("onboarding.continue")}</Button>
        </CardFooter>
      </Card>
    </section>
  )
}

function GuideStep({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <li className="flex gap-3" data-step={n}>
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{n}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </li>
  )
}
