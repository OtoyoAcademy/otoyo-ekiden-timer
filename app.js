const STORAGE_KEY = 'ekiden_timer_v14_state';
const QUEUE_KEY = 'ekiden_timer_v14_queue';
const DEVICE_KEY = 'ekiden_timer_v14_device';
const ROOT_PATH = (window.EKIDEN_APP_OPTIONS && window.EKIDEN_APP_OPTIONS.rootPath) || 'ekidenTimerV02';
const PASSAGE_WINDOW_MS = 2500;
const SPREAD_WARNING_MS = 500;
const LOCK_STALE_MS = 90000;
const HEARTBEAT_MS = 20000;
const DEFAULT_NOTICE = '開会式は、体育館で10時からとなっています。参加者は、5分前にはお集まりください。';
const DEFAULT_CODES = { admin:'1234', A:'1111', B:'2222', C:'3333' };

let currentScreen = 'top';
let currentOperator = null;
let currentTeamNo = null;
let currentSession = null;
let csvPending = null;
let serverOffsetMs = 0;
let supabaseMode = false;
let supabaseReady = false;
let supabaseConnected = false;
let sb = null;
let supabaseUserId = null;
let realtimeChannel = null;
let privateTeamCodes = {};
let serverTimeTimer = null;
let heartbeatTimer = null;
let selectedArchiveId = null;
let state = loadLocalState();
let pendingQueue = loadQueue();

