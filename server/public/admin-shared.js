const $=id=>document.getElementById(id);
let KEY=localStorage.getItem('mx_admin_key')||'';
$('key').value=KEY;
// Declared up here (not down near api(), where it's used) specifically
// because it's also read immediately below, at the top of the script -
// a const referenced before its own declaration line has run throws
// "Cannot access before initialization", the same class of bug that
// once left the Production Schedule grid silently empty until something
// happened to re-trigger it later.
const LS_ACTOR_NAME='mx_actor_name';
function getActorName(){return localStorage.getItem(LS_ACTOR_NAME)||'';}
if($('actorName')){
  $('actorName').value=getActorName();
  $('actorName').addEventListener('change',e=>localStorage.setItem(LS_ACTOR_NAME,e.target.value.trim()));
}

function saveKey(){KEY=$('key').value.trim();localStorage.setItem('mx_admin_key',KEY);load();loadReports();loadTunnelUrl();loadScheduleList();loadDeviceActivity();loadExceptions();loadMaterialStock();loadPackingSlips();}

// ── TABS ─────────────────────────────────────────────────────
// Production Schedule is the landing view now, open to whoever has the
// page URL; Operations (device approvals, part lookup, reporting) sits
// behind the same casual-deterrent password already used for the phone
// app's Production Schedule tab (BATCH_PASSWORD in index.html) - not
// real security, matches this project's existing pattern, and doesn't
// replace the real admin key Operations' own data calls still require.
const OPS_PASSWORD='3090MWS';
let opsUnlocked=false;
function goToOperations(){
  if(!opsUnlocked){
    const pw=prompt('Enter the Operations password:');
    if(pw===null)return;
    if(pw!==OPS_PASSWORD){alert('Incorrect password.');return;}
    opsUnlocked=true;
  }
  showTab('ops');
}
let currentTab='schedule';
const TAB_CONTAINERS={
  ops:'tabOperations',schedule:'tabSchedule',labels:'tabLabels',
  weekly:'tabWeekly',weeklyDetail:'tabWeeklyDetail',
  material:'tabMaterial',stalled:'tabStalled',risk:'tabRisk',yieldTab:'tabYield',
  jobs:'tabJobSummary',jobDetail:'tabJobDetail',
  packing:'tabPacking',packingForm:'tabPackingForm',packingPrint:'tabPackingPrint'
};
// Which tab-bar button lights up "active" for a given tab name - several
// names share one button (weekly + weeklyDetail both light up the one
// Weekly Schedule button; 'labels' has no button of its own since it's
// only ever reached by clicking a batch, not directly).
const TAB_BUTTON_FOR={
  ops:'tabBtnOps',schedule:'tabBtnSchedule',
  weekly:'tabBtnWeekly',weeklyDetail:'tabBtnWeekly',
  material:'tabBtnMaterial',stalled:'tabBtnStalled',risk:'tabBtnRisk',yieldTab:'tabBtnYield',
  jobs:'tabBtnJobs',jobDetail:'tabBtnJobs',
  packing:'tabBtnPacking',packingForm:'tabBtnPacking',packingPrint:'tabBtnPacking'
};
function showTab(name){
  currentTab=name;
  // Table-driven and defensive on purpose: this same file is shared by
  // admin.html (every tab) and gm.html (a trimmed subset - no Material
  // Demand/Stalled Batches/At Risk/Throughput & Yield/Operations). A
  // page missing some of these containers/buttons must never crash
  // showTab() just because it doesn't have every tab admin.html does -
  // each lookup is guarded instead of assumed to exist.
  Object.entries(TAB_CONTAINERS).forEach(([tab,id])=>{
    const el=$(id);
    if(el)el.style.display=(tab===name)?'':'none';
  });
  const activeBtnId=TAB_BUTTON_FOR[name];
  new Set(Object.values(TAB_BUTTON_FOR)).forEach(btnId=>{
    const el=$(btnId);
    if(el)el.classList.toggle('active',btnId===activeBtnId);
  });
  if(name==='schedule')loadScheduleList();
  if(name==='weekly')renderWeeklySchedule();
  if(name==='material')renderMaterialDemand();
  if(name==='stalled')renderStalledBatches();
  if(name==='risk')renderAtRisk();
  if(name==='yieldTab')renderThroughputYield();
  if(name==='jobs')renderJobSummary();
  if(name==='packing')renderPackingTab();
  if(name==='ops')showOpsSubTab(currentOpsSubTab);
}
// ── OPERATIONS SUB-TABS ─────────────────────────────────────
// Activity Log, Boards & Admin Key, and Phone Setup live inside
// Operations now instead of as their own top-level tabs - reaching any
// of them means you're already past the Operations password gate, so
// none of them need (or have) a gate of their own anymore. Same
// table-driven/guarded pattern as showTab() above, scoped to Operations'
// own sub-containers instead of the whole page's tabs.
let currentOpsSubTab='devices';
const OPS_SUBTAB_CONTAINERS={devices:'opsDeviceApprovals',activity:'opsActivity',boards:'opsBoards',phoneSetup:'opsPhoneSetup'};
const OPS_SUBTAB_BUTTONS={devices:'opsSubBtnDevices',activity:'opsSubBtnActivity',boards:'opsSubBtnBoards',phoneSetup:'opsSubBtnPhoneSetup'};
function showOpsSubTab(name){
  currentOpsSubTab=name;
  Object.entries(OPS_SUBTAB_CONTAINERS).forEach(([tab,id])=>{
    const el=$(id);
    if(el)el.style.display=(tab===name)?'':'none';
  });
  Object.values(OPS_SUBTAB_BUTTONS).forEach(btnId=>{
    const el=$(btnId);
    if(el)el.classList.toggle('active',btnId===OPS_SUBTAB_BUTTONS[name]);
  });
  if(name==='activity')renderActivityLog();
  if(name==='boards')renderBoardsTab();
}
// Not present on gm.html at all (Operations itself isn't reachable
// there), so this is guarded like the other gm.html-excluded render
// functions - cheap insurance against a future call site added wrong.
function renderBoardsTab(){
  const el=$('boardsAdminKey');
  if(!el)return;
  el.textContent=KEY||'— connect above first —';
}
function copyAdminKeyFromBoards(){
  if(!KEY)return;
  navigator.clipboard.writeText(KEY).catch(()=>{});
}

async function api(path,opts){
  const r=await fetch(path,Object.assign({headers:{'X-Admin-Key':KEY,'X-Actor-Name':getActorName(),'Content-Type':'application/json'}},opts||{}));
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.json();
}

