import {useEffect,useState} from "react"
import {Ban, CheckCircle2, ChevronDown, Clock, Download, Inbox, Layers, Loader2, Pause, Play, RotateCcw, X, Trash2, XCircle} from "lucide-react"
import {Button} from "@/components/ui/button"
import {Collapsible, CollapsibleContent, CollapsibleTrigger} from "@/components/ui/collapsible"
import {Alert, AlertDescription} from "@/components/ui/alert"
import {SectionHeader} from "@/components/app/section"
import {createDownloads} from "@/core/downloads.js"
import {useStore} from "@/hooks/use-store"
import {useI18n} from "@/hooks/use-i18n"
import {getEnv} from "@/lib/env"
import {cn} from "@/lib/utils"
import {createFeedbackList} from "@/core/feedbackList.js"
import {ResultRow} from "@/components/app/result-row"
import {jobFailure} from "@/core/present.js"
import type {DownloadBatch} from "../../../../lib/download_contracts"
/* eslint-disable @typescript-eslint/no-explicit-any */
const bytes=(n:number)=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:n>=1024?`${(n/1024).toFixed(1)} KB`:`${n} B`
const TERMINAL=['complete','failed','cancelled']
type FeedbackController=ReturnType<typeof createFeedbackList>
// Icon and tone per job state; every other (preparing or post-transfer) state spins.
const JOB_ICONS:Record<string,[typeof Download,string]>={complete:[CheckCircle2,"text-success"],failed:[XCircle,"text-danger"],cancelled:[Ban,"text-muted-foreground"],queued:[Clock,"text-muted-foreground"],receiving:[Download,"text-ring"]}
/** A job's state as an icon; the state is also written out in the row, so colour is never the only signal. */
function JobIcon({state}:{state:string}) {
  const [Icon,tone]=JOB_ICONS[state] || [Loader2,"animate-spin text-ring motion-reduce:animate-none"]
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden="true"><Icon className={cn("size-4",tone)}/></span>
}
const BATCH_SITES:Record<string,string>={x:'x.com',reddit:'Reddit'}
/** One post batch ("Save all"): counts only. "Saved" is what the browser or the chosen folder confirmed; a batch with nothing left is
 * finished, which is not the same as every file saved. No bytes, speed or ETA is aggregated across files. */
function BatchSummary({batch:b}:{batch:DownloadBatch}) {
  const {t}=useI18n()
  const parts=[b.failed&&['failed',b.failed,"text-danger"],b.cancelled&&['cancelled',b.cancelled,""],b.skipped&&['skipped',b.skipped,""],b.remaining&&['remaining',b.remaining,""]].filter(Boolean) as [string,number,string][]
  return <li data-slot="batch-summary" data-batch={b.id} className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2 text-xs leading-4">
    <Layers className="mt-px size-3.5 shrink-0 text-muted-foreground" aria-hidden="true"/>
    <p role="status" className="min-w-0 flex-1 tabular-nums">
      <span className="font-semibold">{t('downloads.batch.title',{site:BATCH_SITES[b.site]||b.site})}</span>
      {' · '}{b.saved===b.count?t('downloads.batch.allSaved',{count:b.count}):t('downloads.batch.saved',{saved:b.saved,count:b.count})}
      {parts.map(([key,n,tone])=><span key={key} className={tone||"text-muted-foreground"}>{' · '}{t('downloads.batch.'+key,{n})}</span>)}
    </p>
  </li>
}
/** A job's error as a localized title/explanation (and, for a failed job on the full page, the next step), with the raw code kept on a small line.
 * A queued job that the manager retries itself (RATE_LIMIT) is not styled as a failure. */
