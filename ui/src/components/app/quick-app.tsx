import { History, Settings } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { BrandMark } from "@/components/app/brand"
import { ResultsList } from "@/components/app/results-list"
import { createQuick } from "@/core/quick.js"
import { useI18n } from "@/hooks/use-i18n"
import { useStore } from "@/hooks/use-store"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type QuickController = ReturnType<typeof createQuick>

/** The compact toolbar popup: recent results while history is enabled, otherwise a small invitation to enable it. */
export function QuickApp({ quick }: { quick: QuickController }) {
  const s: any = useStore(quick.store)
  const { t, msg } = useI18n()
  const showList = s.ready && s.enabled
  const showInvite = s.ready && !s.enabled && !s.dismissed
  const empty = s.ready && !showList && !showInvite

  return (
    <TooltipProvider>
      <div className="w-[360px] max-w-full space-y-3 p-4" data-popup="quick" data-empty={empty ? "true" : "false"}>
        <header className={empty ? "flex items-center gap-3" : "flex items-center gap-3 border-b pb-3"}>
          <BrandMark />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold tracking-tight">Image Saver</h1>
            {showList ? (
              <p className="text-xs text-muted-foreground" id="quickSubtitle">
                {t("quick.recent")}
              </p>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                id="openSettingsButton"
                variant="ghost"
                size="icon"
                aria-label={t("quick.settings")}
                onClick={() => { void quick.openSettings("saving") }}
              >
                <Settings />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              {t("quick.settings")}
            </TooltipContent>
          </Tooltip>
        </header>

        {showList ? (
          <main id="quickMain">
            <ResultsList
              key={s.mount}
              compact
              limit={5}
              heading={false}
              openFull
              isActive={() => quick.isActive(s.mount)}
            />
          </main>
        ) : null}

        {showInvite ? (
          <main id="quickMain">
            <aside id="historyInvite" aria-label={t("quick.invite.aria")} className="space-y-3 rounded-lg border bg-card p-3">
              <div className="flex gap-2.5">
                <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm leading-snug">{t("quick.invite.text")}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" id="enableHistoryButton" aria-label={t("quick.invite.enable")} onClick={() => { void quick.enableHistory() }}>
                  {t("quick.invite.enable")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  id="dismissHistoryInviteButton"
                  aria-label={t("quick.invite.dismissAria")}
                  onClick={() => { void quick.dismissInvite() }}
                >
                  {t("quick.invite.dismiss")}
                </Button>
              </div>
              {s.inviteError ? (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{msg(s.inviteError)}</AlertDescription>
                </Alert>
              ) : null}
            </aside>
          </main>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