async function load(){
  if(!KEY){$('list').innerHTML='<div class="empty">Enter the admin key to see devices.</div>';return;}
  try{
    const devices=await api('/admin/api/devices');
    if(!devices.length){$('list').innerHTML='<div class="empty">No devices have registered yet.</div>';return;}
    devicesCache=devices;
    $('list').innerHTML=devices.map(d=>`
      <div class="card" data-deviceid="${esc(d.device_id)}" oncontextmenu="openDeviceCtxMenu(event,'${esc(d.device_id)}')">
        <div>
          <div class="name">${esc(d.device_name||'(unnamed)')}</div>
          <div class="meta">${esc(d.device_id)} · first seen ${fmt(d.first_seen)} · last seen ${fmt(d.last_seen)}</div>
        </div>
        <span class="pill ${d.status}">${d.status}</span>
        <div class="acts">
          ${d.status!=='APPROVED'?`<button class="ok" onclick="act('${esc(d.device_id)}','approve')">Approve</button>`:''}
          ${d.status!=='REVOKED'?`<button class="danger" onclick="act('${esc(d.device_id)}','revoke')">Revoke</button>`:''}
        </div>
      </div>`).join('');
  }catch(e){$('list').innerHTML='<div class="empty">Wrong key, or server unreachable.</div>';}
}
let devicesCache=[];
async function act(id,action){await api(`/admin/api/devices/${encodeURIComponent(id)}/${action}`,{method:'POST'});load();}
// Right-click a device for Delete - same shared #rowCtxMenu the schedule
// grid and packing slips already use, just populated with one item since
// there's nothing to edit on a device row.
function openDeviceCtxMenu(evt,id){
  evt.preventDefault();
  evt.stopPropagation();
  const menu=$('rowCtxMenu');
  menu.innerHTML=`<div class="ctx-menu-item danger" onclick="closeRowContextMenu();deleteDevice('${id}')">${ICON_DELETE} Delete</div>`;
  menu.style.top=evt.clientY+'px';
  menu.style.left=Math.min(evt.clientX,window.innerWidth-170)+'px';
  menu.style.display='block';
}
async function deleteDevice(id){
  const d=devicesCache.find(x=>x.device_id===id);
  if(!confirm('Delete '+(d?(d.device_name||d.device_id):id)+' from the device list? This cannot be undone - if it scans again later it will show up as a brand-new Pending device.'))return;
  try{
    await api('/admin/api/devices/'+encodeURIComponent(id),{method:'DELETE'});
    await load();
  }catch(e){alert('Could not delete: '+e.message);}
}
function esc(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function fmt(iso){return iso?new Date(iso).toLocaleString():'—';}

// ── DEVICE ACTIVITY ──────────────────────────────────────────
const IDLE_THRESHOLD_MIN=15;
async function loadDeviceActivity(){
  if(!KEY){$('deviceActivityList').innerHTML='<div class="empty">Enter the admin key to see device activity.</div>';return;}
  try{
    const data=await api('/admin/api/device-activity');
    renderDeviceActivity(data.devices||[]);
  }catch(e){$('deviceActivityList').innerHTML='<div class="empty">Wrong key, or server unreachable.</div>';}
}
function renderDeviceActivity(devices){
  if(!devices.length){$('deviceActivityList').innerHTML='<div class="empty">No approved devices yet.</div>';return;}
  const now=Date.now();
  $('deviceActivityList').innerHTML=devices.map(d=>{
    const lastMs=d.last_scan_at?new Date(d.last_scan_at).getTime():null;
    const idleMin=lastMs?Math.round((now-lastMs)/60000):null;
    const isIdle=idleMin===null||idleMin>=IDLE_THRESHOLD_MIN;
    return`<div class="card">
      <div>
        <div class="name">${esc(d.device_name||'(unnamed)')}</div>
        <div class="meta">${esc(d.device_id)} · last scan ${d.last_scan_at?fmt(d.last_scan_at):'never'}</div>
      </div>
      <span class="pill ${isIdle?'IDLE':'ACTIVE'}">${idleMin===null?'No scans yet':idleMin+' min idle'}</span>
    </div>`;
  }).join('');
}

// ── EXCEPTION QUEUE ───────────────────────────────────────────
let exceptionCache=[];
async function loadExceptions(){
  if(!KEY){$('exceptionList').innerHTML='<div class="empty">Enter the admin key to see exceptions.</div>';return;}
  try{
    const data=await api('/admin/api/exceptions');
    exceptionCache=data.exceptions||[];
    renderExceptions();
  }catch(e){$('exceptionList').innerHTML='<div class="empty">Wrong key, or server unreachable.</div>';}
}
function renderExceptions(){
  const hideAck=$('excHideAck').checked;
  const rows=hideAck?exceptionCache.filter(r=>r.acknowledged!=='Yes'):exceptionCache;
  if(!rows.length){$('exceptionList').innerHTML='<div class="empty">No exceptions'+(hideAck?' to review':'')+'.</div>';return;}
  $('exceptionList').innerHTML=rows.map(r=>`
    <div class="card">
      <div>
        <div class="name">${esc(r.part_name||r.unique_id||'(unknown)')} <span style="color:var(--gray-500);font-weight:600">${esc(r.match_status||'')}</span></div>
        <div class="meta">${esc(r.device||r.device_id||'')} · ${r.mode==='DIRECTED'?'Directed':'Free'} scan (${esc(r.method||'?')})${r.batch?' · batch '+esc(r.batch):''} · ${fmt(r.scanned_at)}</div>
      </div>
      ${r.acknowledged==='Yes'
        ?'<span class="pill APPROVED">Acknowledged</span>'
        :`<button class="secondary" onclick="ackException('${esc(r.scan_id)}')">Acknowledge</button>`}
    </div>`).join('');
}
async function ackException(scanId){
  await api('/admin/api/exceptions/'+encodeURIComponent(scanId)+'/ack',{method:'POST'});
  loadExceptions();
}

// ── TUNNEL URL — reads the same file watchdog.ps1 keeps current, so this
// is always accurate even though the URL itself changes on its own.
let lastTunnelUrl=null;
async function loadTunnelUrl(){
  if(!KEY){$('tunnelCard').style.display='none';return;}
  try{
    const data=await api('/admin/api/tunnel-url');
    lastTunnelUrl=data.url;
    $('tunnelCard').style.display='flex';
    $('tunnelUrl').textContent=data.url||'(tunnel not running / URL not detected yet)';
  }catch(e){/* leave last-known value showing rather than blank it on a transient error */}
}
function copyTunnelUrl(){
  if(!lastTunnelUrl)return;
  navigator.clipboard.writeText(lastTunnelUrl).catch(()=>{});
}

if(window.Notification&&Notification.permission==='granted')$('bEnableAlerts').textContent='🔔 Alerts Enabled';
load();
loadTunnelUrl();
loadDeviceActivity();
loadExceptions();
loadMaterialStock();
loadPackingSlips();
setInterval(load,4000);
setInterval(loadTunnelUrl,10000);
// Keeps the Production Schedule grid live for a supervisor watching it on
// a second device while operators scan, without a manual refresh - same
// cadence as the Operations device list above. Guarded inside
// loadScheduleList() so it never clobbers an in-progress row edit.
setInterval(loadScheduleList,4000);
// Lower-urgency monitoring views - a slower poll is plenty and keeps
// these from competing with the device-approval/schedule refreshes above.
setInterval(loadDeviceActivity,10000);
setInterval(loadExceptions,10000);

// ── PART LOOKUP + NOTES ─────────────────────────────────────
const NOTE_CATEGORIES=[
  ['DAMAGE','Damage'],['DEFECT','Defect'],['SCRATCH','Scratch'],['BENT','Bent / Warped'],
  ['INCORRECT','Incorrect Spec'],['DENT','Dent'],['COLOUR_MISMATCH','Colour Mismatch'],
  ['MISSING_COMPONENT','Missing Component'],['OTHER','Other (describe below)']
];
const catLabel=Object.fromEntries(NOTE_CATEGORIES);
let currentPartId=null;

async function lookupPart(){
  const id=$('partId').value.trim().toUpperCase();
  if(!id){$('partResult').innerHTML='';return;}
  if(!KEY){$('partResult').innerHTML='<div class="empty">Enter the admin key first.</div>';return;}
  currentPartId=id;
  $('partResult').innerHTML='<div class="empty">Looking up…</div>';
  try{
    const data=await api(`/admin/api/parts/${encodeURIComponent(id)}`);
    if(!data.found){$('partResult').innerHTML='<div class="empty">No part registered with that ID.</div>';return;}
    renderPart(data);
  }catch(e){$('partResult').innerHTML='<div class="empty">Lookup failed — wrong key, or server unreachable.</div>';}
}
$('partId').addEventListener('keydown',e=>{if(e.key==='Enter')lookupPart();});

function renderPart(data){
  const idx=data.index,d=data.detail||{};
  const statusPill=idx.void==='Yes'?'<span class="pill REVOKED">VOID</span>':idx.scanned==='Yes'?'<span class="pill APPROVED">SCANNED</span>':'<span class="pill PENDING">NOT SCANNED</span>';
  const fields=[['Department',idx.department],['Batch',d.batch],['Sheet Name',d.sheet_name],['Project',d.project],
    ['Floor',d.floor],['Tag',d.tag],['Type',d.part_type],['Size',[d.width,d.height].filter(Boolean).join(' X ')],
    ['Qty',d.qty],['Colour',d.colour],['Scanned At',fmt(idx.scanned_at)],['Scanned By',idx.scanned_by_device]]
    .filter(([,v])=>v).map(([k,v])=>`<div class="field-row"><span class="field-k">${esc(k)}</span><span class="field-v">${esc(v)}</span></div>`).join('');

  $('partResult').innerHTML=`
    <div class="card" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="name">${esc(idx.unique_id)}</div>${statusPill}
      </div>
      ${fields}
    </div>
    <h2 style="margin-top:16px">Notes</h2>
    <div id="notesArea"></div>
    <div class="keybar" style="margin-top:10px">
      <select id="noteCat">${NOTE_CATEGORIES.map(([v,l])=>`<option value="${v}">${esc(l)}</option>`).join('')}</select>
      <input id="noteTxt" placeholder="Details (required for Other)">
      <button onclick="addPartNote()">Add Note</button>
      ${idx.void==='Yes'?'':'<button class="danger-solid" onclick="voidCurrentPart()">Void This Part</button>'}
    </div>`;
  renderNotes(data.notes);
}
function renderNotes(notes){
  $('notesArea').innerHTML=!notes.length?'<div class="empty">No notes yet.</div>':notes.map(n=>`
    <div class="note-card">
      <div class="note-cat">${esc(catLabel[n.category]||n.category)}</div>
      ${n.note?`<div class="note-text">${esc(n.note)}</div>`:''}
      <div class="note-meta">${esc(n.device||'admin')} · ${fmt(n.created_at)}</div>
    </div>`).join('');
}
async function addPartNote(){
  const category=$('noteCat').value,note=$('noteTxt').value.trim();
  if(category==='OTHER'&&!note){alert('Details are required for "Other".');return;}
  try{
    const data=await api('/admin/api/parts/notes',{method:'POST',body:JSON.stringify({unique_id:currentPartId,category,note,device:'ADMIN'})});
    $('noteTxt').value='';
    renderNotes(data.notes);
  }catch(e){alert('Could not add note — check the admin key and try again.');}
}
async function voidCurrentPart(){
  const category=$('noteCat').value,note=$('noteTxt').value.trim();
  if(category==='OTHER'&&!note){alert('Details are required for "Other".');return;}
  if(!confirm('Void '+currentPartId+'? This flags it on every future scan and cannot be undone from this screen.'))return;
  try{
    const data=await api('/admin/api/parts/void',{method:'POST',body:JSON.stringify({unique_id:currentPartId,category,note,device:'ADMIN'})});
    $('noteTxt').value='';
    lookupPart();
  }catch(e){alert('Could not void part — check the admin key and try again.');}
}

// ── REPORTING ────────────────────────────────────────────────
let repData={registry:[],matchStatus:[],daily:[],notes:[]};
let repDailyStatuses=[];

function loadReports(){
  if(!KEY)return;
  loadReportSummary();
  loadReportDaily();
}
function fmtNum(n){return(n||0).toLocaleString();}
function tbl(headers,rows){
  if(!rows.length)return'<div class="empty">No data yet.</div>';
  return`<table class="rep-tbl"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map((c,i)=>i===0?`<td>${esc(c)}</td>`:`<td class="num">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

async function loadReportSummary(){
  if(!KEY){$('repRegistry').innerHTML='<div class="empty">Enter the admin key to load.</div>';return;}
  try{
    const data=await api('/admin/api/report/summary');
    repData.registry=data.registry;repData.matchStatus=data.match_status;
    $('repRegistry').innerHTML=tbl(['Department','Total','Scanned','Never Scanned','Voided'],
      data.registry.map(r=>[r.department,fmtNum(r.total),fmtNum(r.scanned),fmtNum(r.never_scanned),fmtNum(r.voided)]));
    $('repMatchStatus').innerHTML=tbl(['Outcome','Count'],
      data.match_status.map(r=>[r.match_status,fmtNum(r.c)]));
    loadReportNotes();
  }catch(e){$('repRegistry').innerHTML='<div class="empty">Could not load — wrong key, or server unreachable.</div>';}
}
async function loadReportDaily(){
  if(!KEY)return;
  const from=$('repFrom').value,to=$('repTo').value;
  const qs=(from?`from=${from}&`:'')+(to?`to=${to}`:'');
  try{
    const data=await api('/admin/api/report/daily'+(qs?`?${qs}`:''));
    $('repFrom').value=data.from;$('repTo').value=data.to;
    const statuses=[...new Set(data.rows.map(r=>r.match_status))];
    repDailyStatuses=statuses;
    const byDate={};
    data.rows.forEach(r=>{(byDate[r.date]=byDate[r.date]||{})[r.match_status]=r.c;});
    const dates=Object.keys(byDate).sort();
    repData.daily=dates.map(d=>{
      const total=statuses.reduce((s,st)=>s+(byDate[d][st]||0),0);
      return[d,...statuses.map(st=>byDate[d][st]||0),total];
    });
    $('repDaily').innerHTML=tbl(['Date',...statuses,'Total'],
      repData.daily.map(r=>[r[0],...r.slice(1).map(fmtNum)]));
  }catch(e){$('repDaily').innerHTML='<div class="empty">Could not load — wrong key, or server unreachable.</div>';}
}
async function loadReportNotes(){
  if(!KEY)return;
  try{
    const data=await api('/admin/api/report/notes');
    repData.notes=data.rows;
    $('repNotes').innerHTML=tbl(['Category','Action','Count'],
      data.rows.map(r=>[catLabel[r.category]||r.category,r.action,fmtNum(r.c)]));
  }catch(e){$('repNotes').innerHTML='<div class="empty">Could not load — wrong key, or server unreachable.</div>';}
}

function csvEscape(v){const s=String(v==null?'':v);return/[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function csvDownload(which){
  let headers,rows,filename;
  if(which==='registry'){headers=['Department','Total','Scanned','Never Scanned','Voided'];rows=repData.registry.map(r=>[r.department,r.total,r.scanned,r.never_scanned,r.voided]);filename='registry_status.csv';}
  else if(which==='matchStatus'){headers=['Outcome','Count'];rows=repData.matchStatus.map(r=>[r.match_status,r.c]);filename='scans_by_outcome.csv';}
  else if(which==='daily'){headers=['Date',...repDailyStatuses,'Total'];rows=repData.daily;filename='daily_activity.csv';}
  else if(which==='notes'){headers=['Category','Action','Count'];rows=repData.notes.map(r=>[catLabel[r.category]||r.category,r.action,r.c]);filename='notes_by_category.csv';}
  if(!rows||!rows.length){alert('Nothing loaded to export yet.');return;}
  const headerLine=headers?headers.map(csvEscape).join(','):'';
  const csv=(headerLine?headerLine+'\r\n':'')+rows.map(r=>r.map(csvEscape).join(',')).join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=filename;a.click();
  URL.revokeObjectURL(a.href);
}

(function initDates(){
  const to=new Date(),from=new Date(Date.now()-29*86400000);
  $('repTo').value=to.toISOString().slice(0,10);
  $('repFrom').value=from.toISOString().slice(0,10);
})();
loadReports();

// ── PRODUCTION SCHEDULE ─────────────────────────────────────
// Reuses the same /viewer/api/batches* endpoints the phone app polls
// (requireViewer also accepts X-Admin-Key, so the api() helper above works
// unchanged) for reading; POST /admin/api/schedule/:batch (admin-only) for
// writing. One form serves both "add info for an existing batch" and
// "correct what Excel sent" — it's an upsert either way.
const SCHEDULE_FIELDS=[
  ['job_name','Job Name'],['floor_or_work_order','Floor / Work Order'],['target_finish','Target Finish'],
  ['material','Material'],['finish','Finish'],['part_name','Part Name'],['sheet_qty','Sheet Qty'],
  ['comment','Comment'],['tasked','Tasked']
];
let scheduleBatches=[];

const GRID_COLUMNS=[
  ['job_name','Job'],['floor_or_work_order','Floor or Work Order'],['target_finish','Target Finish'],
  ['material','Material'],['finish','Finish'],['part_name','Part Name'],['batch','Batch Name'],
  ['status','Part Qty'],['sheet_qty','Sheet Qty'],['comment','Comment'],['tasked','Tasked']
];
function renderScheduleHead(){
  $('scheduleHeadRow').innerHTML=GRID_COLUMNS.map(([key,label])=>
    `<th>${esc(label)}<button class="colf-btn" id="colfbtn_${key}" onclick="openColFilter(event,'${key}','${esc(label)}')">&#9660;</button></th>`
  ).join('');
}
async function loadScheduleList(){
  if(!$('scheduleHeadRow').children.length)renderScheduleHead();
  if(!KEY){$('scheduleTbody').innerHTML='<tr><td colspan="11" class="empty">Enter the admin key to load.</td></tr>';return;}
  // Skip while a row is mid-edit - a background refresh replaces the grid's
  // innerHTML wholesale, which would silently wipe out whatever's typed
  // into that row's inputs before it's saved. Resumes on its own within
  // one poll interval of Save/Cancel, no explicit resume needed.
  if(editingBatches.size)return;
  try{
    const data=await api('/viewer/api/batches');
    scheduleBatches=data.batches||[];
    // Only the currently-visible tab actually needs to re-render on this
    // poll - the other six were rebuilding their full DOM every 4s
    // whether anyone was looking at them or not. checkCompletionAlerts()
    // is the one exception: it has to run every tick regardless of tab,
    // since the whole point is noticing a completion even when you're
    // looking at something else.
    if(currentTab==='schedule')renderScheduleGrid();
    if(currentTab==='weekly'||currentTab==='weeklyDetail')renderWeeklySchedule();
    if(currentTab==='material')renderMaterialDemand();
    if(currentTab==='stalled')renderStalledBatches();
    if(currentTab==='risk')renderAtRisk();
    if(currentTab==='yieldTab')renderThroughputYield();
    if(currentTab==='jobs'||currentTab==='jobDetail')renderJobSummary();
    if(currentTab==='packing')renderPackingTab();
    checkCompletionAlerts();
  }catch(e){$('scheduleTbody').innerHTML='<tr><td colspan="11" class="empty">Could not load — wrong key, or server unreachable.</td></tr>';}
}

// ── WEEKLY SCHEDULE — a read-only lens on the same scheduleBatches array
// the main grid already polls every 4s (no separate fetch, no new backend
// endpoint). Groups by the Monday-start calendar week each batch's Target
// Finish date falls in; batches with no parseable date land in a single
// "No Target Finish Date" bucket instead of being dropped. Editing still
// only happens from Production Schedule itself - this is purely a
// different way to look at the same data.
let currentWeekKey=null;
function weekKeyFor(dateStr){
  const iso=toISODate(dateStr);
  if(!iso)return null;
  const d=new Date(iso+'T00:00:00');
  const day=d.getDay(); // 0=Sun..6=Sat
  d.setDate(d.getDate()+(day===0?-6:1-day)); // back up to that week's Monday
  return d.toISOString().slice(0,10);
}
function weekLabel(mondayKey){
  const start=new Date(mondayKey+'T00:00:00');
  const end=new Date(start);end.setDate(start.getDate()+6);
  const f=d=>d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
  return`${f(start)} – ${f(end)}, ${start.getFullYear()}`;
}
function groupByWeek(){
  const groups={};
  scheduleBatches.forEach(b=>{
    const key=weekKeyFor(b.target_finish)||'unscheduled';
    (groups[key]=groups[key]||[]).push(b);
  });
  return groups;
}
function statusPillClass(v){return v==='complete'?'done':v==='progress'?'working':'notstarted';}
// Shared by any batch-card list that mixes every status together (Weekly
// Detail, Job Detail) - groups into Not Started / In Progress / Complete
// sections instead of one flat list where a finished batch sits next to
// one that hasn't started, sorts each group by Target Finish (soonest
// first, batches with no date last), and skips empty groups entirely.
// cardFn renders one batch's card markup - callers differ in what they
// put in the meta line, so that part stays with the caller.
function groupedBatchCardsHtml(items,cardFn){
  const groups={none:[],progress:[],complete:[]};
  items.forEach(b=>groups[rowStatus(b)].push(b));
  const byDue=(a,b)=>(a.target_finish||'9999-99-99').localeCompare(b.target_finish||'9999-99-99');
  Object.values(groups).forEach(g=>g.sort(byDue));
  return[['none','Not Started'],['progress','In Progress'],['complete','Complete']]
    .filter(([key])=>groups[key].length)
    .map(([key,label])=>`<div class="batch-group">
      <div class="batch-group-head">${label} <span class="batch-group-count">${groups[key].length}</span></div>
      ${groups[key].map(cardFn).join('')}
    </div>`).join('');
}
function renderWeeklySchedule(){
  const groups=groupByWeek();
  const thisWeek=weekKeyFor(new Date().toISOString().slice(0,10));
  // Always give the current week a card, even with nothing due in it -
  // otherwise "This Week" (the green landmark everything else is judged
  // against) silently disappears the moment no batch happens to have a
  // Target Finish date inside it, which is exactly what was happening.
  if(!groups[thisWeek])groups[thisWeek]=[];
  const weekKeys=Object.keys(groups).filter(k=>k!=='unscheduled').sort();
  const unscheduled=groups.unscheduled||[];
  if(!weekKeys.length&&!unscheduled.length){$('weeklyList').innerHTML='<div class="empty">No batches in Production Schedule yet.</div>';}
  else{
    // Current week always reads green regardless of progress (it's not
    // "overdue" yet, it's just where we are). A past week only reads red
    // once it's actually overdue - if everything in it got done on time
    // there's nothing left to flag.
    let html='<div class="week-grid">'+weekKeys.map(k=>{
      const items=groups[k];
      const done=items.filter(b=>rowStatus(b)==='complete').length;
      const isCurrent=k===thisWeek;
      const isOverdue=!isCurrent&&k<thisWeek&&done<items.length;
      const cls=isCurrent?' current':isOverdue?' overdue':'';
      const badge=isCurrent?'<div class="week-card-badge current">This Week</div>':isOverdue?'<div class="week-card-badge overdue">Overdue</div>':'';
      return`<div class="week-card${cls}" onclick="openWeekDetail('${k}')">
        ${badge}
        <div class="week-card-range">${weekLabel(k)}</div>
        <div class="week-card-count">${items.length} batch${items.length===1?'':'es'}</div>
        <div class="week-card-sub">${items.length?done+' of '+items.length+' complete':'Nothing due this week'}</div>
      </div>`;
    }).join('');
    if(unscheduled.length){
      html+=`<div class="week-card unscheduled" onclick="openWeekDetail('unscheduled')">
        <div class="week-card-range">No Target Finish Date</div>
        <div class="week-card-count">${unscheduled.length} batch${unscheduled.length===1?'':'es'}</div>
      </div>`;
    }
    $('weeklyList').innerHTML=html+'</div>';
  }
  if(currentWeekKey)renderWeekDetail(currentWeekKey); // keep an already-open week's detail live too
}
function openWeekDetail(key){
  currentWeekKey=key;
  showTab('weeklyDetail');
  renderWeekDetail(key);
}
// Same material+finish grouping shape as groupByMaterial() (Material
// Demand tab), scoped to one week's items instead of every open batch -
// reuses parseQty so a non-numeric Sheet Qty is called out, not dropped
// or crashed on.
function renderWeekMaterialSummary(items){
  const el=$('weeklyMaterialSummaryBody');
  if(!el)return; // this table doesn't exist on every page
  const open=items.filter(b=>rowStatus(b)!=='complete');
  const groups={};
  open.forEach(b=>{
    const key=(b.material||'(No Material Specified)')+'|'+(b.finish||'(No Finish Specified)');
    const g=groups[key]=groups[key]||{material:b.material||'(No Material Specified)',finish:b.finish||'(No Finish Specified)',total:0,unparsed:0};
    const q=parseQty(b.sheet_qty);
    q===null?g.unparsed++:g.total+=q;
  });
  const rows=Object.values(groups).sort((a,b)=>a.material.localeCompare(b.material)||a.finish.localeCompare(b.finish));
  if(!rows.length){el.innerHTML='<tr><td colspan="3" class="empty">No open batches with a Sheet Qty due this week.</td></tr>';return;}
  el.innerHTML=rows.map(r=>`<tr>
    <td>${esc(r.material)}</td>
    <td>${esc(r.finish)}</td>
    <td class="num">${r.total}${r.unparsed?` <span style="color:var(--gray-500);font-weight:400">(+${r.unparsed} non-numeric)</span>`:''}</td>
  </tr>`).join('');
}
function renderWeekDetail(key){
  const items=(groupByWeek()[key])||[];
  $('weeklyDetailTitle').textContent=key==='unscheduled'?'No Target Finish Date':weekLabel(key);
  $('weeklyDetailSub').textContent=items.length+' batch'+(items.length===1?'':'es');
  renderWeekMaterialSummary(items);
  if(!items.length){$('weeklyDetailList').innerHTML='<div class="empty">No batches.</div>';return;}
  $('weeklyDetailList').innerHTML=groupedBatchCardsHtml(items,b=>{
    const status=rowStatus(b);
    const sub=[b.job_name,b.material,b.finish,b.tasked].filter(Boolean).map(esc).join(' · ');
    const meta=[sub,`${b.scanned}/${b.total} scanned`,b.target_finish?'Due '+esc(b.target_finish):''].filter(Boolean).join(' · ');
    return`<div class="card" onclick="viewBatchLabels('${esc(b.batch)}')" style="cursor:pointer">
      <div>
        <div class="name">${esc(b.batch)}</div>
        <div class="meta">${meta}</div>
      </div>
      <span class="pill ${statusPillClass(status)}">${statusLabel(status)}</span>
    </div>`;
  });
}
$('bBackWeeklyDetail').onclick=()=>{currentWeekKey=null;showTab('weekly');};

// ── MATERIAL DEMAND FORECAST — another read-only lens on scheduleBatches,
// same pattern as Weekly Schedule (no separate fetch, no new backend
// endpoint). "Open" means not yet 100% scanned - a completed batch has
// already consumed its material, so it doesn't count toward what's still
// needed. sheet_qty is free-text (typed in Excel or the grid), not always
// a clean number - only parseable values are summed, and how many
// couldn't be parsed is called out rather than silently dropped or
// crashing the total.
function parseQty(v){
  const n=parseFloat(String(v||'').replace(/[^\d.-]/g,''));
  return isNaN(n)?null:n;
}
function groupByMaterial(){
  const groups={};
  scheduleBatches.filter(b=>rowStatus(b)!=='complete').forEach(b=>{
    const key=b.material||'(No Material Specified)';
    (groups[key]=groups[key]||[]).push(b);
  });
  return groups;
}
// ── MATERIAL STOCK (Cross-Job Material Conflict Detection, Phase 4) —
// manual on-hand qty per material, loaded once (not on the 4s poll - it
// only changes when someone edits it, not from scan activity) and cross-
// referenced against Phase 1's own open-batch Sheet Qty totals so a
// shortfall surfaces right where the demand is already shown, rather than
// as a separate disconnected view.
let materialStockCache={};
async function loadMaterialStock(){
  if(!KEY)return;
  try{
    const data=await api('/admin/api/material-stock');
    materialStockCache={};
    (data.stock||[]).forEach(s=>{materialStockCache[s.material]=s.on_hand_qty;});
    renderMaterialDemand();
  }catch(e){/* leave last-known cache showing rather than blank it on a transient error */}
}
async function saveMaterialStock(material,value){
  const qty=parseFloat(value);
  if(isNaN(qty))return;
  materialStockCache[material]=qty; // optimistic - re-render immediately, don't wait on the round-trip
  renderMaterialDemand();
  try{await api('/admin/api/material-stock/'+encodeURIComponent(material),{method:'POST',body:JSON.stringify({on_hand_qty:qty})});}
  catch(e){/* stays in the cache either way - worst case a stale value until the next successful save */}
}
function renderMaterialDemand(){
  if(!$('materialList'))return; // this tab doesn't exist on every page (gm.html) - loadMaterialStock() calls this unconditionally at boot
  const groups=groupByMaterial();
  const materials=Object.keys(groups).sort();
  if(!materials.length){$('materialList').innerHTML='<div class="empty">No open batches — nothing currently demanding material.</div>';return;}
  $('materialList').innerHTML=materials.map(m=>{
    const items=groups[m];
    let total=0,unparsed=0;
    items.forEach(b=>{const q=parseQty(b.sheet_qty);q===null?unparsed++:total+=q;});
    const jobs=[...new Set(items.map(b=>b.job_name).filter(Boolean))].sort();
    const onHand=materialStockCache.hasOwnProperty(m)?materialStockCache[m]:null;
    const shortfall=onHand!==null?total-onHand:null;
    const conflict=shortfall!==null&&shortfall>0;
    return`<div class="card" style="align-items:flex-start;flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="name" style="font-size:16px">${esc(m)}</div>
        <div style="display:flex;gap:8px;align-items:center">
          ${conflict?'<span class="pill notstarted">Short by '+shortfall+'</span>':''}
          <span class="pill working">${items.length} open batch${items.length===1?'':'es'}</span>
        </div>
      </div>
      <div class="meta">Sheet Qty remaining: <strong style="color:var(--gray-900)">${total}</strong>${unparsed?` (+${unparsed} batch${unparsed===1?'':'es'} with a non-numeric Sheet Qty, not counted)`:''}</div>
      <div class="meta">Jobs: ${jobs.length?esc(jobs.join(', ')):'(none specified)'}</div>
      <div class="meta" style="display:flex;align-items:center;gap:6px">On hand:
        <input type="number" value="${onHand!==null?onHand:''}" placeholder="Enter qty" style="width:90px;padding:4px 8px"
          onchange="saveMaterialStock('${esc(m)}',this.value)">
        ${onHand!==null?(conflict?'<span style="color:var(--red-600);font-weight:700">shortfall</span>':'<span style="color:var(--green-700);font-weight:700">covered</span>'):''}
      </div>
    </div>`;
  }).join('');
}

// ── THROUGHPUT & YIELD ANALYTICS — completed-batch-only metrics (nothing
// to measure on a batch that hasn't finished). Cycle time is
// last_scanned_at - added_at for a complete batch: the timestamp of its
// final scan doubles as its completion time, so no new "completed_at"
// column is needed - both endpoints it's built from already exist.
function cycleTimeDays(b){
  if(!(b.total>0&&b.scanned===b.total))return null;
  if(!b.added_at||!b.last_scanned_at)return null;
  const start=new Date(b.added_at),end=new Date(b.last_scanned_at);
  if(isNaN(start.getTime())||isNaN(end.getTime()))return null;
  return Math.max(0,(end-start)/86400000);
}
function throughputRows(keyFn){
  const groups={};
  scheduleBatches.forEach(b=>{
    const key=keyFn(b)||'(none specified)';
    const g=groups[key]=groups[key]||{total:0,completed:0,cycleTimes:[]};
    g.total++;
    if(rowStatus(b)==='complete'){
      g.completed++;
      const ct=cycleTimeDays(b);
      if(ct!==null)g.cycleTimes.push(ct);
    }
  });
  return Object.keys(groups).sort().map(key=>{
    const g=groups[key];
    const rate=g.total?Math.round(g.completed/g.total*100):0;
    const avgCt=g.cycleTimes.length?(g.cycleTimes.reduce((a,c)=>a+c,0)/g.cycleTimes.length).toFixed(1):'—';
    return[key,g.total,g.completed,rate+'%',avgCt];
  });
}
function cycleTimeOnlyRows(keyFn){
  const groups={};
  scheduleBatches.forEach(b=>{
    if(rowStatus(b)!=='complete')return;
    const ct=cycleTimeDays(b);
    if(ct===null)return;
    const key=keyFn(b)||'(none specified)';
    (groups[key]=groups[key]||[]).push(ct);
  });
  return Object.keys(groups).sort().map(key=>{
    const times=groups[key];
    const avg=(times.reduce((a,c)=>a+c,0)/times.length).toFixed(1);
    return[key,times.length,avg];
  });
}
function renderThroughputYield(){
  if(!$('throughputMaterial'))return; // not every page has this tab (gm.html)
  $('throughputMaterial').innerHTML=tbl(['Material','Total Batches','Completed','Completion Rate','Avg Cycle Time (days)'],throughputRows(b=>b.material));
  $('throughputFinish').innerHTML=tbl(['Finish','Total Batches','Completed','Completion Rate','Avg Cycle Time (days)'],throughputRows(b=>b.finish));
  $('throughputJob').innerHTML=tbl(['Job','Completed Batches','Avg Cycle Time (days)'],cycleTimeOnlyRows(b=>b.job_name));
  $('throughputFloor').innerHTML=tbl(['Floor / Work Order','Completed Batches','Avg Cycle Time (days)'],cycleTimeOnlyRows(b=>b.floor_or_work_order));

  const yGroups={};
  scheduleBatches.forEach(b=>{
    const sheetQty=parseQty(b.sheet_qty);
    if(sheetQty===null||sheetQty<=0)return; // can't compute a yield ratio without a real sheet qty
    const key=b.material||'(No Material Specified)';
    const g=yGroups[key]=yGroups[key]||{sheets:0,parts:0,batches:0};
    g.sheets+=sheetQty;g.parts+=b.total;g.batches++;
  });
  const yieldRows=Object.keys(yGroups).sort().map(m=>{
    const g=yGroups[m];
    return[m,g.batches,g.sheets,g.parts,(g.parts/g.sheets).toFixed(2)];
  });
  $('yieldByMaterial').innerHTML=tbl(['Material','Batches','Sheet Qty Consumed','Parts Produced','Parts per Sheet'],yieldRows);
}

// ── JOB SUMMARY (Job-Level Rollups) — every batch under a Job rolled up
// to one overall completion %, with a floor-by-floor breakdown for multi-
// floor jobs. For reporting without digging through individual batch
// rows. Same list->detail tab pattern as Weekly Schedule.
let currentJobKey=null;
function groupByJob(){
  const groups={};
  scheduleBatches.forEach(b=>{
    const key=b.job_name||'(No Job Specified)';
    (groups[key]=groups[key]||[]).push(b);
  });
  return groups;
}
function sumProgress(items){
  const scanned=items.reduce((a,b)=>a+(b.scanned||0),0);
  const total=items.reduce((a,b)=>a+(b.total||0),0);
  return{scanned,total,pct:total?Math.round(scanned/total*100):0};
}
function progressPillClass(pct){return pct>=100?'done':pct>0?'working':'notstarted';}
function renderJobSummary(){
  const groups=groupByJob();
  const jobs=Object.keys(groups).sort();
  if(!jobs.length){$('jobSummaryList').innerHTML='<div class="empty">No batches in Production Schedule yet.</div>';return;}
  $('jobSummaryList').innerHTML=jobs.map(j=>{
    const items=groups[j];
    const{scanned,total,pct}=sumProgress(items);
    const floors=[...new Set(items.map(b=>b.floor_or_work_order).filter(Boolean))];
    return`<div class="card" style="align-items:flex-start;flex-direction:column;gap:6px;cursor:pointer" onclick="openJobDetail('${esc(j)}')">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
        <div class="name" style="font-size:16px">${esc(j)}</div>
        <span class="pill ${progressPillClass(pct)}">${pct}% complete</span>
      </div>
      <div class="job-progress"><div class="job-progress-track"><div class="job-progress-fill" style="width:${pct}%"></div></div></div>
      <div class="meta">${items.length} batch${items.length===1?'':'es'} · ${scanned}/${total} scanned${floors.length?' · '+floors.length+' floor'+(floors.length===1?'':'s')+': '+esc(floors.join(', ')):''}</div>
    </div>`;
  }).join('');
  if(currentJobKey)renderJobDetail(currentJobKey); // keep an already-open job's detail live too
}
function openJobDetail(job){
  currentJobKey=job;
  showTab('jobDetail');
  renderJobDetail(job);
}
function renderJobDetail(job){
  const items=groupByJob()[job]||[];
  $('jobDetailTitle').textContent=job;
  const{scanned,total,pct}=sumProgress(items);
  $('jobDetailSub').textContent=items.length+' batch'+(items.length===1?'':'es')+' · '+scanned+'/'+total+' scanned ('+pct+'% complete)';

  const floorGroups={};
  items.forEach(b=>{
    const key=b.floor_or_work_order||'(No Floor / Work Order Specified)';
    (floorGroups[key]=floorGroups[key]||[]).push(b);
  });
  $('jobDetailFloors').innerHTML=Object.keys(floorGroups).sort().map(f=>{
    const fitems=floorGroups[f];
    const fp=sumProgress(fitems);
    return`<div class="card" style="align-items:flex-start;flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
        <div class="name" style="font-size:15px">${esc(f)}</div>
        <span class="pill ${progressPillClass(fp.pct)}">${fp.pct}%</span>
      </div>
      <div class="job-progress"><div class="job-progress-track"><div class="job-progress-fill" style="width:${fp.pct}%"></div></div></div>
      <div class="meta">${fitems.length} batch${fitems.length===1?'':'es'} · ${fp.scanned}/${fp.total} scanned</div>
    </div>`;
  }).join('');

  $('jobDetailBatches').innerHTML=groupedBatchCardsHtml(items,b=>{
    const bp=sumProgress([b]);
    return`<div class="card" onclick="viewBatchLabels('${esc(b.batch)}')" style="cursor:pointer">
      <div>
        <div class="name">${esc(b.batch)}</div>
        <div class="meta">${esc(b.floor_or_work_order||'(no floor specified)')} · ${bp.scanned}/${bp.total} scanned</div>
      </div>
      <span class="pill ${progressPillClass(bp.pct)}">${bp.pct}%</span>
    </div>`;
  });
}
$('bBackJobDetail').onclick=()=>{currentJobKey=null;showTab('jobs');};

// ── PACKING SLIPS — generated once a batch is fully scanned. The "Ready
// to Pack" list is just scheduleBatches filtered to complete ones (no
// extra fetch); the created-slips list and each slip's own record come
// from the packing_slips backend. PDF delivery is the browser's own
// Print > Save as PDF, via a print-only-styled view (@media print above)
// - no PDF library needed, matches how the rest of this app avoids
// adding dependencies where a native browser feature already covers it.
let packingSlipsCache=[];
let currentPackingBatch=null;
let currentPackingParts=[];
let editingSlipId=null; // null = creating a new slip; set = editing an existing one

function renderPackingTab(){
  const ready=scheduleBatches.filter(b=>rowStatus(b)==='complete');
  $('readyToPackList').innerHTML=ready.length?ready.map(b=>{
    const slipCount=packingSlipsCache.filter(s=>s.batch===b.batch).length;
    return`<div class="card">
      <div>
        <div class="name">${esc(b.batch)}</div>
        <div class="meta">${esc(b.job_name||'(no job)')} · ${b.scanned}/${b.total} scanned${slipCount?' · '+slipCount+' packing slip'+(slipCount===1?'':'s')+' already created':''}</div>
      </div>
      <button onclick="openPackingForm('${esc(b.batch)}')">Create Packing Slip</button>
    </div>`;
  }).join(''):'<div class="empty">No fully-scanned batches yet.</div>';

  $('packingSlipsList').innerHTML=packingSlipsCache.length?packingSlipsCache.map(s=>`
    <div class="card" data-slipid="${s.id}" onclick="viewPackingSlip(${s.id})" oncontextmenu="openPackingCtxMenu(event,${s.id})" style="cursor:pointer">
      <div>
        <div class="name">${esc(s.slip_number)} — ${esc(s.batch)}</div>
        <div class="meta">${esc(s.department||'')}${s.department&&s.ship_to?' · ':''}${esc(s.ship_to||'')} · ${esc(s.slip_date)}</div>
      </div>
      <span class="pill neutral">View / Print</span>
    </div>`).join(''):'<div class="empty">No packing slips created yet.</div>';
}
// Right-click a created packing slip for Edit/Delete - reuses the exact
// same shared context-menu element the Production Schedule grid already
// has (#rowCtxMenu / closeRowContextMenu), just populated differently.
function openPackingCtxMenu(evt,id){
  evt.preventDefault();
  evt.stopPropagation();
  const menu=$('rowCtxMenu');
  menu.innerHTML=`
    <div class="ctx-menu-item" onclick="closeRowContextMenu();openPackingEditForm(${id})">${ICON_EDIT} Edit</div>
    <div class="ctx-menu-item danger" onclick="closeRowContextMenu();deletePackingSlip(${id})">${ICON_DELETE} Delete</div>`;
  menu.style.top=evt.clientY+'px';
  menu.style.left=Math.min(evt.clientX,window.innerWidth-170)+'px';
  menu.style.display='block';
}
async function deletePackingSlip(id){
  const s=packingSlipsCache.find(x=>x.id===id);
  if(!confirm('Delete packing slip '+(s?s.slip_number:id)+'? This cannot be undone.'))return;
  try{
    await api('/admin/api/packing-slips/'+id,{method:'DELETE'});
    await loadPackingSlips();
  }catch(e){alert('Could not delete: '+e.message);}
}
async function loadPackingSlips(){
  if(!KEY)return;
  try{
    const data=await api('/admin/api/packing-slips');
    packingSlipsCache=data.slips||[];
    if(currentTab==='packing')renderPackingTab();
  }catch(e){/* leave last-known cache showing rather than blank it on a transient error */}
}

async function openPackingForm(batch){
  editingSlipId=null;
  currentPackingBatch=batch;
  $('packingFormTitle').textContent='New Packing Slip';
  $('packingFormSubmitBtn').textContent='Generate Packing Slip';
  const b=scheduleBatches.find(x=>x.batch===batch)||{};
  $('packingFormBatchLabel').textContent=batch+' — '+b.scanned+'/'+b.total+' scanned';
  $('pfDepartment').value='';
  $('pfDate').value=new Date().toISOString().slice(0,10);
  $('pfShipTo').value='';
  $('pfJob').value=b.job_name||'';
  $('pfFloor').value=b.floor_or_work_order||'';
  $('pfCheckedBy').value='';
  $('pfComments').value='';
  $('pfSpecial').value='';
  $('packingFormPartsPreview').innerHTML='<div class="empty">Loading part list…</div>';
  showTab('packingForm');
  try{
    const data=await api('/viewer/api/batches/'+encodeURIComponent(batch));
    currentPackingParts=(data.labels||[]).map(l=>({unique_id:l.unique_id,tag:l.tag,part_type:l.part_type,width:l.width,height:l.height,qty:l.qty,colour:l.colour}));
    $('packingFormPartsPreview').innerHTML=tbl(['Tag','Part Type','Size','Qty','Colour'],currentPackingParts.map(p=>[p.tag||p.unique_id,p.part_type||'',[p.width,p.height].filter(Boolean).join(' X '),p.qty||'',p.colour||'']));
  }catch(e){
    $('packingFormPartsPreview').innerHTML='<div class="empty">Could not load part list.</div>';
  }
}
// Editing an existing slip only touches its metadata (same fields as
// creation) - the part list stays whatever was snapshotted when it was
// first generated, shown read-only here rather than re-fetched live, so
// editing never accidentally changes what the slip says was packed.
async function openPackingEditForm(id){
  try{
    const data=await api('/admin/api/packing-slips/'+id);
    const s=data.slip;
    editingSlipId=id;
    currentPackingBatch=s.batch;
    $('packingFormTitle').textContent='Edit Packing Slip '+s.slip_number;
    $('packingFormSubmitBtn').textContent='Save Changes';
    $('packingFormBatchLabel').textContent=s.batch;
    $('pfDepartment').value=s.department||'';
    $('pfDate').value=s.slip_date||'';
    $('pfShipTo').value=s.ship_to||'';
    $('pfJob').value=s.job_name||'';
    $('pfFloor').value=s.floor_or_work_order||'';
    $('pfCheckedBy').value=s.checked_by||'';
    $('pfComments').value=s.comments||'';
    $('pfSpecial').value=s.special_handling||'';
    currentPackingParts=s.parts_snapshot||[];
    $('packingFormPartsPreview').innerHTML='<div class="sub" style="margin-bottom:8px">Part list is locked to what was packed when this slip was created — not editable here.</div>'
      +tbl(['Tag','Part Type','Size','Qty','Colour'],currentPackingParts.map(p=>[p.tag||p.unique_id,p.part_type||'',[p.width,p.height].filter(Boolean).join(' X '),p.qty||'',p.colour||'']));
    showTab('packingForm');
  }catch(e){alert('Could not load packing slip: '+e.message);}
}
$('bBackPackingForm').onclick=()=>{currentPackingBatch=null;editingSlipId=null;showTab('packing');};

async function submitPackingForm(){
  if(!currentPackingBatch)return;
  const fields={
    department:$('pfDepartment').value.trim(),
    slip_date:$('pfDate').value||undefined,
    ship_to:$('pfShipTo').value.trim(),
    job_name:$('pfJob').value.trim(),
    floor_or_work_order:$('pfFloor').value.trim(),
    checked_by:$('pfCheckedBy').value.trim(),
    comments:$('pfComments').value.trim(),
    special_handling:$('pfSpecial').value.trim()
  };
  try{
    const data=editingSlipId
      ?await api('/admin/api/packing-slips/'+editingSlipId,{method:'POST',body:JSON.stringify(fields)})
      :await api('/admin/api/packing-slips',{method:'POST',body:JSON.stringify({...fields,batch:currentPackingBatch})});
    editingSlipId=null;
    await loadPackingSlips();
    renderPackingSlip(data.slip);
    showTab('packingPrint');
  }catch(e){
    alert('Could not save packing slip: '+e.message);
  }
}

async function viewPackingSlip(id){
  try{
    const data=await api('/admin/api/packing-slips/'+id);
    renderPackingSlip(data.slip);
    showTab('packingPrint');
  }catch(e){
    alert('Could not load packing slip: '+e.message);
  }
}
$('bBackPackingPrint').onclick=()=>showTab('packing');

// Everything above the part rows lives in ONE <thead> (across two <tr>s -
// the top info block, then the column headings) so it repeats on every
// printed page once the part list is long enough to spill past page one.
// The signature/notes/footer block is a sibling AFTER the table, so it
// only ever renders once, wherever the table's last row happens to end -
// never repeated, never floating mid-document.
function renderPackingSlip(slip){
  const parts=slip.parts_snapshot||[];
  const cell=(v)=>v?esc(v):'';
  $('psSheet').innerHTML=`
    <table class="ps-doc">
      <thead>
        <tr><td colspan="6" class="ps-header-cell">
          <div class="ps-top">
            <div class="ps-brand">
              <svg width="34" height="34" viewBox="0 0 200 200" fill="none" style="flex-shrink:0">
                <rect x="30" y="30" width="140" height="140" rx="6" transform="rotate(45 100 100)" stroke="#0071E3" stroke-width="10" fill="none"/>
                <path d="M55 145L55 70L100 115L145 70L145 145" stroke="#0071E3" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
              </svg>
              <div>
                <div class="ps-brand-name">MATREX<br>WINDOW SYSTEM</div>
                <div class="ps-brand-addr">3090 Langstaff Road,<br>Vaughan, Ontario L4K 4Y5<br>416-906-6195</div>
              </div>
            </div>
            <div class="ps-title">
              <div class="ps-title-main">PACKING SLIP</div>
              <div class="ps-title-sub">INTERNAL</div>
            </div>
            <div class="ps-numbox">
              <div class="ps-numbox-hdr">PACKING SLIP NUMBER</div>
              <div class="ps-numbox-val">${esc(slip.slip_number)}</div>
              <div class="ps-numbox-hdr">DATE</div>
              <div class="ps-numbox-val">${esc(slip.slip_date)}</div>
            </div>
          </div>

          <div class="ps-bar">DEPARTMENT</div>
          <div class="ps-bar-val" style="margin-bottom:8px">${cell(slip.department)}</div>

          <div class="ps-row3">
            <div><div class="ps-bar">SHIP TO</div><div class="ps-bar-val">${cell(slip.ship_to)}</div></div>
            <div><div class="ps-bar">JOB</div><div class="ps-bar-val">${cell(slip.job_name)}</div></div>
            <div><div class="ps-bar">FLOOR / WORK ORDER</div><div class="ps-bar-val">${cell(slip.floor_or_work_order)}</div></div>
          </div>
        </td></tr>
        <tr><th>ITEM #</th><th>TAG / ID</th><th>PART TYPE</th><th>SIZE</th><th>QTY</th><th>COLOUR</th></tr>
      </thead>
      <tbody>${parts.map((p,i)=>`<tr><td>${i+1}</td><td>${cell(p.tag||p.unique_id)}</td><td>${cell(p.part_type)}</td><td>${cell([p.width,p.height].filter(Boolean).join(' X '))}</td><td>${cell(p.qty)}</td><td>${cell(p.colour)}</td></tr>`).join('')}
      ${!parts.length?'<tr><td colspan="6">No parts on record for this batch.</td></tr>':''}
      </tbody>
    </table>

    <div class="ps-sign-row">
      <div><div class="ps-sign-hdr">CHECKED BY</div><div style="padding:6px">${cell(slip.checked_by)}</div></div>
      <div><div class="ps-sign-hdr">RECEIVER NAME</div></div>
      <div><div class="ps-sign-hdr">RECEIVER SIGN</div></div>
      <div><div class="ps-sign-hdr">DATE RECEIVED</div></div>
    </div>

    <div class="ps-notes">
      <div>
        <div class="ps-notes-hdr">COMMENTS / NOTES</div>
        <div class="ps-notes-body">${cell(slip.comments)}</div>
      </div>
      <div>
        <div class="ps-notes-hdr">SPECIAL HANDLING / REMARK</div>
        <div class="ps-notes-body">${cell(slip.special_handling)}</div>
      </div>
    </div>

    <div class="ps-footer">Thank You For Your Business!</div>
  `;
}

// ── 100%-COMPLETION ALERT (Phase 7, partial) — the rest of Phase 7
// ("Panel Scan Integration Hooks") is either already true today (scan
// progress already updates Production Schedule live - there was never a
// separate system to integrate with) or explicitly ruled out
// (auto-generating the next Batch Name/Work Order - no reliable naming
// convention to build against). This is just the "batch hits 100%,
// ready for QC/shipping" notification.
//
// Tracks each batch's completion state across polls and fires only on a
// genuine transition into 100% - never on page load for batches that
// were already complete before this tab was open, which is why the
// first pass just records a baseline and alerts nothing.
let knownCompletion={};
let completionAlertPrimed=false;
function checkCompletionAlerts(){
  scheduleBatches.forEach(b=>{
    const isComplete=b.total>0&&b.scanned===b.total;
    if(completionAlertPrimed&&isComplete&&knownCompletion[b.batch]===false)fireCompletionAlert(b);
    knownCompletion[b.batch]=isComplete;
  });
  completionAlertPrimed=true;
}
function fireCompletionAlert(b){
  showToast('✓ '+b.batch+' hit 100% — ready for QC/shipping');
  if(window.Notification&&Notification.permission==='granted'){
    try{new Notification('Batch Complete',{body:b.batch+' — ready for QC/shipping'});}catch(e){}
  }
}
function showToast(msg){
  const el=document.createElement('div');
  el.className='toast';
  el.textContent=msg;
  $('toastContainer').appendChild(el);
  setTimeout(()=>el.remove(),8000);
}
function enableCompletionNotifications(){
  if(!window.Notification){alert('Desktop notifications are not supported in this browser.');return;}
  Notification.requestPermission().then(perm=>{
    $('bEnableAlerts').textContent=perm==='granted'?'🔔 Alerts Enabled':'🔔 Enable Desktop Alerts';
  });
}

// ── STALLED BATCHES (Bottleneck Detection) — another read-only lens on
// scheduleBatches. "Idle since" is last_scanned_at (added to the batches
// endpoint above) for a batch that's made some progress, or added_at (when
// it was first registered) for one that hasn't been touched at all - a
// batch idle since day one is exactly as much a bottleneck as one that
// stalled halfway through, so both count rather than only tracking the
// "has some scans" case. Working days only (Sat/Sun don't count against
// the threshold), matching "3 working days" in the spec.
const LS_STALLED_THRESHOLD='mx_stalled_threshold';
function workingDaysSince(dateStr){
  if(!dateStr)return null;
  const start=new Date(dateStr);
  if(isNaN(start.getTime()))return null;
  const cur=new Date(start);cur.setHours(0,0,0,0);
  const today=new Date();today.setHours(0,0,0,0);
  let days=0;
  while(cur<today){
    cur.setDate(cur.getDate()+1);
    const dow=cur.getDay();
    if(dow!==0&&dow!==6)days++;
  }
  return days;
}
function renderStalledBatches(){
  if(!$('stalledThreshold'))return; // not every page has this tab (gm.html)
  const saved=localStorage.getItem(LS_STALLED_THRESHOLD);
  if(saved)$('stalledThreshold').value=saved;
  const threshold=Math.max(1,parseInt($('stalledThreshold').value,10)||3);
  const open=scheduleBatches.filter(b=>rowStatus(b)!=='complete');
  const stalled=open.map(b=>{
    const refDate=b.scanned>0?b.last_scanned_at:b.added_at;
    const idleDays=workingDaysSince(refDate);
    return{b,idleDays,refDate,started:b.scanned>0};
  }).filter(r=>r.idleDays!==null&&r.idleDays>=threshold)
    .sort((a,b)=>b.idleDays-a.idleDays);
  if(!stalled.length){$('stalledList').innerHTML='<div class="empty">No batches idle '+threshold+'+ working days — nothing stalled right now.</div>';return;}
  $('stalledList').innerHTML=stalled.map(({b,idleDays,refDate,started})=>{
    const sub=[b.job_name,b.material,b.floor_or_work_order].filter(Boolean).map(esc).join(' · ');
    return`<div class="card" onclick="viewBatchLabels('${esc(b.batch)}')" style="cursor:pointer">
      <div>
        <div class="name">${esc(b.batch)}</div>
        <div class="meta">${sub}${sub?' · ':''}${b.scanned}/${b.total} scanned · ${started?'last scan':'registered, never scanned'} ${fmt(refDate)}</div>
      </div>
      <span class="pill notstarted">${idleDays} working day${idleDays===1?'':'s'} idle</span>
    </div>`;
  }).join('');
}
// Guarded (not every page has this tab - see the showTab comment above)
if($('stalledThreshold'))$('stalledThreshold').addEventListener('input',e=>{
  localStorage.setItem(LS_STALLED_THRESHOLD,e.target.value);
  renderStalledBatches();
});

// ── AT RISK — the auto-escalation panel the spec asks for: same computeRisk()
// used to color Production Schedule rows, filtered to just 'red' and sorted
// worst-first (most overdue, or least complete with the least time left).
function renderAtRisk(){
  if(!$('riskList'))return; // not every page has this tab (gm.html)
  const atRisk=scheduleBatches
    .map(b=>({b,risk:computeRisk(b)}))
    .filter(r=>r.risk&&r.risk.level==='red')
    .sort((a,b)=>a.risk.daysRemaining-b.risk.daysRemaining);
  if(!atRisk.length){$('riskList').innerHTML='<div class="empty">Nothing at risk right now.</div>';return;}
  $('riskList').innerHTML=atRisk.map(({b,risk})=>{
    const sub=[b.job_name,b.material,b.floor_or_work_order].filter(Boolean).map(esc).join(' · ');
    const dueText=risk.daysRemaining<0?Math.abs(risk.daysRemaining)+' day'+(Math.abs(risk.daysRemaining)===1?'':'s')+' overdue':risk.daysRemaining+' day'+(risk.daysRemaining===1?'':'s')+' left';
    return`<div class="card" onclick="viewBatchLabels('${esc(b.batch)}')" style="cursor:pointer">
      <div>
        <div class="name">${esc(b.batch)}</div>
        <div class="meta">${sub}${sub?' · ':''}${b.scanned}/${b.total} scanned (${Math.round(risk.completionPct)}%) · Due ${esc(b.target_finish)} · ${dueText}</div>
      </div>
      <span class="pill notstarted">At Risk</span>
    </div>`;
  }).join('');
}

// ── ACTIVITY LOG — read-only history of every admin-dashboard write
// action, including ones made from the GM's copy of the dashboard.
// Deliberately absent from gm.html entirely (no button, no container,
// guarded here the same way as the other GM-excluded tabs) - this page
// is the review surface, not something the GM sees themselves. Rendered
// once per visit rather than on the 4s poll, since reviewing history
// doesn't need to be live the way scan progress does.
async function renderActivityLog(){
  const el=$('activityLogList');
  if(!el)return;
  if(!KEY){el.innerHTML='<div class="empty">Enter the admin key to load.</div>';return;}
  try{
    const data=await api('/admin/api/audit-log');
    const entries=data.entries||[];
    if(!entries.length){el.innerHTML='<div class="empty">No activity recorded yet.</div>';return;}
    el.innerHTML=entries.map(e=>{
      const details=e.details&&e.details.length>150?e.details.slice(0,150)+'…':e.details;
      return`<div class="card">
        <div>
          <div class="name">${esc(e.action)}${e.target?' — '+esc(e.target):''}</div>
          <div class="meta">${esc(e.actor||'—')} · ${fmt(e.at)}${details?' · '+esc(details):''}</div>
        </div>
      </div>`;
    }).join('');
  }catch(err){el.innerHTML='<div class="empty">Wrong key, or server unreachable.</div>';}
}

// ── AutoFilter (Excel-style: checkbox multi-select per column, search,
// sort A-Z/Z-A from the same dropdown, columns AND together) ──────────
function rowStatus(b){return b.total>0&&b.scanned===b.total?'complete':b.scanned>0?'progress':'none';}
function statusLabel(v){return v==='complete'?'Complete':v==='progress'?'In Progress':'Not Started';}
function colValue(b,key){return key==='status'?rowStatus(b):(b[key]||'');}
function uniqueValuesFor(key){
  if(key==='status')return['complete','progress','none'];
  return[...new Set(scheduleBatches.map(b=>b[key]).filter(Boolean))].sort();
}

let columnFilters={};      // key -> Set of checked values (absent = no filter on that column)
let gridSort=null;         // {key, asc}
let colfKey=null,colfLabel=null,colfPending=new Set();

function openColFilter(evt,key,label){
  evt.stopPropagation();
  const pop=$('colFilterPopover');
  if(pop.style.display==='block'&&colfKey===key){
    closeColFilter();  // same button clicked again while its own popover is open - toggle closed
    return;
  }
  colfKey=key;colfLabel=label;
  const values=uniqueValuesFor(key);
  colfPending=new Set(columnFilters[key]?[...columnFilters[key]]:values);
  $('colfSearch').value='';
  renderColFilterList();
  $('colfClearItem').classList.toggle('disabled',!columnFilters[key]);
  const r=evt.currentTarget.getBoundingClientRect();
  pop.style.top=(r.bottom+4)+'px';
  pop.style.left=Math.min(r.left,window.innerWidth-300)+'px';
  pop.style.display='block';
}
function renderColFilterList(){
  const q=$('colfSearch').value.trim().toLowerCase();
  const values=uniqueValuesFor(colfKey).filter(v=>(colfKey==='status'?statusLabel(v):v).toLowerCase().includes(q));
  const allChecked=values.length>0&&values.every(v=>colfPending.has(v));
  // Inline styles here are deliberate, not just class-based - this row
  // layout (checkbox flush left, label immediately beside it) kept
  // breaking under a class-only approach, so every alignment-relevant
  // property is repeated inline where nothing else in the page can
  // override it.
  const rowStyle='display:flex;flex-direction:row;justify-content:flex-start;align-items:center;width:100%;text-align:left';
  const cbStyle='margin:0;flex-shrink:0';
  const lblStyle='margin-left:4px;text-align:left;flex:1';
  $('colfList').innerHTML=`
    <label class="colf-item colf-all" style="${rowStyle}"><input type="checkbox" style="${cbStyle}" ${allChecked?'checked':''} onchange="toggleAllColf(this.checked)"><span style="${lblStyle}">(Select All)</span></label>
    ${values.map(v=>{
      const label=colfKey==='status'?statusLabel(v):esc(v);
      return`<label class="colf-item" style="${rowStyle}"><input type="checkbox" style="${cbStyle}" ${colfPending.has(v)?'checked':''} onchange="toggleColfValue('${esc(v)}',this.checked)"><span style="${lblStyle}">${label}</span></label>`;
    }).join('')}`;
}
function toggleAllColf(checked){
  const values=uniqueValuesFor(colfKey);
  if(checked)values.forEach(v=>colfPending.add(v));else values.forEach(v=>colfPending.delete(v));
  renderColFilterList();
}
function toggleColfValue(v,checked){
  if(checked)colfPending.add(v);else colfPending.delete(v);
}
function applyColFilter(){
  const allValues=uniqueValuesFor(colfKey);
  if(colfPending.size>=allValues.length)delete columnFilters[colfKey];
  else columnFilters[colfKey]=new Set(colfPending);
  closeColFilter();
  renderScheduleGrid();
}
function closeColFilter(){
  $('colFilterPopover').style.display='none';
  colfKey=null;
}
function clearColFilter(){
  if(!columnFilters[colfKey])return; // matches Excel: greyed out/no-op when this column has no active filter
  delete columnFilters[colfKey];
  closeColFilter();
  renderScheduleGrid();
}
function sortGridBy(asc){
  gridSort=colfKey?{key:colfKey,asc}:gridSort;
  closeColFilter();
  renderScheduleGrid();
}
document.addEventListener('click',e=>{
  if(!e.target.closest('#colFilterPopover')&&!e.target.closest('.colf-btn'))closeColFilter();
  if(!e.target.closest('#rowCtxMenu'))closeRowContextMenu();
  if(!e.target.closest('#otherDashMenu')&&!e.target.closest('#otherDashBtn'))closeOtherDashboards();
});
// Not present on gm.html/damon.html/swar.html (only the main dashboard
// links out to the others), so guarded like every other admin.html-only
// control.
function toggleOtherDashboards(evt){
  const menu=$('otherDashMenu');
  if(!menu)return;
  evt.stopPropagation();
  menu.style.display=menu.style.display==='block'?'none':'block';
}
function closeOtherDashboards(){
  const menu=$('otherDashMenu');
  if(menu)menu.style.display='none';
}
document.addEventListener('contextmenu',e=>{
  if(!e.target.closest('tr[data-batch], [data-slipid], [data-deviceid]'))closeRowContextMenu();
});
// Right-click a Production Schedule row for Edit/Delete (or Save/Cancel
// if that row is already mid-edit) - same actions the old Actions column
// had, just via a context menu instead of always-visible icons.
function openRowContextMenu(evt,batch){
  evt.preventDefault();
  evt.stopPropagation();
  const editing=editingBatches.has(batch);
  const menu=$('rowCtxMenu');
  menu.innerHTML=editing?`
    <div class="ctx-menu-item" onclick="closeRowContextMenu();saveRowEdit('${esc(batch)}')">${ICON_SAVE} Save</div>
    <div class="ctx-menu-item" onclick="closeRowContextMenu();cancelRowEdit('${esc(batch)}')">${ICON_CANCEL} Cancel</div>`
    :`
    <div class="ctx-menu-item" onclick="closeRowContextMenu();toggleEditRow('${esc(batch)}')">${ICON_EDIT} Edit</div>
    <div class="ctx-menu-item danger" onclick="closeRowContextMenu();deleteBatchFromGrid('${esc(batch)}')">${ICON_DELETE} Delete</div>`;
  menu.style.top=evt.clientY+'px';
  menu.style.left=Math.min(evt.clientX,window.innerWidth-170)+'px';
  menu.style.display='block';
}
function closeRowContextMenu(){$('rowCtxMenu').style.display='none';}

// One row per batch, an Excel-style AutoFilter dropdown on every column
// header (columns AND together, same as Excel) - Part Qty filters/sorts
// by completion state since scanned/total is computed, not stored.
// Clicking a row opens the same edit panel used below, without hiding
// the grid, so switching batches (or re-filtering) never loses context.
// ── DEADLINE & RISK — red/yellow/green per batch, comparing completion %
// against how much of the allotted time (added_at -> target_finish) has
// elapsed. Suggested thresholds from the spec, kept as named constants so
// they're easy to retune without hunting through the logic below. A
// complete batch or one with no Target Finish date isn't "at risk" of
// anything - both return null (no color, excluded from the At Risk tab).
const RISK_RED_COMPLETION_MAX=20;    // red if under this % complete...
const RISK_RED_TIME_ELAPSED_MIN=70;  // ...and at least this much of the time is gone
function computeRisk(b){
  if(b.total>0&&b.scanned===b.total)return null;
  const targetIso=toISODate(b.target_finish);
  if(!targetIso)return null;
  const target=new Date(targetIso+'T00:00:00');
  const now=new Date();now.setHours(0,0,0,0);
  const addedIso=toISODate(b.added_at)||targetIso;
  const added=new Date(addedIso+'T00:00:00');
  const msPerDay=86400000;
  const daysRemaining=Math.round((target-now)/msPerDay);
  const totalDays=Math.round((target-added)/msPerDay);
  const completionPct=b.total>0?(b.scanned/b.total)*100:0;
  const elapsedPct=totalDays>0?Math.min(100,Math.max(0,((totalDays-daysRemaining)/totalDays)*100)):(daysRemaining<=0?100:0);
  let level;
  if(daysRemaining<0)level='red'; // already overdue and incomplete - worst case regardless of %
  else if(completionPct<RISK_RED_COMPLETION_MAX&&elapsedPct>=RISK_RED_TIME_ELAPSED_MIN)level='red';
  else if(completionPct<elapsedPct)level='yellow'; // used more time than work done - behind pace
  else level='green'; // on pace or ahead
  return{level,completionPct,elapsedPct,daysRemaining};
}

function renderScheduleGrid(){
  let rows=scheduleBatches.filter(b=>{
    for(const key in columnFilters){
      if(!columnFilters[key].has(colValue(b,key)))return false;
    }
    return true;
  });
  if(gridSort){
    const{key,asc}=gridSort;
    rows=[...rows].sort((a,b)=>{
      const av=String(colValue(a,key)),bv=String(colValue(b,key));
      return asc?av.localeCompare(bv):bv.localeCompare(av);
    });
  }
  GRID_COLUMNS.forEach(([key])=>{
    const btn=$('colfbtn_'+key);
    if(btn)btn.classList.toggle('active',!!columnFilters[key]);
  });
  if(!rows.length){$('scheduleTbody').innerHTML=`<tr><td colspan="11" class="empty">${scheduleBatches.length?'No matches.':'No batches registered yet.'}</td></tr>`;return;}
  $('scheduleTbody').innerHTML=rows.map(b=>{
    const pct=b.total?Math.round((b.scanned/b.total)*100):0;
    const state=rowStatus(b);
    const editing=editingBatches.has(b.batch);
    // Editable text field, or a date-type one for target_finish - same
    // upsert-only-what's-present contract as before, just inline in the
    // grid row. Edit/Delete (or Save/Cancel while editing) now live on
    // the row's right-click menu instead of a dedicated Actions column.
    const field=(key,isDate)=>{
      if(!editing)return esc(b[key]||'');
      const val=isDate?toISODate(b[key]):esc(b[key]||'');
      return`<input class="gc-input" type="${isDate?'date':'text'}" data-field="${key}" value="${val}" onclick="event.stopPropagation()">`;
    };
    const risk=computeRisk(b);
    return`<tr data-batch="${esc(b.batch)}" class="${risk?'risk-'+risk.level:''}" onclick="viewBatchLabels('${esc(b.batch)}')" oncontextmenu="openRowContextMenu(event,'${esc(b.batch)}')">
      <td>${field('job_name')}</td>
      <td>${field('floor_or_work_order')}</td>
      <td>${field('target_finish',true)}</td>
      <td>${field('material')}</td>
      <td>${field('finish')}</td>
      <td>${field('part_name')}</td>
      <td class="gc-batch">${esc(b.batch)}</td>
      <td><div class="gc-progress"><div class="gc-progress-track"><div class="gc-progress-fill ${state}" style="width:${pct}%"></div></div><div class="gc-count">${b.scanned}/${b.total}</div></div></td>
      <td class="gc-num">${field('sheet_qty')}</td>
      <td class="gc-comment">${field('comment')}</td>
      <td>${field('tasked')}</td>
    </tr>`;
  }).join('');
}

// Best-effort free text -> yyyy-mm-dd, for feeding an existing stored
// value into <input type="date">. Returns '' (not an error) if it can't
// be confidently parsed - the date field just starts blank rather than
// this ever breaking the page.
function toISODate(v){
  if(!v)return'';
  if(/^\d{4}-\d{2}-\d{2}$/.test(v))return v;
  const d=new Date(v);
  return isNaN(d.getTime())?'':d.toISOString().slice(0,10);
}

// Plain text glyphs instead of hand-written SVG paths - a typo in path
// data renders as nothing at all with no error, which is exactly what
// happened here; a text character can't silently fail to render like that.
const ICON_EDIT='&#9998;';   // ✎ pencil
const ICON_DELETE='&#128465;'; // 🗑 wastebasket
const ICON_SAVE='&#10003;';  // ✓ check mark
const ICON_CANCEL='&#10005;'; // ✕ multiplication x

// Batches currently in inline-edit mode (their grid row shows inputs
// instead of plain text). A row's own Edit/Save icons toggle membership.
let editingBatches=new Set();

function toggleEditRow(batch){editingBatches.add(batch);renderScheduleGrid();}
function cancelRowEdit(batch){editingBatches.delete(batch);renderScheduleGrid();}

// Reads every .gc-input in that batch's row (identified via data-batch,
// since batch names are unique) and saves in one call - same upsert
// endpoint as before. extra_fields is deliberately omitted from the body
// now that there's no UI for it; the backend only overwrites fields that
// are actually present, so any extra_fields set before this change stays
// intact even though nothing here can edit it anymore.
async function saveRowEdit(batch){
  const row=document.querySelector(`tr[data-batch="${CSS.escape(batch)}"]`);
  if(!row)return;
  const body={};
  row.querySelectorAll('.gc-input').forEach(inp=>{body[inp.dataset.field]=inp.value.trim();});
  try{
    await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'POST',body:JSON.stringify(body)});
    editingBatches.delete(batch);
    await loadScheduleList();
  }catch(e){alert('Could not save — check the admin key and try again.');}
}

// Permanently deletes the batch: every registered part in it, their notes
// and scan-log entries, and the schedule row itself. Allowed even with
// scanned parts (per the "warn but don't block" choice for this feature -
// this is for cleaning up mistaken/test batches) - but requires typing the
// exact batch name first, and the warning text says plainly how many parts
// have already been scanned when that's the case, so it's never a surprise.
async function deleteBatchFromGrid(batch){
  const b=scheduleBatches.find(x=>x.batch===batch);
  const total=b?b.total:0,scannedCount=b?b.scanned:0;
  let warning=`This permanently deletes batch "${batch}" and all ${total} registered part(s) in it. This cannot be undone.`;
  if(scannedCount>0){
    warning+=`\n\nWARNING: ${scannedCount} of ${total} part(s) in this batch have ALREADY BEEN SCANNED. Deleting will permanently lose that scan history.`;
  }
  warning+=`\n\nType the batch name exactly to confirm:\n${batch}`;
  const typed=prompt(warning);
  if(typed===null)return;
  if(typed!==batch){alert('Batch name did not match — nothing deleted.');return;}
  try{
    await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'DELETE'});
    editingBatches.delete(batch);
    await loadScheduleList();
  }catch(e){alert('Could not delete — check the admin key and try again.');}
}