function JobError({code,ready,full,failed}:{code:string;ready:boolean;full:boolean;failed:boolean}) {
  const {t,lang}=useI18n()
  const f=jobFailure(getEnv().FB,code,lang)
  return <div className={cn("space-y-0.5 rounded-lg px-3 py-2 text-xs leading-[18px]",failed?"bg-danger/8":"bg-muted")} data-slot="job-error">
    <p className={failed?"font-semibold text-danger":"font-semibold"}>{f.title}</p>
    <p className="text-muted-foreground">{f.explanation}{ready?` ${t('downloads.kept')}.`:''}</p>
    {full && failed && f.nextStep?<p className="text-foreground">{f.nextStep}</p>:null}
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
  // A batch summary is shown while something of it is unfinished or one of its rows is still listed; rows keep their own actions.
  const batches=new Map<string,DownloadBatch>(s.batches.filter(b=>b.remaining>0 || jobs.some(j=>j.batch===b.id)).map(b=>[b.id,b]))
  const finished=s.jobs.some(j=>TERMINAL.includes(j.state))
  const pauseLabel=t(s.paused?'downloads.resume':'downloads.pause')
  // A row action: an icon button whose accessible name is also its tooltip.
  const rowAction=(label:string,command:Parameters<typeof controller.command>[0],id:string,icon:React.ReactNode)=><Button variant="ghost" size="icon-sm" disabled={s.busy} aria-label={label} title={label} onClick={()=>void controller.command(command,id)}>{icon}</Button>
  const queueControls=<>
    <Button variant={full?'outline':'ghost'} size={full?'sm':'icon-sm'} disabled={s.busy} aria-label={pauseLabel} title={pauseLabel} onClick={()=>void controller.command('pause',undefined)}>
      {s.paused?<Play/>:<Pause/>}{full?pauseLabel:null}
    </Button>
    <Button variant={full?'outline':'ghost'} size="icon-sm" disabled={s.busy || !finished} aria-label={t('downloads.clearFinished')} title={t('downloads.clearFinished')} onClick={()=>void controller.command('clearFinished',undefined)}><Trash2/></Button>
  </>
  const row=(j:any)=>{
    const active=!TERMINAL.includes(j.state)
    const seconds=j.total && j.speed>0?Math.ceil((j.total-j.received)/j.speed):null
    const record=records.find(r=>r.id===(j.op || j.id))
    const actions=<div className="flex shrink-0 items-center gap-0.5">
      {active && j.managed!==false?rowAction(t('downloads.cancel'),'cancel',j.id,<X/>):null}
      {j.state==='failed' && j.managed!==false && j.error!=='EXPORT_UNCERTAIN'?rowAction(t(j.ready?'downloads.exportAgain':'downloads.retry'),'retry',j.id,<RotateCcw/>):null}
    </div>
    const detailsActions=full && !active?rowAction(t(j.managed===false?'downloads.removeRecord':'downloads.remove'),'remove',j.id,<Trash2/>):null
    // Only received bytes with a known total fill the bar; preparation, checking, the wait before saving and the export itself are
    // indeterminate, and a queued job has no bar, so a full bar is never shown for a file that is not saved yet.
    const bar=active && j.state!=='queued'
    const progress=<div className="space-y-1.5 empty:hidden">
      {bar?<progress aria-label={t('downloads.progress')} max={j.state==='receiving' && j.total?j.total:1} value={j.state==='receiving' && j.total?j.received:undefined}/>:null}
      {record && active?<p className="text-xs text-muted-foreground" role="status">{t(`downloads.${j.state}`)}</p>:null}
      {j.received>0?<p className="text-xs leading-4 text-muted-foreground tabular-nums">{bytes(j.received)} / {j.total?bytes(j.total):t('downloads.unknown')}{j.state==='receiving' && j.speed>0?` · ${bytes(j.speed)}/s`:''}{seconds!==null && j.state==='receiving'?` · ${t('downloads.remaining',{seconds})}`:''}</p>:null}
      {j.error && j.error!=='CANCELLED'?<JobError code={j.error} ready={!!j.ready} full={full} failed={j.state==='failed'}/>:null}
      {j.managed===false && active?<p className="text-xs text-muted-foreground">{t('downloads.preparingHint')}</p>:null}
    </div>
    if(record && feedback)return <ResultRow key={j.id} jobId={j.id} record={record} env={{FB:env.FB,...feedback.env}} unread={unreadIds.includes(record.id)} defaultOpen={focusId===record.id} actions={actions} detailsActions={detailsActions}><div className="pr-3 pb-3 pl-14 has-[>div:empty]:hidden">{progress}</div></ResultRow>
    const summary=<><JobIcon state={j.state}/><div className="min-w-0 flex-1 pt-px">
        <p className="line-clamp-2 text-[13px] leading-[18px] font-medium break-all">{j.filename || t('downloads.pendingName')}</p>
        <p className={cn("text-xs leading-4",j.state==='failed'?"text-danger":j.state==='complete'?"text-success":"text-muted-foreground")} role="status">{t(`downloads.${j.state}`)}</p>
      </div></>
    return <li key={j.id} className={cn("space-y-2.5 rounded-xl border bg-card p-3",j.state==='failed' && "border-danger/35")} data-job={j.id} data-state={j.state}>
      {detailsActions?<Collapsible className="space-y-2.5">
        <div className="flex items-start gap-1">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:-outline-offset-2" aria-label={`${j.filename || t('downloads.pendingName')}: ${t(`downloads.${j.state}`)}`}>
            {summary}<ChevronDown className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" aria-hidden="true"/>
          </CollapsibleTrigger>
          {actions}
        </div>
        <div className="pl-11 has-[>div:empty]:hidden">{progress}</div>
        <CollapsibleContent><div className="flex justify-end">{detailsActions}</div></CollapsibleContent>
      </Collapsible>:<>
        <div className="flex items-start gap-3">{summary}{actions}</div>
        <div className="pl-11 has-[>div:empty]:hidden">{progress}</div>
      </>}
    </li>
  }
  return <section aria-label={t('downloads.heading')} tabIndex={-1} className={cn("outline-none",full?"space-y-4":"space-y-2.5")} data-slot={full?'results-section':undefined}>
    {full
      ?<SectionHeader title={t('downloads.heading')} description={t('section.downloads')}>{queueControls}</SectionHeader>
      :<div className="flex items-center justify-between gap-2"><h2 className="text-[13px] font-semibold">{t('downloads.heading')}</h2><div className="flex items-center gap-0.5">{queueControls}</div></div>}
    {s.error || retrying?<Alert variant={s.error?"destructive":"default"} data-slot="downloads-error"><AlertDescription className="flex flex-wrap items-center gap-2">
      <span>{s.status!=='error' && retrying?t('downloads.loading'):t(s.error)}</span>
      {s.status==='error' || retrying?<Button type="button" variant="outline" size="sm" aria-disabled={retrying} className="aria-disabled:opacity-50" onClick={retry}><RotateCcw/>{t('downloads.retryList')}</Button>:null}
    </AlertDescription></Alert>:null}
    {s.status==='loading'?<p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true"/>{t('downloads.loading')}</p>:null}
    {s.status==='ready' && !jobs.length && !batches.size?<p data-slot="empty" className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"><Inbox className="size-5" aria-hidden="true"/>{t('downloads.empty')}</p>:null}
    <ul className="space-y-2" data-slot="download-jobs">{[...batches.values()].filter(b=>!jobs.some(j=>j.batch===b.id)).map(b=><BatchSummary key={b.id} batch={b}/>)}{jobs.flatMap((j,i)=>{
      // the first row of a batch brings its summary and the batch's other rows; a batch is placed where its newest row is
      const batch=j.batch?batches.get(j.batch):undefined
      if(batch && jobs.findIndex(x=>x.batch===batch.id)!==i)return []
      return batch?[<BatchSummary key={'batch-'+batch.id} batch={batch}/>,...jobs.filter(x=>x.batch===batch.id).map(row)]:[row(j)]
    })}</ul>
  </section>
}
function DetailedBody({controller,feedback,focusId}:{controller:ReturnType<typeof createDownloads>;feedback:FeedbackController;focusId:string}) {
  const s:any=useStore(feedback.store),{msg}=useI18n()
  return <>{s.error?<Alert variant="destructive" className="mb-4"><AlertDescription>{msg(s.error)}</AlertDescription></Alert>:null}<Body controller={controller} feedback={feedback} records={s.records} unreadIds={s.unreadIds} focusId={focusId} full/></>
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
