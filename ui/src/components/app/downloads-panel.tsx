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
/* eslint-disable @typescript-eslint/no-explicit-any */
const bytes=(n:number)=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:n>=1024?`${(n/1024).toFixed(1)} KB`:`${n} B`
type FeedbackController=ReturnType<typeof createFeedbackList>
function Body({controller,feedback,records=[],unreadIds=[],focusId='',full=false}:{controller:ReturnType<typeof createDownloads>;feedback?:FeedbackController;records?:any[];unreadIds?:string[];focusId?:string;full?:boolean}) {
  const s:any=useStore(controller.store),{t}=useI18n()
  const env=getEnv()
  const jobs=s.jobs.slice()
  // Keep old notification deep links inspectable even after their byte-queue record was removed.
  const focused=records.find(r=>r.id===focusId)
  if(focused && !jobs.some((j:any)=>(j.op || j.id)===focusId))jobs.push({id:focused.id,op:focused.id,managed:false,state:focused.state,received:0})
  return <section aria-label={t('downloads.heading')} className="space-y-3" data-slot={full?'results-section':undefined}>
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{t('downloads.heading')}</h2>
      <Button variant="ghost" size="sm" disabled={s.busy} onClick={()=>void controller.command('pause',undefined)}>
        {s.paused?<Play/>:<Pause/>}{t(s.paused?'downloads.resume':'downloads.pause')}
      </Button>
    </div>
    {s.error?<Alert variant="destructive"><AlertDescription>{t(s.error)}</AlertDescription></Alert>:null}
    {s.status==='loading'?<p className="text-xs text-muted-foreground">{t('downloads.loading')}</p>:null}
    {s.status==='ready' && !jobs.length?<p data-slot="empty" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('downloads.empty')}</p>:null}
    <ul className="space-y-2" data-slot="download-jobs">{jobs.map((j:any)=>{
      const active=!['complete','failed','cancelled'].includes(j.state)
      const seconds=j.total && j.speed>0?Math.ceil((j.total-j.received)/j.speed):null
      const record=records.find(r=>r.id===(j.op || j.id))
      const actions=<>
        {active && j.managed!==false?<Button variant="ghost" size="icon" disabled={s.busy} aria-label={t('downloads.cancel')} onClick={()=>void controller.command('cancel',j.id)}><X/></Button>:null}
        {j.state==='failed' && j.managed!==false?<Button variant="ghost" size="icon" disabled={s.busy} aria-label={t(j.ready?'downloads.exportAgain':'downloads.retry')} onClick={()=>void controller.command('retry',j.id)}><RotateCcw/></Button>:null}
        {!active && j.managed!==false?<Button variant="ghost" size="icon" disabled={s.busy} aria-label={t('downloads.remove')} onClick={()=>void controller.command('remove',j.id)}><Trash2/></Button>:null}
      </>
      const progress=<div className="space-y-2">
        {active?<progress className="h-1.5 w-full accent-primary" aria-label={t('downloads.progress')} max={j.total||1} value={j.total?j.received:undefined}/>:null}
        {record && active?<p className="text-xs text-muted-foreground" role="status">{t(`downloads.${j.state}`)}</p>:null}
        {j.received>0?<p className="text-xs text-muted-foreground">{bytes(j.received)} / {j.total?bytes(j.total):t('downloads.unknown')}{j.state==='receiving' && j.speed>0?` · ${bytes(j.speed)}/s`:''}{seconds!==null && j.state==='receiving'?` · ${t('downloads.remaining',{seconds})}`:''}</p>:null}
        {j.error?<p className="break-all text-xs text-danger">{j.error}{j.ready?` · ${t('downloads.kept')}`:''}</p>:null}
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