// Read-only: clicking anywhere on a row that isn't an icon/input shows
// just its per-label scan status (same view the phone app's Production
// Schedule drill-down shows) - editing/deleting now live on the row's own
// icons instead of a shared detail panel.
// Opens as its own tab now (not a panel under the grid) - header follows
// the same <h1>/.sub pattern every other tab uses, with the sub-line
// built from that batch's own production-schedule row (job/target
// finish/material/finish/part name/tasked) so there's context for which
// batch this is without having to flip back to Production Schedule.
let currentBatchLabels=[];
let labelFilters={part_type:'',scanned:''};
let currentLabelsBatch=null;
// Selection lives independent of the filter dropdowns but is cleared
// whenever the batch or filters change - "what's checked on screen right
// now" should always be exactly what a bulk action affects, never a
// stale selection hiding behind a filter that's since moved on.
let selectedLabelIds=new Set();

async function viewBatchLabels(batch){
  showTab('labels');
  currentLabelsBatch=batch;
  $('labelsTitle').textContent=batch;
  $('labelsSub').textContent='Loading…';
  $('labelsFilterBar').innerHTML='';
  $('labelsContent').innerHTML='<div class="empty">Loading…</div>';
  labelFilters={part_type:'',scanned:''};
  selectedLabelIds=new Set();
  try{
    const data=await api('/viewer/api/batches/'+encodeURIComponent(batch));
    const sched=data.schedule||{};
    const line=[sched.job_name,sched.target_finish,sched.material,sched.finish,sched.part_name,sched.tasked].filter(Boolean).join(' · ');
    $('labelsSub').textContent=line||'No production schedule details for this batch yet.';
    currentBatchLabels=data.labels||[];
    renderLabelFilterBar();
    renderFilteredLabels();
  }catch(e){
    $('labelsSub').textContent='';
    $('labelsContent').innerHTML='<div class="empty">Could not load this batch.</div>';
  }
}
// Type options come from whatever part_type values actually appear in
// this batch (varies per batch, so built fresh each time rather than
// hardcoded); Scanned is a fixed two-state choice, same "Yes"/"No" the
// server already uses for parts_index.scanned. Both live in the
// top-right corner of the header, and combine (AND) same as the grid's
// column filters.
function renderLabelFilterBar(){
  const types=[...new Set(currentBatchLabels.map(l=>l.part_type).filter(Boolean))].sort();
  $('labelsFilterBar').innerHTML=`
    <select id="filtLabelType" onchange="labelFilters.part_type=this.value;selectedLabelIds=new Set();renderFilteredLabels()">
      <option value="">All Types</option>
      ${types.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('')}
    </select>
    <select id="filtLabelScanned" onchange="labelFilters.scanned=this.value;selectedLabelIds=new Set();renderFilteredLabels()">
      <option value="">Scanned &amp; Not Scanned</option>
      <option value="Yes">Scanned</option>
      <option value="No">Not Scanned</option>
    </select>`;
}
function renderFilteredLabels(){
  let rows=currentBatchLabels;
  if(labelFilters.part_type)rows=rows.filter(l=>(l.part_type||'')===labelFilters.part_type);
  if(labelFilters.scanned)rows=rows.filter(l=>l.scanned===labelFilters.scanned);
  $('labelsContent').innerHTML=rows.length?labelRowsHtml(rows):'<div class="empty">No matches.</div>';
  renderLabelsBulkBar();
}
function labelRowsHtml(labels){
  if(!labels.length)return'<div class="empty">No labels in this batch.</div>';
  return labels.map(l=>{
    const dc=l.void==='Yes'?'void':l.scanned==='Yes'?'scanned':'';
    const statusText=l.void==='Yes'?'VOID':l.scanned==='Yes'?'Scanned':'Not scanned';
    const sub=[l.project,l.floor,l.part_type,[l.width,l.height].filter(Boolean).join(' X '),l.qty,l.colour].filter(Boolean).map(esc).join(' · ');
    // Already-voided labels can't be voided again (the endpoint rejects
    // it), so they get no checkbox - nothing for a bulk action to do to
    // them.
    const cb=l.void==='Yes'?'<span style="width:16px;flex-shrink:0"></span>':`<input type="checkbox" style="flex-shrink:0" ${selectedLabelIds.has(l.unique_id)?'checked':''} onchange="toggleLabelSelect('${esc(l.unique_id)}',this.checked)">`;
    return`<div class="bl-row">${cb}<div class="bl-dot ${dc}"></div><div class="bl-info"><div class="bl-name">${esc(l.tag||l.unique_id)}</div><div class="bl-sub">${sub?sub+' · ':''}${esc(statusText)}</div></div></div>`;
  }).join('');
}
function toggleLabelSelect(uid,checked){
  checked?selectedLabelIds.add(uid):selectedLabelIds.delete(uid);
  renderLabelsBulkBar();
}
function visibleVoidableLabelIds(){
  let rows=currentBatchLabels;
  if(labelFilters.part_type)rows=rows.filter(l=>(l.part_type||'')===labelFilters.part_type);
  if(labelFilters.scanned)rows=rows.filter(l=>l.scanned===labelFilters.scanned);
  return rows.filter(l=>l.void!=='Yes').map(l=>l.unique_id);
}
function selectAllVisibleLabels(){
  selectedLabelIds=new Set(visibleVoidableLabelIds());
  renderFilteredLabels();
}
function clearLabelSelection(){
  selectedLabelIds=new Set();
  renderFilteredLabels();
}
// Bulk void reuses the exact same category+reason contract as a single
// part's Void (NOTE_CATEGORIES, "Other" requires text) - one reason
// applied to every selected label, written to each one's own part_notes
// row exactly like the single-part flow does.
function renderLabelsBulkBar(){
  const bar=$('labelsBulkBar');
  if(!bar)return;
  const n=selectedLabelIds.size;
  const voidableOnScreen=visibleVoidableLabelIds().length;
  if(!voidableOnScreen){bar.style.display='none';return;}
  bar.style.display='flex';
  if(!n){
    bar.innerHTML=`<button class="secondary" onclick="selectAllVisibleLabels()">Select All (${voidableOnScreen})</button>
      <span class="meta">Check labels below to void more than one at once.</span>`;
    return;
  }
  bar.innerHTML=`
    <strong>${n} selected</strong>
    <button class="secondary" onclick="clearLabelSelection()">Clear</button>
    <select id="bulkVoidCat">${NOTE_CATEGORIES.map(([v,l])=>`<option value="${v}">${esc(l)}</option>`).join('')}</select>
    <input id="bulkVoidTxt" placeholder="Details (required for Other)" style="flex:1;min-width:160px">
    <button class="danger-solid" onclick="bulkVoidSelectedLabels()">Void Selected</button>`;
}
async function bulkVoidSelectedLabels(){
  const category=$('bulkVoidCat').value,note=$('bulkVoidTxt').value.trim();
  if(category==='OTHER'&&!note){alert('Details are required for "Other".');return;}
  const ids=[...selectedLabelIds];
  if(!confirm('Void '+ids.length+' label'+(ids.length===1?'':'s')+'? This flags them on every future scan and cannot be undone from this screen.'))return;
  let failed=0;
  for(const uid of ids){
    try{await api('/admin/api/parts/void',{method:'POST',body:JSON.stringify({unique_id:uid,category,note,device:'ADMIN'})});}
    catch(e){failed++;}
  }
  if(failed)alert(failed+' of '+ids.length+' could not be voided (already voided, or a connection issue) - the rest went through.');
  if(currentLabelsBatch)viewBatchLabels(currentLabelsBatch);
}

// Production Schedule is the landing tab now, so its grid needs to load
// immediately - this has to be the last line in the script, not grouped
// with the other startup calls near the top, because it depends on
// GRID_COLUMNS and the other consts/functions defined further down the
// file (a `const` isn't usable before its own declaration line runs,
// unlike a function declaration - calling this too early silently threw
// and left the grid empty until something re-triggered it, e.g. clicking
// the tab).
loadScheduleList();