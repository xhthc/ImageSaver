import {useEffect,useState} from "react"
import {Download, Pause, Play, RotateCcw, X, Trash2} from "lucide-react"
import {Button} from "@/components/ui/button"
import {Alert, AlertDescription} from "@/components/ui/alert"
import {createDownloads} from "@/core/downloads.js"
import {useStore} from "@/hooks/use-store"
import {useI18n} from "@/hooks/use-i18n"
import {getEnv} from "@/lib/env"
import {createFeedbackList} from "@/core/feedbackList.js"
import {ResultRow} from "@/components/app/result-row"
import {jobFailure} from "@/core/present.js"
/* eslint-disable @typescript-eslint/no-explicit-any */
const bytes=(n:number)=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:n>=1024?`${(n/1024).toFixed(1)} KB`:`${n} B`
type FeedbackController=ReturnType<typeof createFeedbackList>
/** A job's error as a localized title/explanation (and, for a failed job on the full page, the next step), with the raw code kept on a small line.
 * A queued job that the manager retries itself (RATE_LIMIT) is not styled as a failure. */
function JobError({code,ready,full,failed}:{code:string;ready:boolean;full:boolean;failed:boolean}) {
  const {t,lang}=useI18n()
  const f=jobFailure(getEnv().FB,code,lang)
  return <div className="space-y-0.5 text-xs" data-slot="job-error">
    <p className={failed?"font-medium text-danger":"font-medium"}>{f.title}</p>
    <p className="text-muted-foreground">{f.explanation}{ready?` ${t('downloads.kept')}.`:''}</p>
    {full && failed && f.nextStep?<p className="text-muted-foreground">{f.nextStep}</p>:null}
    <p className="break-all font-mono text-[11px] text-muted-foreground">{t('failure.code',{code})}</p>
  </div>
}
function Body({controller,feedback,records=[],unreadIds=[],focusId='',full=false}:{controller:ReturnType<typeof createDownloads>;feedback?:FeedbackController;records?:any[];unreadIds?:string[];focusId?:string;full?:boolean}) {
  const s=useStore(controller.store),{t}=useI18n()
  const [retrying,setRetrying]=useState(false)
  const env=getEnv()
  const jobs=s.jobs.slice()
  // Keep old notification deep links inspectable even after their byte-queue record was removed.
  const focused=records.find(r=>r.id===focusId)
  if(focused && !s.removingIds?.includes(focused.id) && !s.dismissedIds?.includes(focused.id) && !jobs.some(j=>(j.op || j.id)===focusId))jobs.push({id:focused.id,op:focused.id,managed:false,filename:focused.filename || '',state:focused.state==='interrupted'?'failed':focused.state,received:0,total:null,speed:0,error:'',createdAt:focused.createdAt})
  // Retry stays busy until the read it requested has finished (load() also waits behind an automatic refresh in flight). It stays
  // focusable while busy (aria-disabled), and the alert holding it stays mounted until that result even if an older automatic read
  // succeeds meanwhile (then it says "Loading", not the old failure). A failed retry keeps focus on it; a successful one removes it,
  // so focus moves to the list.
  const retry=async(e:React.MouseEvent<HTMLButtonElement>)=>{
    if(retrying)return
    const list=e.currentTarget.closest('section')
    setRetrying(true)
    try{await controller.load()}finally{setRetrying(false)}
    if(controller.store.getState().status==='ready')list?.focus()
  }
  return <section aria-label={t('downloads.heading')} tabIndex={-1} className="space-y-3" data-slot={full?'results-section':undefined}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{t('downloads.heading')}</h2>
      <div className="flex items-center gap-1">
      <Button variant="ghost" size={full?'sm':'icon'} disabled={s.busy} aria-label={t(s.paused?'downloads.resume':'downloads.pause')} title={t(s.paused?'downloads.resume':'downloads.pause')} onClick={()=>void controller.command('pause',undefined)}>
        {s.paused?<Play/>:<Pause/>}{full?t(s.paused?'downloads.resume':'downloads.pause'):null}
      </Button>
      <Button variant="ghost" size="icon" disabled={s.busy || !s.jobs.some(j=>['complete','failed','cancelled'].includes(j.state))} aria-label={t('downloads.clearFinished')} title={t('downloads.clearFinished')} onClick={()=>void controller.command('clearFinished',undefined)}><Trash2/></Button>
      </div>
    </div>
    {s.error || retrying?<Alert variant={s.error?"destructive":"default"} data-slot="downloads-error"><AlertDescription className="flex flex-wrap items-center gap-2">
      <span>{s.status!=='error' && retrying?t('downloads.loading'):t(s.error)}</span>
      {s.status==='error' || retrying?<Button type="button" variant="outline" size="sm" aria-disabled={retrying} className="aria-disabled:opacity-50" onClick={retry}><RotateCcw/>{t('downloads.retryList')}</Button>:null}
    </AlertDescription></Alert>:null}
    {s.status==='loading'?<p className="text-xs text-muted-foreground">{t('downloads.loading')}</p>:null}
    {s.status==='ready' && !jobs.length?<p data-slot="empty" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('downloads.empty')}</p>:null}
    <ul className="space-y-2" data-slot="download-jobs">{jobs.map(j=>{
      const active=!['complete','failed','cancelled'].includes(j.state)
      const seconds=j.total && j.speed>0?Math.ceil((j.total-j.received)/j.speed):null
      const record=records.find(r=>r.id===(j.op || j.id))
      const actions=<>
        {active && j.managed!==false?<Button variant="ghost" size="icon" disabled={s.busy} aria-label={t('downloads.cancel')} onClick={()=>void controller.command('cancel',j.id)}><X/></Button>:null}
        {j.state==='failed' && j.managed!==false && j.error!=='EXPORT_UNCERTAIN'?<Button variant="ghost" size="icon" disabled={s.busy} aria-label={t(j.ready?'downloads.exportAgain':'downloads.retry')} onClick={()=>void controller.command('retry',j.id)}><RotateCcw/></Button>:null}
        {full && !active?<Button variant="ghost" size="icon" disabled={s.busy} aria-label={t(j.managed===false?'downloads.removeRecord':'downloads.remove')} onClick={()=>void controller.command('remove',j.id)}><Trash2/></Button>:null}
      </>
      const progress=<div className="space-y-2">
        {active?<progress className="h-1.5 w-full accent-primary" aria-label={t('downloads.progress')} max={j.total||1} value={j.total?j.received:undefined}/>:null}
        {record && active?<p className="text-xs text-muted-foreground" role="status">{t(`downloads.${j.state}`)}</p>:null}
        {j.received>0?<p className="text-xs text-muted-foreground">{bytes(j.received)} / {j.total?bytes(j.total):t('downloads.unknown')}{j.state==='receiving' && j.speed>0?` · ${bytes(j.speed)}/s`:''}{seconds!==null && j.state==='receiving'?` · ${t('downloads.remaining',{seconds})}`:''}</p>:null}
        {j.error && j.error!=='CANCELLED'?<JobError code={j.error} ready={!!j.ready} full={full} failed={j.state==='failed'}/>:null}
        {j.managed===false && active?<p className="text-xs text-muted-foreground">{t('downloads.preparingHint')}</p>:null}
      </div>
      if(record && feedback)return <ResultRow key={j.id} jobId={j.id} record={record} env={{FB:env.FB,...feedback.env}} unread={unreadIds.includes(record.id)} defaultOpen={focusId===record.id} actions={actions}><div className="px-3 pb-3">{progress}</div></ResultRow>
      return <li key={j.id} className="space-y-2 rounded-lg border bg-card p-3" data-job={j.id}>
        <div className="flex items-start gap-2"><Download className="mt-0.5 size-4 shrink-0 text-muted-foreground"/><div className="min-w-0 flex-1">
          <p className="break-all text-sm font-medium">{j.filename || t('downloads.pendingName')}</p>
          <p className="text-xs text-muted-foreground" role="status">{t(`downloads.${j.state}`)}</p>
        </div>
        {actions}
        </div>
        {progress}
      </li>
    })}</ul>
  </section>
}
function DetailedBody({controller,feedback,focusId}:{controller:ReturnType<typeof createDownloads>;feedback:FeedbackController;focusId:string}) {
  const s:any=useStore(feedback.store),{msg}=useI18n()
  return <>{s.error?<Alert variant="destructive"><AlertDescription>{msg(s.error)}</AlertDescription></Alert>:null}<Body controller={controller} feedback={feedback} records={s.records} unreadIds={s.unreadIds} focusId={focusId} full/></>
}
export function DownloadsPanel({full=false,focusId='',visible=true}:{full?:boolean;focusId?:string;visible?:boolean}) {
  const [c,setC]=useState<ReturnType<typeof createDownloads>|null>(null)
  const [feedback,setFeedback]=useState<FeedbackController|null>(null)
  useEffect(()=>{const controller=createDownloads({chrome:getEnv().chrome});setC(controller);void controller.load();return ()=>controller.dispose()},[])
  useEffect(()=>{
    if(!full)return
    const env=getEnv(),controller=createFeedbackList({chrome:env.chrome,FB:env.FB,navigator:env.navigator},{focusId,visible})
    setFeedback(controller);void controller.start().catch(()=>{})
    return ()=>controller.dispose()
    // Visibility is forwarded without resetting expanded cards or report notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[full])
  useEffect(()=>{feedback?.setVisible(visible)},[feedback,visible])
  // Feedback and byte progress use separate events; either can arrive first.
  return c?(full && feedback?<DetailedBody controller={c} feedback={feedback} focusId={focusId}/>:<Body controller={c}/>):null
}