function freshState(){
  return {
    meta:{ raceStatus:'before', startAt:null, finishAt:null, notice:DEFAULT_NOTICE, version:14, eventId:'legacy-current', eventYear:null },
    settings:{ eventName:'大豊学園駅伝大会', eventDate:'', entryDeadline:'', venue:'大豊学園', contact:'大会事務局', entryOpen:true, legCount:15, legDistances:{}, certificate:{ organizerName:'', issuerName:'大会実行委員長', sealMode:'text', sealText:'大豊学園', sealImagePath:'', templates:{teamAward:'',individualAward:'',recordCertificate:''} } },
    applications:{},
    teams:{},
    officialMeasurements:{},
    teamMeasurements:{},
    adoptions:{},
    overrides:{},
    credentials:{ adminHash:'', operatorHashes:{} },
    locks:{ operators:{}, teams:{} },
    notices:{},
    awards:{ teamTopN:3, overallFastest:true, genderAwards:true, ageGroupAwards:true, ageGenderAwards:false, formalResultsPublished:false, individualAwardsPublished:false },
    eventArchives:{}
  };
}
function normalizeState(raw){
  const f=freshState();
  const r=raw||{};
  return {
    meta:{...f.meta,...(r.meta||{})},
    settings:{...f.settings,...(r.settings||{})},
    applications:r.applications||{},
    teams:r.teams||{},
    officialMeasurements:r.officialMeasurements||{},
    teamMeasurements:r.teamMeasurements||{},
    adoptions:r.adoptions||{},
    overrides:r.overrides||{},
    credentials:{...f.credentials,...(r.credentials||{}),operatorHashes:{...(r.credentials?.operatorHashes||{})}},
    locks:{operators:{...(r.locks?.operators||{})},teams:{...(r.locks?.teams||{})}},
    notices:r.notices||{},
    awards:{...f.awards,...(r.awards||{})},
    eventArchives:r.eventArchives||{}
  };
}
function loadLocalState(){
  try{return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'));}catch{return freshState();}
}
function saveLocalSnapshot(){
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  window.dispatchEvent(new CustomEvent('ekiden-local-change'));
}
function loadQueue(){
  try{return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]');}catch{return [];}
}
function saveQueue(){localStorage.setItem(QUEUE_KEY,JSON.stringify(pendingQueue)); renderSyncStatus();}
function getDeviceId(){
  let id=localStorage.getItem(DEVICE_KEY);
  if(!id){id='d_'+cryptoRandom(18);localStorage.setItem(DEVICE_KEY,id);} return id;
}
const DEVICE_ID=getDeviceId();

function cryptoRandom(len=12){
  const a=new Uint8Array(len); crypto.getRandomValues(a); return [...a].map(x=>(x%36).toString(36)).join('');
}
function makeId(prefix='x'){return `${prefix}_${syncedNow()}_${cryptoRandom(8)}`;}
function syncedNow(){return Date.now()+serverOffsetMs;}
function fmtClock(ms){
  if(ms==null||ms<0)return '00:00:00.00';
  const cs=Math.floor(ms/10)%100,s=Math.floor(ms/1000)%60,m=Math.floor(ms/60000)%60,h=Math.floor(ms/3600000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}
function fmtTimeOfDay(ts){
  if(!ts)return '---';
  const d=new Date(ts); return d.toLocaleTimeString('ja-JP',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})+'.'+String(Math.floor(d.getMilliseconds()/10)).padStart(2,'0');
}
function parseTimeOfDay(text,baseTs){
  const m=String(text||'').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/); if(!m)return null;
  const d=new Date(baseTs||Date.now()); d.setHours(Number(m[1]),Number(m[2]),Number(m[3]),Number(String(m[4]||'0').padEnd(3,'0'))); return d.getTime();
}
function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1900);}
function teamKey(v){return String(v).trim().replace(/[.#$\/[\]]/g,'_');}
function teamList(){return Object.values(state.teams||{}).sort((a,b)=>naturalCompare(a.teamNo,b.teamNo));}
function naturalCompare(a,b){return String(a).localeCompare(String(b),'ja',{numeric:true,sensitivity:'base'});}
function getTeam(no){return state.teams[teamKey(no)]||teamList().find(t=>String(t.teamNo)===String(no));}
function statusLabel(){return state.meta.raceStatus==='running'?'計測中':state.meta.raceStatus==='finished'?'終了':'開始前';}
function getLegCount(){const n=Number(state.settings?.legCount||15);return Math.max(1,Math.min(30,Number.isFinite(n)?Math.round(n):15));}
function getLegDistance(leg){
  const raw=state.settings?.legDistances?.[String(leg)];const n=Number(raw);return Number.isFinite(n)&&n>0?n:null;
}
function formatDistanceKm(v){const n=Number(v);if(!Number.isFinite(n)||n<=0)return '';return `${Number(n.toFixed(3))}km`;}
function legDistanceLabel(leg){const d=getLegDistance(leg);return d?formatDistanceKm(d):'';}
function legLabel(leg){const d=legDistanceLabel(leg);return `第${leg}区間${d?`（${d}）`:''}`;}
function courseDistanceSummary(){
  const count=getLegCount(),vals=Array.from({length:count},(_,i)=>getLegDistance(i+1)),set=vals.filter(v=>v!=null),total=set.reduce((a,b)=>a+b,0);
  return {count,setCount:set.length,total,complete:set.length===count&&count>0};
}

// ---------- Annual event management ----------
function inferredEventYear(settings=state.settings){
  const date=String(settings?.eventDate||'');const m=date.match(/^(\d{4})-/);if(m)return Number(m[1]);
  const n=String(settings?.eventName||'').match(/(20\d{2})/);if(n)return Number(n[1]);
  return new Date().getFullYear();
}
function currentEventId(){return String(state.meta?.eventId||'legacy-current');}
function currentEventYear(){const n=Number(state.meta?.eventYear);return Number.isFinite(n)&&n>0?n:inferredEventYear();}
function eventArchiveList(){return Object.values(state.eventArchives||{}).filter(Boolean).sort((a,b)=>(Number(b.year)||0)-(Number(a.year)||0)||(b.archivedAt||0)-(a.archivedAt||0));}
function cleanArchiveApplications(apps){
  const out=structuredClone(apps||{});Object.values(out).forEach(a=>{if(a&&typeof a==='object')delete a.issuedAccessCode;});return out;
}
function currentResultSummary(){
  return {
    teamResults:formalTeamResults().map(r=>({rank:r.rank,teamNo:String(r.team.teamNo),teamName:r.team.teamName,total:r.total,legs:r.legs})),
    individualAwards:individualAwardGroups().map(g=>({key:g.key,label:g.label,winners:g.winners.map(w=>({...w}))})),
    personalRecords:personalBestRecords().map(r=>({...r,distanceKm:getLegDistance(r.leg)}))
  };
}
function buildCurrentEventArchive(){
  return {
    id:currentEventId(),year:currentEventYear(),name:state.settings?.eventName||'駅伝大会',status:'archived',createdAt:state.meta?.eventCreatedAt||null,archivedAt:syncedNow(),
    settings:structuredClone(state.settings||{}),awards:structuredClone(state.awards||{}),notices:structuredClone(state.notices||{}),
    applications:cleanArchiveApplications(state.applications),teams:structuredClone(state.teams||{}),officialMeasurements:structuredClone(state.officialMeasurements||{}),teamMeasurements:structuredClone(state.teamMeasurements||{}),adoptions:structuredClone(state.adoptions||{}),overrides:structuredClone(state.overrides||{}),
    meta:structuredClone(state.meta||{}),resultSummary:currentResultSummary(),
    counts:{applications:Object.keys(state.applications||{}).length,teams:teamList().length,passes:computedPasses().length}
  };
}
function makeNewEventId(year){return `evt_${year}_${cryptoRandom(8)}`;}
async function persistEventArchive(archive){
  const path=`eventArchives/${archive.id}`;
  if(supabaseMode&&supabaseReady&&sb){const {error}=await sb.from('ekiden_kv').upsert({path,value:archive,updated_at:new Date().toISOString()},{onConflict:'path'});if(error){console.error(error);return false;}}
  setByPath(state,path,archive);saveLocalSnapshot();renderCurrent();return true;
}
async function deleteEventArchive(id){
  const a=state.eventArchives?.[id];if(!a)return;
  if(supabaseMode&&!supabaseConnected){toast('過去大会の削除はSupabaseがONLINEのときに行ってください');return;}
  if(pendingQueue.length){toast('未送信データがあります。同期が完了してから削除してください');return;}
  const label=`${a.year||''}年度 ${a.name||'過去大会'}`.trim();
  if(!confirm(`「${label}」を過去大会から完全に削除しますか？\n\nこの操作は元に戻せません。現在運用中の大会には影響しません。`))return;
  let assetCleanupFailed=false;
  if(supabaseMode&&supabaseReady&&sb){
    const safeEvent=String(id).replace(/[^a-zA-Z0-9_-]/g,'_'),cert=a.settings?.certificate||{};
    const paths=[cert.sealImagePath,...Object.values(cert.templates||{})].filter(p=>typeof p==='string'&&p.startsWith(`certificates/${safeEvent}/`));
    if(paths.length){const {error}=await sb.storage.from(CERT_BUCKET).remove([...new Set(paths)]);if(error){console.warn('archive asset cleanup failed',error);assetCleanupFailed=true;}}
    const {error}=await sb.from('ekiden_kv').delete().eq('path',`eventArchives/${id}`);if(error){console.error(error);toast('過去大会の削除に失敗しました');return;}
  }
  removeByPath(state,`eventArchives/${id}`);if(selectedArchiveId===id)selectedArchiveId=null;saveLocalSnapshot();renderCurrent();
  toast(assetCleanupFailed?'過去大会を削除しました（証書画像の整理のみ未完了）':'過去大会を削除しました');
}
function copySettingsForNewEvent(source,name){
  const base=freshState().settings,src=source?.settings||null;
  if(!src)return {...base,eventName:name,eventDate:'',entryDeadline:'',entryOpen:false,legDistances:{},certificate:structuredClone(base.certificate)};
  return {...base,...structuredClone(src),eventName:name,eventDate:'',entryDeadline:'',entryOpen:false,legDistances:structuredClone(src.legDistances||{}),certificate:structuredClone(src.certificate||base.certificate)};
}
function copyAwardsForNewEvent(source){
  const base=freshState().awards,src=source?.awards||null,next={...base,...(src?structuredClone(src):{})};next.formalResultsPublished=false;next.individualAwardsPublished=false;return next;
}
function formatArchiveDate(v){if(!v)return '未設定';const d=new Date(`${v}T00:00:00`);return Number.isNaN(d.getTime())?String(v):d.toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric'});}
function renderEventManager(){
  const current=document.getElementById('currentEventSummary'),list=document.getElementById('eventArchiveList'),detail=document.getElementById('eventArchiveDetail');if(!current||!list)return;
  const year=currentEventYear(),summary=courseDistanceSummary();
  current.innerHTML=`<div><small>現在の大会</small><strong>${esc(state.settings?.eventName||'駅伝大会')}</strong><span>${year}年度 ・ ${formatArchiveDate(state.settings?.eventDate)} ・ ${getLegCount()}区間${summary.setCount?` ・ 総距離 ${Number(summary.total.toFixed(3))}km`:''}</span></div><span class="current-event-badge">運用中</span>`;
  const y=document.getElementById('newEventYear'),n=document.getElementById('newEventName'),sel=document.getElementById('newEventCopySource');
  if(y&&!y.value)y.value=String(year+1);if(n&&!n.value)n.value=state.settings?.eventName||'駅伝大会';
  if(sel){const keep=sel.value;sel.innerHTML=`<option value="current">現在大会の設定をコピー</option><option value="none">設定をコピーしない</option>${eventArchiveList().map(a=>`<option value="archive:${esc(a.id)}">${esc(a.year||'')}年度 ${esc(a.name||'過去大会')} の設定</option>`).join('')}`;if([...sel.options].some(o=>o.value===keep))sel.value=keep;}
  const archives=eventArchiveList();
  if(!archives.length)list.innerHTML='<div class="empty-state">過去大会はまだありません。新しい大会を作成すると、現在大会が自動的にここへ保存されます。</div>';
  else list.innerHTML=`<table class="data-table"><thead><tr><th>年度</th><th>大会名</th><th>開催日</th><th>チーム</th><th>正式記録</th><th>保存日時</th><th>操作</th></tr></thead><tbody>${archives.map(a=>`<tr><td><b>${esc(a.year||'—')}</b></td><td>${esc(a.name||'')}</td><td>${esc(formatArchiveDate(a.settings?.eventDate))}</td><td>${Number(a.counts?.teams||Object.keys(a.teams||{}).length)}</td><td>${Number(a.resultSummary?.teamResults?.length||0)}チーム</td><td>${a.archivedAt?new Date(a.archivedAt).toLocaleString('ja-JP'):''}</td><td><button class="tiny-btn" data-view-archive="${esc(a.id)}">閲覧</button> <button class="tiny-btn" data-copy-archive="${esc(a.id)}">設定をコピー</button> <button class="text-btn" data-export-archive="${esc(a.id)}">結果CSV</button> <button class="tiny-btn red" data-delete-archive="${esc(a.id)}">削除</button></td></tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('[data-view-archive]').forEach(b=>b.addEventListener('click',()=>{selectedArchiveId=b.dataset.viewArchive;renderEventManager();document.getElementById('eventArchiveDetail')?.scrollIntoView({behavior:'smooth',block:'nearest'});}));
  list.querySelectorAll('[data-copy-archive]').forEach(b=>b.addEventListener('click',()=>{if(sel)sel.value=`archive:${b.dataset.copyArchive}`;const a=state.eventArchives?.[b.dataset.copyArchive];if(a&&n)n.value=a.name||'';if(a&&y)y.value=String((Number(a.year)||year)+1);toast('コピー元に設定しました');}));
  list.querySelectorAll('[data-export-archive]').forEach(b=>b.addEventListener('click',()=>exportArchivedResults(b.dataset.exportArchive)));
  list.querySelectorAll('[data-delete-archive]').forEach(b=>b.addEventListener('click',()=>deleteEventArchive(b.dataset.deleteArchive)));
  if(detail){const a=selectedArchiveId&&state.eventArchives?.[selectedArchiveId];if(!a){detail.classList.add('hidden');detail.innerHTML='';}else{detail.classList.remove('hidden');detail.innerHTML=archiveDetailHtml(a);detail.querySelector('[data-close-archive]')?.addEventListener('click',()=>{selectedArchiveId=null;renderEventManager();});}}
}
function archiveDetailHtml(a){
  const teams=a.resultSummary?.teamResults||[],awards=a.resultSummary?.individualAwards||[],records=a.resultSummary?.personalRecords||[];
  const teamHtml=teams.length?`<table class="data-table"><thead><tr><th>順位</th><th>チーム</th><th>総合タイム</th></tr></thead><tbody>${teams.map(r=>`<tr><td>${r.rank}位</td><td>${esc(r.teamNo)} ${esc(r.teamName)}</td><td><b>${fmtClock(r.total)}</b></td></tr>`).join('')}</tbody></table>`:'<div class="empty-state">正式結果は保存されていません。</div>';
  const awardHtml=awards.length?`<div class="archive-awards">${awards.map(g=>`<div><strong>${esc(g.label)}</strong>${(g.winners||[]).map(w=>`<span>${esc(w.name)}（${esc(w.teamName)}・第${w.leg}区間） ${fmtClock(w.lap)}</span>`).join('')}</div>`).join('')}</div>`:'<div class="empty-state">個人賞データはありません。</div>';
  const recHtml=records.length?`<table class="data-table"><thead><tr><th>選手</th><th>チーム</th><th>区間</th><th>距離</th><th>記録</th></tr></thead><tbody>${records.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.teamName)}</td><td>第${r.leg}区間</td><td>${r.distanceKm?esc(formatDistanceKm(r.distanceKm)):'—'}</td><td>${fmtClock(r.lap)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty-state">個人記録はありません。</div>';
  return `<div class="archive-detail-head"><div><small>READ ONLY</small><h3>${esc(a.year||'')}年度 ${esc(a.name||'')}</h3><p>${esc(formatArchiveDate(a.settings?.eventDate))}　${esc(a.settings?.venue||'')}</p></div><button class="secondary-btn" data-close-archive>閉じる</button></div><div class="archive-detail-stats"><span>申込 <b>${Number(a.counts?.applications||Object.keys(a.applications||{}).length)}</b></span><span>チーム <b>${Number(a.counts?.teams||Object.keys(a.teams||{}).length)}</b></span><span>区間 <b>${Number(a.settings?.legCount||15)}</b></span><span>通過記録 <b>${Number(a.counts?.passes||0)}</b></span></div><div class="archive-detail-grid"><section><h4>チーム正式順位</h4>${teamHtml}</section><section><h4>個人賞</h4>${awardHtml}</section><section class="span-two"><h4>個人記録</h4>${recHtml}</section></div><p class="hint">過去大会は閲覧専用です。申込・チーム・計測データを現在大会へ戻すことはしません。</p>`;
}
function exportArchivedResults(id){
  const a=state.eventArchives?.[id];if(!a)return;const rows=[['record_type','rank_or_category','team_no','team_name','runner_name','leg','distance_km','time']];
  (a.resultSummary?.teamResults||[]).forEach(r=>rows.push(['team',r.rank,r.teamNo,r.teamName,'','','',fmtClock(r.total)]));
  (a.resultSummary?.personalRecords||[]).forEach(r=>rows.push(['runner','',r.teamNo,r.teamName,r.name,r.leg,r.distanceKm||'',fmtClock(r.lap)]));
  downloadText('\uFEFF'+rows.map(r=>r.map(csvEscape).join(',')).join('\r\n'),`ekiden_${a.year||'archive'}_results.csv`,'text/csv;charset=utf-8');
}
async function createNewAnnualEvent(){
  if(state.meta?.raceStatus==='running'){toast('計測中は新しい大会へ切り替えできません');return;}
  if(supabaseMode&&!supabaseConnected){toast('年度切替はSupabaseがONLINEのときに行ってください');return;}
  if(pendingQueue.length){toast('未送信データがあります。同期が完了してから年度切替してください');return;}
  const year=Math.max(2000,Math.min(2100,Number(document.getElementById('newEventYear')?.value)||0)),name=document.getElementById('newEventName')?.value.trim(),sourceKey=document.getElementById('newEventCopySource')?.value||'current';
  if(!year||!name){toast('新しい大会の年度と大会名を入力してください');return;}
  let source=null;if(sourceKey==='current')source={settings:structuredClone(state.settings),awards:structuredClone(state.awards)};else if(sourceKey.startsWith('archive:'))source=state.eventArchives?.[sourceKey.slice(8)]||null;
  const msg=`現在の「${state.settings?.eventName||'大会'}」を過去大会として保存し、${year}年度「${name}」へ切り替えます。\n\n申込者・チーム・計測記録・結果は新大会へ引き継ぎません。開催日と申込締切も未設定になります。続けますか？`;
  if(!confirm(msg))return;
  const archive=buildCurrentEventArchive();if(!(await persistEventArchive(archive))){toast('現在大会のアーカイブ保存に失敗したため、年度切替を中止しました');return;}
  if(supabaseMode&&supabaseReady){const {error}=await sb.rpc('ekiden_prepare_new_event');if(error){console.error('ekiden_prepare_new_event failed',error);const msg=String(error.message||error.details||'').slice(0,120);toast(`年度切替の安全処理に失敗しました${msg?`：${msg}`:''}`);return;}}privateTeamCodes={};
  if(!(await purgeCurrentEventRows())){toast('旧大会データの整理に失敗しました。年度切替を中止しました');return;}
  const f=freshState(),newId=makeNewEventId(year),newSettings=copySettingsForNewEvent(source,name),newAwards=copyAwardsForNewEvent(source),newMeta={...f.meta,eventId:newId,eventYear:year,eventCreatedAt:syncedNow(),version:14,notice:DEFAULT_NOTICE};
  queueWrite('meta',newMeta);queueWrite('settings',newSettings);queueWrite('applications',{});queueWrite('teams',{});queueWrite('officialMeasurements',{});queueWrite('teamMeasurements',{});queueWrite('adoptions',{});queueWrite('overrides',{});queueWrite('locks',{operators:{},teams:{}});queueWrite('notices',{});queueWrite('awards',newAwards);
  certificateResolvedUrls={teamAward:'',individualAward:'',recordCertificate:'',seal:''};selectedArchiveId=null;
  const y=document.getElementById('newEventYear'),n=document.getElementById('newEventName');if(y)y.value='';if(n)n.value='';toast(`${year}年度の新しい大会を作成しました`);
}
function normalizeAgeGroup(value,age){
  const v=String(value||'');if(['未就学','小学生','中学生','高校生','一般（～29歳）','一般（30歳～）'].includes(v))return v;
  const a=Number(age);if(v==='40代'||v==='50代'||v==='60代以上')return '一般（30歳～）';
  if(v==='一般'){if(Number.isFinite(a)&&a>0)return a<=29?'一般（～29歳）':'一般（30歳～）';return '一般（30歳～）';}
  return v||'未就学';
}
function runnerFor(teamNo,leg){const t=getTeam(teamNo);return t?.runners?.find(r=>Number(r.leg)===Number(leg));}

function audienceLabel(v){return ({all:'全体',participants:'参加者向け',ekiden:'駅伝参加チーム',funrun:'ファンラン'})[v]||'全体';}
function priorityLabel(v){return v==='important'?'重要':'通常';}
function fmtNoticeTime(ts){if(!ts)return '';const d=new Date(ts);return d.toLocaleString('ja-JP',{hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function noticeList(includeHidden=false){
  const arr=Object.values(state.notices||{}).filter(Boolean);
  const visible=arr.filter(n=>includeHidden || n.visible!==false);
  if(!visible.length&&state.meta.notice){
    return [{id:'legacy_notice',title:'大会からのお知らせ',body:state.meta.notice,audience:'all',priority:'important',pinned:true,visible:true,createdAt:state.meta.startAt||0,updatedAt:state.meta.startAt||0,legacy:true}];
  }
  return visible.sort((a,b)=>(Number(!!b.pinned)-Number(!!a.pinned))||((b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0)));
}
function clearNoticeForm(){
  const ti=document.getElementById('noticeTitleInput'),bi=document.getElementById('noticeBodyInput'),ai=document.getElementById('noticeAudienceInput'),pi=document.getElementById('noticePriorityInput'),fi=document.getElementById('noticePinInput');
  if(ti)ti.value=''; if(bi)bi.value=''; if(ai)ai.value='all'; if(pi)pi.value='important'; if(fi)fi.checked=false;
}
function createNoticeFromForm(){
  const title=document.getElementById('noticeTitleInput')?.value.trim()||'大会からのお知らせ';
  const body=document.getElementById('noticeBodyInput')?.value.trim()||'';
  if(!body){toast('本文を入力してください');return null;}
  return {id:makeId('notice'),title,body,audience:document.getElementById('noticeAudienceInput')?.value||'all',priority:document.getElementById('noticePriorityInput')?.value||'important',pinned:!!document.getElementById('noticePinInput')?.checked,visible:true,createdAt:syncedNow(),updatedAt:syncedNow()};
}
function renderNoticeBoardAdmin(){
  const el=document.getElementById('noticeBoardAdmin'); if(!el)return;
  const rows=noticeList(true);
  if(!rows.length){el.innerHTML='<div class="notice-empty">まだ掲示板の投稿はありません。</div>';return;}
  el.innerHTML=rows.map(n=>`<div class="notice-card ${n.pinned?'pinned':''} ${n.visible===false?'hidden-notice':''}"><div class="notice-card-head"><div><div class="notice-card-title">${esc(n.title||'大会からのお知らせ')}</div><div class="notice-tags"><span class="notice-tag audience">${esc(audienceLabel(n.audience))}</span><span class="notice-tag ${n.priority==='important'?'important':''}">${esc(priorityLabel(n.priority))}</span>${n.pinned?'<span class="notice-tag pinned">固定表示</span>':''}${n.visible===false?'<span class="notice-tag hidden">非公開</span>':''}</div></div><div class="notice-card-meta">${esc(fmtNoticeTime(n.updatedAt||n.createdAt))}</div></div><div class="notice-body">${esc(n.body||'').replace(/\n/g,'<br>')}</div><div class="notice-actions">${n.legacy?'':`<button class="tiny-btn" data-toggle-notice="${esc(n.id)}">${n.visible===false?'公開する':'非公開にする'}</button> <button class="tiny-btn" data-pin-notice="${esc(n.id)}">${n.pinned?'固定解除':'上部に固定'}</button> <button class="tiny-btn red" data-delete-notice="${esc(n.id)}">削除</button>`}</div></div>`).join('');
  el.querySelectorAll('[data-toggle-notice]').forEach(b=>b.addEventListener('click',()=>{const n=state.notices?.[b.dataset.toggleNotice];if(!n)return;queueWrite(`notices/${n.id}`,{...n,visible:n.visible===false?true:false,updatedAt:syncedNow()});toast(n.visible===false?'お知らせを公開しました':'お知らせを非公開にしました');}));
  el.querySelectorAll('[data-pin-notice]').forEach(b=>b.addEventListener('click',()=>{const n=state.notices?.[b.dataset.pinNotice];if(!n)return;queueWrite(`notices/${n.id}`,{...n,pinned:!n.pinned,updatedAt:syncedNow()});toast(!n.pinned?'上部に固定しました':'固定を解除しました');}));
  el.querySelectorAll('[data-delete-notice]').forEach(b=>b.addEventListener('click',()=>{const n=state.notices?.[b.dataset.deleteNotice];if(!n)return;if(confirm('このお知らせを削除しますか？')){queueWrite(`notices/${n.id}`,null,true);toast('お知らせを削除しました');}}));
}
function renderParticipantNotices(){
  const el=document.getElementById('participantNoticeBoard'); if(!el)return;
  const rows=noticeList(false).filter(n=>n.visible!==false);
  const count=document.getElementById('participantNoticeCount'); if(count)count.textContent=`${rows.length}件`;
  if(!rows.length){el.innerHTML='<div class="notice-empty">現在、お知らせはありません。</div>';return;}
  el.innerHTML=rows.map(n=>`<details class="participant-notice-item ${n.priority==='important'?'important':''} ${n.pinned?'pinned':''}"><summary><div class="participant-notice-summary-main"><div class="notice-card-title">${esc(n.title||'大会からのお知らせ')}</div><div class="notice-tags"><span class="notice-tag audience">${esc(audienceLabel(n.audience))}</span><span class="notice-tag ${n.priority==='important'?'important':''}">${esc(priorityLabel(n.priority))}</span>${n.pinned?'<span class="notice-tag pinned">固定</span>':''}</div></div><div class="participant-notice-summary-side"><span>${esc(fmtNoticeTime(n.updatedAt||n.createdAt))}</span><b class="disclosure-mark">＋</b></div></summary><div class="participant-notice-body">${esc(n.body||'').replace(/\n/g,'<br>')}</div></details>`).join('');
}

async function sha256(text){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(text))); return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function verifyCode(kind,code,operator=null){
  if(kind==='admin'){
    const hash=state.credentials.adminHash; return hash?await sha256(code)===hash:String(code)===DEFAULT_CODES.admin;
  }
  if(kind==='operator'){
    const hash=state.credentials.operatorHashes?.[operator]; return hash?await sha256(code)===hash:String(code)===DEFAULT_CODES[operator];
  }
  return false;
}

function pathParts(path){return path.split('/').filter(Boolean);}
function setByPath(obj,path,value){
  const parts=pathParts(path); let cur=obj;
  for(let i=0;i<parts.length-1;i++){if(!cur[parts[i]]||typeof cur[parts[i]]!=='object')cur[parts[i]]={};cur=cur[parts[i]];}
  cur[parts.at(-1)]=value;
}
function removeByPath(obj,path){
  const parts=pathParts(path); let cur=obj;
  for(let i=0;i<parts.length-1;i++){cur=cur?.[parts[i]];if(!cur)return;} delete cur[parts.at(-1)];
}
function mergePending(raw){
  const copy=structuredClone(raw||{}); pendingQueue.forEach(op=>{if(op.remove)removeByPath(copy,op.path);else setByPath(copy,op.path,op.value);}); return copy;
}
function localApply(path,value,remove=false){
  if(remove)removeByPath(state,path);else setByPath(state,path,value); saveLocalSnapshot(); renderCurrent();
}
function sanitizeRemoteValue(path,value){
  if(value==null||typeof value!=='object')return value;
  const v=structuredClone(value);
  const scrubTeam=t=>{if(!t||typeof t!=='object')return t;delete t.accessCode;delete t.representative;return t;};
  if(path==='teams')Object.values(v).forEach(scrubTeam);
  else if(path.startsWith('teams/'))scrubTeam(v);
  if(path==='officialMeasurements')Object.values(v).forEach(x=>{if(x)delete x.deviceId;});
  else if(path.startsWith('officialMeasurements/'))delete v.deviceId;
  if(path==='teamMeasurements')Object.values(v).forEach(bucket=>Object.values(bucket||{}).forEach(x=>{if(x)delete x.deviceId;}));
  else if(path.startsWith('teamMeasurements/'))delete v.deviceId;
  return v;
}
function queueWrite(path,value,remove=false){
  if(!supabaseMode){localApply(path,value,remove);return;}
  if(remove)removeByPath(state,path);else setByPath(state,path,value); saveLocalSnapshot(); renderCurrent();
  const op={id:makeId('q'),path,value:sanitizeRemoteValue(path,value),remove};pendingQueue.push(op);saveQueue();sendQueuedOp(op);
}
async function sendQueuedOp(op){
  if(!supabaseReady||!sb)return;
  try{
    let error=null;
    if(op.remove){({error}=await sb.from('ekiden_kv').delete().eq('path',op.path));}
    else if(op.path.startsWith('applications/')&&currentSession?.role!=='admin'){({error}=await sb.rpc('ekiden_submit_application',{p_path:op.path,p_value:op.value}));}
    else {({error}=await sb.from('ekiden_kv').upsert({path:op.path,value:op.value,updated_at:new Date().toISOString()},{onConflict:'path'}));}
    if(error)throw error;
    pendingQueue=pendingQueue.filter(x=>x.id!==op.id);saveQueue();
  }catch(err){console.warn('Supabase write pending',op.path,err?.message||err);}
}
function flushQueue(){pendingQueue.slice().forEach(sendQueuedOp);}
async function purgeCurrentEventRows(){
  const prefixes=['applications','teams','officialMeasurements','teamMeasurements','adoptions','overrides','locks','notices'];
  if(!supabaseMode||!supabaseReady||!sb){prefixes.forEach(k=>{state[k]=k==='locks'?{operators:{},teams:{}}:{};});saveLocalSnapshot();return true;}
  for(const prefix of prefixes){
    let r=await sb.from('ekiden_kv').delete().eq('path',prefix);if(r.error){console.error(r.error);return false;}
    r=await sb.from('ekiden_kv').delete().like('path',`${prefix}/%`);if(r.error){console.error(r.error);return false;}
  }
  return true;
}
function stateFromRows(rows){const next=freshState();for(const row of rows||[]){if(row?.path)setByPath(next,row.path,row.value);}return normalizeState(mergePending(next));}
async function refreshRemoteState(){
  if(!supabaseReady||!sb)return;
  const {data,error}=await sb.from('ekiden_kv').select('path,value');
  if(error){console.warn('Supabase state read failed',error);return;}
  state=stateFromRows(data);saveLocalSnapshot();renderCurrent();
}
async function syncServerTime(){
  if(!supabaseReady||!sb)return;
  try{const before=Date.now();const {data,error}=await sb.rpc('ekiden_server_time_ms');const after=Date.now();if(error)throw error;serverOffsetMs=Number(data)-Math.round((before+after)/2);renderSyncStatus();}catch(err){console.warn('Supabase time sync failed',err);}
}
async function loadPrivateTeamCodes(){
  privateTeamCodes={};if(!supabaseReady||currentSession?.role!=='admin')return;
  const {data,error}=await sb.rpc('ekiden_list_team_codes');if(error){console.warn(error);return;}
  for(const row of data||[])privateTeamCodes[String(row.team_no)]=String(row.access_code||'');
  renderCurrent();
}
async function setTeamSecret(teamNo,code){
  if(!supabaseReady||!sb)return false;
  const {error}=await sb.rpc('ekiden_set_team_code',{p_team_no:String(teamNo),p_code:String(code)});if(error){console.error(error);toast('チームコードの保存に失敗しました');return false;}
  privateTeamCodes[String(teamNo)]=String(code);return true;
}
async function deleteTeamSecret(teamNo){
  if(!supabaseReady||!sb)return false;
  const {error}=await sb.rpc('ekiden_delete_team_code',{p_team_no:String(teamNo)});if(error){console.error(error);return false;}delete privateTeamCodes[String(teamNo)];return true;
}
async function supabaseRoleLogin(role,identifier,passcode){
  if(!supabaseReady||!sb)return false;
  const {data,error}=await sb.rpc('ekiden_sign_in',{p_role:role,p_identifier:identifier||'',p_passcode:String(passcode||'')});
  if(error||!data?.ok)return false;
  currentSession={role,id:data.identifier||identifier||role};await refreshRemoteState();if(role==='admin')await loadPrivateTeamCodes();return true;
}
async function initSupabase(){
  const config=window.EKIDEN_SUPABASE_CONFIG;
  if(!config?.url||!config?.publishableKey||!window.supabase){supabaseMode=false;supabaseReady=false;renderSyncStatus();return;}
  supabaseMode=true;
  try{
    sb=window.supabase.createClient(config.url,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
    let {data:{session}}=await sb.auth.getSession();
    if(!session){const {data,error}=await sb.auth.signInAnonymously();if(error)throw error;session=data.session;}
    supabaseUserId=session?.user?.id||null;supabaseReady=true;supabaseConnected=true;
    await syncServerTime();await refreshRemoteState();
    realtimeChannel=sb.channel('ekiden-kv-changes').on('postgres_changes',{event:'*',schema:'public',table:'ekiden_kv'},payload=>{
      const row=payload.new||payload.old;if(!row?.path)return;const beforeEvent=currentEventId();
      if(payload.eventType==='DELETE')removeByPath(state,row.path);else setByPath(state,row.path,row.value);
      if(row.path==='meta'&&currentEventId()!==beforeEvent&&currentSession&&currentSession.role!=='admin'){
        currentSession=null;currentOperator=null;currentTeamNo=null;clearInterval(heartbeatTimer);go('top');toast('大会が切り替わりました。必要に応じて再ログインしてください');
      }
      saveLocalSnapshot();renderCurrent();
    }).subscribe(status=>{supabaseConnected=status==='SUBSCRIBED';renderSyncStatus();if(supabaseConnected)flushQueue();});
    serverTimeTimer=setInterval(syncServerTime,60000);renderSyncStatus();flushQueue();
  }catch(err){console.error(err);supabaseMode=false;supabaseReady=false;supabaseConnected=false;toast('Supabase接続に失敗。ローカルモードで続行します');renderSyncStatus();}
}

function renderSyncStatus(){
  const badge=document.getElementById('syncBadge'),cb=document.getElementById('connectionBadge'),cd=document.getElementById('connectionDetail'),pc=document.getElementById('pendingCount'),so=document.getElementById('serverOffsetLabel');
  if(badge)badge.textContent=supabaseMode?(supabaseConnected?'Supabase同期中':'Supabase待機中'):'ローカル試作モード';
  if(cb){cb.textContent=supabaseMode?(supabaseConnected?'ONLINE':'OFFLINE'):'LOCAL';cb.className='mini-badge '+(supabaseConnected?'online':'');}
  if(cd)cd.textContent=supabaseMode?(supabaseConnected?'複数端末でSupabaseリアルタイム同期しています。':'通信復旧後に未送信データを再送します。'):'同一ブラウザ内のみ。Supabase設定後に複数端末同期します。';
  if(pc)pc.textContent=String(pendingQueue.length);if(so)so.textContent=`${Math.round(serverOffsetMs)} ms`;
  const cs=document.getElementById('clockStatus');if(cs)cs.textContent=supabaseMode?`Supabase基準の時刻補正：${Math.round(serverOffsetMs)} ms`:'端末時刻で計測（ローカル試作）';
}

// ---------- Screen navigation ----------
const screens=[...document.querySelectorAll('.screen')];
function go(name){
  currentScreen=name; screens.forEach(s=>s.classList.toggle('active',s.id===`screen-${name}`));
  document.getElementById('appTopbar').classList.toggle('hidden',name==='top');
  const titles={'entry':'参加申込','entry-complete':'申込完了','admin-login':'管理者ログイン','timer-login':'計測係ログイン','admin':'管理者画面','timer':'運営計測','team-timer':'チーム参考計測','participant':'参加者・閲覧画面'};
  document.getElementById('topbarTitle').textContent=titles[name]||'駅伝タイム計測';
  renderCurrent(); window.scrollTo({top:0,behavior:'smooth'});
}
function renderCurrent(){
  renderSyncStatus();
  renderTopStatus();
  if(currentScreen==='entry')renderEntry();
  if(currentScreen==='admin')renderAdmin();
  if(currentScreen==='timer')renderTimer();
  if(currentScreen==='team-timer')renderTeamTimer();
  if(currentScreen==='participant')renderParticipant();
}
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
document.getElementById('homeBtn').addEventListener('click',async()=>{await releaseCurrentLock();go('top');});
document.getElementById('menuBtn').addEventListener('click',async()=>{await releaseCurrentLock();go('top');});

// ---------- Login ----------
document.getElementById('adminLoginBtn').addEventListener('click',async()=>{
  const code=document.getElementById('adminPin').value;const ok=supabaseMode?await supabaseRoleLogin('admin','admin',code):await verifyCode('admin',code);if(ok){if(!supabaseMode)currentSession={role:'admin'};go('admin');}else toast('アクセスコードが違います');
});
document.querySelectorAll('[data-login-tab]').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('[data-login-tab]').forEach(x=>x.classList.toggle('active',x===btn));
  const official=btn.dataset.loginTab==='official'; document.getElementById('officialLoginPane').classList.toggle('active',official);document.getElementById('teamLoginPane').classList.toggle('active',!official);
}));
document.querySelectorAll('#operatorSelector button').forEach(btn=>btn.addEventListener('click',()=>{
  currentOperator=btn.dataset.op; document.querySelectorAll('#operatorSelector button').forEach(b=>b.classList.toggle('selected',b===btn));document.getElementById('timerEnterBtn').disabled=false;
}));
document.getElementById('timerEnterBtn').addEventListener('click',async()=>{
  if(!currentOperator)return;const code=document.getElementById('operatorPin').value;const ok=supabaseMode?await supabaseRoleLogin('operator',currentOperator,code):await verifyCode('operator',code,currentOperator);if(!ok){toast('アクセスコードが違います');return;}if(!supabaseMode)currentSession={role:'operator',id:currentOperator};if(!(await claimLock('operators',currentOperator))){if(supabaseMode)await sb.rpc('ekiden_sign_out');toast(`計測係${currentOperator}は別端末で使用中です`);return;}startHeartbeat();go('timer');
});
document.getElementById('teamEnterBtn').addEventListener('click',async()=>{
  const no=document.getElementById('teamLoginNo').value.trim();const code=document.getElementById('teamLoginCode').value.trim();const t=getTeam(no);
  if(!t){toast('チーム番号が見つかりません');return;}const ok=supabaseMode?await supabaseRoleLogin('team',String(t.teamNo),code):String(t.accessCode||'')===String(code);if(!ok){toast('チーム用アクセスコードが違います');return;}currentTeamNo=String(t.teamNo);if(!supabaseMode)currentSession={role:'team',id:String(t.teamNo)};if(!(await claimLock('teams',String(t.teamNo)))){if(supabaseMode)await sb.rpc('ekiden_sign_out');toast('このチームの計測画面は別端末で使用中です');return;}startHeartbeat();go('team-timer');
});

async function claimLock(kind,id){
  const path=`locks/${kind}/${id}`;const now=syncedNow();const val={deviceId:DEVICE_ID,lastSeen:now};
  if(supabaseMode&&supabaseReady){const {data,error}=await sb.rpc('ekiden_claim_lock',{p_kind:kind,p_identifier:String(id),p_device_id:DEVICE_ID});if(error){console.warn(error);return false;}return !!data;}
  const cur=state.locks?.[kind]?.[id];if(cur&&cur.deviceId!==DEVICE_ID&&now-cur.lastSeen<LOCK_STALE_MS)return false;localApply(path,val);return true;
}
function startHeartbeat(){clearInterval(heartbeatTimer);heartbeatTimer=setInterval(async()=>{if(!currentSession||!['operator','team'].includes(currentSession.role))return;const kind=currentSession.role==='operator'?'operators':'teams';if(supabaseMode&&supabaseReady)await sb.rpc('ekiden_claim_lock',{p_kind:kind,p_identifier:String(currentSession.id),p_device_id:DEVICE_ID});else queueWrite(`locks/${kind}/${currentSession.id}`,{deviceId:DEVICE_ID,lastSeen:syncedNow()});},HEARTBEAT_MS);}
async function releaseCurrentLock(){
  clearInterval(heartbeatTimer);heartbeatTimer=null;
  if(currentSession&&['operator','team'].includes(currentSession.role)){const kind=currentSession.role==='operator'?'operators':'teams';if(supabaseMode&&supabaseReady)await sb.rpc('ekiden_release_lock',{p_kind:kind,p_identifier:String(currentSession.id),p_device_id:DEVICE_ID});else {const path=`locks/${kind}/${currentSession.id}`;const cur=kind==='operators'?state.locks.operators?.[currentSession.id]:state.locks.teams?.[currentSession.id];if(cur?.deviceId===DEVICE_ID)queueWrite(path,null,true);}}
  if(supabaseMode&&supabaseReady&&currentSession){await sb.rpc('ekiden_sign_out');privateTeamCodes={};}
  currentSession=null;currentOperator=null;currentTeamNo=null;if(supabaseMode&&supabaseReady)await refreshRemoteState();
}

// ---------- Data computation ----------
function activeOfficialMeasurements(teamNo=null){
  return Object.values(state.officialMeasurements||{}).filter(m=>m&&m.status!=='deleted'&&(teamNo==null||String(m.teamNo)===String(teamNo))).sort((a,b)=>a.at-b.at);
}
function activeTeamMeasurements(teamNo=null){
  const flat=[];Object.values(state.teamMeasurements||{}).forEach(bucket=>Object.values(bucket||{}).forEach(m=>{if(m&&m.status!=='deleted'&&(teamNo==null||String(m.teamNo)===String(teamNo)))flat.push(m);}));return flat.sort((a,b)=>a.at-b.at);
}
function clusterRows(rows,keyFn){
  const groups=[];for(const row of rows){const key=keyFn(row);let g=groups.at(-1);if(!g||g.key!==key||row.at-g.lastAt>PASSAGE_WINDOW_MS){g={key,rows:[],lastAt:row.at};groups.push(g);}g.rows.push(row);g.lastAt=row.at;}return groups;
}
function officialGroups(teamNo){
  const rows=activeOfficialMeasurements(teamNo);const rawGroups=clusterRows(rows,r=>String(r.teamNo));
  return rawGroups.map(g=>{
    const byOp={};g.rows.forEach(r=>{if(!byOp[r.operator]||r.at<byOp[r.operator].at)byOp[r.operator]=r;});const uniq=Object.values(byOp).sort((a,b)=>a.at-b.at);const times=uniq.map(r=>r.at).sort((a,b)=>a-b);
    let at=times[0];if(times.length===2)at=Math.round((times[0]+times[1])/2);if(times.length>=3)at=times[Math.floor(times.length/2)];const spread=times.length>1?times.at(-1)-times[0]:0;
    return {eventId:`off_${g.rows[0].id}`,source:'official',teamNo:String(g.rows[0].teamNo),rawIds:g.rows.map(r=>r.id),usedRows:uniq,at,spread,count:uniq.length,review:spread>SPREAD_WARNING_MS};
  });
}
function teamGroups(teamNo){
  const rows=activeTeamMeasurements(teamNo);const rawGroups=clusterRows(rows,r=>String(r.teamNo));
  return rawGroups.map(g=>({eventId:`team_${g.rows[0].id}`,source:'team',teamNo:String(g.rows[0].teamNo),rawIds:g.rows.map(r=>r.id),at:g.rows[0].at,count:1,spread:0,review:false}));
}
function isTeamGroupMatched(tg){return officialGroups(tg.teamNo).some(og=>Math.abs(og.at-tg.at)<=PASSAGE_WINDOW_MS);}
function computedPasses(teamNo=null){
  const teams=teamNo!=null?[getTeam(teamNo)].filter(Boolean):teamList();const all=[];
  for(const t of teams){
    let events=officialGroups(t.teamNo).slice();
    teamGroups(t.teamNo).forEach(g=>{if(state.adoptions?.[g.eventId]?.active)events.push({...g,source:'team-adopted'});});
    events=events.sort((a,b)=>a.at-b.at).slice(0,getLegCount());
    events.forEach((e,i)=>{const ov=state.overrides?.[e.eventId];all.push({...e,teamName:t.teamName,leg:i+1,officialAt:ov?.officialAt??e.at,override:!!ov});});
  }
  return all;
}
function passesForTeam(teamNo){return computedPasses(teamNo).sort((a,b)=>a.leg-b.leg);}
function teamProgress(teamNo){return passesForTeam(teamNo).length;}
function teamTotal(teamNo){const p=passesForTeam(teamNo).at(-1);return p&&state.meta.startAt?p.officialAt-state.meta.startAt:null;}
function lapTime(pass){if(!pass||!state.meta.startAt)return null;const prev=passesForTeam(pass.teamNo).find(x=>x.leg===pass.leg-1);return pass.officialAt-(prev?.officialAt??state.meta.startAt);}

function formalTeamResults(){
  const rows=teamList().map(t=>({team:t,legs:teamProgress(t.teamNo),total:teamTotal(t.teamNo)})).filter(x=>x.legs>=getLegCount()&&x.total!=null).sort((a,b)=>a.total-b.total||naturalCompare(a.team.teamNo,b.team.teamNo));
  let lastTime=null,lastRank=0;
  return rows.map((r,i)=>{const rank=r.total===lastTime?lastRank:i+1;lastTime=r.total;lastRank=rank;return {...r,rank};});
}
function personalBestRecords(){
  const map=new Map();
  computedPasses().forEach(p=>{
    const runner=runnerFor(p.teamNo,p.leg)||{};const lap=lapTime(p);
    if(!runner.name||lap==null||lap<=0)return;
    const key=`${p.teamNo}::${String(runner.name).trim()}`;
    const rec={teamNo:String(p.teamNo),teamName:p.teamName,leg:p.leg,name:runner.name,sex:runner.sex||'',ageGroup:normalizeAgeGroup(runner.ageGroup,runner.age),age:runner.age??null,lap};
    if(!map.has(key)||lap<map.get(key).lap)map.set(key,rec);
  });
  return [...map.values()].sort((a,b)=>a.lap-b.lap||naturalCompare(a.teamNo,b.teamNo)||naturalCompare(a.name,b.name));
}
function tiedFastest(rows){if(!rows.length)return[];const best=rows[0].lap;return rows.filter(r=>r.lap===best);}
function individualAwardGroups(){
  const cfg=state.awards||freshState().awards,rows=personalBestRecords(),groups=[];
  if(cfg.overallFastest&&rows.length)groups.push({key:'overall',label:'大会個人最速',winners:tiedFastest(rows)});
  if(cfg.genderAwards){['男','女'].forEach(sex=>{const a=rows.filter(r=>r.sex===sex);if(a.length)groups.push({key:`sex-${sex}`,label:`${sex==='男'?'男子':'女子'} 最速`,winners:tiedFastest(a)});});}
  if(cfg.ageGroupAwards){AGE_GROUPS.forEach(g=>{const a=rows.filter(r=>r.ageGroup===g);if(a.length)groups.push({key:`age-${g}`,label:`${g} 最速`,winners:tiedFastest(a)});});}
  if(cfg.ageGenderAwards){AGE_GROUPS.forEach(g=>['男','女'].forEach(sex=>{const a=rows.filter(r=>r.ageGroup===g&&r.sex===sex);if(a.length)groups.push({key:`age-sex-${g}-${sex}`,label:`${g}・${sex==='男'?'男子':'女子'} 最速`,winners:tiedFastest(a)});}));}
  return groups;
}
function awardTeamRows(){const n=Math.max(1,Math.min(10,Number(state.awards?.teamTopN||3)));return formalTeamResults().filter(r=>r.rank<=n);}
function renderFormalTeamTable(rows,compact=false){
  if(!rows.length)return '<div class="empty-state">完走チームの正式記録がまだありません。</div>';
  const topN=Math.max(1,Math.min(10,Number(state.awards?.teamTopN||3)));
  if(compact)return `<div class="formal-ranking-list">${rows.map(r=>`<div class="formal-rank-row ${r.rank<=topN?'team-award-row':''}"><span class="formal-rank-num">${r.rank}位</span><strong>${esc(r.team.teamName)}${r.rank<=topN?' <em class="award-label">表彰</em>':''}</strong><span>チーム ${esc(r.team.teamNo)}</span><b>${fmtClock(r.total)}</b></div>`).join('')}</div>`;
  return `<table class="data-table"><thead><tr><th>順位</th><th>チーム</th><th>総合タイム</th><th>完走区間</th><th>表彰</th></tr></thead><tbody>${rows.map(r=>`<tr><td><b>${r.rank}位</b></td><td>${esc(r.team.teamNo)} ${esc(r.team.teamName)}</td><td><b>${fmtClock(r.total)}</b></td><td>${r.legs}/${getLegCount()}</td><td>${r.rank<=topN?'<span class="status-chip approved">対象</span>':'—'}</td></tr>`).join('')}</tbody></table>`;
}
function renderAwardCards(groups,compact=false){
  if(!groups.length)return '<div class="empty-state">現在の設定で該当する個人賞はありません。</div>';
  return `<div class="award-card-list ${compact?'compact':''}">${groups.map(g=>`<div class="award-result-card"><div class="award-result-title">${esc(g.label)}</div>${g.winners.map(w=>`<div class="award-winner"><div><strong>${esc(w.name)}</strong><span>${esc(w.teamName)}・${esc(legLabel(w.leg))}${w.ageGroup?`・${esc(w.ageGroup)}`:''}${w.sex?`・${esc(w.sex)}`:''}</span></div><b>${fmtClock(w.lap)}</b></div>`).join('')}</div>`).join('')}</div>`;
}
function renderAwardsAdmin(){
  const cfg=state.awards||freshState().awards;
  const topN=document.getElementById('awardTeamTopN');if(topN)topN.value=cfg.teamTopN||3;
  const map=[['awardOverallFastest','overallFastest'],['awardGender','genderAwards'],['awardAgeGroup','ageGroupAwards'],['awardAgeGender','ageGenderAwards']];map.forEach(([id,k])=>{const el=document.getElementById(id);if(el)el.checked=!!cfg[k];});
  const f=document.getElementById('formalResultsBadge');if(f){f.textContent=cfg.formalResultsPublished?'正式結果 公開中':'正式結果 非公開';f.className='mini-badge '+(cfg.formalResultsPublished?'online':'');}
  const i=document.getElementById('individualAwardsBadge');if(i){i.textContent=cfg.individualAwardsPublished?'個人賞 公開中':'個人賞 非公開';i.className='mini-badge '+(cfg.individualAwardsPublished?'online':'');}
  const tf=document.getElementById('toggleFormalResultsBtn');if(tf)tf.textContent=cfg.formalResultsPublished?'正式結果を非公開':'正式結果を公開';
  const ti=document.getElementById('toggleIndividualAwardsBtn');if(ti){ti.textContent=cfg.individualAwardsPublished?'個人賞を非公開':'個人賞を公開';ti.disabled=!cfg.formalResultsPublished&&!cfg.individualAwardsPublished;}
  const teamEl=document.getElementById('adminFormalTeamResults');if(teamEl)teamEl.innerHTML=renderFormalTeamTable(formalTeamResults());
  const awardEl=document.getElementById('adminAwardResults');if(awardEl)awardEl.innerHTML=renderAwardCards(individualAwardGroups(),true);
}

// ---------- Certificates / templates ----------
const CERT_BUCKET='ekiden-assets';
const CERT_DEFAULTS={
  organizerName:'',issuerName:'大会実行委員長',sealMode:'text',sealText:'大豊学園',sealImagePath:'',
  templates:{teamAward:'',individualAward:'',recordCertificate:''}
};
const CERT_TEMPLATE_FILES={teamAward:'assets/templates/team-award.png',individualAward:'assets/templates/individual-award.png',recordCertificate:'assets/templates/record-certificate.png'};
const CERT_TEMPLATE_NAMES={teamAward:'team_award_template.png',individualAward:'individual_award_template.png',recordCertificate:'record_certificate_template.png'};
let certificateResolvedUrls={teamAward:'',individualAward:'',recordCertificate:'',seal:''};
function certificateConfig(){
  const raw=state.settings?.certificate||{};
  return {...CERT_DEFAULTS,...raw,templates:{...CERT_DEFAULTS.templates,...(raw.templates||{})}};
}
function absoluteAppUrl(path){try{return new URL(path,location.href).href;}catch{return path;}}
function certificateTemplateUrl(kind){const cfg=certificateConfig();return (cfg.templates?.[kind]&&certificateResolvedUrls[kind])||absoluteAppUrl(CERT_TEMPLATE_FILES[kind]||CERT_TEMPLATE_FILES.recordCertificate);}
function saveCertificateConfig(patch){
  const cur=certificateConfig(),next={...cur,...patch,templates:{...cur.templates,...(patch.templates||{})}};
  queueWrite('settings',{...(state.settings||{}),certificate:next});
}
function renderCertificateSettings(){
  const cfg=certificateConfig();
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v??'';};
  set('certificateOrganizerName',cfg.organizerName);set('certificateIssuerName',cfg.issuerName);set('certificateSealMode',cfg.sealMode||'text');set('certificateSealText',cfg.sealText||'');
  ['teamAward','individualAward','recordCertificate'].forEach(kind=>{
    const img=document.getElementById(`${kind}TemplatePreview`),st=document.getElementById(`${kind}TemplateStatus`);if(img)img.src=certificateTemplateUrl(kind);if(st)st.textContent=cfg.templates?.[kind]?'アップロード済みテンプレート':'標準テンプレート';
  });
  const box=document.getElementById('certificateSealPreview');if(box){
    if(cfg.sealMode==='none')box.innerHTML='<span class="seal-none">なし</span>';
    else if(cfg.sealMode==='image'&&cfg.sealImagePath&&certificateResolvedUrls.seal)box.innerHTML=`<img src="${esc(certificateResolvedUrls.seal)}" alt="印画像" />`;
    else if(cfg.sealMode==='image'&&cfg.sealImagePath)box.innerHTML='<span class="seal-none">画像読込中</span>';
    else box.innerHTML=`<span class="seal-text-mini">${esc(cfg.sealText||'印')}</span>`;
  }
  const needsSigned=(cfg.sealImagePath&&!certificateResolvedUrls.seal)||(['teamAward','individualAward','recordCertificate'].some(k=>cfg.templates?.[k]&&!certificateResolvedUrls[k]));
  if(needsSigned&&currentSession?.role==='admin')refreshCertificateAssetUrls();
}
async function refreshCertificateAssetUrls(){
  const cfg=certificateConfig();if(!supabaseReady||!sb||currentSession?.role!=='admin')return;
  const entries=[['teamAward',cfg.templates?.teamAward],['individualAward',cfg.templates?.individualAward],['recordCertificate',cfg.templates?.recordCertificate],['seal',cfg.sealImagePath]];
  for(const [key,path] of entries){
    if(!path){certificateResolvedUrls[key]='';continue;}
    const {data,error}=await sb.storage.from(CERT_BUCKET).createSignedUrl(path,3600);
    if(!error&&data?.signedUrl)certificateResolvedUrls[key]=data.signedUrl;
  }
  ['teamAward','individualAward','recordCertificate'].forEach(kind=>{const img=document.getElementById(`${kind}TemplatePreview`);if(img)img.src=certificateTemplateUrl(kind);});
  const box=document.getElementById('certificateSealPreview');if(box&&cfg.sealMode==='image'&&certificateResolvedUrls.seal)box.innerHTML=`<img src="${esc(certificateResolvedUrls.seal)}" alt="印画像" />`;
}
function downloadCertificateTemplate(kind){
  const a=document.createElement('a');a.href=absoluteAppUrl(CERT_TEMPLATE_FILES[kind]);a.download=CERT_TEMPLATE_NAMES[kind]||'certificate_template.png';document.body.appendChild(a);a.click();a.remove();
}
function certFileOk(file){
  if(!file)return false;if(!['image/png','image/jpeg','image/webp'].includes(file.type)){toast('PNG・JPG・WebP画像を選んでください');return false;}if(file.size>3*1024*1024){toast('画像は3MB以下にしてください');return false;}return true;
}
async function uploadCertificateAsset(kind,file){
  if(!certFileOk(file))return;
  if(!supabaseMode||!supabaseReady||!sb){toast('テンプレート画像の共有保存にはSupabase接続が必要です');return;}
  if(currentSession?.role!=='admin'){toast('管理者ログインが必要です');return;}
  const safeEvent=currentEventId().replace(/[^a-zA-Z0-9_-]/g,'_');const objectName=`certificates/${safeEvent}/${kind}`;
  const {error}=await sb.storage.from(CERT_BUCKET).upload(objectName,file,{upsert:true,contentType:file.type,cacheControl:'3600'});
  if(error){console.error(error);toast('画像アップロードに失敗しました。証書用Storage設定を確認してください');return;}
  certificateResolvedUrls[kind==='seal'?'seal':kind]='';
  if(kind==='seal')saveCertificateConfig({sealImagePath:objectName,sealMode:'image'});else saveCertificateConfig({templates:{[kind]:objectName}});
  await refreshCertificateAssetUrls();toast(kind==='seal'?'印画像を安全に保存しました':'テンプレートを保存しました');
}
function certificateSealHtml(cfg){
  if(cfg.sealMode==='none')return '';
  if(cfg.sealMode==='image'&&cfg.sealImagePath&&certificateResolvedUrls.seal)return `<img class="cert-seal-image" src="${esc(certificateResolvedUrls.seal)}" alt="印" />`;
  return `<div class="cert-seal-text">${esc(cfg.sealText||'印')}</div>`;
}
function certificateDateText(){
  const s=state.settings?.eventDate;if(!s)return new Date().toLocaleDateString('ja-JP');const d=new Date(`${s}T00:00:00`);return Number.isNaN(d.getTime())?s:`${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}
function certificateRankLabel(rank){return Number(rank)===1?'優勝':Number(rank)===2?'準優勝':`第${rank}位`;}
function certificateCommonFoot(cfg){
  const org=cfg.organizerName||state.settings?.eventName||'大会実行委員会',issuer=cfg.issuerName||'大会実行委員長';
  return `<div class="cert-date">${esc(certificateDateText())}</div><div class="cert-issuer"><span>${esc(org)}</span><strong>${esc(issuer)}</strong>${certificateSealHtml(cfg)}</div>`;
}
function certificatePageHtml(kind,data){
  const cfg=certificateConfig(),eventName=state.settings?.eventName||'駅伝大会',bg=certificateTemplateUrl(kind);
  if(kind==='teamAward')return `<section class="cert-page"><img class="cert-bg" src="${esc(bg)}" /><div class="cert-content team-award"><div class="cert-title">表彰状</div><div class="cert-subtitle">${esc(certificateRankLabel(data.rank||1))}</div><div class="cert-recipient">${esc(data.teamName||'チーム名')} <small>殿</small></div><div class="cert-record">総合記録　${esc(data.total||'--:--:--')}</div><div class="cert-body">あなたのチームは「${esc(eventName)}」において<br>頭書の成績を収められました<br>よってその健闘をたたえ ここに表彰します</div>${certificateCommonFoot(cfg)}</div></section>`;
  if(kind==='individualAward')return `<section class="cert-page"><img class="cert-bg" src="${esc(bg)}" /><div class="cert-content individual-award"><div class="cert-title">表彰状</div><div class="cert-subtitle">${esc(data.category||'個人賞')}</div><div class="cert-recipient">${esc(data.name||'選手名')} <small>殿</small></div><div class="cert-detail">${esc(data.teamName||'')}　${esc(data.legLabel||'')}</div><div class="cert-record">記録　${esc(data.lap||'--:--:--')}</div><div class="cert-body">あなたは「${esc(eventName)}」において<br>優秀な成績を収められました<br>よってその健闘をたたえ ここに表彰します</div>${certificateCommonFoot(cfg)}</div></section>`;
  return `<section class="cert-page"><img class="cert-bg" src="${esc(bg)}" /><div class="cert-content record-certificate"><div class="cert-title">記録証</div><div class="cert-team">${esc(data.teamName||'チーム名')}</div><div class="cert-recipient">${esc(data.name||'選手名')} <small>殿</small></div><div class="record-table"><div><span>出場区間</span><strong>${esc(data.legLabel||'第1区間')}</strong></div><div><span>区間距離</span><strong>${esc(data.distance||'未設定')}</strong></div><div><span>記録</span><strong>${esc(data.lap||'--:--:--')}</strong></div><div><span>区間順位</span><strong>${esc(data.legRank||'—')}</strong></div></div><div class="cert-body compact">あなたの「${esc(eventName)}」における記録を<br>ここに証します</div>${certificateCommonFoot(cfg)}</div></section>`;
}
function certificatePrintStyles(){return `
@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e7edf3;font-family:"Yu Mincho","Hiragino Mincho ProN","Noto Serif JP",serif;color:#152535;-webkit-print-color-adjust:exact;print-color-adjust:exact}.toolbar{position:sticky;top:0;z-index:5;padding:10px;background:#102b47;color:#fff;text-align:center;font-family:sans-serif}.toolbar button{border:0;border-radius:8px;padding:9px 18px;font-weight:800;cursor:pointer}.cert-page{width:210mm;height:297mm;position:relative;margin:12px auto;background:#fff;overflow:hidden;page-break-after:always;box-shadow:0 8px 28px #0002}.cert-page:last-child{page-break-after:auto}.cert-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.cert-content{position:absolute;inset:0;text-align:center}.cert-title{position:absolute;top:13%;left:10%;right:10%;font-size:24mm;font-weight:700;letter-spacing:.14em}.cert-subtitle{position:absolute;top:28%;left:12%;right:12%;font-size:11mm;font-weight:700}.cert-recipient{position:absolute;top:39%;left:12%;right:12%;font-size:11mm;font-weight:700;border-bottom:1px solid #566;display:inline-block;padding-bottom:3mm}.cert-recipient small{font-size:5mm;font-weight:500}.cert-detail{position:absolute;top:49%;left:12%;right:12%;font-size:5mm}.cert-record{position:absolute;top:54%;left:12%;right:12%;font-size:8mm;font-weight:700}.cert-body{position:absolute;top:63%;left:15%;right:15%;font-size:5.4mm;line-height:2}.cert-body.compact{top:69%}.cert-date{position:absolute;top:79%;left:15%;right:15%;font-size:4.8mm}.cert-issuer{position:absolute;top:83%;left:27%;right:18%;min-height:20mm;font-size:5mm;display:flex;align-items:center;justify-content:flex-end;gap:4mm}.cert-issuer span{font-size:4.2mm}.cert-issuer strong{font-size:5.2mm}.cert-seal-image{width:18mm;height:18mm;object-fit:contain}.cert-seal-text{width:18mm;height:18mm;border:1.2mm solid #c22;color:#c22;display:grid;place-items:center;font-family:"Yu Mincho",serif;font-size:4.2mm;font-weight:800;line-height:1.05;writing-mode:vertical-rl;letter-spacing:.08em}.cert-team{position:absolute;top:28%;left:12%;right:12%;font-size:5.5mm}.record-certificate .cert-recipient{top:34%}.record-table{position:absolute;top:48%;left:24%;right:24%;font-size:5mm;text-align:left}.record-table>div{display:grid;grid-template-columns:1fr 1.4fr;gap:8mm;border-bottom:1px solid #98aab7;padding:2.5mm 1mm}.record-table strong{text-align:right;font-size:5.4mm}.record-certificate .cert-date{top:79%}.record-certificate .cert-issuer{top:83%}@media print{body{background:#fff}.toolbar{display:none}.cert-page{margin:0;box-shadow:none}}`}
function openCertificatePages(pages,title='証書プレビュー'){
  if(!pages.length){toast('出力できるデータがありません');return;}const w=window.open('','_blank');if(!w){toast('ポップアップを許可してください');return;}w.document.open();w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${certificatePrintStyles()}</style></head><body><div class="toolbar"><button onclick="window.print()">PDF・印刷</button>　${esc(title)}（${pages.length}枚）</div>${pages.join('')}</body></html>`);w.document.close();
}
function sampleCertificateData(kind){
  if(kind==='teamAward')return {rank:1,teamName:'サンプルチーム',total:'01:12:34.56'};
  if(kind==='individualAward')return {category:'中学生・男子 最速',name:'大豊 太郎',teamName:'サンプルチーム',legLabel:legLabel(1),lap:'00:08:24.00'};
  return {name:'大豊 花子',teamName:'サンプルチーム',legLabel:legLabel(1),distance:legDistanceLabel(1)||'2.5km',lap:'00:09:12.00',legRank:'3位'};
}
async function previewCertificate(kind){await refreshCertificateAssetUrls();openCertificatePages([certificatePageHtml(kind,sampleCertificateData(kind))],'証書サンプル');}
function allRunnerCertificateRecords(){
  const passes=computedPasses().slice().sort((a,b)=>naturalCompare(a.teamNo,b.teamNo)||a.leg-b.leg),byLeg={};
  passes.forEach(p=>{const lap=lapTime(p);if(lap==null)return;(byLeg[p.leg]??=[]).push({p,lap});});
  const ranks={};Object.entries(byLeg).forEach(([leg,rows])=>{rows.sort((a,b)=>a.lap-b.lap);let last=null,rank=0;rows.forEach((x,i)=>{if(x.lap!==last)rank=i+1;last=x.lap;ranks[`${x.p.teamNo}:${x.p.leg}`]=rank;});});
  return passes.map(p=>{const r=runnerFor(p.teamNo,p.leg)||{};return {name:r.name||'走者未登録',teamName:p.teamName,legLabel:legLabel(p.leg),distance:legDistanceLabel(p.leg)||'未設定',lap:fmtClock(lapTime(p)),legRank:ranks[`${p.teamNo}:${p.leg}`]?`${ranks[`${p.teamNo}:${p.leg}`]}位`:'—'};});
}
async function printAwardCertificates(){
  await refreshCertificateAssetUrls();const pages=[];awardTeamRows().forEach(r=>pages.push(certificatePageHtml('teamAward',{rank:r.rank,teamName:r.team.teamName,total:fmtClock(r.total)})));
  individualAwardGroups().forEach(g=>g.winners.forEach(w=>pages.push(certificatePageHtml('individualAward',{category:g.label,name:w.name,teamName:w.teamName,legLabel:legLabel(w.leg),lap:fmtClock(w.lap)}))));
  if(!pages.length){pages.push(certificatePageHtml('teamAward',sampleCertificateData('teamAward')),certificatePageHtml('individualAward',sampleCertificateData('individualAward')));toast('正式結果がないためサンプルを出力します');}openCertificatePages(pages,'表彰状');
}
async function printRecordCertificates(){
  await refreshCertificateAssetUrls();let records=allRunnerCertificateRecords();if(!records.length){records=[sampleCertificateData('recordCertificate')];toast('正式記録がないためサンプルを出力します');}openCertificatePages(records.map(r=>certificatePageHtml('recordCertificate',r)),'個人記録証');
}

function renderParticipantFormalResults(){
  const cfg=state.awards||freshState().awards,panel=document.getElementById('participantFormalResultsPanel');if(!panel)return;
  panel.classList.toggle('hidden',!cfg.formalResultsPublished);if(!cfg.formalResultsPublished)return;
  const teams=document.getElementById('participantFormalTeams');if(teams)teams.innerHTML=renderFormalTeamTable(formalTeamResults(),true);
  const wrap=document.getElementById('participantAwardsWrap');if(wrap)wrap.classList.toggle('hidden',!cfg.individualAwardsPublished);
  const awards=document.getElementById('participantAwards');if(awards&&cfg.individualAwardsPublished)awards.innerHTML=renderAwardCards(individualAwardGroups(),true);
  const st=document.getElementById('participantFormalStatus');if(st)st.textContent=cfg.individualAwardsPublished?'結果・個人賞 公開':'正式結果 公開';
}
function generateDemoFormalResults(){
  if(!teamList().length){toast('先にデモチームまたは申込チームを登録してください');return;}
  if(!confirm('現在の計測記録を初期化して、全チーム完走のダミー正式結果を生成します。よろしいですか？'))return;
  const teams=teamList(),legs=getLegCount(),start=syncedNow()-60*60*1000;const measurements={};
  teams.forEach((t,ti)=>{let at=start;for(let leg=1;leg<=legs;leg++){const lap=150000+(ti*1250)+((leg*1700+ti*430)%21000);at+=lap;const id=`demo_${ti+1}_${leg}_${start}`;measurements[id]={id,teamNo:String(t.teamNo),teamName:t.teamName,operator:'A',at,localAt:at,deviceId:'demo-results',status:'active'};}});
  queueWrite('officialMeasurements',measurements);queueWrite('teamMeasurements',{});queueWrite('adoptions',{});queueWrite('overrides',{});queueWrite('meta',{...state.meta,raceStatus:'finished',startAt:start,finishAt:Math.max(...Object.values(measurements).map(m=>m.at))});toast('ダミー正式結果を生成しました');
}

// ---------- Entry / operations (v0.3) ----------
const AGE_GROUPS=['未就学','小学生','中学生','高校生','一般（～29歳）','一般（30歳～）'];
let lastReceiptId='';

function localDayNumber(dateLike){
  if(!dateLike)return null;
  const parts=String(dateLike).split('-').map(Number); if(parts.length!==3||parts.some(Number.isNaN))return null;
  return Math.floor(Date.UTC(parts[0],parts[1]-1,parts[2])/86400000);
}
function todayDayNumber(){const d=new Date();return Math.floor(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86400000);}
function daysUntil(dateLike){const n=localDayNumber(dateLike);return n==null?null:n-todayDayNumber();}
function formatShortDate(dateLike){if(!dateLike)return '';const p=String(dateLike).split('-').map(Number);if(p.length!==3)return '';return `${p[0]}年${p[1]}月${p[2]}日`;}
function entryIsOpenNow(){if(!state.settings?.entryOpen)return false;const d=daysUntil(state.settings?.entryDeadline);return d==null||d>=0;}
function countdownText(days,kind){
  if(days==null)return kind==='event'?'日程未設定':'締切未設定';
  if(kind==='event')return days>0?`あと ${days}日`:days===0?'本日開催':'開催済み';
  return days>0?`あと ${days}日`:days===0?'本日締切':'受付終了';
}
function renderTopImportantNotices(){
  const sec=document.getElementById('topImportantSection'),el=document.getElementById('topImportantNotices'); if(!sec||!el)return;
  const rows=noticeList(false).filter(n=>n.visible!==false&&n.priority==='important').slice(0,3);
  sec.classList.toggle('hidden',!rows.length);
  if(!rows.length){el.innerHTML='';return;}
  el.innerHTML=rows.map(n=>`<div class="top-important-item"><div class="top-important-item-head"><span>${esc(n.title||'重要なお知らせ')}</span>${n.pinned?'<em>固定</em>':''}</div><p>${esc(n.body||'').replace(/\n/g,'<br>')}</p></div>`).join('');
}

function renderTopStatus(){
  const cfg=state.settings||{},open=entryIsOpenNow();
  const el=document.getElementById('entryTopStatus');
  if(el)el.textContent=open?'申込受付中・フォームはこちら':'現在、申込受付は終了しています';
  const eventDays=daysUntil(cfg.eventDate),entryDays=daysUntil(cfg.entryDeadline);
  const eventEl=document.getElementById('eventCountdown'),entryEl=document.getElementById('entryCountdown');
  const eventDateEl=document.getElementById('eventDateLabel'),entryDateEl=document.getElementById('entryDeadlineLabel');
  if(eventEl)eventEl.textContent=countdownText(eventDays,'event');
  if(entryEl)entryEl.textContent=cfg.entryOpen?countdownText(entryDays,'entry'):'受付停止中';
  if(eventDateEl)eventDateEl.textContent=cfg.eventDate?formatShortDate(cfg.eventDate):'';
  if(entryDateEl)entryDateEl.textContent=cfg.entryDeadline?formatShortDate(cfg.entryDeadline):'';
  renderTopImportantNotices();
}
function initEntryRows(){
  const body=document.getElementById('entryRunnerRows'); if(!body)return;
  const count=getLegCount();
  if(Number(body.dataset.legCount)===count && body.children.length===count)return;
  const previous=[...body.querySelectorAll('tr')].map(row=>({
    name:row.querySelector('[data-runner-name]')?.value||'',
    sex:row.querySelector('[data-runner-sex]')?.value||'男',
    ageGroup:normalizeAgeGroup(row.querySelector('[data-runner-group]')?.value||'未就学',row.querySelector('[data-runner-age]')?.value),
    age:row.querySelector('[data-runner-age]')?.value||''
  }));
  const sexOpts=['男','女','回答しない'].map(v=>`<option>${v}</option>`).join('');
  const ageOpts=AGE_GROUPS.map(v=>`<option>${v}</option>`).join('');
  body.innerHTML=Array.from({length:count},(_,i)=>`<tr data-entry-leg="${i+1}"><td data-label="区間" class="runner-leg"><span class="runner-leg-label">${esc(legLabel(i+1))}</span><span class="runner-leg-number">${i+1}</span></td><td data-label="氏名"><input data-runner-name maxlength="60" placeholder="走者氏名" /></td><td data-label="性別"><select data-runner-sex>${sexOpts}</select></td><td data-label="区分"><select data-runner-group>${ageOpts}</select></td><td data-label="年齢"><input data-runner-age inputmode="numeric" type="number" min="1" max="100" placeholder="任意" /></td></tr>`).join('');
  body.dataset.legCount=String(count);
  [...body.querySelectorAll('tr')].forEach((row,i)=>{const p=previous[i];if(!p)return;row.querySelector('[data-runner-name]').value=p.name;row.querySelector('[data-runner-sex]').value=p.sex;row.querySelector('[data-runner-group]').value=normalizeAgeGroup(p.ageGroup,p.age);row.querySelector('[data-runner-age]').value=p.age;});
}
function renderEntry(){
  initEntryRows();
  const cfg=state.settings||{};
  const legLegend=document.getElementById('entryLegLegend');if(legLegend){const ds=courseDistanceSummary();legLegend.textContent=`${getLegCount()}区間${ds.complete?`・全${Number(ds.total.toFixed(3))}km`:''}の走者`;}
  document.getElementById('entryEventName').textContent=`${cfg.eventName||'大豊学園駅伝大会'} 参加申込`;
  const open=entryIsOpenNow(),badge=document.getElementById('entryOpenBadge'),closed=document.getElementById('entryClosedMessage'),btn=document.getElementById('entrySubmitBtn');
  badge.textContent=open?'受付中':'受付停止中';badge.className='status-pill '+(open?'running':'finished');
  closed.classList.toggle('hidden',open);closed.textContent=open?'':`現在、駅伝の参加申込は受け付けていません。${cfg.contact?` お問い合わせ：${cfg.contact}`:''}`;
  btn.disabled=!open;
}
function entryRows(){return [...document.querySelectorAll('#entryRunnerRows tr')];}
function fillDemoEntry(){
  const n=Math.floor(Math.random()*900)+100;
  document.getElementById('entryTeamName').value=`ダミーチーム${n}`;
  document.getElementById('entryRepName').value=`代表者${n}`;
  document.getElementById('entryPhone').value='090-0000-0000';
  document.getElementById('entryEmail').value=`dummy${n}@example.com`;
  document.getElementById('entryContactPref').value=['email','phone','fax','postal','student'][n%5];
  document.getElementById('entryFax').value=n%5===2?'0887-00-0000':'';
  document.getElementById('entryAddress').value=n%5===3?'高知県長岡郡大豊町 ダミー住所':'';
  document.getElementById('entryStudentName').value=n%5===4?'大豊学園 児童生徒（ダミー）':'';
  const names=['青木','井上','上田','大西','岡田','加藤','川村','小松','佐々木','田中'];
  entryRows().forEach((row,i)=>{
    const who=i===7?2:i%names.length;
    row.querySelector('[data-runner-name]').value=`${names[who]} ${i===7?'光':'選手'+(who+1)}`;
    row.querySelector('[data-runner-sex]').value=i%2?'女':'男';
    row.querySelector('[data-runner-group]').value=['小学生','中学生','一般（～29歳）','一般（30歳～）'][i%4];
    row.querySelector('[data-runner-age]').value=[10,14,28,45][i%4];
  });
  document.getElementById('entryNotes').value='開発用ダミーデータです。';
  document.getElementById('entryAgree').checked=true;
}
function copyPrevRunner(){
  const rows=entryRows();
  for(let i=1;i<rows.length;i++){
    const cur=rows[i].querySelector('[data-runner-name]'),prev=rows[i-1].querySelector('[data-runner-name]');
    if(!cur.value.trim()&&prev.value.trim()){
      ['name','sex','group','age'].forEach(k=>{const a=rows[i].querySelector(`[data-runner-${k}]`),b=rows[i-1].querySelector(`[data-runner-${k}]`);if(a&&b)a.value=b.value;});
      toast(`第${i+1}区間へ直前の走者をコピーしました`);return;
    }
  }
  toast('コピーできる空欄がありません');
}
function validateContact(pref,data){
  if(pref==='email'&&!data.email)return '希望連絡方法がメールの場合、メールアドレスを入力してください。';
  if(pref==='fax'&&!data.fax)return '希望連絡方法がFAXの場合、FAX番号を入力してください。';
  if(pref==='postal'&&!data.address)return '希望連絡方法が郵送の場合、郵送先住所を入力してください。';
  if(pref==='student'&&!data.studentName)return '児童生徒経由の場合、受取可能な児童生徒名等を入力してください。';
  return '';
}
function receiptNumber(id,ts){const d=new Date(ts);return `E${String(d.getFullYear()).slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${id.slice(-5).toUpperCase()}`;}

initEntryRows();
document.getElementById('fillDemoEntryBtn').addEventListener('click',fillDemoEntry);
document.getElementById('copyPrevRunnerBtn').addEventListener('click',copyPrevRunner);
document.getElementById('entryForm').addEventListener('submit',e=>{
  e.preventDefault(); if(!entryIsOpenNow()){toast('現在、申込受付は終了しています');return;}
  const contact={
    repName:document.getElementById('entryRepName').value.trim(),repType:document.getElementById('entryRepType').value,
    phone:document.getElementById('entryPhone').value.trim(),email:document.getElementById('entryEmail').value.trim(),fax:document.getElementById('entryFax').value.trim(),
    address:document.getElementById('entryAddress').value.trim(),contactPref:document.getElementById('entryContactPref').value,studentName:document.getElementById('entryStudentName').value.trim()
  };
  const err=validateContact(contact.contactPref,contact);if(err){toast(err);return;}
  const runners=entryRows().map((row,i)=>({leg:i+1,name:row.querySelector('[data-runner-name]').value.trim(),sex:row.querySelector('[data-runner-sex]').value,ageGroup:row.querySelector('[data-runner-group]').value,age:Number(row.querySelector('[data-runner-age]').value)||null}));
  const missing=runners.find(r=>!r.name);if(missing){toast(`第${missing.leg}区間の走者名を入力してください`);return;}
  const at=syncedNow(),id=makeId('app');
  const app={id,eventId:currentEventId(),receiptNo:receiptNumber(id,at),teamName:document.getElementById('entryTeamName').value.trim(),contact,runners,notes:document.getElementById('entryNotes').value.trim(),status:'pending',submittedBy:supabaseMode?(supabaseUserId||''):'local',submittedAt:at,updatedAt:at};
  if(!app.teamName||!contact.repName||!contact.phone){toast('必須項目を確認してください');return;}
  document.getElementById('entrySubmitBtn').disabled=true;queueWrite(`applications/${id}`,app);lastReceiptId=id;
  document.getElementById('entryReceiptNo').textContent=app.receiptNo;document.getElementById('entryCompleteText').textContent=`「${app.teamName}」の申込内容を大会事務局で確認します。`;e.target.reset();entryRows().forEach(row=>{row.querySelector('[data-runner-sex]').value='男';row.querySelector('[data-runner-group]').value='未就学';});go('entry-complete');
});

function readLegDistanceDraft(){
  const out={...(state.settings?.legDistances||{})};
  document.querySelectorAll('[data-leg-distance]').forEach(inp=>{const leg=String(inp.dataset.legDistance),v=String(inp.value||'').trim();if(!v){delete out[leg];return;}const n=Number(v);if(Number.isFinite(n)&&n>0)out[leg]=Number(n.toFixed(3));});
  return out;
}
function updateLegDistanceSummary(){
  const el=document.getElementById('legDistanceSummary');if(!el)return;const inputs=[...document.querySelectorAll('[data-leg-distance]')];const vals=inputs.map(i=>Number(i.value)).filter(n=>Number.isFinite(n)&&n>0),total=vals.reduce((a,b)=>a+b,0);
  el.textContent=vals.length===inputs.length&&inputs.length?`全${inputs.length}区間設定済み・総距離 ${Number(total.toFixed(3))}km`:`${vals.length}/${inputs.length}区間設定済み${vals.length?`・設定分合計 ${Number(total.toFixed(3))}km`:''}`;
}
function renderLegDistanceInputs(count,preserve=false){
  const box=document.getElementById('legDistanceInputs');if(!box)return;const source=preserve?readLegDistanceDraft():{...(state.settings?.legDistances||{})};
  box.innerHTML=Array.from({length:count},(_,i)=>{const leg=i+1,v=source[String(leg)]??'';return `<label><span>第${leg}区間</span><div class="distance-input-wrap"><input data-leg-distance="${leg}" type="number" min="0.01" max="100" step="0.01" inputmode="decimal" value="${esc(v)}" placeholder="未設定" /><em>km</em></div></label>`;}).join('');
  box.querySelectorAll('[data-leg-distance]').forEach(i=>i.addEventListener('input',updateLegDistanceSummary));updateLegDistanceSummary();
}
function renderEventSettings(){
  const x=state.settings||{};
  document.getElementById('settingEventName').value=x.eventName||'';document.getElementById('settingEventDate').value=x.eventDate||'';document.getElementById('settingEntryDeadline').value=x.entryDeadline||'';document.getElementById('settingVenue').value=x.venue||'';document.getElementById('settingContact').value=x.contact||'';document.getElementById('settingLegCount').value=getLegCount();document.getElementById('settingEntryOpen').checked=!!x.entryOpen;renderLegDistanceInputs(getLegCount());
}
document.getElementById('saveEventSettingsBtn').addEventListener('click',()=>{
  const oldCount=getLegCount();const legCount=Math.max(1,Math.min(30,Number(document.getElementById('settingLegCount').value)||15));
  if(legCount<oldCount&&(teamList().some(t=>(t.runners||[]).some(r=>Number(r.leg)>legCount))||computedPasses().some(p=>p.leg>legCount))&&!confirm(`区間数を${oldCount}から${legCount}へ減らします。第${legCount+1}区間以降の既存データは削除せず保存されますが、画面・計測対象から外れます。続けますか？`))return;
  const legDistances=readLegDistanceDraft();const x={...(state.settings||{}),eventName:document.getElementById('settingEventName').value.trim()||'大豊学園駅伝大会',eventDate:document.getElementById('settingEventDate').value,entryDeadline:document.getElementById('settingEntryDeadline').value,venue:document.getElementById('settingVenue').value.trim(),contact:document.getElementById('settingContact').value.trim(),entryOpen:document.getElementById('settingEntryOpen').checked,legCount,legDistances};
  queueWrite('settings',x);const ds=Object.values(legDistances).filter(v=>Number(v)>0);toast(`大会・申込設定を保存しました（${legCount}区間${ds.length?`・距離設定あり`:''}）`);
});
document.getElementById('settingLegCount')?.addEventListener('input',()=>{const n=Math.max(1,Math.min(30,Number(document.getElementById('settingLegCount').value)||15));renderLegDistanceInputs(n,true);});
document.getElementById('applySameDistanceBtn')?.addEventListener('click',()=>{const v=Number(document.getElementById('settingAllLegDistance')?.value);if(!Number.isFinite(v)||v<=0){toast('一括設定する距離を入力してください');return;}document.querySelectorAll('[data-leg-distance]').forEach(i=>i.value=String(Number(v.toFixed(3))));updateLegDistanceSummary();toast('表示中の全区間に同じ距離を入力しました');});

document.getElementById('saveAwardSettingsBtn')?.addEventListener('click',()=>{
  const cfg={...(state.awards||freshState().awards),teamTopN:Math.max(1,Math.min(10,Number(document.getElementById('awardTeamTopN').value)||3)),overallFastest:document.getElementById('awardOverallFastest').checked,genderAwards:document.getElementById('awardGender').checked,ageGroupAwards:document.getElementById('awardAgeGroup').checked,ageGenderAwards:document.getElementById('awardAgeGender').checked};queueWrite('awards',cfg);toast('表彰設定を保存しました');
});
document.getElementById('toggleFormalResultsBtn')?.addEventListener('click',()=>{
  const cfg=state.awards||freshState().awards,next=!cfg.formalResultsPublished;if(next&&state.meta.raceStatus!=='finished'&&!confirm('競技終了前ですが、正式結果を公開しますか？'))return;queueWrite('awards',{...cfg,formalResultsPublished:next,individualAwardsPublished:next?cfg.individualAwardsPublished:false});toast(next?'正式結果を公開しました':'正式結果を非公開にしました');
});
document.getElementById('toggleIndividualAwardsBtn')?.addEventListener('click',()=>{
  const cfg=state.awards||freshState().awards;if(!cfg.formalResultsPublished){toast('先に正式結果を公開してください');return;}const next=!cfg.individualAwardsPublished;queueWrite('awards',{...cfg,individualAwardsPublished:next});toast(next?'個人賞を公開しました':'個人賞を非公開にしました');
});
document.getElementById('generateDemoResultsBtn')?.addEventListener('click',()=>generateDemoFormalResults());

function entryUrl(){const u=new URL(location.href);u.search='';u.hash='';u.searchParams.set('screen','entry');return u.toString();}
function renderEntryQr(){
  const text=entryUrl(),label=document.getElementById('entryUrlText'),box=document.getElementById('entryQrBox');if(label)label.textContent=text;if(!box)return;box.innerHTML='';
  if(window.QRCode){new window.QRCode(box,{text,width:220,height:220,colorDark:'#102d48',colorLight:'#ffffff',correctLevel:window.QRCode.CorrectLevel.M});}else{box.innerHTML='<div class="empty-state">QRライブラリ読込待ち</div>';}
}
document.getElementById('refreshQrBtn').addEventListener('click',()=>{renderEntryQr();toast('申込QRを更新しました');});
document.getElementById('downloadQrBtn').addEventListener('click',()=>{renderEntryQr();setTimeout(()=>{const box=document.getElementById('entryQrBox'),c=box.querySelector('canvas'),img=box.querySelector('img'),a=document.createElement('a');a.download='ekiden_entry_qr.png';a.href=c?c.toDataURL('image/png'):img?.src||'';if(a.href)a.click();else toast('QR画像を保存できませんでした');},50);});

function applicationList(){return Object.values(state.applications||{}).filter(Boolean).sort((a,b)=>(b.submittedAt||0)-(a.submittedAt||0));}
function contactPrefLabel(v){return ({email:'メール',phone:'電話',fax:'FAX',postal:'郵送',student:'児童生徒経由'})[v]||v||'—';}
function renderApplications(){
  const apps=applicationList(),pending=apps.filter(a=>a.status==='pending').length,approved=apps.filter(a=>a.status==='approved').length,returned=apps.filter(a=>a.status==='returned').length;
  document.getElementById('applicationStats').innerHTML=`<div class="application-stat"><strong>${apps.length}</strong><small>申込総数</small></div><div class="application-stat"><strong>${pending}</strong><small>未確認</small></div><div class="application-stat"><strong>${approved}</strong><small>承認済</small></div>`;
  const el=document.getElementById('applicationList');if(!apps.length){el.innerHTML='<div class="empty-state">申込はまだありません。ダミー申込を追加して画面確認できます。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>受付</th><th>チーム</th><th>代表者・連絡</th><th>選手</th><th>状態</th><th>発行情報</th><th>操作</th></tr></thead><tbody>${apps.map(a=>{
    const c=a.contact||{},status=a.status||'pending',chip=status==='approved'?'approved':status==='returned'?'returned':'pending',statusText=status==='approved'?'承認済':status==='returned'?'差戻し':'未確認';
    const detail=(a.runners||[]).map(r=>`${legLabel(r.leg)} ${r.name}（${r.sex}/${normalizeAgeGroup(r.ageGroup,r.age)}${r.age?'/'+r.age+'歳':''}）`).join('、');
    const issued=status==='approved'?`チーム${esc(a.issuedTeamNo||'')} / <span class="team-code-inline">${esc(a.issuedAccessCode||'')}</span>`:'—';
    const actions=status==='pending'?`<button class="tiny-btn green" data-approve-app="${esc(a.id)}">承認</button> <button class="tiny-btn" data-return-app="${esc(a.id)}">差戻し</button>`:status==='returned'?`<button class="tiny-btn" data-reopen-app="${esc(a.id)}">未確認へ戻す</button>`:`<button class="tiny-btn" data-show-team="${esc(a.issuedTeamNo||'')}">チーム確認</button>`;
    return `<tr><td>${esc(a.receiptNo||'')}<br><small>${a.submittedAt?new Date(a.submittedAt).toLocaleString('ja-JP'):''}</small></td><td><strong>${esc(a.teamName||'')}</strong><div class="app-detail">${esc(a.notes||'')}</div></td><td>${esc(c.repName||'')}<div class="app-detail">${esc(c.phone||'')} / ${esc(c.email||'')}<br>希望：${esc(contactPrefLabel(c.contactPref))}${c.studentName?`<br>${esc(c.studentName)}`:''}</div></td><td><details><summary>${getLegCount()}区間を確認</summary><div class="app-detail">${esc(detail)}</div></details></td><td><span class="status-chip ${chip}">${statusText}</span></td><td>${issued}</td><td>${actions} <button class="tiny-btn red" data-delete-app="${esc(a.id)}">削除</button></td></tr>`;
  }).join('')}</tbody></table>`;
  el.querySelectorAll('[data-approve-app]').forEach(b=>b.addEventListener('click',()=>approveApplication(b.dataset.approveApp)));
  el.querySelectorAll('[data-return-app]').forEach(b=>b.addEventListener('click',()=>setApplicationStatus(b.dataset.returnApp,'returned')));
  el.querySelectorAll('[data-reopen-app]').forEach(b=>b.addEventListener('click',()=>setApplicationStatus(b.dataset.reopenApp,'pending')));
  el.querySelectorAll('[data-delete-app]').forEach(b=>b.addEventListener('click',()=>deleteApplication(b.dataset.deleteApp)));
  el.querySelectorAll('[data-show-team]').forEach(b=>b.addEventListener('click',()=>toast(`チーム${b.dataset.showTeam}は下の「登録チーム管理」で確認できます`)));
}
function nextTeamNumber(){const used=new Set(teamList().map(t=>String(t.teamNo)));let n=1;while(used.has(String(n)))n++;return String(n);}
async function approveApplication(id){
  const a=state.applications?.[id];if(!a||a.status==='approved')return;if(!confirm(`「${a.teamName}」を承認し、チーム番号とアクセスコードを発行しますか？`))return;
  const no=nextTeamNumber(),code=randomNumericCode(),team={teamNo:no,teamName:a.teamName,runners:(a.runners||[]).map(r=>({...r,leg:Number(r.leg)})),sourceApplicationId:id};
  if(!supabaseMode){team.accessCode=code;team.representative={name:a.contact?.repName||'',phone:a.contact?.phone||'',email:a.contact?.email||'',contactPref:a.contact?.contactPref||''};}
  if(supabaseMode&&!(await setTeamSecret(no,code)))return;queueWrite(`teams/${teamKey(no)}`,team);queueWrite(`applications/${id}`,{...a,status:'approved',issuedTeamNo:no,issuedAccessCode:code,approvedAt:syncedNow(),updatedAt:syncedNow()});toast(`チーム${no}として承認しました`);
}
function setApplicationStatus(id,status){const a=state.applications?.[id];if(!a)return;queueWrite(`applications/${id}`,{...a,status,updatedAt:syncedNow()});toast(status==='returned'?'差戻しにしました':'未確認へ戻しました');}
function deleteApplication(id){const a=state.applications?.[id];if(!a)return;if(a.status==='approved'){toast('承認済み申込は先に登録チームを確認してください');return;}if(confirm(`申込「${a.teamName}」を削除しますか？`)){queueWrite(`applications/${id}`,null,true);toast('申込を削除しました');}}

function renderTeamManagement(){
  const teams=teamList(),el=document.getElementById('teamManagementList');if(!teams.length){el.innerHTML='<div class="empty-state">登録チームはありません。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>No.</th><th>チーム名</th><th>代表者</th><th>走者</th><th>アクセスコード</th><th>操作</th></tr></thead><tbody>${teams.map(t=>`<tr><td>${esc(t.teamNo)}</td><td>${esc(t.teamName)}</td><td>${esc(state.applications?.[t.sourceApplicationId]?.contact?.repName||t.representative?.name||'—')}</td><td>${(t.runners||[]).filter(r=>Number(r.leg)<=getLegCount()).length}/${getLegCount()}区間</td><td><span class="team-code-inline">${esc(privateTeamCodes[String(t.teamNo)]||t.accessCode||'未設定')}</span></td><td><button class="tiny-btn" data-rename-team="${esc(t.teamNo)}">名称変更</button> <button class="tiny-btn" data-regenerate-code="${esc(t.teamNo)}">4桁コード再発行</button> <button class="tiny-btn green" data-print-team="${esc(t.teamNo)}">PDF・印刷</button> <button class="tiny-btn red" data-delete-team="${esc(t.teamNo)}">削除</button></td></tr>`).join('')}</tbody></table>`;
  el.querySelectorAll('[data-rename-team]').forEach(b=>b.addEventListener('click',()=>renameTeam(b.dataset.renameTeam)));
  el.querySelectorAll('[data-regenerate-code]').forEach(b=>b.addEventListener('click',()=>regenerateTeamCode(b.dataset.regenerateCode)));
  el.querySelectorAll('[data-print-team]').forEach(b=>b.addEventListener('click',()=>printTeamGuide([b.dataset.printTeam])));
  el.querySelectorAll('[data-delete-team]').forEach(b=>b.addEventListener('click',()=>deleteTeam(b.dataset.deleteTeam)));
}

function printEscape(s=''){return String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]||c));}
function formatEventDateForGuide(v){
  if(!v)return '未設定';
  const d=new Date(`${v}T00:00:00`);if(Number.isNaN(d.getTime()))return v;
  return d.toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
}
function teamGuideHtml(teamNo){
  const t=getTeam(teamNo);if(!t)return '';
  const app=t.sourceApplicationId?state.applications?.[t.sourceApplicationId]:null;
  const c=app?.contact||{};const cfg=state.settings||{};
  const code=privateTeamCodes[String(t.teamNo)]||t.accessCode||app?.issuedAccessCode||'未設定';
  const runners=(t.runners||[]).slice().sort((a,b)=>Number(a.leg)-Number(b.leg));
  const legCount=getLegCount(),split=Math.ceil(legCount/2);
  const runnerRow=(leg)=>{const r=runners.find(x=>Number(x.leg)===leg)||{},d=legDistanceLabel(leg);return `<div class="runner-item"><b>第${leg}区間${d?`<em>${printEscape(d)}</em>`:''}</b><span>${printEscape(r.name||'—')}</span><small>${printEscape([r.sex,normalizeAgeGroup(r.ageGroup,r.age)].filter(Boolean).join(' / '))}</small></div>`;};
  const runnerColumns=`<div>${Array.from({length:split},(_,i)=>runnerRow(i+1)).join('')}</div><div>${Array.from({length:legCount-split},(_,i)=>runnerRow(split+i+1)).join('')}</div>`;
  return `<section class="team-sheet">
    <header class="sheet-head">
      <img src="assets/logo-kanji.png" alt="駅伝" />
      <div><div class="sheet-kicker">${printEscape(cfg.eventName||'大豊学園駅伝大会')}</div><h1>チーム参加案内</h1></div>
    </header>
    <div class="credential-box">
      <div><small>チーム番号</small><strong>${printEscape(t.teamNo)}</strong></div>
      <div><small>チーム用アクセスコード</small><strong>${printEscape(code)}</strong></div>
    </div>
    <table class="summary"><tbody>
      <tr><th>チーム名</th><td>${printEscape(t.teamName)}</td><th>代表者</th><td>${printEscape(c.repName||t.representative?.name||'—')}</td></tr>
      <tr><th>開催日</th><td>${printEscape(formatEventDateForGuide(cfg.eventDate))}</td><th>会場</th><td>${printEscape(cfg.venue||'未設定')}</td></tr>
      <tr><th>事務局</th><td colspan="3">${printEscape(cfg.contact||'大会事務局')}</td></tr>
    </tbody></table>
    <div class="guide-note"><strong>チーム参考計測について</strong><br>「計測係」→「チーム計測係」から、上記のチーム番号とアクセスコードでログインしてください。チーム側のタイムはバックアップ用の参考記録で、運営側の記録が正式記録です。</div>
    <h2>登録走者（全${legCount}区間）</h2>
    <div class="runner-grid">${runnerColumns}</div>
    <p class="sheet-foot">この用紙はチーム内で保管してください。アクセスコードを第三者へ公開しないでください。</p>
  </section>`;
}
function printTeamGuide(teamNos){
  const nos=(teamNos||[]).map(String).filter(no=>getTeam(no));if(!nos.length){toast('印刷するチームがありません');return;}
  const w=window.open('','_blank');if(!w){toast('ポップアップを許可してください');return;}
  const sheets=nos.map(teamGuideHtml).join('').replaceAll('src="assets/logo-kanji.png"',`src="${new URL('assets/logo-kanji.png',location.href).href}"`);
  w.document.open();w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>駅伝 チーム参加案内</title><style>
    @page{size:A4 portrait;margin:8mm}*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;color:#132b45;background:#fff}.team-sheet{page-break-after:always;height:279mm;max-height:279mm;overflow:hidden;padding:1mm}.team-sheet:last-child{page-break-after:auto}.sheet-head{display:flex;align-items:center;gap:10px;border-bottom:2px solid #167fd7;padding-bottom:6px}.sheet-head img{width:70px;height:48px;object-fit:contain}.sheet-kicker{font-size:9px;color:#5f7890;font-weight:700}.sheet-head h1{font-size:19px;margin:2px 0}.credential-box{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}.credential-box>div{border:1.5px solid #1686e8;border-radius:10px;padding:6px;text-align:center;background:#f4f9ff}.credential-box small{display:block;color:#60788f;font-weight:700;font-size:9px}.credential-box strong{display:block;font-size:24px;letter-spacing:.06em;margin-top:1px}.summary{width:100%;border-collapse:collapse;margin:6px 0;font-size:9.5px}.summary th,.summary td{border:1px solid #cfdde9;padding:4px 5px}.summary th{background:#eef6fc;text-align:left;width:14%}.guide-note{border-left:4px solid #ff8a21;background:#fff7eb;padding:6px 8px;line-height:1.45;font-size:9.5px;margin:7px 0}h2{font-size:12px;margin:7px 0 4px}.runner-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px 10px}.runner-grid>div{min-width:0}.runner-item{display:grid;grid-template-columns:64px 1fr auto;align-items:center;gap:5px;border-bottom:1px solid #d9e4ed;padding:2.5px 3px;font-size:9px;min-height:19px}.runner-item b{color:#174d7a}.runner-item b em{display:block;font-size:7px;font-style:normal;color:#6b8194;font-weight:700;margin-top:1px}.runner-item span{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.runner-item small{font-size:7.8px;color:#60788f;white-space:nowrap}.sheet-foot{font-size:8px;color:#6a8094;margin-top:5px}@media print{button{display:none}}
  </style></head><body>${sheets}<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),350));<\/script></body></html>`);w.document.close();
}
function renameTeam(no){const t=getTeam(no);if(!t)return;const name=prompt('新しいチーム名を入力してください。',t.teamName);if(!name?.trim())return;queueWrite(`teams/${teamKey(no)}`,{...t,teamName:name.trim()});toast('チーム名を変更しました');}
async function regenerateTeamCode(no){const t=getTeam(no);if(!t||!confirm(`${t.teamName}のチーム用アクセスコードを再発行しますか？`))return;const code=randomNumericCode();if(supabaseMode){if(!(await setTeamSecret(no,code)))return;}else queueWrite(`teams/${teamKey(no)}`,{...t,accessCode:code});if(t.sourceApplicationId&&state.applications?.[t.sourceApplicationId]){const a=state.applications[t.sourceApplicationId];queueWrite(`applications/${t.sourceApplicationId}`,{...a,issuedAccessCode:code,updatedAt:syncedNow()});}toast(`新しいコード：${code}`);renderCurrent();}
async function deleteTeam(no){const t=getTeam(no);if(!t)return;if(teamProgress(no)>0){toast('計測記録があるチームは削除できません');return;}if(!confirm(`チーム${no}「${t.teamName}」を削除しますか？`))return;if(supabaseMode)await deleteTeamSecret(no);queueWrite(`teams/${teamKey(no)}`,null,true);if(t.sourceApplicationId&&state.applications?.[t.sourceApplicationId]){const a=state.applications[t.sourceApplicationId];queueWrite(`applications/${t.sourceApplicationId}`,{...a,status:'pending',issuedTeamNo:null,issuedAccessCode:null,approvedAt:null,updatedAt:syncedNow()});}toast('チームを削除しました');}

function makeDummyApplication(seed){
  const groups=['小学生','中学生','一般（～29歳）','一般（30歳～）'];const surnames=['山田','佐藤','高橋','小川','西村','森','岡本','藤田'];const submittedAt=syncedNow()-seed*60000,id=makeId(`dummy${seed}`),pref=['email','phone','fax','postal','student'][seed%5];
  return {id,receiptNo:receiptNumber(id,submittedAt),teamName:['大豊ファミリー','杉の子ランナーズ','吉野川スマイル','おおとよフレンズ','山びこチーム','れいほくスターズ'][seed%6]+seed,contact:{repName:`代表 ${surnames[seed%surnames.length]}`,repType:seed%2?'保護者':'大豊学園児童・生徒',phone:'090-0000-'+String(1000+seed),email:pref==='email'?`dummy${seed}@example.com`:'',fax:pref==='fax'?'0887-00-0000':'',address:pref==='postal'?'高知県長岡郡大豊町（ダミー）':'',contactPref:pref,studentName:pref==='student'?'大豊学園 児童生徒（ダミー）':''},runners:Array.from({length:getLegCount()},(_,i)=>{const same=(i===8?2:i);return {leg:i+1,name:`${surnames[(same+seed)%surnames.length]} 選手${(same%7)+1}`,sex:(i+seed)%2?'女':'男',ageGroup:groups[(i+seed)%groups.length],age:[10,14,29,45][(i+seed)%4]};}),notes:'開発用ダミー申込',status:'pending',submittedAt,updatedAt:submittedAt};
}
document.getElementById('loadDemoApplicationsBtn').addEventListener('click',()=>{const merged={...(state.applications||{})};for(let i=1;i<=6;i++){const a=makeDummyApplication(i);merged[a.id]=a;}queueWrite('applications',merged);toast('ダミー申込を6件追加しました');});
document.getElementById('printAllTeamsBtn')?.addEventListener('click',()=>printTeamGuide(teamList().map(t=>t.teamNo)));
document.getElementById('exportApplicationsBtn').addEventListener('click',()=>{
  const out=[['receipt_no','status','team_name','representative','phone','email','fax','address','contact_preference','student_contact','notes','submitted_at','issued_team_no','issued_access_code']];applicationList().forEach(a=>{const c=a.contact||{};out.push([a.receiptNo||'',a.status||'',a.teamName||'',c.repName||'',c.phone||'',c.email||'',c.fax||'',c.address||'',contactPrefLabel(c.contactPref),c.studentName||'',a.notes||'',a.submittedAt?new Date(a.submittedAt).toISOString():'',a.issuedTeamNo||'',a.issuedAccessCode||'']);});downloadText('\uFEFF'+out.map(r=>r.map(csvEscape).join(',')).join('\r\n'),'ekiden_applications_v03.csv','text/csv;charset=utf-8');
});

// ---------- Admin ----------
function renderAdmin(){
  const passes=computedPasses();document.getElementById('adminTeamCount').textContent=teamList().length;document.getElementById('adminLegCount').textContent=getLegCount();document.getElementById('adminPassCount').textContent=passes.length;
  const pill=document.getElementById('raceStatusPill');pill.textContent=statusLabel();pill.className='status-pill '+(state.meta.raceStatus==='running'?'running':state.meta.raceStatus==='finished'?'finished':'');
  document.getElementById('startRaceBtn').disabled=state.meta.raceStatus==='running';document.getElementById('finishRaceBtn').disabled=state.meta.raceStatus!=='running';
  renderEventSettings();renderEntryQr();renderApplications();renderTeamManagement();
  renderTeamCodes();renderAdminPassLog();renderRawOfficialLog();renderTeamBackupLog();renderNoticeBoardAdmin();renderAwardsAdmin();renderCertificateSettings();renderEventManager();renderSyncStatus();
}
document.getElementById('createNewEventBtn')?.addEventListener('click',()=>createNewAnnualEvent());
document.getElementById('startRaceBtn').addEventListener('click',()=>{
  if(!teamList().length&&!confirm('チーム登録がありません。このまま開始しますか？'))return;if(!confirm('全チーム一斉スタートとして計測を開始します。よろしいですか？'))return;
  queueWrite('meta',{...state.meta,raceStatus:'running',startAt:syncedNow(),finishAt:null});toast('一斉スタートしました');
});
document.getElementById('finishRaceBtn').addEventListener('click',()=>{queueWrite('meta',{...state.meta,raceStatus:'finished',finishAt:syncedNow()});toast('競技終了にしました');});
document.getElementById('saveNoticeBtn').addEventListener('click',()=>{const notice=createNoticeFromForm(); if(!notice)return; queueWrite(`notices/${notice.id}`,notice); queueWrite('meta/notice',notice.body); toast('掲示板に投稿しました'); clearNoticeForm();});
document.getElementById('clearNoticeFormBtn').addEventListener('click',()=>clearNoticeForm());
document.getElementById('saveAccessCodesBtn').addEventListener('click',async()=>{
  const a=document.getElementById('newAdminCode').value.trim(),A=document.getElementById('newOpACode').value.trim(),B=document.getElementById('newOpBCode').value.trim(),C=document.getElementById('newOpCCode').value.trim();
  if(supabaseMode&&supabaseReady){const {error}=await sb.rpc('ekiden_update_access_codes',{p_admin:a||null,p_a:A||null,p_b:B||null,p_c:C||null});if(error){console.error(error);toast('アクセスコード更新に失敗しました');return;}}
  else {const cred=structuredClone(state.credentials||{adminHash:'',operatorHashes:{}});cred.operatorHashes=cred.operatorHashes||{};if(a)cred.adminHash=await sha256(a);if(A)cred.operatorHashes.A=await sha256(A);if(B)cred.operatorHashes.B=await sha256(B);if(C)cred.operatorHashes.C=await sha256(C);queueWrite('credentials',cred);}
  ['newAdminCode','newOpACode','newOpBCode','newOpCCode'].forEach(id=>document.getElementById(id).value='');toast('アクセスコードを更新しました');
});

function renderTeamCodes(){
  const el=document.getElementById('teamCodeList'),teams=teamList();if(!teams.length){el.innerHTML='<div class="empty-state">チーム未登録</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>チーム</th><th>コード</th></tr></thead><tbody>${teams.map(t=>`<tr><td>${esc(t.teamNo)} ${esc(t.teamName)}</td><td><code>${esc(privateTeamCodes[String(t.teamNo)]||t.accessCode||'未設定')}</code></td></tr>`).join('')}</tbody></table>`;
}
function renderAdminPassLog(){
  const rows=computedPasses().sort((a,b)=>b.officialAt-a.officialAt),el=document.getElementById('adminPassLog');if(!rows.length){el.innerHTML='<div class="empty-state">まだ正式通過記録はありません。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>チーム</th><th>区間</th><th>走者</th><th>正式通過</th><th>区間タイム</th><th>根拠</th><th>状態</th><th>操作</th></tr></thead><tbody>${rows.map(p=>{
    const reason=p.source==='official'?p.usedRows.map(r=>`${r.operator}:${fmtTimeOfDay(r.at)}`).join(' / '):'チーム参考記録';const status=p.source==='team-adopted'?'参考記録採用':p.review?`差 ${p.spread}ms`:`${p.count}名計測`;
    return `<tr><td>${esc(p.teamNo)} ${esc(p.teamName)}</td><td>${p.leg}/${getLegCount()}</td><td>${esc(runnerFor(p.teamNo,p.leg)?.name||'')}</td><td>${fmtTimeOfDay(p.officialAt)}${p.override?' *':''}</td><td>${fmtClock(lapTime(p))}</td><td>${esc(reason)}</td><td>${esc(status)}</td><td><button class="text-btn" data-edit-time="${esc(p.eventId)}">時刻修正</button>${p.source==='team-adopted'?` <button class="text-btn" data-unadopt="${esc(p.eventId)}">採用取消</button>`:''}</td></tr>`;
  }).join('')}</tbody></table>`;
  el.querySelectorAll('[data-edit-time]').forEach(b=>b.addEventListener('click',()=>editPassTime(b.dataset.editTime)));
  el.querySelectorAll('[data-unadopt]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.unadopt;queueWrite(`adoptions/${id}`,null,true);queueWrite(`overrides/${id}`,null,true);toast('チーム参考記録の採用を取り消しました');}));
}
function editPassTime(eventId){
  const p=computedPasses().find(x=>x.eventId===eventId);if(!p)return;const val=prompt('正式通過時刻を HH:MM:SS.cc で入力してください。',fmtTimeOfDay(p.officialAt));if(val==null)return;const ts=parseTimeOfDay(val,state.meta.startAt||p.officialAt);if(!ts){toast('時刻形式を確認してください');return;}queueWrite(`overrides/${eventId}`,{officialAt:ts,updatedAt:syncedNow()});toast('正式時刻を修正しました');
}
function renderRawOfficialLog(){
  const rows=activeOfficialMeasurements().sort((a,b)=>b.at-a.at).slice(0,120),el=document.getElementById('rawOfficialLog');if(!rows.length){el.innerHTML='<div class="empty-state">まだ運営側の生計測はありません。</div>';return;}
  const options=teamList().map(t=>`<option value="${esc(t.teamNo)}">${esc(t.teamNo)} ${esc(t.teamName)}</option>`).join('');
  el.innerHTML=`<table class="data-table"><thead><tr><th>時刻</th><th>計測係</th><th>チーム</th><th>操作</th></tr></thead><tbody>${rows.map(m=>`<tr><td>${fmtTimeOfDay(m.at)}</td><td>${esc(m.operator)}</td><td><select class="inline-select" data-raw-team="${esc(m.id)}">${options}</select></td><td><button class="text-btn" data-save-raw="${esc(m.id)}">変更</button> <button class="text-btn danger-text" data-delete-raw="${esc(m.id)}">削除</button></td></tr>`).join('')}</tbody></table>`;
  rows.forEach(m=>{const s=el.querySelector(`[data-raw-team="${CSS.escape(m.id)}"]`);if(s)s.value=String(m.teamNo);});
  el.querySelectorAll('[data-save-raw]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.saveRaw,s=el.querySelector(`[data-raw-team="${CSS.escape(id)}"]`),m=state.officialMeasurements[id];if(!m||!s)return;queueWrite(`officialMeasurements/${id}`,{...m,teamNo:s.value,teamName:getTeam(s.value)?.teamName||m.teamName});toast('チームを修正しました');}));
  el.querySelectorAll('[data-delete-raw]').forEach(b=>b.addEventListener('click',()=>{if(confirm('この生計測データを削除しますか？')){queueWrite(`officialMeasurements/${b.dataset.deleteRaw}`,null,true);toast('削除しました');}}));
}
function renderTeamBackupLog(){
  const groups=teamList().flatMap(t=>teamGroups(t.teamNo)).sort((a,b)=>b.at-a.at),el=document.getElementById('teamBackupLog');if(!groups.length){el.innerHTML='<div class="empty-state">チーム参考計測はまだありません。</div>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>チーム</th><th>参考時刻</th><th>状態</th><th>操作</th></tr></thead><tbody>${groups.map(g=>{const adopted=!!state.adoptions?.[g.eventId]?.active,matched=isTeamGroupMatched(g);return `<tr><td>${esc(g.teamNo)} ${esc(getTeam(g.teamNo)?.teamName||'')}</td><td>${fmtTimeOfDay(g.at)}</td><td>${adopted?'正式記録に採用済':matched?'運営記録あり':'未照合'}</td><td>${adopted?`<button class="text-btn" data-backup-unadopt="${esc(g.eventId)}">採用取消</button>`:matched?'—':`<button class="text-btn" data-backup-adopt="${esc(g.eventId)}">正式記録に採用</button>`}</td></tr>`;}).join('')}</tbody></table>`;
  el.querySelectorAll('[data-backup-adopt]').forEach(b=>b.addEventListener('click',()=>{if(confirm('このチーム参考記録を正式記録の補完として採用しますか？')){queueWrite(`adoptions/${b.dataset.backupAdopt}`,{active:true,adoptedAt:syncedNow()});toast('正式記録に採用しました');}}));
  el.querySelectorAll('[data-backup-unadopt]').forEach(b=>b.addEventListener('click',()=>{queueWrite(`adoptions/${b.dataset.backupUnadopt}`,null,true);toast('採用を取り消しました');}));
}

// ---------- CSV temporary entry ----------
document.getElementById('downloadCsvBtn').addEventListener('click',()=>{
  const rows=[['team_no','team_name','team_code','runner_name','sex','age_group','leg'],['1','大豊A','1001','山田 太郎','男','中学生','1'],['1','大豊A','1001','佐藤 花子','女','一般（～29歳）','2']];downloadText('\uFEFF'+rows.map(r=>r.join(',')).join('\r\n'),'ekiden_entry_template_v02.csv','text/csv;charset=utf-8');
});
document.getElementById('csvInput').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;try{csvPending=parseEntryCsv(await f.text());renderCsvPreview(csvPending);document.getElementById('commitCsvBtn').disabled=!csvPending.valid;}catch(err){csvPending=null;document.getElementById('csvPreview').innerHTML=`<b>読み込みエラー：</b>${esc(err.message)}`;document.getElementById('commitCsvBtn').disabled=true;}});
document.getElementById('commitCsvBtn').addEventListener('click',async()=>{if(!csvPending?.valid)return;if(supabaseMode){for(const t of Object.values(csvPending.teams)){if(!(await setTeamSecret(t.teamNo,t.accessCode)))return;}}queueWrite('teams',csvPending.teams);clearRaceMeasurements();csvPending=null;document.getElementById('commitCsvBtn').disabled=true;toast('チームデータを登録しました');});
function parseEntryCsv(text){
  const lines=parseCsv(text.replace(/^\uFEFF/,''));if(lines.length<2)throw new Error('データ行がありません。');const headers=lines[0].map(x=>x.trim());const req=['team_no','team_name','runner_name','sex','age_group','leg'];req.forEach(h=>{if(!headers.includes(h))throw new Error(`列「${h}」がありません。`);});const idx=Object.fromEntries(headers.map((h,i)=>[h,i]));const hasCode=headers.includes('team_code'),errors=[],rows=[];
  lines.slice(1).filter(r=>r.some(v=>String(v).trim())).forEach((r,n)=>{const row=Object.fromEntries(req.map(h=>[h,(r[idx[h]]??'').trim()]));row.team_code=hasCode?(r[idx.team_code]??'').trim():'';row.team_no=zenToHan(row.team_no);row.leg=zenToHan(row.leg);if(!row.team_no||!row.team_name||!row.runner_name||!row.leg)errors.push(`${n+2}行目：必須項目が空欄です。`);if(/[.#$\/[\]]/.test(row.team_no))errors.push(`${n+2}行目：team_noに使用できない記号があります。`);if(!(Number(row.leg)>=1&&Number(row.leg)<=getLegCount()))errors.push(`${n+2}行目：legは1〜${getLegCount()}で入力してください。`);rows.push(row);});
  const teams={};rows.forEach(r=>{const k=teamKey(r.team_no);if(!teams[k])teams[k]={teamNo:r.team_no,teamName:r.team_name,accessCode:r.team_code||randomNumericCode(),runners:[]};if(r.team_code&&teams[k].accessCode!==r.team_code)errors.push(`チーム${r.team_no}：team_codeが行によって異なります。`);teams[k].runners.push({name:r.runner_name,sex:r.sex,ageGroup:normalizeAgeGroup(r.age_group,null),leg:Number(r.leg)});});
  Object.values(teams).forEach(t=>{const legs=t.runners.map(r=>r.leg),dup=legs.find((x,i)=>legs.indexOf(x)!==i);if(dup)errors.push(`チーム${t.teamNo}：第${dup}区間が重複しています。`);});return {valid:!errors.length,errors,rows,teams};
}
function zenToHan(s){return String(s).replace(/[０-９]/g,x=>String.fromCharCode(x.charCodeAt(0)-0xFEE0));}
function randomNumericCode(){const a=new Uint32Array(1);crypto.getRandomValues(a);return String(1000+(a[0]%9000));}
function parseCsv(text){const out=[];let row=[],cell='',q=false;for(let i=0;i<text.length;i++){const c=text[i];if(q){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')q=false;else cell+=c;}else{if(c==='"')q=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));out.push(row);row=[];cell='';}else cell+=c;}}row.push(cell.replace(/\r$/,''));if(row.some(v=>v!==''))out.push(row);return out;}
function renderCsvPreview(x){const el=document.getElementById('csvPreview');el.classList.remove('empty');if(x.errors.length){el.innerHTML=`<b>${x.errors.length}件のエラー</b><ul>${x.errors.slice(0,10).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`;return;}el.innerHTML=`<b>登録可能：</b>${Object.keys(x.teams).length}チーム / ${x.rows.length}区間分<br><small>チーム用コードが空欄の場合は4桁で自動発行します。</small>`;}
function clearRaceMeasurements(){queueWrite('officialMeasurements',{});queueWrite('teamMeasurements',{});queueWrite('adoptions',{});queueWrite('overrides',{});queueWrite('meta',{...state.meta,raceStatus:'before',startAt:null,finishAt:null});}

// ---------- Official timer ----------
function renderTimer(){
  document.getElementById('operatorLabel').textContent=`計測係 ${currentOperator||'-'}`;document.getElementById('racePhaseLabel').textContent=statusLabel();document.getElementById('timerNote').textContent=state.meta.raceStatus==='running'?'接近するチームを声かけで押し分けてください。複数人の計測値は自動統合されます。':state.meta.raceStatus==='finished'?'競技は終了しています。':'管理者が一斉スタートを押すと計測できます。';
  const wrap=document.getElementById('teamButtons'),teams=teamList();if(!teams.length)wrap.innerHTML='<div class="empty-state" style="grid-column:1/-1">チームが未登録です。</div>';else wrap.innerHTML=teams.map(t=>{const leg=teamProgress(t.teamNo)+1,count=getLegCount();return `<button class="team-btn ${leg>count?'finished':''}" data-team="${esc(t.teamNo)}" ${state.meta.raceStatus!=='running'||leg>count?'disabled':''}><strong>${esc(t.teamNo)}</strong><span>${esc(t.teamName)}</span><span class="leg">${leg>count?'FINISH':`次：${legLabel(leg)}`}</span></button>`;}).join('');wrap.querySelectorAll('[data-team]').forEach(b=>b.addEventListener('click',()=>recordOfficialMeasurement(b.dataset.team)));renderTimerLog();
}
function recordOfficialMeasurement(teamNo){
  if(state.meta.raceStatus!=='running'||!currentOperator)return;const t=getTeam(teamNo);if(!t)return;const id=makeId('om'),rec={id,teamNo:String(t.teamNo),teamName:t.teamName,operator:currentOperator,at:syncedNow(),localAt:Date.now(),deviceId:DEVICE_ID,status:'active'};queueWrite(`officialMeasurements/${id}`,rec);toast(`${t.teamName} を記録`);
}
function renderTimerLog(){
  const mine=activeOfficialMeasurements().filter(m=>m.operator===currentOperator).sort((a,b)=>b.at-a.at).slice(0,10);document.getElementById('operatorRecordCount').textContent=`${activeOfficialMeasurements().filter(m=>m.operator===currentOperator).length}件`;document.getElementById('timerLog').innerHTML=mine.length?`<div class="log-list">${mine.map(m=>`<div class="log-item"><span class="log-time">${fmtTimeOfDay(m.at)}</span><span>${esc(m.teamName)}</span><span class="measure-badge">${esc(m.operator)}</span></div>`).join('')}</div>`:'<div class="empty-state">まだ記録がありません。</div>';document.getElementById('undoBtn').disabled=!mine.length;
}
document.getElementById('undoBtn').addEventListener('click',()=>{const last=activeOfficialMeasurements().filter(m=>m.operator===currentOperator).sort((a,b)=>b.at-a.at)[0];if(!last)return;queueWrite(`officialMeasurements/${last.id}`,null,true);toast('直前の記録を取り消しました');});
document.getElementById('timerLogoutBtn').addEventListener('click',async()=>{await releaseCurrentLock();go('top');});

// ---------- Team backup timer ----------
function renderTeamTimer(){
  const t=getTeam(currentTeamNo);if(!t){document.getElementById('teamTimerName').textContent='未登録';return;}document.getElementById('teamTimerNo').textContent=`チーム ${t.teamNo}`;document.getElementById('teamTimerName').textContent=t.teamName;const groups=teamGroups(t.teamNo);const next=groups.length+1,count=getLegCount();document.getElementById('teamPassLeg').textContent=next>count?'FINISH':legLabel(next);document.getElementById('teamPassBtn').disabled=state.meta.raceStatus!=='running'||next>count;document.getElementById('teamTimerNote').textContent=state.meta.raceStatus==='running'?'自チームの選手が計測地点を通過した瞬間に押してください。':state.meta.raceStatus==='finished'?'競技は終了しています。':'管理者が一斉スタートを押すと計測できます。';document.getElementById('teamRecordCount').textContent=`${groups.length}件`;document.getElementById('teamTimerLog').innerHTML=groups.length?`<div class="log-list">${groups.slice().reverse().slice(0,getLegCount()).map((g,i)=>`<div class="log-item"><span class="log-time">${fmtTimeOfDay(g.at)}</span><span>${esc(t.teamName)}</span><span class="measure-badge">参考</span></div>`).join('')}</div>`:'<div class="empty-state">まだ参考記録がありません。</div>';document.getElementById('teamUndoBtn').disabled=!groups.length;
}
document.getElementById('teamPassBtn').addEventListener('click',()=>{const t=getTeam(currentTeamNo);if(!t||state.meta.raceStatus!=='running')return;const id=makeId('tm'),rec={id,teamNo:String(t.teamNo),teamName:t.teamName,at:syncedNow(),localAt:Date.now(),deviceId:DEVICE_ID,status:'active'};queueWrite(`teamMeasurements/${teamKey(t.teamNo)}/${id}`,rec);toast('チーム参考タイムを記録しました');});
document.getElementById('teamUndoBtn').addEventListener('click',()=>{const rows=activeTeamMeasurements(currentTeamNo).sort((a,b)=>b.at-a.at);const last=rows[0];if(!last)return;queueWrite(`teamMeasurements/${teamKey(currentTeamNo)}/${last.id}`,null,true);toast('直前の参考記録を取り消しました');});
document.getElementById('teamLogoutBtn').addEventListener('click',async()=>{await releaseCurrentLock();go('top');});

// ---------- Participant ----------
function renderParticipant(){
  renderParticipantNotices();renderParticipantFormalResults();
  const ranking=teamList().map(t=>({team:t,legs:teamProgress(t.teamNo),total:teamTotal(t.teamNo),passes:passesForTeam(t.teamNo)})).sort((a,b)=>b.legs-a.legs||((a.total??Infinity)-(b.total??Infinity))||naturalCompare(a.team.teamNo,b.team.teamNo));
  const el=document.getElementById('participantTeamList'); if(!el)return;
  if(!ranking.length){el.innerHTML='<div class="empty-state">まだチームが登録されていません。</div>';return;}
  el.innerHTML=ranking.map((r,i)=>{
    const progress=r.legs===0?'未通過':r.legs>=getLegCount()?'FINISH':`第${r.legs}区間`;
    const records=r.passes.length?r.passes.map(p=>{const runner=runnerFor(p.teamNo,p.leg)||{};return `<div class="team-record-row"><span class="record-leg">${esc(legLabel(p.leg))}</span><span class="record-runner">${esc(runner.name||'走者未登録')}</span><span class="record-lap">${fmtClock(lapTime(p))}</span><span class="record-total">累積 ${state.meta.startAt?fmtClock(p.officialAt-state.meta.startAt):'--:--'}</span></div>`;}).join(''):'<div class="team-record-empty">まだ通過記録はありません。</div>';
    return `<details class="participant-team-item"><summary><div class="team-rank-badge">${i+1}<small>位</small></div><div class="team-summary-name"><strong>${esc(r.team.teamName)}</strong><span>チーム ${esc(r.team.teamNo)}</span></div><div class="team-summary-progress"><span>${progress}</span><strong>${r.total!=null?fmtClock(r.total):'--:--'}</strong></div><b class="disclosure-mark">＋</b></summary><div class="team-record-body">${records}</div></details>`;
  }).join('');
}


// Certificate settings / template controls
const saveCertBtn=document.getElementById('saveCertificateSettingsBtn');
if(saveCertBtn)saveCertBtn.addEventListener('click',()=>{saveCertificateConfig({organizerName:document.getElementById('certificateOrganizerName')?.value.trim()||'',issuerName:document.getElementById('certificateIssuerName')?.value.trim()||'大会実行委員長',sealMode:document.getElementById('certificateSealMode')?.value||'text',sealText:document.getElementById('certificateSealText')?.value.trim()||'大豊学園'});toast('証書設定を保存しました');});
document.getElementById('certificateSealUpload')?.addEventListener('change',e=>{const f=e.target.files?.[0];if(f)uploadCertificateAsset('seal',f);e.target.value='';});
document.getElementById('clearCertificateSealBtn')?.addEventListener('click',()=>{certificateResolvedUrls.seal='';saveCertificateConfig({sealImagePath:'',sealMode:'text'});toast('印画像を解除し、文字印へ戻しました');});
document.querySelectorAll('[data-download-cert-template]').forEach(b=>b.addEventListener('click',()=>downloadCertificateTemplate(b.dataset.downloadCertTemplate)));
document.querySelectorAll('[data-upload-cert-template]').forEach(inp=>inp.addEventListener('change',e=>{const f=e.target.files?.[0];if(f)uploadCertificateAsset(inp.dataset.uploadCertTemplate,f);e.target.value='';}));
document.querySelectorAll('[data-reset-cert-template]').forEach(b=>b.addEventListener('click',()=>{certificateResolvedUrls[b.dataset.resetCertTemplate]='';saveCertificateConfig({templates:{[b.dataset.resetCertTemplate]:''}});toast('標準テンプレートへ戻しました');}));
document.querySelectorAll('[data-preview-cert]').forEach(b=>b.addEventListener('click',()=>previewCertificate(b.dataset.previewCert)));
document.getElementById('printAwardCertificatesBtn')?.addEventListener('click',printAwardCertificates);
document.getElementById('printRecordCertificatesBtn')?.addEventListener('click',printRecordCertificates);

// ---------- Demo / reset / export ----------
const demoNames=['大豊A','大杉A','豊永A','清流A','北山A','南風A','桜丘A','みどりA','希望A','つばさA','大豊B','大杉B'];
function demoTeams(){const obj={};demoNames.forEach((name,i)=>{const no=String(i+1);obj[teamKey(no)]={teamNo:no,teamName:name,accessCode:String(1001+i),runners:Array.from({length:getLegCount()},(_,j)=>({name:`選手${j+1}`,sex:j%2?'女':'男',ageGroup:j%4===0?'小学生':j%4===1?'中学生':j%4===2?'一般（～29歳）':'一般（30歳～）',leg:j+1}))};});return obj;}
document.getElementById('loadDemoBtn').addEventListener('click',async()=>{if(!confirm('デモ12チームを読み込み、現在の計測データを初期化しますか？'))return;const teams=demoTeams();if(supabaseMode){for(const t of Object.values(teams)){if(!(await setTeamSecret(t.teamNo,t.accessCode)))return;}}queueWrite('teams',teams);clearRaceMeasurements();toast('デモ12チームを読み込みました');});
document.getElementById('resetBtn').addEventListener('click',async()=>{
  if(!confirm('現在大会の申込・チーム・計測記録・設定を初期化します。過去大会アーカイブと管理者・計測係コードは残ります。よろしいですか？'))return;
  if(supabaseMode&&!supabaseConnected){toast('SupabaseがONLINEのときに初期化してください');return;}if(pendingQueue.length){toast('未送信データの同期完了後に初期化してください');return;}
  if(supabaseMode&&supabaseReady){const {error}=await sb.rpc('ekiden_prepare_new_event');if(error){console.error('ekiden_prepare_new_event failed',error);const msg=String(error.message||error.details||'').slice(0,120);toast(`端末セッションの整理に失敗しました${msg?`：${msg}`:''}`);return;}}privateTeamCodes={};
  if(!(await purgeCurrentEventRows())){toast('現在大会データの整理に失敗しました');return;}
  const f=freshState(),keep={eventId:currentEventId(),eventYear:currentEventYear(),eventCreatedAt:state.meta?.eventCreatedAt||syncedNow()};
  queueWrite('meta',{...f.meta,...keep,version:14});queueWrite('settings',f.settings);queueWrite('applications',{});queueWrite('teams',{});queueWrite('officialMeasurements',{});queueWrite('teamMeasurements',{});queueWrite('adoptions',{});queueWrite('overrides',{});queueWrite('locks',f.locks);queueWrite('notices',{});queueWrite('awards',f.awards);toast('現在大会を初期化しました');
});
document.getElementById('exportResultsBtn').addEventListener('click',()=>{
  const out=[['team_no','team_name','leg','distance_km','runner_name','sex','age_group','lap_time','total_time','source']];computedPasses().sort((a,b)=>naturalCompare(a.teamNo,b.teamNo)||a.leg-b.leg).forEach(p=>{const r=runnerFor(p.teamNo,p.leg)||{};out.push([p.teamNo,p.teamName,p.leg,getLegDistance(p.leg)??'',r.name||'',r.sex||'',normalizeAgeGroup(r.ageGroup,r.age),fmtClock(lapTime(p)),fmtClock(p.officialAt-state.meta.startAt),p.source]);});downloadText('\uFEFF'+out.map(r=>r.map(csvEscape).join(',')).join('\r\n'),'ekiden_results_v14.csv','text/csv;charset=utf-8');
});
function csvEscape(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
function downloadText(text,name,type){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}

// ---------- Clocks / cross-tab ----------
function renderElapsed(){
  const end=state.meta.raceStatus==='finished'&&state.meta.finishAt?state.meta.finishAt:syncedNow();const v=state.meta.startAt?fmtClock(Math.max(0,end-state.meta.startAt)):'00:00:00.00';const a=document.getElementById('elapsedClock'),b=document.getElementById('teamElapsedClock');if(a)a.textContent=v;if(b)b.textContent=v;
}
setInterval(()=>{renderElapsed();if(currentScreen==='participant')renderParticipant();},250);
window.addEventListener('storage',e=>{if(supabaseMode)return;if(e.key===STORAGE_KEY){state=loadLocalState();renderCurrent();}});
window.addEventListener('beforeunload',()=>{});

renderElapsed();renderSyncStatus();initSupabase();
const initialScreen=new URLSearchParams(location.search).get('screen');if(initialScreen==='entry')go('entry');else renderTopStatus();
