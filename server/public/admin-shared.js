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

function saveKey(){KEY=$('key').value.trim();localStorage.setItem('mx_admin_key',KEY);load();loadReports();loadTunnelUrl();loadScheduleList();loadDeviceActivity();loadExceptions();loadMaterialStock();loadPackingSlips();loadDeletedBatchesCount();checkAppVersion();loadCustomColumns();loadStageDefinitions();}

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
  packing:'tabPacking',packingForm:'tabPackingForm',packingPrint:'tabPackingPrint',
  completed:'tabCompleted'
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
  packing:'tabBtnPacking',packingForm:'tabBtnPacking',packingPrint:'tabBtnPacking',
  completed:'tabBtnCompleted'
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
  if(!r.ok){
    // Surface the server's actual message (e.g. a validation reason) when
    // it sends one, instead of every caller's alert() just saying "HTTP
    // 409" - falls back to the bare status if the body isn't JSON or has
    // no .error, so this never throws a worse error than before.
    let msg='HTTP '+r.status;
    try{const body=await r.json();if(body&&body.error)msg=body.error;}catch(e){}
    throw new Error(msg);
  }
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

// Shared by the Part Lookup page and the Batch Labels click-through
// modal below - both show the same index+detail shape from
// /admin/api/parts/:id, just in two different places.
function partStatusPillHtml(idx){
  return idx.void==='Yes'?'<span class="pill REVOKED">VOID</span>'
    :idx.delivered_internally==='Yes'?'<span class="pill neutral">DELIVERED (INTERNAL)</span>'
    :idx.scanned==='Yes'?'<span class="pill APPROVED">SCANNED</span>':'<span class="pill PENDING">NOT SCANNED</span>';
}
function partFieldsHtml(idx,d){
  return[['Department',idx.department],['Batch',d.batch],['Sheet Name',d.sheet_name],['Project',d.project],
    ['Floor',d.floor],['Tag',d.tag],['Type',d.part_type],['Size',[d.width,d.height].filter(Boolean).join(' X ')],
    ['Qty',d.qty],['Colour',d.colour],['Scanned At',fmt(idx.scanned_at)],['Scanned By',idx.scanned_by_device],
    ['Voided At',idx.void==='Yes'?fmt(idx.voided_at):'']]
    .filter(([,v])=>v).map(([k,v])=>`<div class="field-row"><span class="field-k">${esc(k)}</span><span class="field-v">${esc(v)}</span></div>`).join('');
}
function renderPart(data){
  const idx=data.index,d=data.detail||{};
  const statusPill=partStatusPillHtml(idx);
  const fields=partFieldsHtml(idx,d);

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
      ${idx.void==='Yes'?'<button class="secondary" onclick="unvoidCurrentPart()">Un-void This Part</button>':'<button class="danger-solid" onclick="voidCurrentPart()">Void This Part</button>'}
    </div>`;
  renderNotes(data.notes);
}
function notesListHtml(notes){
  return!notes.length?'<div class="empty">No notes yet.</div>':notes.map(n=>`
    <div class="note-card">
      <div class="note-cat">${esc(catLabel[n.category]||n.category)}</div>
      ${n.note?`<div class="note-text">${esc(n.note)}</div>`:''}
      <div class="note-meta">${esc(n.device||'admin')} · ${fmt(n.created_at)}</div>
    </div>`).join('');
}
function renderNotes(notes){$('notesArea').innerHTML=notesListHtml(notes);}
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
  if(!confirm('Void '+currentPartId+'? It will be flagged on every future scan until un-voided.'))return;
  try{
    const data=await api('/admin/api/parts/void',{method:'POST',body:JSON.stringify({unique_id:currentPartId,category,note,device:'ADMIN'})});
    $('noteTxt').value='';
    lookupPart();
  }catch(e){alert('Could not void part — check the admin key and try again.');}
}
async function unvoidCurrentPart(){
  if(!confirm('Un-void '+currentPartId+'? It goes back to normal - scanned stays whatever it already was, it just stops being flagged as void.'))return;
  try{
    await api('/admin/api/parts/unvoid',{method:'POST',body:JSON.stringify({unique_id:currentPartId})});
    lookupPart();
  }catch(e){alert('Could not un-void part: '+e.message);}
}

// ── BATCH LABEL DETAIL (admin.html only) — clicking any label in the
// Batch Labels tab opens the same index+detail+notes view as Part
// Lookup, as a modal instead of its own tab. Void/Un-void here refresh
// both the modal (re-fetch) and the underlying label list behind it, so
// the status dot updates immediately instead of waiting for the next
// 4s poll.
let labelDetailId=null;
async function openLabelDetail(uid){
  labelDetailId=uid;
  $('mLabelDetail').classList.add('on');
  $('labelDetailTitle').textContent=uid;
  $('labelDetailBody').innerHTML='<div class="empty">Loading…</div>';
  $('labelDetailNotes').innerHTML='';
  $('labelDetailVoidBtn').innerHTML='';
  try{
    const data=await api('/admin/api/parts/'+encodeURIComponent(uid));
    if(!data.found){$('labelDetailBody').innerHTML='<div class="empty">Not registered.</div>';return;}
    renderLabelDetail(data);
  }catch(e){$('labelDetailBody').innerHTML='<div class="empty">Could not load — check the admin key and try again.</div>';}
}
function closeLabelDetail(){$('mLabelDetail').classList.remove('on');}
function renderLabelDetail(data){
  const idx=data.index,d=data.detail||{};
  $('labelDetailTitle').textContent=idx.unique_id;
  $('labelDetailBody').innerHTML=partStatusPillHtml(idx)+'<div style="margin-top:8px">'+partFieldsHtml(idx,d)+'</div>';
  $('labelDetailNotes').innerHTML=notesListHtml(data.notes);
  $('labelNoteCat').innerHTML=NOTE_CATEGORIES.map(([v,l])=>`<option value="${v}">${esc(l)}</option>`).join('');
  $('labelNoteTxt').value='';
  const voidBtnHtml=idx.void==='Yes'
    ?'<button class="secondary" onclick="unvoidLabelDetailPart()" style="width:auto">Un-void This Part</button>'
    :'<button class="danger-solid" onclick="voidLabelDetailPart()" style="width:auto">Void This Part</button>';
  // A voided part can't also be marked delivered-internally (the server
  // rejects it) - no point offering a button that would just fail.
  const internalBtnHtml=idx.void==='Yes'?''
    :idx.delivered_internally==='Yes'
      ?'<button class="secondary" onclick="unmarkLabelDetailInternalDelivery()" style="width:auto">Un-mark Delivered (Internal)</button>'
      :'<button class="secondary" onclick="markLabelDetailInternalDelivery()" style="width:auto">Delivered Within Building</button>';
  $('labelDetailVoidBtn').innerHTML=voidBtnHtml+internalBtnHtml;
}
async function addLabelDetailNote(){
  const category=$('labelNoteCat').value,note=$('labelNoteTxt').value.trim();
  if(category==='OTHER'&&!note){alert('Details are required for "Other".');return;}
  try{
    const data=await api('/admin/api/parts/notes',{method:'POST',body:JSON.stringify({unique_id:labelDetailId,category,note,device:'ADMIN'})});
    $('labelNoteTxt').value='';
    $('labelDetailNotes').innerHTML=notesListHtml(data.notes);
  }catch(e){alert('Could not add note — check the admin key and try again.');}
}
async function voidLabelDetailPart(){
  const category=$('labelNoteCat').value,note=$('labelNoteTxt').value.trim();
  if(category==='OTHER'&&!note){alert('Details are required for "Other".');return;}
  if(!confirm('Void '+labelDetailId+'? It will be flagged on every future scan until un-voided.'))return;
  try{
    await api('/admin/api/parts/void',{method:'POST',body:JSON.stringify({unique_id:labelDetailId,category,note,device:'ADMIN'})});
    await openLabelDetail(labelDetailId);
    if(currentLabelsBatch)viewBatchLabels(currentLabelsBatch);
  }catch(e){alert('Could not void part — check the admin key and try again.');}
}
async function unvoidLabelDetailPart(){
  if(!confirm('Un-void '+labelDetailId+'? It goes back to normal - scanned stays whatever it already was, it just stops being flagged as void.'))return;
  try{
    await api('/admin/api/parts/unvoid',{method:'POST',body:JSON.stringify({unique_id:labelDetailId})});
    await openLabelDetail(labelDetailId);
    if(currentLabelsBatch)viewBatchLabels(currentLabelsBatch);
  }catch(e){alert('Could not un-void part: '+e.message);}
}
async function markLabelDetailInternalDelivery(){
  if(!confirm('Mark '+labelDetailId+' as delivered within the building? It will no longer be offered on any packing slip for this batch.'))return;
  try{
    await api('/admin/api/parts/internal-delivery',{method:'POST',body:JSON.stringify({unique_id:labelDetailId})});
    await openLabelDetail(labelDetailId);
    if(currentLabelsBatch)viewBatchLabels(currentLabelsBatch);
  }catch(e){alert('Could not mark part: '+e.message);}
}
async function unmarkLabelDetailInternalDelivery(){
  if(!confirm('Un-mark '+labelDetailId+'? It becomes eligible for a packing slip again.'))return;
  try{
    await api('/admin/api/parts/internal-delivery/'+encodeURIComponent(labelDetailId),{method:'DELETE'});
    await openLabelDetail(labelDetailId);
    if(currentLabelsBatch)viewBatchLabels(currentLabelsBatch);
  }catch(e){alert('Could not un-mark part: '+e.message);}
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

// ── EXPORT TO CSV — generic, works on any sched-grid table by reading its
// <thead> and <tbody> straight out of the live DOM, so it always matches
// exactly what's currently on screen (whatever filters/sort/search are
// active) without needing its own copy of each tab's data/state. Skips
// the empty-state row and any totals row (that's a display summary, not
// a data row - Excel users compute their own sums after importing).
function csvCell(v){
  v=String(v==null?'':v);
  return/[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;
}
// A cell might hold a <select> (Task Status) or <input> (inline edit,
// On Hand qty) instead of plain text - read the actual value in either
// case rather than exporting empty/misleading text.
function csvCellText(td){
  const sel=td.querySelector('select');
  if(sel)return sel.options[sel.selectedIndex]?sel.options[sel.selectedIndex].text:'';
  const inp=td.querySelector('input');
  if(inp)return inp.value;
  return td.textContent.trim();
}
function exportTableToCSV(tbodyId,baseName){
  const tbody=$(tbodyId);
  const table=tbody&&tbody.closest('table');
  if(!table){alert('Nothing to export.');return;}
  const headers=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim().replace(/\s+/g,' '));
  const rows=[...tbody.querySelectorAll('tr')].filter(tr=>!tr.querySelector('td.empty')&&!tr.classList.contains('gc-totals-row'));
  if(!rows.length){alert('Nothing to export.');return;}
  const lines=[headers.map(csvCell).join(',')];
  rows.forEach(tr=>{lines.push([...tr.children].map(td=>csvCell(csvCellText(td))).join(','));});
  const blob=new Blob([lines.join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=baseName+'-'+new Date().toISOString().slice(0,10)+'.csv';
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── GLOBAL SEARCH (Find) — one box searching across every field already
// shown for that row, instead of a filter per column. Just a case-
// insensitive substring test; each tab wires its own query variable into
// its render function's existing filter step.
function textMatches(query,...values){
  if(!query)return true;
  return values.some(v=>String(v||'').toLowerCase().includes(query));
}
// Same sched-grid look as Production Schedule/Weekly Detail/Completed
// Tasks, not the older rep-tbl style - "static" since none of tbl()'s
// callers make their rows clickable, so they get the plain look without
// the pointer cursor/hover highlight that would misleadingly suggest
// otherwise. Wrapped in its own overflow-x:auto since callers just drop
// this straight into a plain container div, same as every other sched-
// grid table on this page.
function tbl(headers,rows){
  if(!rows.length)return'<div class="empty">No data yet.</div>';
  return`<div class="sched-grid-wrap"><table class="sched-grid static"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map((c,i)=>i===0?`<td class="gc-batch">${esc(c)}</td>`:`<td class="gc-num">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
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
  ['status','Part Qty'],['sheet_qty','Sheet Qty'],['comment','Comment'],['task_status','Task Status'],
  ['scan_stage','Scan Stage']
];
// ── CUSTOM COLUMNS (Production Schedule only) — admin-defined columns
// beyond the fixed 11, stored server-side (not just localStorage) so
// every dashboard/every admin sees the same set, not a personal view.
// A custom column's VALUE lives in extra_fields (no schema change,
// same catch-all already used for forceComplete/expedite/flagged) -
// its key is always prefixed 'custom_' server-side specifically so
// editableTd/commitCellEdit below can tell "this key lives in
// extra_fields" from "this is a real production_schedule column" by
// checking the prefix alone, no separate flag threaded through
// editingCell needed.
let customColumns=[]; // [{key,label}], fetched once, kept in sync locally after add/remove
async function loadCustomColumns(){
  if(!KEY)return;
  try{
    const data=await api('/admin/api/custom-columns');
    customColumns=data.columns||[];
    renderScheduleHead();
    if(currentTab==='schedule')renderScheduleGrid();
  }catch(e){}
}
async function addCustomColumn(){
  const input=$('newColumnName');
  const label=((input&&input.value)||'').trim();
  if(!label){alert('Enter a name for the new column.');return;}
  try{
    const data=await api('/admin/api/custom-columns',{method:'POST',body:JSON.stringify({label})});
    customColumns.push({key:data.key,label:data.label});
    if(input)input.value='';
    renderScheduleHead();
    renderColumnsPanel();
    if(currentTab==='schedule')renderScheduleGrid();
  }catch(e){alert('Could not add column: '+e.message);}
}
async function removeCustomColumn(key){
  const col=customColumns.find(c=>c.key===key);
  if(!confirm(`Remove the "${col?col.label:key}" column from the grid?\n\nAny values already saved under it stay on each batch's record - re-adding a column with this exact name later brings them back.`))return;
  try{
    await api('/admin/api/custom-columns/'+encodeURIComponent(key),{method:'DELETE'});
    customColumns=customColumns.filter(c=>c.key!==key);
    hiddenScheduleColumns.delete(key);
    localStorage.setItem(LS_HIDDEN_COLUMNS,JSON.stringify([...hiddenScheduleColumns]));
    renderScheduleHead();
    renderColumnsPanel();
    if(currentTab==='schedule')renderScheduleGrid();
  }catch(e){alert('Could not remove column: '+e.message);}
}
function allScheduleColumns(){return GRID_COLUMNS.concat(customColumns.map(c=>[c.key,c.label]));}
function scheduleColspan(){return GRID_COLUMNS.length+customColumns.length;}

// ── COLUMN SHOW/HIDE (Production Schedule only) — hidden via injected
// CSS (nth-child, scoped to #tabSchedule) rather than actually omitting
// cells from renderScheduleHead()/scheduleRowHtml(). That keeps every
// column's index-to-key mapping (colf-btn filters, colValue, etc.)
// completely untouched - hiding a column never risks desyncing the
// header from the body, since both still render every cell, CSS just
// stops one from taking up space. Custom columns are always appended
// after every fixed one, so their nth-child position is just their
// place in allScheduleColumns() - no separate offset math needed for
// them versus the fixed set.
const LS_HIDDEN_COLUMNS='mx_hidden_schedule_columns';
let hiddenScheduleColumns=new Set(JSON.parse(localStorage.getItem(LS_HIDDEN_COLUMNS)||'[]'));
function applyHiddenColumnsCSS(){
  let css='';
  allScheduleColumns().forEach(([key],i)=>{
    if(hiddenScheduleColumns.has(key)){
      const n=i+1;
      css+=`#tabSchedule .sched-grid th:nth-child(${n}),#tabSchedule .sched-grid td:nth-child(${n}){display:none}`;
    }
  });
  let styleEl=document.getElementById('hiddenScheduleColumnsStyle');
  if(!styleEl){styleEl=document.createElement('style');styleEl.id='hiddenScheduleColumnsStyle';document.head.appendChild(styleEl);}
  styleEl.textContent=css;
}
function toggleColumnVisibility(key){
  if(hiddenScheduleColumns.has(key))hiddenScheduleColumns.delete(key);else hiddenScheduleColumns.add(key);
  localStorage.setItem(LS_HIDDEN_COLUMNS,JSON.stringify([...hiddenScheduleColumns]));
  applyHiddenColumnsCSS();
  renderColumnsPanel();
}
function renderColumnsPanel(){
  const el=$('columnsPanelList');
  if(!el)return;
  const fixedRows=GRID_COLUMNS.map(([key,label])=>
    `<label class="columns-pop-row"><input type="checkbox" ${hiddenScheduleColumns.has(key)?'':'checked'} onchange="toggleColumnVisibility('${key}')"> ${esc(label)}</label>`
  ).join('');
  const customRows=customColumns.map(c=>
    `<div class="columns-pop-row"><label style="flex:1;display:flex;align-items:center;gap:8px;cursor:pointer;margin:0"><input type="checkbox" ${hiddenScheduleColumns.has(c.key)?'':'checked'} onchange="toggleColumnVisibility('${c.key}')"> ${esc(c.label)}</label><button class="secondary" onclick="removeCustomColumn('${c.key}')" style="width:auto;padding:2px 8px;font-size:11px" title="Remove this column">&times;</button></div>`
  ).join('');
  el.innerHTML=fixedRows+customRows+
    `<div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--gray-200)">
      <input id="newColumnName" placeholder="New column name" style="flex:1;min-width:0;font-size:12.5px;padding:6px 8px">
      <button onclick="addCustomColumn()" style="width:auto;padding:6px 10px;font-size:12px">Add</button>
    </div>
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--gray-200)">
      <button class="secondary" onclick="resetGridCustomization()" style="width:100%;padding:6px 10px;font-size:12px">Reset column widths, row heights &amp; alignment</button>
    </div>`;
}
function toggleColumnsPanel(evt){
  evt.stopPropagation();
  const pop=$('columnsPopover');
  if(!pop)return;
  if(pop.style.display==='block'){pop.style.display='none';return;}
  renderColumnsPanel();
  pop.style.display='block';
}
function closeColumnsPanel(){const pop=$('columnsPopover');if(pop)pop.style.display='none';}

// ── COLUMN WIDTH RESIZE — drag the handle on a header's right edge,
// same interaction as Excel. Per-browser (localStorage), not shared
// server-side like custom columns - this is a personal display
// preference (screen size/zoom vary per admin), same treatment as
// hiddenScheduleColumns. Applied the same way hidden columns are: CSS
// injected by nth-child position off allScheduleColumns()'s order, so
// it never has to touch renderScheduleHead()/scheduleRowHtml()'s actual
// cell generation - just constrains the width of whichever position a
// resized column happens to occupy.
const LS_COLUMN_WIDTHS='mx_schedule_column_widths';
let columnWidths=JSON.parse(localStorage.getItem(LS_COLUMN_WIDTHS)||'{}');
const COL_MIN_WIDTH=40,COL_MAX_WIDTH=600;
function applyColumnWidthsCSS(){
  let css='';
  allScheduleColumns().forEach(([key],i)=>{
    const w=columnWidths[key];
    if(w){
      const n=i+1;
      css+=`#tabSchedule .sched-grid th:nth-child(${n}),#tabSchedule .sched-grid td:nth-child(${n}){width:${w}px;max-width:${w}px}`;
    }
  });
  let styleEl=document.getElementById('columnWidthsStyle');
  if(!styleEl){styleEl=document.createElement('style');styleEl.id='columnWidthsStyle';document.head.appendChild(styleEl);}
  styleEl.textContent=css;
}
let colResize=null; // {key, startX, startWidth}
function startColumnResize(evt,key){
  evt.preventDefault();
  evt.stopPropagation();
  const th=evt.target.closest('th');
  const startWidth=columnWidths[key]||(th?th.offsetWidth:100);
  colResize={key,startX:evt.clientX,startWidth};
  evt.target.classList.add('mx-resizing');
}

// ── ROW HEIGHT RESIZE — drag the handle at the bottom of a row's first
// cell (there's no row-number gutter to grab, per the checkbox column's
// removal, so the handle lives inside that cell instead). Same
// per-browser localStorage treatment as column width. Keyed by batch,
// not row position, so it survives sorting/filtering/re-renders, and -
// since Weekly Detail renders the same batches through this same
// scheduleRowHtml() - a resized row looks the same size in both places
// rather than needing two independent settings.
const LS_ROW_HEIGHTS='mx_schedule_row_heights';
let rowHeights=JSON.parse(localStorage.getItem(LS_ROW_HEIGHTS)||'{}');
const ROW_MIN_HEIGHT=24,ROW_MAX_HEIGHT=300;
let rowResize=null; // {batch, startY, startHeight, row}
function startRowResize(evt,batch){
  evt.preventDefault();
  evt.stopPropagation();
  const row=evt.target.closest('tr');
  const startHeight=rowHeights[batch]||(row?row.offsetHeight:32);
  rowResize={batch,startY:evt.clientY,startHeight,row};
  evt.target.classList.add('mx-resizing');
}
document.addEventListener('mousemove',evt=>{
  if(colResize){
    const delta=evt.clientX-colResize.startX;
    const w=Math.max(COL_MIN_WIDTH,Math.min(COL_MAX_WIDTH,colResize.startWidth+delta));
    columnWidths[colResize.key]=w;
    applyColumnWidthsCSS();
  }
  if(rowResize){
    const delta=evt.clientY-rowResize.startY;
    const h=Math.max(ROW_MIN_HEIGHT,Math.min(ROW_MAX_HEIGHT,rowResize.startHeight+delta));
    rowHeights[rowResize.batch]=h;
    if(rowResize.row)rowResize.row.style.height=h+'px';
  }
});
document.addEventListener('mouseup',()=>{
  if(colResize){
    localStorage.setItem(LS_COLUMN_WIDTHS,JSON.stringify(columnWidths));
    document.querySelectorAll('.col-resize-handle.mx-resizing').forEach(el=>el.classList.remove('mx-resizing'));
    colResize=null;
  }
  if(rowResize){
    localStorage.setItem(LS_ROW_HEIGHTS,JSON.stringify(rowHeights));
    document.querySelectorAll('.row-resize-handle.mx-resizing').forEach(el=>el.classList.remove('mx-resizing'));
    rowResize=null;
  }
});

// ── CELL ALIGNMENT — per-cell, not per-column (a Qty column might still
// want one particular cell called out differently), set from the same
// right-click menu the row already has for Flag/Delete - openRowContext
// Menu below now also looks at which specific <td> was clicked. Stored
// as "batch:key" -> 'left'|'center'|'right', per-browser like the two
// settings above, applied as a plain inline text-align style so it
// always wins over the grid's own centered default with no specificity
// fights.
const LS_CELL_ALIGN='mx_schedule_cell_align';
let cellAlign=JSON.parse(localStorage.getItem(LS_CELL_ALIGN)||'{}');
function cellAlignStyle(b,key){
  const a=cellAlign[b.batch+':'+key];
  return a?`text-align:${a}`:'';
}
function setCellAlign(batch,key,align){
  const k=batch+':'+key;
  if(align)cellAlign[k]=align;else delete cellAlign[k];
  localStorage.setItem(LS_CELL_ALIGN,JSON.stringify(cellAlign));
  refreshRow(batch);
}
// The one blanket "put it back the way it was" escape hatch for all
// three settings above, reachable from the Columns popover alongside
// show/hide - column show/hide and custom columns themselves are a
// separate concern and aren't touched by this.
function resetGridCustomization(){
  if(!confirm('Reset all column widths, row heights, and cell alignment back to default?\n\nColumn show/hide and custom columns are not affected.'))return;
  columnWidths={};rowHeights={};cellAlign={};
  localStorage.removeItem(LS_COLUMN_WIDTHS);
  localStorage.removeItem(LS_ROW_HEIGHTS);
  localStorage.removeItem(LS_CELL_ALIGN);
  applyColumnWidthsCSS();
  if(currentTab==='schedule')renderScheduleGrid();
  if(currentTab==='weekly'&&currentWeekKey)renderWeekDetail(currentWeekKey);
}

// ── MANUAL ROW FLAG — a second, deliberately distinct signal from risk
// (computeRisk's red/amber/green). Kept as an icon badge rather than a
// row color/background specifically so it never competes with risk for
// the same visual channel - color here is spent once, on risk only,
// same principle applied everywhere else the grid uses color. Stored
// in extra_fields (no schema change), same pattern as isForceComplete/
// isExpedited above.
function isRowFlagged(b){return!!(b&&b.extra_fields&&b.extra_fields.flagged);}
async function toggleRowFlag(batch){
  const b=scheduleBatches.find(x=>x.batch===batch);
  if(!b)return;
  const newVal=!isRowFlagged(b);
  const prevExtra=b.extra_fields;
  const extra=Object.assign({},b.extra_fields||{},{flagged:newVal});
  b.extra_fields=extra;
  refreshRow(batch);
  try{
    await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'POST',body:JSON.stringify({extra_fields:extra})});
  }catch(e){
    b.extra_fields=prevExtra;
    refreshRow(batch);
    alert('Could not update flag: '+e.message);
  }
}

function renderScheduleHead(){
  $('scheduleHeadRow').innerHTML=
    GRID_COLUMNS.map(([key,label])=>
      `<th>${esc(label)}<button class="colf-btn" id="colfbtn_${key}" onclick="openColFilter(event,'${key}','${esc(label)}')">&#9660;</button><div class="col-resize-handle" onmousedown="startColumnResize(event,'${key}')" title="Drag to resize"></div></th>`
    ).join('')+
    // Custom columns have no AutoFilter dropdown (v1) - they're plain
    // extra_fields text, not wired into columnFilters/colValue's
    // known-field lookup. Still resizable, same as every fixed column.
    customColumns.map(c=>`<th>${esc(c.label)}<div class="col-resize-handle" onmousedown="startColumnResize(event,'${c.key}')" title="Drag to resize"></div></th>`).join('');
  applyHiddenColumnsCSS();
  applyColumnWidthsCSS();
}
async function loadScheduleList(){
  if(!$('scheduleHeadRow').children.length)renderScheduleHead();
  if(!KEY){$('scheduleTbody').innerHTML=`<tr><td colspan="${scheduleColspan()}" class="empty">Enter the admin key to load.</td></tr>`;return;}
  // Skip while a cell is mid-edit - a background refresh replaces the
  // grid's innerHTML wholesale, which would silently wipe out whatever's
  // typed into that cell before it's saved. Resumes on its own within
  // one poll interval of the edit committing/cancelling, no explicit
  // resume needed.
  if(editingCell)return;
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
    if(currentTab==='completed')renderCompletedTasks();
    checkCompletionAlerts();
  }catch(e){$('scheduleTbody').innerHTML=`<tr><td colspan="${scheduleColspan()}" class="empty">Could not load — wrong key, or server unreachable.</td></tr>`;}
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
// 'notstarted'(red) is reserved for genuine problems elsewhere (a real
// material shortfall) - a batch that simply hasn't been picked up yet
// isn't inherently a problem the same way, and coloring it identically
// to red-hot-urgent work makes red mean less everywhere it's used.
// Actual urgency is already the At Risk tab's job, not this pill's.
function statusPillClass(v){return v==='complete'?'done':v==='progress'?'working':'neutral';}
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
  showWeekDetailSubTab(currentWeekDetailSubTab);
  renderWeekDetail(key);
}
// ── WEEK DETAIL SUB-TABS ─────────────────────────────────────
// Batches and Material Requirement Summary used to both show at once,
// stacked on the same page - moved to sub-tabs (same table-driven pattern
// as Operations' showOpsSubTab) so only one shows at a time. Sticky across
// which week you open next, same reasoning as Operations staying on
// whichever of its sub-tabs you were last looking at.
let currentWeekDetailSubTab='batches';
const WEEKDETAIL_SUBTAB_CONTAINERS={batches:'weekDetailBatches',material:'weekDetailMaterial'};
const WEEKDETAIL_SUBTAB_BUTTONS={batches:'weekDetailSubBtnBatches',material:'weekDetailSubBtnMaterial'};
function showWeekDetailSubTab(name){
  currentWeekDetailSubTab=name;
  Object.entries(WEEKDETAIL_SUBTAB_CONTAINERS).forEach(([tab,id])=>{
    const el=$(id);
    if(el)el.style.display=(tab===name)?'':'none';
  });
  Object.values(WEEKDETAIL_SUBTAB_BUTTONS).forEach(btnId=>{
    const el=$(btnId);
    if(el)el.classList.toggle('active',btnId===WEEKDETAIL_SUBTAB_BUTTONS[name]);
  });
}
// Same look as Production Schedule now (scheduleRowHtml is the exact
// same row markup, inline edit, and right-click Edit/Delete menu) -
// just pre-filtered to one week's batches instead of showing every
// batch with its own column-filter UI. No separate filter/sort state
// for this grid: a week's batches are already a small, pre-narrowed
// set, so the main grid's per-column filters aren't needed here too.
function renderWeekDetail(key){
  const items=(groupByWeek()[key])||[];
  $('weeklyDetailTitle').textContent=key==='unscheduled'?'No Target Finish Date':weekLabel(key);
  $('weeklyDetailSub').textContent=items.length+' batch'+(items.length===1?'':'es');
  renderWeekMaterialSummary(items);
  if($('weeklyDetailTotals'))$('weeklyDetailTotals').innerHTML=scheduleTotalsBarHtml(items);
  if(!items.length){$('weeklyDetailList').innerHTML='<tr><td colspan="12" class="empty">No batches.</td></tr>';return;}
  const sorted=[...items].sort((a,b)=>(a.target_finish||'9999-99-99').localeCompare(b.target_finish||'9999-99-99'));
  $('weeklyDetailList').innerHTML=sorted.map(b=>scheduleRowHtml(b,false)).join('');
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
// items defaults to every batch (the standalone Material Demand tab's
// scope); Weekly Detail passes just that week's batches instead, so the
// exact same grouping/shortfall math works for both without duplicating
// it - a batch drops out of both the instant it's fully scanned, since
// that's just rowStatus() re-evaluating on the next 4s poll like
// everything else here.
function groupByMaterial(items){
  const groups={};
  (items||scheduleBatches).filter(b=>rowStatus(b)!=='complete').forEach(b=>{
    const key=b.material||'(No Material Specified)';
    (groups[key]=groups[key]||[]).push(b);
  });
  return groups;
}
// Shared by the card view (standalone tab) and the table view (Weekly
// Detail) - one material's demand stats shouldn't be computed two
// different ways depending which screen happens to be showing them.
function materialDemandStats(m,items){
  let total=0,unparsed=0;
  items.forEach(b=>{const q=parseQty(b.sheet_qty);q===null?unparsed++:total+=q;});
  const jobs=[...new Set(items.map(b=>b.job_name).filter(Boolean))].sort();
  // A material group can span batches with different finishes (e.g. ALUM
  // Mill vs ALUM Anodized) - same "distinct values, joined" treatment as
  // Jobs above, rather than picking just one.
  const finishes=[...new Set(items.map(b=>b.finish).filter(Boolean))].sort();
  const onHand=materialStockCache.hasOwnProperty(m)?materialStockCache[m]:null;
  const shortfall=onHand!==null?total-onHand:null;
  const conflict=shortfall!==null&&shortfall>0;
  return{total,unparsed,jobs,finishes,onHand,shortfall,conflict};
}
// Shared table-row builder - the standalone Material Demand tab and the
// Weekly Detail summary show the exact same columns (Material, Finish,
// Sheet Qty Remaining, Open Batches, Jobs, On Hand, Status), just scoped
// to different sets of batches, so there's one place that builds the
// actual <tr> markup instead of two copies that could drift apart.
function materialDemandRowsHtml(items,searchQuery){
  const groups=groupByMaterial(items);
  let materials=Object.keys(groups).sort();
  if(searchQuery)materials=materials.filter(m=>textMatches(searchQuery,m,...groups[m].map(b=>b.job_name)));
  if(!materials.length)return null;
  return materials.map(m=>{
    const mItems=groups[m];
    const{total,unparsed,jobs,finishes,onHand,shortfall,conflict}=materialDemandStats(m,mItems);
    return`<tr>
      <td class="gc-batch">${esc(m)}</td>
      <td>${finishes.length?esc(finishes.join(', ')):''}</td>
      <td class="gc-num">${total}${unparsed?` <span style="color:var(--gray-500);font-weight:400">(+${unparsed} unparsed)</span>`:''}</td>
      <td class="gc-num">${mItems.length}</td>
      <td>${jobs.length?esc(jobs.join(', ')):''}</td>
      <td class="gc-num"><input type="number" class="gc-input" value="${onHand!==null?onHand:''}" placeholder="—" style="width:80px" onclick="event.stopPropagation()" onchange="saveMaterialStock('${esc(m)}',this.value)"></td>
      <td>${onHand===null?'':conflict?'<span style="color:var(--red-600);font-weight:700">Short by '+shortfall+'</span>':'<span style="color:var(--green-700);font-weight:700">Covered</span>'}</td>
    </tr>`;
  }).join('');
}
// Styled like every other Production-Schedule-family grid on this page
// (sched-grid) - this is the one embedded inside Weekly Detail, scoped to
// whatever week is currently open.
function renderWeekMaterialSummary(items){
  const el=$('weeklyMaterialSummary');
  if(!el)return; // not every page has this section yet
  el.innerHTML=materialDemandRowsHtml(items)||'<tr><td colspan="7" class="empty">No open batches this week — nothing currently demanding material.</td></tr>';
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
  if(currentWeekKey)renderWeekMaterialSummary((groupByWeek()[currentWeekKey])||[]);
  try{await api('/admin/api/material-stock/'+encodeURIComponent(material),{method:'POST',body:JSON.stringify({on_hand_qty:qty})});}
  catch(e){/* stays in the cache either way - worst case a stale value until the next successful save */}
}
let materialSearchQuery='';
function setMaterialSearch(v){materialSearchQuery=v.trim().toLowerCase();renderMaterialDemand();}
function renderMaterialDemand(){
  if(!$('materialList'))return; // this tab doesn't exist on every page (gm.html) - loadMaterialStock() calls this unconditionally at boot
  $('materialList').innerHTML=materialDemandRowsHtml(undefined,materialSearchQuery)||`<tr><td colspan="7" class="empty">${materialSearchQuery?'No matches.':'No open batches — nothing currently demanding material.'}</td></tr>`;
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
let jobSummarySearchQuery='';
function setJobSummarySearch(v){jobSummarySearchQuery=v.trim().toLowerCase();renderJobSummary();}
// admin.html has the kanban board (#kanbanOngoing); gm/damon/swar still
// have the plain table (#jobSummaryList) - same call site everywhere
// (showTab's dispatch, setJobSummarySearch, the 4s poll) either way,
// routed here by whichever container actually exists on that page.
function renderJobSummary(){
  if($('kanbanOngoing'))renderJobSummaryKanban();
  else if($('jobSummaryList'))renderJobSummaryTable();
  if(currentJobKey)renderJobDetail(currentJobKey); // keep an already-open job's detail live too
}
function renderJobSummaryTable(){
  const groups=groupByJob();
  let jobs=Object.keys(groups).sort();
  if(jobSummarySearchQuery)jobs=jobs.filter(j=>textMatches(jobSummarySearchQuery,j));
  if(!jobs.length){$('jobSummaryList').innerHTML=`<tr><td colspan="4" class="empty">${Object.keys(groups).length?'No matches.':'No batches in Production Schedule yet.'}</td></tr>`;return;}
  let totalBatches=0,totalScanned=0,totalOfTotal=0;
  $('jobSummaryList').innerHTML=jobs.map(j=>{
    const items=groups[j];
    const{scanned,total,pct}=sumProgress(items);
    totalBatches+=items.length;totalScanned+=scanned;totalOfTotal+=total;
    const floors=[...new Set(items.map(b=>b.floor_or_work_order).filter(Boolean))];
    const state=pct>=100?'complete':pct>0?'progress':'none';
    return`<tr onclick="openJobDetail('${esc(j)}')">
      <td class="gc-batch">${esc(j)}</td>
      <td class="gc-num">${items.length}</td>
      <td><div class="gc-progress"><div class="gc-progress-track"><div class="gc-progress-fill ${state}" style="width:${pct}%"></div></div><div class="gc-count">${scanned}/${total}</div></div></td>
      <td>${floors.length?esc(floors.join(', ')):''}</td>
    </tr>`;
  }).join('')+`<tr class="gc-totals-row">
    <td class="gc-batch">TOTAL — ${jobs.length} job${jobs.length===1?'':'s'}</td>
    <td class="gc-num">${totalBatches}</td>
    <td class="gc-num">${totalScanned}/${totalOfTotal}</td>
    <td></td>
  </tr>`;
}
// ── JOB SUMMARY BOARD (admin.html only) — one card per BATCH, not per
// job (a job with several batches used to average them into one bar,
// which hid a struggling batch behind healthy siblings under the same
// job). Ongoing / Upcoming / Done, plus a pinned Expedite lane above
// both that pulls a batch out of its normal column rather than
// duplicating it. A card's accent color is computeRisk() on that one
// batch - same red/amber/green language Production Schedule's row
// accent already uses.
function daysUntil(dateStr){
  const iso=toISODate(dateStr);
  if(!iso)return null;
  const target=new Date(iso+'T00:00:00');
  const now=new Date();now.setHours(0,0,0,0);
  return Math.round((target-now)/86400000);
}
function kanbanDueBadge(days){
  if(days===null)return null;
  if(days<0)return{label:Math.abs(days)+'d overdue',cls:'kanban-due-red'};
  if(days===0)return{label:'Due today',cls:'kanban-due-red'};
  if(days<=3)return{label:'Due in '+days+'d',cls:'kanban-due-amber'};
  return{label:'Due in '+days+'d',cls:'kanban-due-neutral'};
}
function isExpedited(b){return!!(b.extra_fields&&b.extra_fields.expedite);}
// Idle-days reuses the exact same calculation and the exact same
// user-set threshold as Stalled Batches (workingDaysSince /
// LS_STALLED_THRESHOLD, defined below) rather than inventing a second
// "days idle" number that could disagree with the first one.
function batchAgingDays(b){
  const refDate=b.scanned>0?b.last_scanned_at:b.added_at;
  const idleDays=workingDaysSince(refDate);
  const threshold=Math.max(1,parseInt(localStorage.getItem(LS_STALLED_THRESHOLD),10)||3);
  return(idleDays!==null&&idleDays>=threshold)?idleDays:null;
}
function batchKanbanCardHtml(b){
  const total=b.total||0,scanned=b.scanned||0;
  // Bar fill goes to 100% on a forced Complete, same treatment as the
  // Production Schedule grid - scanned/total in the footer stays the
  // real count regardless.
  const pct=isForceComplete(b)?100:(total?Math.round(scanned/total*100):0);
  const state=rowStatus(b);
  const risk=computeRisk(b);
  const accent=risk?(risk.level==='red'?'var(--red-600)':risk.level==='yellow'?'var(--amber-700)':'var(--green-700)'):'var(--gray-200)';
  const badge=kanbanDueBadge(daysUntil(b.target_finish));
  const expedited=isExpedited(b);
  const blocked=(b.open_note_count||0)>0;
  const agingDays=batchAgingDays(b);
  const chips=[
    b.material?`<span class="kanban-chip">${esc(b.material)}</span>`:'',
    b.sheet_qty?`<span class="kanban-chip">${esc(b.sheet_qty)} sh</span>`:''
  ].filter(Boolean).join('');
  return`<div class="kanban-card${agingDays!==null?' aging':''}" style="border-left-color:${accent}" onclick="viewBatchLabels('${esc(b.batch)}')">
    <div class="kanban-card-top">
      <div class="kanban-card-eyebrow">${esc(b.job_name||'(No Job)')}${b.floor_or_work_order?' · '+esc(b.floor_or_work_order):''}</div>
      <button class="kanban-star${expedited?' on':''}" onclick="toggleExpedite('${esc(b.batch)}',event)" title="${expedited?'Remove from Expedite':'Mark Expedite'}" type="button">&#9733;</button>
    </div>
    <div class="kanban-card-title">${esc(b.batch)}</div>
    ${blocked?`<div class="kanban-blocked-badge">BLOCKED &middot; ${b.open_note_count} open note${b.open_note_count===1?'':'s'}</div>`:''}
    <div class="kanban-progress-track"><div class="kanban-progress-fill ${state}" style="width:${pct}%"></div></div>
    ${chips?`<div class="kanban-chips">${chips}</div>`:''}
    <div class="kanban-card-footer">
      <span>${scanned}/${total} scanned${isForceComplete(b)&&scanned<total?' <span class="kanban-manual-badge">MANUAL</span>':''}</span>
      ${badge?`<span class="kanban-card-due ${badge.cls}">${badge.label}</span>`:''}
    </div>
    ${agingDays!==null?`<div class="kanban-aging">Idle ${agingDays} working day${agingDays===1?'':'s'}</div>`:''}
  </div>`;
}
async function toggleExpedite(batch,ev){
  ev.stopPropagation();
  const b=scheduleBatches.find(x=>x.batch===batch);
  if(!b)return;
  const currentlyOn=isExpedited(b);
  if(!currentlyOn){
    const onCount=scheduleBatches.filter(isExpedited).length;
    // The cap is enforced right here, at the moment someone tries to
    // exceed it - not by silently hiding a 3rd card, which would just
    // make the lane quietly stop meaning anything.
    if(onCount>=2&&!confirm('Expedite is capped at 2 batches on purpose - add a 3rd anyway?'))return;
  }
  const extra=Object.assign({},b.extra_fields||{},{expedite:!currentlyOn});
  const prevExtra=b.extra_fields;
  b.extra_fields=extra; // optimistic
  renderJobSummaryKanban();
  try{
    await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'POST',body:JSON.stringify({extra_fields:extra})});
  }catch(e){
    b.extra_fields=prevExtra;
    renderJobSummaryKanban();
    alert('Could not update expedite: '+e.message);
  }
}
function batchMatchesKanbanFilter(b,mode){
  if(mode==='week'){const d=daysUntil(b.target_finish);return d!==null&&d<=7;}
  if(mode==='late'){const r=computeRisk(b);return!!r&&r.level==='red';}
  return true; // 'all'
}
let kanbanFilterMode='all';
function setKanbanFilter(mode){
  kanbanFilterMode=mode;
  ['All','Week','Late'].forEach(suffix=>{
    const el=$('kanbanFilter'+suffix);
    if(el)el.classList.toggle('active',suffix.toLowerCase()===mode);
  });
  renderJobSummaryKanban();
}
const LS_KANBAN_SWIMLANE='mx_kanban_swimlane';
let kanbanSwimlaneMode=localStorage.getItem(LS_KANBAN_SWIMLANE)||'none';
function setKanbanSwimlane(mode){
  kanbanSwimlaneMode=mode;
  localStorage.setItem(LS_KANBAN_SWIMLANE,mode);
  renderJobSummaryKanban();
}
function kanbanWeekStart(iso){
  const d=new Date(iso+'T00:00:00');
  const day=d.getDay(); // 0=Sun..6=Sat
  d.setDate(d.getDate()+(day===0?-6:1-day)); // back up to that week's Monday
  return d;
}
function kanbanLaneInfo(b,mode){
  if(mode==='job')return{key:b.job_name||'￿',label:b.job_name||'(No Job Specified)'};
  if(mode==='material')return{key:b.material||'￿',label:b.material||'(No Material Specified)'};
  if(mode==='week'){
    const iso=toISODate(b.target_finish);
    if(!iso)return{key:'￿',label:'(No Target Finish)'};
    const start=kanbanWeekStart(iso);
    return{key:start.toISOString().slice(0,10),label:'Week of '+start.toLocaleDateString(undefined,{month:'short',day:'numeric'})};
  }
  return null;
}
// batches arrives already sorted by due date - grouping into lanes here
// preserves that order within each lane, so nothing needs re-sorting
// after the split.
function kanbanColumnHtml(batches){
  if(kanbanSwimlaneMode==='none')return batches.map(batchKanbanCardHtml).join('');
  const lanes={};
  batches.forEach(b=>{
    const info=kanbanLaneInfo(b,kanbanSwimlaneMode);
    (lanes[info.key]=lanes[info.key]||{label:info.label,items:[]}).items.push(b);
  });
  return Object.keys(lanes).sort().map(k=>{
    const lane=lanes[k];
    return`<div class="kanban-lane-head">${esc(lane.label)}</div>`+lane.items.map(batchKanbanCardHtml).join('');
  }).join('');
}
function renderKanbanColumn(bodyId,countId,batches,emptyMsg){
  $(countId).textContent=batches.length;
  $(bodyId).innerHTML=batches.length?kanbanColumnHtml(batches):`<div class="kanban-empty">${emptyMsg}</div>`;
}
function renderJobSummaryKanban(){
  let batches=scheduleBatches.slice();
  if(jobSummarySearchQuery)batches=batches.filter(b=>textMatches(jobSummarySearchQuery,b.batch,b.job_name,b.floor_or_work_order,b.material));
  const dueOf=b=>toISODate(b.target_finish)||'9999-99-99';
  batches.sort((a,b)=>dueOf(a).localeCompare(dueOf(b)));

  const expedited=batches.filter(isExpedited);
  const rest=batches.filter(b=>!isExpedited(b));

  // Done and the Expedite lane both ignore the active This-Week/Late
  // filter on purpose - filtering "what's due soon" doesn't mean
  // anything for work that's already finished or already pinned as a
  // priority override. rowStatus() (not a local pct check) so a batch
  // manually marked Complete from the Production Schedule tab lands
  // here too, same as one that's genuinely 100% scanned.
  const done=rest.filter(b=>rowStatus(b)==='complete');
  const open=rest.filter(b=>rowStatus(b)!=='complete'&&batchMatchesKanbanFilter(b,kanbanFilterMode));
  const ongoing=open.filter(b=>(b.scanned||0)>0);
  const upcoming=open.filter(b=>(b.scanned||0)===0);

  $('kanbanExpedite').innerHTML=expedited.length?expedited.map(batchKanbanCardHtml).join(''):'<div class="kanban-expedite-empty">Nothing pinned. Use the star on a card to expedite it (capped at 2).</div>';
  $('kanbanExpediteCount').textContent=expedited.length+' / 2';

  const noMatches=scheduleBatches.length?'No matches.':null;
  renderKanbanColumn('kanbanOngoing','kanbanOngoingCount',ongoing,noMatches||'Nothing in progress right now.');
  renderKanbanColumn('kanbanUpcoming','kanbanUpcomingCount',upcoming,noMatches||'Nothing waiting to start.');
  renderKanbanColumn('kanbanDone','kanbanDoneCount',done,noMatches||'Nothing finished yet.');
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
// Whether the slip currently being built should include still-unscanned
// parts - only ever meaningful for a manually-completed batch that isn't
// fully scanned (openPackingForm asks once, up front); true otherwise,
// since a genuinely fully-scanned batch has nothing to exclude.
let packingIncludeUnscanned=true;
// A part with no recorded scan yet gets a small dot next to its tag on
// both the editable/locked previews and the printed slip itself, so
// "which of these did I actually scan" stays visible even once the
// unscanned ones are included. p.scanned is only present on parts
// loaded fresh (openPackingForm) or on a slip created after this
// feature shipped - an older slip's snapshot predates the field, so
// this quietly renders no dot for it rather than guessing.
function unscannedDot(p){
  return p.scanned&&p.scanned!=='Yes'?'<span class="ps-unscanned-dot" title="Not scanned">&#9679;</span> ':'';
}
// ── SPLIT SHIPMENTS — a batch's parts don't all have to go out on one
// slip. Every part already placed on ANY existing slip for a batch
// (unioned across all of them, deduped by unique_id) is what "already
// packed" means here - openPackingForm below excludes these by default
// so a follow-up slip naturally offers only what's left, and
// renderPackingTab uses this same count to decide whether a batch still
// belongs in Ready to Pack (now: "has anything left to pack", not just
// "has no slip yet").
function packedUniqueIds(batch){
  const ids=new Set();
  packingSlipsCache.filter(s=>s.batch===batch).forEach(s=>(s.parts_snapshot||[]).forEach(p=>ids.add(p.unique_id)));
  return ids;
}

// A batch is "fully accounted for" once every part is either packed
// (on some slip) or marked delivered within the building - either way
// it needs no more packing-slip work. delivered_internally_count comes
// from /viewer/api/batches as a plain aggregate (not a per-part set
// like packedUniqueIds), which is fine here: the two buckets can't
// overlap (the server rejects marking an already-packed part as
// internal, and excludes internal parts from what a new slip can
// offer), so a plain sum is exact, not just an estimate.
function accountedForCount(b){
  return packedUniqueIds(b.batch).size+(b.delivered_internally_count||0);
}
// A batch stays in Ready to Pack as long as it still has at least one
// part not accounted for - not just "no slip yet", so a partial
// shipment (some parts slipped today, the rest later, or some
// delivered on-site) keeps the batch reachable here for a follow-up
// slip instead of disappearing the moment the first one exists. It
// only drops out once every part is accounted for, at which point it
// shows up instead in Completed Tasks (renderCompletedTasks below).
function renderPackingTab(){
  const ready=scheduleBatches.filter(b=>rowStatus(b)==='complete'&&accountedForCount(b)<b.total);
  $('readyToPackList').innerHTML=ready.length?ready.map(b=>{
    const accountedCount=accountedForCount(b);
    const hasSlip=packingSlipsCache.some(s=>s.batch===b.batch);
    const deliveredCount=b.delivered_internally_count||0;
    const metaExtra=accountedCount?` · ${accountedCount}/${b.total} already accounted for${deliveredCount?` (${deliveredCount} delivered within building)`:''}`:'';
    return`<div class="card">
      <div>
        <div class="name">${esc(b.batch)}</div>
        <div class="meta">${esc(b.job_name||'(no job)')} · ${b.scanned}/${b.total} scanned${metaExtra}</div>
      </div>
      <button onclick="openPackingForm('${esc(b.batch)}')">${hasSlip||deliveredCount?`Create Another Slip (${b.total-accountedCount} left)`:'Create Packing Slip'}</button>
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
// ── COMPLETED TASKS — every batch that has at least one packing slip, as
// a compact table row rather than a full-detail card (this list only ever
// grows, so a card per batch - each ten-plus lines tall - doesn't scale;
// a row does). "Completed" date is the batch's most recent packing slip's
// slip_date, since that's the moment the task was actually finished, not
// target_finish (which is when it was *due*).
function completedTaskDate(b){
  const dates=packingSlipsCache.filter(s=>s.batch===b.batch).map(s=>toISODate(s.slip_date)).filter(Boolean).sort();
  return dates.length?dates[dates.length-1]:null;
}
function completedTasksRaw(){
  return scheduleBatches.filter(b=>packingSlipsCache.some(s=>s.batch===b.batch)).map(b=>({b,date:completedTaskDate(b)}));
}
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
// Year -> Month -> Week is cascading: each dropdown's options are only the
// values that actually appear given what's already picked above it (an
// "August" with nothing completed in it never shows up), and a value that's
// still valid after a parent changes is kept selected rather than reset -
// only the ones that no longer apply fall back to "All".
function populateCompletedFilterOptions(){
  const yearSel=$('ctFilterYear'),monthSel=$('ctFilterMonth'),weekSel=$('ctFilterWeek');
  if(!yearSel)return;
  const items=completedTasksRaw().filter(x=>x.date);
  const prevYear=yearSel.value,prevMonth=monthSel.value,prevWeek=weekSel.value;

  const years=[...new Set(items.map(x=>x.date.slice(0,4)))].sort().reverse();
  yearSel.innerHTML='<option value="">All Years</option>'+years.map(y=>`<option value="${y}">${y}</option>`).join('');
  yearSel.value=years.includes(prevYear)?prevYear:'';

  const yearItems=yearSel.value?items.filter(x=>x.date.slice(0,4)===yearSel.value):items;
  const months=[...new Set(yearItems.map(x=>parseInt(x.date.slice(5,7),10)))].sort((a,b)=>a-b);
  monthSel.innerHTML='<option value="">All Months</option>'+months.map(m=>`<option value="${m}">${MONTH_NAMES[m-1]}</option>`).join('');
  monthSel.value=months.map(String).includes(prevMonth)?prevMonth:'';

  const monthItems=monthSel.value?yearItems.filter(x=>parseInt(x.date.slice(5,7),10)===parseInt(monthSel.value,10)):yearItems;
  const weekKeys=[...new Set(monthItems.map(x=>weekKeyFor(x.date)).filter(Boolean))].sort();
  weekSel.innerHTML='<option value="">All Weeks</option>'+weekKeys.map(k=>`<option value="${k}">${weekLabel(k)}</option>`).join('');
  weekSel.value=weekKeys.includes(prevWeek)?prevWeek:'';
}
function completedTaskRowHtml(b,date,slips){
  const latest=[...slips].sort((a,b2)=>(a.slip_date||'').localeCompare(b2.slip_date||'')||a.id-b2.id).pop();
  const slipLabel=slips.length===1?slips[0].slip_number:slips.length+' slips';
  return`<tr onclick="viewPackingSlip(${latest.id})" oncontextmenu="openPackingCtxMenu(event,${latest.id})" style="cursor:pointer">
    <td class="gc-batch">${esc(b.batch)}</td>
    <td>${esc(b.job_name||'')}</td>
    <td>${esc(b.floor_or_work_order||'')}</td>
    <td>${esc(b.material||'')}</td>
    <td>${esc(b.part_name||'')}</td>
    <td class="gc-num">${b.scanned}/${b.total}</td>
    <td>${esc(slipLabel)}</td>
    <td>${esc(date||'—')}</td>
  </tr>`;
}
function renderCompletedTasks(){
  const tbody=$('completedTasksList');
  if(!tbody)return; // not every dashboard page has this tab
  populateCompletedFilterOptions();
  const yearSel=$('ctFilterYear'),monthSel=$('ctFilterMonth'),weekSel=$('ctFilterWeek');
  const jobQ=($('ctSearchJob').value||'').trim().toLowerCase();
  const floorQ=($('ctSearchFloor').value||'').trim().toLowerCase();
  const batchQ=($('ctSearchBatch').value||'').trim().toLowerCase();

  let rows=completedTasksRaw();
  const anyCompleted=rows.length>0;
  if(yearSel.value)rows=rows.filter(x=>x.date&&x.date.slice(0,4)===yearSel.value);
  if(monthSel.value)rows=rows.filter(x=>x.date&&parseInt(x.date.slice(5,7),10)===parseInt(monthSel.value,10));
  if(weekSel.value)rows=rows.filter(x=>x.date&&weekKeyFor(x.date)===weekSel.value);
  if(jobQ)rows=rows.filter(x=>(x.b.job_name||'').toLowerCase().includes(jobQ));
  if(floorQ)rows=rows.filter(x=>(x.b.floor_or_work_order||'').toLowerCase().includes(floorQ));
  if(batchQ)rows=rows.filter(x=>(x.b.batch||'').toLowerCase().includes(batchQ));
  rows.sort((x,y)=>(y.date||'').localeCompare(x.date||'')); // most recently completed first

  if(!rows.length){
    tbody.innerHTML=`<tr><td colspan="8" class="empty">${anyCompleted?'No matches.':'No completed tasks yet — a batch shows up here once its first packing slip is created.'}</td></tr>`;
    return;
  }
  tbody.innerHTML=rows.map(x=>completedTaskRowHtml(x.b,x.date,packingSlipsCache.filter(s=>s.batch===x.b.batch))).join('');
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
    if(currentTab==='completed')renderCompletedTasks();
  }catch(e){/* leave last-known cache showing rather than blank it on a transient error */}
}

async function openPackingForm(batch){
  editingSlipId=null;
  currentPackingBatch=batch;
  const b=scheduleBatches.find(x=>x.batch===batch)||{};
  const alreadySlipped=packingSlipsCache.some(s=>s.batch===batch);
  $('packingFormTitle').textContent=alreadySlipped?'New Packing Slip (additional shipment)':'New Packing Slip';
  $('packingFormSubmitBtn').textContent='Generate Packing Slip';
  $('packingFormBatchLabel').textContent=batch+' — '+b.scanned+'/'+b.total+' scanned';
  $('pfDepartment').value='';
  $('pfDate').value=new Date().toISOString().slice(0,10);
  $('pfShipTo').value='';
  $('pfJob').value=b.job_name||'';
  $('pfFloor').value=b.floor_or_work_order||'';
  $('pfCheckedBy').value='';
  $('pfComments').value='';
  $('pfSpecial').value='';
  packingPartsSelected=new Set();
  if($('pfPartsFilter'))$('pfPartsFilter').value='';
  if($('pfGroupName'))$('pfGroupName').value='';
  packingPartsEditable=true;
  packingIncludeUnscanned=true;
  $('packingFormPartsPreview').innerHTML='<div class="empty">Loading part list…</div>';
  showTab('packingForm');
  try{
    const data=await api('/viewer/api/batches/'+encodeURIComponent(batch));
    const allLabels=data.labels||[];
    // ── SPLIT SHIPMENTS — parts already placed on an earlier slip for
    // this batch are excluded by default, so a second/third slip for the
    // same batch naturally starts from just what's left instead of
    // re-offering everything (removeSelectedPackingParts below lets the
    // remaining set be narrowed further, e.g. splitting today's leftover
    // parts across two more slips instead of one). Parts marked
    // delivered within the building are excluded too - they never need
    // a packing slip at all.
    const packedIds=packedUniqueIds(batch);
    const labels=allLabels.filter(l=>!packedIds.has(l.unique_id)&&l.delivered_internally!=='Yes');
    if(!labels.length){
      alert('Every part in this batch is already accounted for (on a packing slip, or delivered within the building).');
      showTab('packing');
      return;
    }
    const unscannedCount=labels.filter(l=>l.scanned!=='Yes').length;
    // A manually-completed batch (Task Status -> Complete (Manual)) can
    // still have unscanned parts on record - ask once, up front, whether
    // this slip should include them or just what was actually scanned.
    // A genuinely fully-scanned batch never has an unscanned part to ask
    // about, so this never fires for the normal path. Counts here are
    // against the not-yet-packed set, not the whole batch, so the
    // numbers stay accurate on a second/third slip too.
    if(unscannedCount>0&&isForceComplete(b)){
      const packedNote=alreadySlipped?` (${packedIds.size} part(s) already on an earlier slip aren't included in this count)`:'';
      packingIncludeUnscanned=confirm(
        `This batch was marked Complete (Manual) with ${unscannedCount} of ${labels.length} not-yet-packed part(s) still not scanned${packedNote}.\n\n`+
        `Include the ${unscannedCount} unscanned part(s) on this packing slip?\n\n`+
        `OK = include all ${labels.length} remaining parts.\nCancel = only the ${labels.length-unscannedCount} already-scanned part(s).`
      );
    }
    const visibleLabels=packingIncludeUnscanned?labels:labels.filter(l=>l.scanned==='Yes');
    currentPackingParts=visibleLabels.map(l=>({unique_id:l.unique_id,tag:l.tag,part_type:l.part_type,width:l.width,height:l.height,qty:l.qty,colour:l.colour,scanned:l.scanned,group:''}));
    renderPackingPartsPreview();
  }catch(e){
    $('packingFormPartsPreview').innerHTML='<div class="empty">Could not load part list.</div>';
  }
}
// ── PART LIST EDITOR (filter / reorder / group) — only meaningful while
// creating a new slip (packingPartsEditable), since an already-issued
// slip's parts_snapshot is locked (see openPackingEditForm below). A
// "group" is just a label on a part; the UI's job is keeping every part
// sharing a group contiguous in currentPackingParts so rendering it is a
// simple "print a header whenever the group changes" pass, both here and
// in the print view / read-only edit view.
let packingPartsEditable=false;
let packingPartsSelected=new Set();
function getPackingBlockRange(parts,i){
  const g=parts[i].group||'';
  if(!g)return{start:i,end:i,group:''};
  let start=i,end=i;
  while(start>0&&parts[start-1].group===g)start--;
  while(end<parts.length-1&&parts[end+1].group===g)end++;
  return{start,end,group:g};
}
// Moves the whole block a part belongs to (a multi-part group moves as one
// unit; an ungrouped part's "block" is just itself) past its neighboring
// block in the given direction - so grouping something doesn't lose the
// ability to reposition it, it just repositions as a section instead of
// part by part.
function movePackingPart(uid,dir){
  const parts=currentPackingParts;
  const i=parts.findIndex(p=>p.unique_id===uid);
  if(i<0)return;
  const block=getPackingBlockRange(parts,i);
  if(dir<0){
    if(block.start===0)return;
    const prev=getPackingBlockRange(parts,block.start-1);
    currentPackingParts=[...parts.slice(0,prev.start),...parts.slice(block.start,block.end+1),...parts.slice(prev.start,prev.end+1),...parts.slice(block.end+1)];
  }else{
    if(block.end===parts.length-1)return;
    const next=getPackingBlockRange(parts,block.end+1);
    currentPackingParts=[...parts.slice(0,block.start),...parts.slice(next.start,next.end+1),...parts.slice(block.start,block.end+1),...parts.slice(next.end+1)];
  }
  renderPackingPartsPreview();
}
function togglePackingPartSelect(uid,checked){
  checked?packingPartsSelected.add(uid):packingPartsSelected.delete(uid);
}
// Pulls every selected part out of its current position and reinserts them
// together as one contiguous block, right where the earliest-selected one
// used to be - so grouping something roughly keeps it where you were
// looking, rather than jumping to the top or bottom of the list.
function groupSelectedPackingParts(){
  const name=($('pfGroupName').value||'').trim();
  if(!name){alert('Enter a group name first.');return;}
  if(!packingPartsSelected.size){alert('Select at least one part to group.');return;}
  const parts=currentPackingParts;
  const firstIdx=parts.findIndex(p=>packingPartsSelected.has(p.unique_id));
  const insertAt=parts.slice(0,firstIdx).filter(p=>!packingPartsSelected.has(p.unique_id)).length;
  const grouped=parts.filter(p=>packingPartsSelected.has(p.unique_id)).map(p=>({...p,group:name}));
  const rest=parts.filter(p=>!packingPartsSelected.has(p.unique_id));
  currentPackingParts=[...rest.slice(0,insertAt),...grouped,...rest.slice(insertAt)];
  packingPartsSelected=new Set();
  $('pfGroupName').value='';
  renderPackingPartsPreview();
}
function ungroupPackingGroup(group){
  currentPackingParts=currentPackingParts.map(p=>p.group===group?{...p,group:''}:p);
  renderPackingPartsPreview();
}
// ── SPLIT SHIPMENTS — takes the selected parts out of THIS slip
// entirely (not just ungrouped), for splitting a batch's remaining
// parts across two or more slips in one sitting: remove a few now,
// generate this slip, then open "Create Another Slip" for the batch
// again and the ones just removed are still sitting there waiting
// (they were never actually submitted, so packedUniqueIds never counted
// them) - same selection checkboxes Group Selected already uses, just a
// different action on the selection.
function removeSelectedPackingParts(){
  if(!packingPartsSelected.size){alert('Select at least one part to remove.');return;}
  currentPackingParts=currentPackingParts.filter(p=>!packingPartsSelected.has(p.unique_id));
  packingPartsSelected=new Set();
  renderPackingPartsPreview();
}
// Filter only narrows what's visible while arranging - it never removes a
// part from currentPackingParts, so it can't accidentally leave something
// off the actual slip. Selection is tracked by unique_id (not row index),
// so it survives the filter changing what's currently shown.
function renderPackingPartsPreview(){
  const el=$('packingFormPartsPreview');
  if(!el)return;
  const parts=currentPackingParts;
  if(!parts.length){el.innerHTML='<div class="empty">No parts on record for this batch.</div>';return;}
  if(!packingPartsEditable){
    el.innerHTML='<div class="sub" style="margin-bottom:8px">Part list is locked to what was packed when this slip was created — not editable here.</div>'
      +'<div class="sched-grid-wrap"><table class="rep-tbl"><thead><tr><th>Tag</th><th>Part Type</th><th>Size</th><th>Qty</th><th>Colour</th></tr></thead><tbody>'
      +parts.map((p,i)=>{
        const header=p.group&&(i===0||parts[i-1].group!==p.group)?`<tr><td colspan="5" style="background:var(--gray-100);font-weight:700;text-align:left">${esc(p.group)}</td></tr>`:'';
        return header+`<tr><td>${unscannedDot(p)}${esc(p.tag||p.unique_id)}</td><td>${esc(p.part_type||'')}</td><td>${esc([p.width,p.height].filter(Boolean).join(' X '))}</td><td>${esc(p.qty||'')}</td><td>${esc(p.colour||'')}</td></tr>`;
      }).join('')
      +'</tbody></table></div>';
    return;
  }
  const q=(($('pfPartsFilter')&&$('pfPartsFilter').value)||'').trim().toLowerCase();
  const matches=p=>!q||[p.tag,p.part_type,p.colour].some(v=>String(v||'').toLowerCase().includes(q));
  let rows='';
  parts.forEach((p,i)=>{
    if(!matches(p))return;
    if(p.group&&(i===0||parts[i-1].group!==p.group)){
      rows+=`<tr><td colspan="7" style="background:var(--gray-100);font-weight:700;text-align:left">${esc(p.group)} <button type="button" class="secondary" style="padding:2px 8px;font-size:12px;margin-left:8px" onclick="ungroupPackingGroup('${esc(p.group)}')">Ungroup</button></td></tr>`;
    }
    const block=getPackingBlockRange(parts,i);
    rows+=`<tr>
      <td><input type="checkbox" ${packingPartsSelected.has(p.unique_id)?'checked':''} onchange="togglePackingPartSelect('${esc(p.unique_id)}',this.checked)"></td>
      <td>${unscannedDot(p)}${esc(p.tag||p.unique_id)}</td><td>${esc(p.part_type||'')}</td>
      <td>${esc([p.width,p.height].filter(Boolean).join(' X '))}</td>
      <td>${esc(p.qty||'')}</td><td>${esc(p.colour||'')}</td>
      <td style="white-space:nowrap">
        <button type="button" onclick="movePackingPart('${esc(p.unique_id)}',-1)" ${block.start===0?'disabled':''} title="Move up">&#9650;</button>
        <button type="button" onclick="movePackingPart('${esc(p.unique_id)}',1)" ${block.end===parts.length-1?'disabled':''} title="Move down">&#9660;</button>
      </td>
    </tr>`;
  });
  el.innerHTML=`<div class="sched-grid-wrap"><table class="rep-tbl"><thead><tr><th></th><th>Tag</th><th>Part Type</th><th>Size</th><th>Qty</th><th>Colour</th><th>Order</th></tr></thead>`
    +`<tbody>${rows||'<tr><td colspan="7" class="empty">No parts match that filter.</td></tr>'}</tbody></table></div>`;
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
    packingPartsEditable=false;
    renderPackingPartsPreview();
    showTab('packingForm');
  }catch(e){alert('Could not load packing slip: '+e.message);}
}
$('bBackPackingForm').onclick=()=>{currentPackingBatch=null;editingSlipId=null;showTab('packing');};

async function submitPackingForm(){
  if(!currentPackingBatch)return;
  // Removing every part via Remove Selected leaves nothing to submit -
  // the server would otherwise treat an empty parts_snapshot as "not
  // sent" and silently fall back to including everything eligible,
  // which is the opposite of what an empty list here should mean.
  if(!editingSlipId&&!currentPackingParts.length){
    alert('This slip has no parts left on it - add at least one back before generating it.');
    return;
  }
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
      :await api('/admin/api/packing-slips',{method:'POST',body:JSON.stringify({...fields,batch:currentPackingBatch,parts_snapshot:currentPackingParts,include_unscanned:packingIncludeUnscanned})});
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
// Item numbers stay sequential across the whole slip (a group header row
// doesn't consume a number) - groups are a visual section break for
// readability, not a renumbering, so "item 14" still means the same thing
// whether or not it happens to fall inside a group.
function packingSlipBodyRowsHtml(parts,cell){
  let n=0;
  return parts.map((p,i)=>{
    const header=p.group&&(i===0||parts[i-1].group!==p.group)
      ?`<tr class="ps-group-row"><td colspan="6">${cell(p.group)}</td></tr>`:'';
    n++;
    return header+`<tr><td>${n}</td><td>${unscannedDot(p)}${cell(p.tag||p.unique_id)}</td><td>${cell(p.part_type)}</td><td>${cell([p.width,p.height].filter(Boolean).join(' X '))}</td><td>${cell(p.qty)}</td><td>${cell(p.colour)}</td></tr>`;
  }).join('');
}
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
      <tbody>${packingSlipBodyRowsHtml(parts,cell)}
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
// Installed as a desktop app (see manifest-*.json), this page has no
// address bar or browser refresh icon to fall back on - this button is
// the only obvious way to pull a fresh copy after a server-side update.
// Unregisters any service worker first (sw.js is a pure passthrough
// today with nothing to invalidate, but this makes the button correct
// even if that ever changes) and reloads with a cache-busting query
// param, forcing a genuinely fresh network fetch of the page itself
// rather than trusting a normal reload's cache revalidation.
function hardRefresh(){
  const goFresh=()=>{location.href=location.pathname+'?_hr='+Date.now();};
  if('serviceWorker' in navigator&&navigator.serviceWorker.getRegistrations){
    navigator.serviceWorker.getRegistrations().then(regs=>Promise.all(regs.map(r=>r.unregister()))).catch(()=>{}).then(goFresh);
  }else{
    goFresh();
  }
}
// Ctrl+Shift+R (the usual "hard refresh" combo) is reserved by the
// browser itself - it never reaches page JS to intercept, installed app
// or not. Ctrl+Alt+R isn't reserved, so it's the one shortcut that can
// actually be wired up here to trigger the same unregister-then-reload
// as the button.
document.addEventListener('keydown',e=>{
  if(e.ctrlKey&&e.altKey&&!e.shiftKey&&(e.key==='r'||e.key==='R')){
    e.preventDefault();
    hardRefresh();
  }
});

// Red dot on Hard Refresh when a newer deploy exists. appVersionBaseline
// is set on the FIRST check after this page loaded and never updated
// again from here - it stays "the version this page is running", so a
// later mismatch means something changed since load, not since the last
// poll. hardRefresh() reloads the whole page fresh, which re-runs this
// script and captures a new (now-current) baseline, clearing the dot.
let appVersionBaseline=null;
async function checkAppVersion(){
  if(!KEY)return;
  try{
    const data=await api('/admin/api/app-version');
    if(appVersionBaseline===null){appVersionBaseline=data.version;return;}
    if(data.version>appVersionBaseline){
      const btn=$('bHardRefresh');
      if(btn)btn.classList.add('has-update');
    }
  }catch(e){}
}
checkAppVersion();
setInterval(checkAppVersion,120000);

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
let stalledSearchQuery='';
function setStalledSearch(v){stalledSearchQuery=v.trim().toLowerCase();renderStalledBatches();}
function renderStalledBatches(){
  if(!$('stalledThreshold'))return; // not every page has this tab (gm.html)
  const saved=localStorage.getItem(LS_STALLED_THRESHOLD);
  if(saved)$('stalledThreshold').value=saved;
  const threshold=Math.max(1,parseInt($('stalledThreshold').value,10)||3);
  const open=scheduleBatches.filter(b=>rowStatus(b)!=='complete');
  let stalled=open.map(b=>{
    const refDate=b.scanned>0?b.last_scanned_at:b.added_at;
    const idleDays=workingDaysSince(refDate);
    return{b,idleDays,refDate,started:b.scanned>0};
  }).filter(r=>r.idleDays!==null&&r.idleDays>=threshold)
    .sort((a,b)=>b.idleDays-a.idleDays);
  if(stalledSearchQuery)stalled=stalled.filter(({b})=>textMatches(stalledSearchQuery,b.batch,b.job_name,b.material,b.floor_or_work_order));
  if(!stalled.length){$('stalledList').innerHTML='<tr><td colspan="7" class="empty">No batches idle '+threshold+'+ working days — nothing stalled right now.</td></tr>';return;}
  $('stalledList').innerHTML=stalled.map(({b,idleDays,refDate,started})=>{
    return`<tr onclick="viewBatchLabels('${esc(b.batch)}')">
      <td class="gc-batch">${esc(b.batch)}</td>
      <td>${esc(b.job_name||'')}</td>
      <td>${esc(b.material||'')}</td>
      <td>${esc(b.floor_or_work_order||'')}</td>
      <td class="gc-num">${b.scanned}/${b.total}</td>
      <td>${started?'Last scan':'Registered, never scanned'} ${esc(fmt(refDate))}</td>
      <td><span class="pill notstarted">${idleDays}d idle</span></td>
    </tr>`;
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
let riskSearchQuery='';
function setRiskSearch(v){riskSearchQuery=v.trim().toLowerCase();renderAtRisk();}
function renderAtRisk(){
  if(!$('riskList'))return; // not every page has this tab (gm.html)
  let atRisk=scheduleBatches
    .map(b=>({b,risk:computeRisk(b)}))
    .filter(r=>r.risk&&r.risk.level==='red')
    .sort((a,b)=>a.risk.daysRemaining-b.risk.daysRemaining);
  if(riskSearchQuery)atRisk=atRisk.filter(({b})=>textMatches(riskSearchQuery,b.batch,b.job_name,b.material,b.floor_or_work_order));
  if(!atRisk.length){$('riskList').innerHTML='<tr><td colspan="7" class="empty">Nothing at risk right now.</td></tr>';return;}
  $('riskList').innerHTML=atRisk.map(({b,risk})=>{
    const dueText=risk.daysRemaining<0?Math.abs(risk.daysRemaining)+' day'+(Math.abs(risk.daysRemaining)===1?'':'s')+' overdue':risk.daysRemaining+' day'+(risk.daysRemaining===1?'':'s')+' left';
    return`<tr onclick="viewBatchLabels('${esc(b.batch)}')">
      <td class="gc-batch">${esc(b.batch)}</td>
      <td>${esc(b.job_name||'')}</td>
      <td>${esc(b.material||'')}</td>
      <td>${esc(b.floor_or_work_order||'')}</td>
      <td class="gc-num">${b.scanned}/${b.total} (${Math.round(risk.completionPct)}%)</td>
      <td>${esc(toISODate(b.target_finish)||b.target_finish)}</td>
      <td><span class="pill notstarted">${dueText}</span></td>
    </tr>`;
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
// Manual "Complete" override (Production Schedule tab, admin.html only)
// - lets an admin close a batch out even when it's not fully scanned
// (a barcode never worked, work happened off a cart the scanner never
// saw, etc). Stored in extra_fields (no schema change) rather than as
// a real task_status value, so it's a genuinely separate signal from
// the scan-derived one - rowStatus below is the ONE place that blends
// them, so every screen that already calls rowStatus (Stalled Batches,
// At Risk via computeRisk, the kanban board, this grid) picks the
// override up for free instead of needing its own special case.
function isForceComplete(b){return!!(b.extra_fields&&b.extra_fields.forceComplete);}
function rowStatus(b){return isForceComplete(b)||(b.total>0&&b.scanned===b.total)?'complete':b.scanned>0?'progress':'none';}
function statusLabel(v){return v==='complete'?'Complete':v==='progress'?'In Progress':'Not Started';}
function effectiveTaskStatus(b){return rowStatus(b)==='complete'?'Complete':(b.task_status||'Not Started');}
function colValue(b,key){return key==='status'?rowStatus(b):key==='task_status'?effectiveTaskStatus(b):(b[key]||'');}
function uniqueValuesFor(key){
  if(key==='status')return['complete','progress','none'];
  if(key==='task_status')return['Not Started','Cut','Bending','Assembly','Complete'];
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
  if(!e.target.closest('#deletedBatchesPopover')&&!e.target.closest('#bDeletedBatches'))closeDeletedBatchesPanel();
  if(!e.target.closest('#columnsPopover')&&!e.target.closest('#bColumns'))closeColumnsPanel();
  if(!e.target.closest('#stagesPopover')&&!e.target.closest('#bStages'))closeStagesPanel();
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
// Right-click a Production Schedule row to delete it - editing now
// happens per-cell (double-click a field), so there's no more row-wide
// "Edit" mode for this menu to toggle into/out of. When the right-click
// landed inside a specific cell (data-col, set by editableTd/the fixed
// cells in scheduleRowHtml), the menu also offers per-cell text
// alignment - Excel-style, but scoped to just that one cell rather than
// a selected range, since row/range selection was removed.
function openRowContextMenu(evt,batch){
  evt.preventDefault();
  evt.stopPropagation();
  const menu=$('rowCtxMenu');
  const b=scheduleBatches.find(x=>x.batch===batch);
  const flagged=isRowFlagged(b);
  const cellTd=evt.target&&evt.target.closest?evt.target.closest('td[data-col]'):null;
  const colKey=cellTd?cellTd.getAttribute('data-col'):null;
  const alignItems=colKey?`
    <div class="ctx-menu-item" onclick="closeRowContextMenu();setCellAlign('${esc(batch)}','${colKey}','left')">&#8676; Align Left</div>
    <div class="ctx-menu-item" onclick="closeRowContextMenu();setCellAlign('${esc(batch)}','${colKey}','center')">&#8646; Align Center</div>
    <div class="ctx-menu-item" onclick="closeRowContextMenu();setCellAlign('${esc(batch)}','${colKey}','right')">&#8677; Align Right</div>
    <div class="ctx-menu-divider"></div>`:'';
  menu.innerHTML=alignItems+`<div class="ctx-menu-item" onclick="closeRowContextMenu();toggleRowFlag('${esc(batch)}')">${flagged?'&#128481; Remove Flag':'&#128681; Flag Row'}</div><div class="ctx-menu-item danger" onclick="closeRowContextMenu();deleteBatchFromGrid('${esc(batch)}')">${ICON_DELETE} Delete</div>`;
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
  if(isForceComplete(b)||(b.total>0&&b.scanned===b.total))return null;
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

// A custom column's value lives at b.extra_fields[key] instead of
// b[key] directly - keyed off the 'custom_' prefix every custom-column
// key is guaranteed to carry (assigned server-side), so callers never
// need to say which kind of field they're pointing at.
function fieldValue(b,key){
  return key.indexOf('custom_')===0?((b.extra_fields&&b.extra_fields[key])||''):(b[key]||'');
}
// One editable cell, as a complete <td> - shared by every sched-grid row
// on the page (Production Schedule, Weekly Detail). Double-click anywhere
// in the cell to edit just that field; every other cell, including the
// rest of this same row, stays plain text. isDate display normalizes
// through toISODate too, not just the edit input's value - Target Finish
// is free-text from Excel/manual edits, so "2026/08/18" and "2026-08-18"
// both end up stored, and showed up raw before. Falls back to the
// original string if it can't be parsed, so nothing ever goes blank over
// a format toISODate doesn't recognize.
function editableTd(b,key,isDate,extraClass,includeRowHandle){
  const isEditingThis=editingCell&&editingCell.batch===b.batch&&editingCell.key===key;
  const cls=extraClass?` class="${extraClass}"`:'';
  const alignCss=cellAlignStyle(b,key);
  const styleAttr=alignCss?` style="${alignCss}"`:'';
  // Only the row's first cell carries the row-resize handle - see the
  // ROW HEIGHT RESIZE section above for why it lives here instead of a
  // dedicated gutter column.
  const handleHtml=includeRowHandle?`<div class="row-resize-handle" onmousedown="startRowResize(event,'${esc(b.batch)}')" title="Drag to resize row"></div>`:'';
  if(isEditingThis){
    const val=isDate?toISODate(fieldValue(b,key)):esc(fieldValue(b,key));
    return`<td${cls}${styleAttr} data-col="${key}"><input class="gc-input" type="${isDate?'date':'text'}" value="${val}" onclick="event.stopPropagation()" onkeydown="handleCellEditKeydown(event,'${esc(b.batch)}','${key}')" onblur="onCellInputBlur('${esc(b.batch)}','${key}')">${handleHtml}</td>`;
  }
  const raw=fieldValue(b,key);
  const text=esc(isDate?(toISODate(raw)||raw):raw);
  return`<td${cls}${styleAttr} data-col="${key}" ondblclick="event.stopPropagation();startCellEdit('${esc(b.batch)}','${key}',${!!isDate})">${text}${handleHtml}</td>`;
}
// ── MULTI-MATERIAL SPLIT ROWS — the Excel form's "MULTIPLE MATERIAL"
// section stores one pipe-joined string per field (material/finish/
// sheet_qty), one entry per material row on the form (JoinRows in the
// VBA macro is what produces these " | "-joined strings) - shown here
// as one <tr> per entry instead of a single row hiding the whole
// breakdown behind one cell reading "ALUM | STEEL". Everything that
// ISN'T material/finish/sheet-qty is batch-level, not per-material
// (Job, Floor, Comment, Task Status, the progress bar...), so it only
// renders on the group's first row; the rest render blank, same
// grouped-outline look a spreadsheet gives repeated values. Read-only
// for now - double-click-to-edit on a split Material/Finish/Sheet Qty
// cell only makes sense once there's a real per-entry write-back
// instead of one shared pipe-joined string, which isn't built yet.
function splitPipeField(v){
  const parts=String(v||'').split('|').map(s=>s.trim());
  return parts.length?parts:[''];
}
function readOnlyTd(b,key,text,extraClass){
  const cls=extraClass?` class="${extraClass}"`:'';
  const alignCss=cellAlignStyle(b,key);
  const styleAttr=alignCss?` style="${alignCss}"`:'';
  return`<td${cls}${styleAttr} data-col="${key}">${esc(text)}</td>`;
}
// The blank stand-in for a batch-level column on every split row after
// the first. rowHandleBatch is only ever passed for the row's first
// cell (job_name's position) so every sub-row of a split group can
// still be grabbed to resize - rowHeights is keyed by batch, not by
// sub-row, so dragging any of them moves the whole group together.
function blankTd(key,extraClass,rowHandleBatch){
  const cls=extraClass?` class="${extraClass}"`:'';
  const handleHtml=rowHandleBatch?`<div class="row-resize-handle" onmousedown="startRowResize(event,'${esc(rowHandleBatch)}')" title="Drag to resize row"></div>`:'';
  return`<td${cls} data-col="${key}">${handleHtml}</td>`;
}
// One batch's markup - shared by the main Production Schedule grid and
// Weekly Detail's grid (same look, same cell-level inline edit/right-
// click menu, same risk coloring), so the two never drift out of sync
// with each other the way two independently-maintained copies eventually
// would. includeCustomColumns is a real parameter (not just "always
// on") because Weekly Detail's table has its own static header with no
// matching trailing <th> per custom column - appending those cells
// there too would silently desync the column count. Returns ONE <tr>
// for an ordinary batch, or several concatenated <tr>s for a multi-
// material batch (see MULTI-MATERIAL SPLIT ROWS above) - callers that
// just do rows.map(scheduleRowHtml).join('') don't need to know which.
function scheduleRowHtml(b,includeCustomColumns){
  if(includeCustomColumns===undefined)includeCustomColumns=true;
  const materials=splitPipeField(fieldValue(b,'material'));
  const finishes=splitPipeField(fieldValue(b,'finish'));
  const qtys=splitPipeField(fieldValue(b,'sheet_qty'));
  const rowCount=Math.max(materials.length,finishes.length,qtys.length);
  const split=rowCount>1;
  // Bar fill goes to 100% on a forced Complete so the color and the
  // width agree - the honest scanned/total COUNT next to it never
  // changes, so nothing about the real progress is hidden, only the
  // bar's fill matches the status it's now showing.
  const pct=isForceComplete(b)?100:(b.total?Math.round((b.scanned/b.total)*100):0);
  const state=rowStatus(b);
  const risk=computeRisk(b);
  const batchNameEditable=typeof BATCH_NAME_EDITABLE!=='undefined'&&BATCH_NAME_EDITABLE;
  const flagged=isRowFlagged(b);
  const rowHeightStyle=rowHeights[b.batch]?` style="height:${rowHeights[b.batch]}px"`:'';
  const batchAlign=cellAlignStyle(b,'batch'),batchAlignAttr=batchAlign?` style="${batchAlign}"`:'';
  const statusAlign=cellAlignStyle(b,'status'),statusAlignAttr=statusAlign?` style="${statusAlign}"`:'';
  const taskAlign=cellAlignStyle(b,'task_status'),taskAlignAttr=taskAlign?` style="${taskAlign}"`:'';
  const scanStageAlign=cellAlignStyle(b,'scan_stage'),scanStageAlignAttr=scanStageAlign?` style="${scanStageAlign}"`:'';

  let out='';
  for(let i=0;i<rowCount;i++){
    const isFirst=i===0;
    const customCells=includeCustomColumns?customColumns.map(c=>isFirst?editableTd(b,c.key,false,'gc-custom'):blankTd(c.key,'gc-custom')).join(''):'';
    const jobCell=isFirst?editableTd(b,'job_name',false,null,true):blankTd('job_name',null,b.batch);
    const floorCell=isFirst?editableTd(b,'floor_or_work_order'):blankTd('floor_or_work_order');
    const finishDateCell=isFirst?editableTd(b,'target_finish',true):blankTd('target_finish');
    const materialCell=split?readOnlyTd(b,'material',materials[i]||''):editableTd(b,'material');
    const finishCell=split?readOnlyTd(b,'finish',finishes[i]||''):editableTd(b,'finish');
    const partNameCell=isFirst?editableTd(b,'part_name'):blankTd('part_name');
    const batchCell=isFirst
      ?(batchNameEditable?editableTd(b,'batch',false,'gc-batch'):`<td class="gc-batch" data-col="batch"${batchAlignAttr}>${esc(b.batch)}</td>`)
      :blankTd('batch','gc-batch');
    const statusCell=isFirst?`<td data-col="status"${statusAlignAttr}><div class="gc-progress"><div class="gc-progress-track"><div class="gc-progress-fill ${state}" style="width:${pct}%"></div></div><div class="gc-count">${b.scanned}/${b.total}</div></div></td>`:blankTd('status');
    const qtyCell=split?readOnlyTd(b,'sheet_qty',qtys[i]||'','gc-num'):editableTd(b,'sheet_qty',false,'gc-num');
    const commentCell=isFirst?editableTd(b,'comment',false,'gc-comment'):blankTd('comment','gc-comment');
    const taskCell=isFirst?`<td data-col="task_status"${taskAlignAttr}>${taskStatusCell(b,state)}</td>`:blankTd('task_status');
    const scanStageCellHtml=isFirst?`<td data-col="scan_stage"${scanStageAlignAttr}>${scanStageCell(b)}</td>`:blankTd('scan_stage');
    out+=`<tr data-batch="${esc(b.batch)}" class="${risk?'risk-'+risk.level:''}${flagged&&isFirst?' row-flagged':''}" onclick="handleRowClick('${esc(b.batch)}')" oncontextmenu="openRowContextMenu(event,'${esc(b.batch)}')"${rowHeightStyle}>
    ${jobCell}
    ${floorCell}
    ${finishDateCell}
    ${materialCell}
    ${finishCell}
    ${partNameCell}
    ${batchCell}
    ${statusCell}
    ${qtyCell}
    ${commentCell}
    ${taskCell}
    ${scanStageCellHtml}
    ${customCells}
  </tr>`;
  }
  return out;
}
// Task Status is its own always-live control, independent of the row's
// Edit/Save flow (Cut/Bending/Assembly is a quick one-off pick from the
// shop floor, not a field someone edits alongside job name etc.) - saves
// immediately on change, same pattern as saveMaterialStock. Real
// (scan-derived) completion still locks the dropdown to a disabled
// "Complete" - nothing to override once every part is genuinely
// scanned. A batch that's NOT fully scanned still gets a "Complete
// (Manual)" option though, for the case scanning never happened for a
// legitimate reason (bad barcode, work done off a cart the scanner
// never saw) - picking it is a real override (see isForceComplete),
// not a substitute value for task_status, and picking any other stage
// afterward clears it again.
function taskStatusCell(b,state){
  const forced=isForceComplete(b);
  if(state==='complete'&&!forced)return`<select class="ts-select" disabled><option selected>Complete</option></select>`;
  const val=forced?'FORCE_COMPLETE':(b.task_status||'');
  const opts=['',"Cut","Bending","Assembly","FORCE_COMPLETE"].map(v=>{
    const label=v===''?'Not Started':v==='FORCE_COMPLETE'?'Complete (Manual)':v;
    return`<option value="${v}" ${val===v?'selected':''}>${esc(label)}</option>`;
  }).join('');
  return`<select class="ts-select${forced?' ts-forced':''}" onclick="event.stopPropagation()" onchange="event.stopPropagation();saveTaskStatus('${esc(b.batch)}',this.value)">${opts}</select>`;
}
async function saveTaskStatus(batch,value){
  const b=scheduleBatches.find(x=>x.batch===batch);
  if(value==='FORCE_COMPLETE'){
    const countText=b?b.scanned+'/'+b.total+' scanned':'not fully scanned';
    if(!confirm('Mark '+batch+' Complete even though it\'s only '+countText+'?\n\nThe real scan count stays visible everywhere else — this only changes its status, and can be undone by picking a different stage.'))return;
    const extra=Object.assign({},(b&&b.extra_fields)||{},{forceComplete:true});
    if(b)b.extra_fields=extra; // optimistic
    try{
      await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'POST',body:JSON.stringify({extra_fields:extra})});
      await loadScheduleList();
    }catch(e){alert('Could not save — check the admin key and try again.');}
    return;
  }
  const wasForced=b&&isForceComplete(b);
  if(b){b.task_status=value;if(wasForced)b.extra_fields=Object.assign({},b.extra_fields||{},{forceComplete:false});}
  try{
    if(wasForced)await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'POST',body:JSON.stringify({extra_fields:Object.assign({},(b&&b.extra_fields)||{},{forceComplete:false})})});
    await api('/admin/api/schedule/'+encodeURIComponent(batch)+'/task-status',{method:'POST',body:JSON.stringify({task_status:value})});
    await loadScheduleList();
  }catch(e){alert('Could not save — check the admin key and try again.');}
}

// ── MULTI-STAGE SCANNING (Scan Stage column) — a second, independent
// progress signal from Task Status above: this one is driven by real
// scans (see stage_scans/production_stages in schema.sql and
// /parts/match's stage-aware branch server-side), not a manual pick.
// The server sends the auto-derived value on every batch as scan_stage_
// number/name/complete ("furthest stage every non-voided part has
// actually been scanned at" - same all-or-nothing rule rowStatus()
// already uses for scan completion). A manual override lives in
// extra_fields.scanStageOverride (a stage_number, or the string
// 'COMPLETE') - same "override lives in extra_fields, display logic
// lives client-side" architecture as isForceComplete/task_status,
// deliberately kept separate from that field rather than folded into
// it (Task Status stays exactly as it already was).
let stageDefinitions=[]; // [{stage_number,stage_name}], fetched once, kept in sync locally after add/remove
async function loadStageDefinitions(){
  if(!KEY)return;
  try{
    const data=await api('/admin/api/stages');
    stageDefinitions=data.stages||[];
    if(currentTab==='schedule')renderScheduleGrid();
  }catch(e){}
}
function isScanStageOverridden(b){return!!(b.extra_fields&&b.extra_fields.scanStageOverride!=null&&b.extra_fields.scanStageOverride!=='');}
function scanStageCell(b){
  const overridden=isScanStageOverridden(b);
  // Locks the same way taskStatusCell does for a genuine completion -
  // nothing left to override once every part has actually gone through
  // every configured stage.
  if(b.scan_stage_complete&&!overridden)return`<select class="ts-select" disabled><option selected>Complete</option></select>`;
  const val=overridden?String(b.extra_fields.scanStageOverride):(b.scan_stage_number!=null?String(b.scan_stage_number):'');
  const opts=[['','Not Started'],...stageDefinitions.map(s=>[String(s.stage_number),s.stage_name]),['COMPLETE','Complete (Manual)']];
  const optsHtml=opts.map(([v,label])=>`<option value="${esc(v)}" ${val===v?'selected':''}>${esc(label)}</option>`).join('');
  return`<select class="ts-select${overridden?' ts-forced':''}" onclick="event.stopPropagation()" onchange="event.stopPropagation();saveScanStage('${esc(b.batch)}',this.value)">${optsHtml}</select>`;
}
async function saveScanStage(batch,value){
  const b=scheduleBatches.find(x=>x.batch===batch);
  if(value===''){
    // Not Started here means "clear the override, go back to whatever
    // the real scans say" - not "force it to blank". If nothing's
    // actually been scanned yet the auto value is blank anyway, so
    // this reads correctly either way.
    const extra=Object.assign({},(b&&b.extra_fields)||{});
    delete extra.scanStageOverride;
    if(b)b.extra_fields=extra;
    try{
      await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'POST',body:JSON.stringify({extra_fields:extra})});
      await loadScheduleList();
    }catch(e){alert('Could not save — check the admin key and try again.');}
    return;
  }
  const label=value==='COMPLETE'?'Complete':((stageDefinitions.find(s=>String(s.stage_number)===value)||{}).stage_name||value);
  if(!confirm(`Manually set ${batch}'s Scan Stage to "${label}"?\n\nThis overrides what the real scans say until cleared (pick "Not Started" to go back to automatic).`))return;
  const extra=Object.assign({},(b&&b.extra_fields)||{},{scanStageOverride:value==='COMPLETE'?'COMPLETE':parseInt(value,10)});
  if(b)b.extra_fields=extra;
  try{
    await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'POST',body:JSON.stringify({extra_fields:extra})});
    await loadScheduleList();
  }catch(e){alert('Could not save — check the admin key and try again.');}
}
// ── STAGE DEFINITIONS PANEL — add/remove the shop-floor stages
// themselves (number + name), same popover shell as Columns/Deleted
// Batches. Removing a stage never touches stage_scans - parts already
// scanned at that stage keep that history, same "definition removed,
// values stay" reasoning as custom columns.
function renderStagesPanel(){
  const el=$('stagesPanelList');
  if(!el)return;
  const rows=stageDefinitions.map(s=>
    `<div class="columns-pop-row"><label style="flex:1;display:flex;align-items:center;gap:8px;margin:0;cursor:default">Stage ${s.stage_number} — ${esc(s.stage_name)}</label><button class="secondary" onclick="removeStageDefinition(${s.stage_number})" style="width:auto;padding:2px 8px;font-size:11px" title="Remove this stage">&times;</button></div>`
  ).join('');
  el.innerHTML=(rows||'<div class="sub" style="padding:4px">No stages set up yet.</div>')+
    `<div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--gray-200)">
      <input id="newStageNumber" type="number" min="1" placeholder="#" style="width:50px;min-width:0;font-size:12.5px;padding:6px 8px">
      <input id="newStageName" placeholder="Stage name (e.g. Cutting)" style="flex:1;min-width:0;font-size:12.5px;padding:6px 8px">
      <button onclick="addStageDefinition()" style="width:auto;padding:6px 10px;font-size:12px">Add</button>
    </div>`;
}
function toggleStagesPanel(evt){
  evt.stopPropagation();
  const pop=$('stagesPopover');
  if(!pop)return;
  if(pop.style.display==='block'){pop.style.display='none';return;}
  renderStagesPanel();
  pop.style.display='block';
}
function closeStagesPanel(){const pop=$('stagesPopover');if(pop)pop.style.display='none';}
async function addStageDefinition(){
  const numInput=$('newStageNumber'),nameInput=$('newStageName');
  const num=parseInt((numInput&&numInput.value)||'',10);
  const name=((nameInput&&nameInput.value)||'').trim();
  if(!Number.isInteger(num)||num<1){alert('Enter a stage number (1, 2, 3...).');return;}
  if(!name){alert('Enter a name for the stage.');return;}
  try{
    await api('/admin/api/stages',{method:'POST',body:JSON.stringify({stage_number:num,stage_name:name})});
    await loadStageDefinitions();
    if(numInput)numInput.value='';
    if(nameInput)nameInput.value='';
    renderStagesPanel();
    if(currentTab==='schedule')renderScheduleGrid();
  }catch(e){alert('Could not add stage: '+e.message);}
}
async function removeStageDefinition(stageNumber){
  const s=stageDefinitions.find(x=>x.stage_number===stageNumber);
  if(!confirm(`Remove Stage ${stageNumber}${s?' ("'+s.stage_name+'")':''}?\n\nScans already recorded at this stage stay on record - re-adding a stage with this same number later brings it back into the Scan Stage calculation.`))return;
  try{
    await api('/admin/api/stages/'+stageNumber,{method:'DELETE'});
    await loadStageDefinitions();
    renderStagesPanel();
    if(currentTab==='schedule')renderScheduleGrid();
  }catch(e){alert('Could not remove stage: '+e.message);}
}
// One search box across every GRID_COLUMNS field at once (Find), ANDed
// with whatever per-column filters are already active - same colValue()
// each column's own filter already uses, so "search" and "filter" always
// agree on what a column's value actually is.
let globalSearchQuery='';
function setGlobalSearch(v){globalSearchQuery=v.trim().toLowerCase();renderScheduleGrid();}
// Batch count (broken down by Complete/In Progress/Not Started, not just
// a total), total scanned/total, and total Sheet Qty across whatever
// rows are currently shown (post filter/search/sort) - an AutoSum-style
// summary. Lives in its own bar above the table (#scheduleTotals /
// #weeklyDetailTotals) rather than as the table's last row, so it's
// visible without scrolling down a long list - always reflects the
// current rows even when that list is empty (search yields no matches).
function scheduleTotalsBarHtml(rows){
  let scanned=0,total=0,sheetQty=0,unparsed=0,complete=0,progress=0,notStarted=0;
  rows.forEach(b=>{
    scanned+=b.scanned||0;total+=b.total||0;
    const q=parseQty(b.sheet_qty);
    q===null?unparsed++:sheetQty+=q;
    const st=rowStatus(b);
    if(st==='complete')complete++;else if(st==='progress')progress++;else notStarted++;
  });
  return`<div class="totals-bar">
    <span>${rows.length} batch${rows.length===1?'':'es'}</span>
    <span>${complete} complete</span>
    <span>${progress} in progress</span>
    <span>${notStarted} not started</span>
    <span>${scanned}/${total} scanned</span>
    <span>${sheetQty}${unparsed?' *':''} sheet qty</span>
  </div>`;
}
function renderScheduleGrid(){
  let rows=scheduleBatches.filter(b=>{
    for(const key in columnFilters){
      if(!columnFilters[key].has(colValue(b,key)))return false;
    }
    if(globalSearchQuery&&!textMatches(globalSearchQuery,...GRID_COLUMNS.map(([key])=>colValue(b,key))))return false;
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
  if($('scheduleTotals'))$('scheduleTotals').innerHTML=scheduleTotalsBarHtml(rows);
  if(!rows.length){$('scheduleTbody').innerHTML=`<tr><td colspan="${scheduleColspan()}" class="empty">${scheduleBatches.length?'No matches.':'No batches registered yet.'}</td></tr>`;return;}
  $('scheduleTbody').innerHTML=rows.map(b=>scheduleRowHtml(b,true)).join('');
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

// ── CELL-LEVEL INLINE EDIT (universal pattern - used anywhere a
// sched-grid row has editable fields) ───────────────────────────────
// Double-click ONE cell to edit just that field; every other cell on the
// page stays plain read-only text. Only one cell is ever mid-edit at a
// time - moving to a different cell blurs (and so commits) whatever was
// being edited first, the same way moving between cells in a spreadsheet
// commits the one you left.
let editingCell=null; // {batch,key,isDate} | null
// Set for one tick right before Escape blurs the input, so the blur
// handler below can tell "Escape cancelled this" apart from "the user
// clicked away" - both end in the same blur event, but only the second
// one should save.
let cellEditCancelling=false;

// Re-renders just the one row (not the whole table) via outerHTML, then
// refocuses the edit input if a cell on it is mid-edit - keeps the rest
// of the grid, scroll position, and any other row's state untouched.
function refreshRow(batch){
  const b=scheduleBatches.find(x=>x.batch===batch);
  // A multi-material batch renders as MORE THAN ONE <tr> (see MULTI-
  // MATERIAL SPLIT ROWS above scheduleRowHtml) - has to find/replace
  // the whole group, not just the first row it finds, or a material-row
  // count change would leave stale extra rows behind.
  const rows=document.querySelectorAll(`tr[data-batch="${CSS.escape(batch)}"]`);
  if(!b||!rows.length)return;
  // Whichever table these rows actually came from (Production Schedule
  // or Weekly Detail - same batch can exist in both tables' DOM at
  // once) decides whether the group gets rebuilt with custom-column
  // cells, so it never ends up with a different cell count than its own
  // table's header.
  const inWeeklyDetail=!!rows[0].closest('#weeklyDetailList');
  rows[0].outerHTML=scheduleRowHtml(b,!inWeeklyDetail);
  for(let i=1;i<rows.length;i++){if(rows[i]&&rows[i].parentNode)rows[i].remove();}
  const newRows=document.querySelectorAll(`tr[data-batch="${CSS.escape(batch)}"]`);
  const inp=newRows[0]&&newRows[0].querySelector('.gc-input');
  if(inp){inp.focus();if(inp.select)inp.select();}
}
function startCellEdit(batch,key,isDate){
  editingCell={batch,key,isDate};
  refreshRow(batch);
}
function cancelCellEdit(batch,key){
  if(!editingCell||editingCell.batch!==batch||editingCell.key!==key)return;
  editingCell=null;
  refreshRow(batch);
}
// Enter commits (by blurring the input - onCellInputBlur below does the
// actual save); Escape reverts without saving.
function handleCellEditKeydown(evt,batch,key){
  if(evt.key==='Enter'){evt.preventDefault();evt.target.blur();}
  else if(evt.key==='Escape'){evt.preventDefault();cellEditCancelling=true;evt.target.blur();}
}
function onCellInputBlur(batch,key){
  if(cellEditCancelling){cellEditCancelling=false;cancelCellEdit(batch,key);return;}
  commitCellEdit(batch,key);
}
// Renaming (key==='batch') goes through its own confirm + dedicated
// rename endpoint - batch is production_schedule's primary key and is
// also referenced by parts_panel/scans/packing_slips, so it can't just be
// PATCHed like a normal field (see the rename endpoint's own comment in
// server.js for why). Every other field is a single-key PATCH to the
// existing schedule-edit endpoint - upsertSchedule there already only
// overwrites whichever key is actually present in the body, so sending
// just {[key]:value} is safe and never touches any other field on the row.
async function commitCellEdit(batch,key){
  if(!editingCell||editingCell.batch!==batch||editingCell.key!==key)return;
  const row=document.querySelector(`tr[data-batch="${CSS.escape(batch)}"]`);
  const inp=row&&row.querySelector('.gc-input');
  editingCell=null;
  if(!inp)return;
  const value=inp.value.trim();
  const b=scheduleBatches.find(x=>x.batch===batch);

  if(key==='batch'){
    if(!value||value===batch){refreshRow(batch);return;}
    if(!confirm(`Rename batch "${batch}" to "${value}"?\n\nThis updates every part, scan, and packing slip already tied to "${batch}".`)){refreshRow(batch);return;}
    try{
      await api('/admin/api/schedule/'+encodeURIComponent(batch)+'/rename',{method:'POST',body:JSON.stringify({new_batch:value})});
      await loadScheduleList();
    }catch(e){alert('Could not rename batch: '+e.message);await loadScheduleList();}
    return;
  }

  const isCustom=key.indexOf('custom_')===0;
  const original=isCustom?fieldValue(b||{},key):(key==='target_finish'?(toISODate(b&&b[key])||''):String((b&&b[key])||''));
  if(value===original){refreshRow(batch);return;} // nothing actually changed - close without a network call
  // A custom column's value is one key inside extra_fields, not a
  // top-level field - has to go through the same read-merge-write as
  // isForceComplete/toggleRowFlag do (the general upsert replaces
  // extra_fields wholesale, it doesn't merge server-side), or saving
  // this one custom value would wipe out every other extra_fields key
  // already on the batch (forceComplete, expedite, flagged, other
  // custom columns).
  const body=isCustom?{extra_fields:Object.assign({},(b&&b.extra_fields)||{},{[key]:value})}:{[key]:value};
  try{
    await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'POST',body:JSON.stringify(body)});
    await loadScheduleList();
  }catch(e){alert('Could not save — check the admin key and try again.');refreshRow(batch);}
}

// A single click views that batch's labels; a double-click on a specific
// cell means "edit this field" instead (see startCellEdit above). Both
// fire on the same click, so the single-click action is held for a beat -
// if a second click lands within that window it's a double-click and the
// held action never runs. A row with a cell mid-edit ignores the click
// entirely (no accidental navigate-away while editing).
let rowClickTimer=null;
function handleRowClick(batch){
  if(editingCell&&editingCell.batch===batch)return;
  if(rowClickTimer){clearTimeout(rowClickTimer);rowClickTimer=null;return;}
  rowClickTimer=setTimeout(()=>{rowClickTimer=null;viewBatchLabels(batch);},250);
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
  let warning=`This removes batch "${batch}" and all ${total} registered part(s) in it from Production Schedule. It's recoverable afterward from Deleted Batches (above Export CSV) until discarded from there.`;
  if(scannedCount>0){
    warning+=`\n\n${scannedCount} of ${total} part(s) in this batch have already been scanned - that scan history goes with it into Deleted Batches too, and comes back if restored.`;
  }
  warning+=`\n\nType the batch name exactly to confirm:\n${batch}`;
  const typed=prompt(warning);
  if(typed===null)return;
  if(typed!==batch){alert('Batch name did not match — nothing deleted.');return;}
  try{
    await api('/admin/api/schedule/'+encodeURIComponent(batch),{method:'DELETE'});
    await loadScheduleList();
    loadDeletedBatchesCount();
  }catch(e){alert('Could not delete — check the admin key and try again.');}
}

// ── DELETED BATCHES (recycle bin) — a small popover under its own button
// above Export CSV, listing every batch deleted from this grid so it can
// be brought back. Count badge is fetched once on connect (and after any
// delete/restore/discard) so it's visible without opening the panel; the
// panel's own list is (re)fetched fresh each time it's opened.
let deletedBatchesCache=[];
async function loadDeletedBatchesCount(){
  if(!KEY)return;
  try{
    const data=await api('/admin/api/deleted-batches');
    deletedBatchesCache=data.deleted||[];
    const el=$('deletedBatchesCount');
    if(el)el.textContent=deletedBatchesCache.length?String(deletedBatchesCache.length):'';
  }catch(e){/* leave last-known cache/badge showing rather than blank it on a transient error */}
}
function renderDeletedBatchesPanel(){
  const el=$('deletedBatchesList');
  if(!el)return;
  if(!deletedBatchesCache.length){el.innerHTML='<div class="empty" style="padding:16px 4px">Nothing deleted recently.</div>';return;}
  el.innerHTML=deletedBatchesCache.map(d=>`
    <div class="deleted-row">
      <div class="deleted-row-info">
        <div class="deleted-row-name">${esc(d.batch)}</div>
        <div class="deleted-row-meta">${d.part_count} part${d.part_count===1?'':'s'} (${d.scanned_count} scanned) · ${esc(fmt(d.deleted_at))}${d.deleted_by?' · by '+esc(d.deleted_by):''}</div>
      </div>
      <div class="deleted-row-actions">
        <button onclick="restoreDeletedBatch(${d.id})">Restore</button>
        <button class="danger" onclick="purgeDeletedBatch(${d.id})">Discard</button>
      </div>
    </div>`).join('');
}
async function toggleDeletedBatchesPanel(evt){
  evt.stopPropagation();
  const pop=$('deletedBatchesPopover');
  if(!pop)return;
  if(pop.style.display==='block'){pop.style.display='none';return;}
  pop.style.display='block';
  await loadDeletedBatchesCount();
  renderDeletedBatchesPanel();
}
function closeDeletedBatchesPanel(){
  const pop=$('deletedBatchesPopover');
  if(pop)pop.style.display='none';
}
async function restoreDeletedBatch(id){
  try{
    const data=await api('/admin/api/deleted-batches/'+id+'/restore',{method:'POST'});
    await loadDeletedBatchesCount();
    renderDeletedBatchesPanel();
    await loadScheduleList();
    showToast('✓ Restored '+data.batch);
  }catch(e){alert('Could not restore: '+e.message);}
}
async function purgeDeletedBatch(id){
  const d=deletedBatchesCache.find(x=>x.id===id);
  if(!confirm('Permanently discard the deleted record for "'+(d?d.batch:id)+'"?\n\nThis cannot be undone - it will no longer be restorable afterward.'))return;
  try{
    await api('/admin/api/deleted-batches/'+id,{method:'DELETE'});
    await loadDeletedBatchesCount();
    renderDeletedBatchesPanel();
  }catch(e){alert('Could not discard: '+e.message);}
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
    const line=[sched.job_name,sched.target_finish?(toISODate(sched.target_finish)||sched.target_finish):'',sched.material,sched.finish,sched.part_name,sched.tasked].filter(Boolean).join(' · ');
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
function filteredBatchLabels(){
  let rows=currentBatchLabels;
  if(labelFilters.part_type)rows=rows.filter(l=>(l.part_type||'')===labelFilters.part_type);
  if(labelFilters.scanned)rows=rows.filter(l=>l.scanned===labelFilters.scanned);
  return rows;
}
function renderFilteredLabels(){
  const rows=filteredBatchLabels();
  $('labelsContent').innerHTML=rows.length?labelRowsHtml(rows):'<div class="empty">No matches.</div>';
  renderLabelsBulkBar();
}
// Prints whatever's currently filtered/visible, not always the full
// batch - if someone's narrowed the list to just "Not Scanned" before
// printing, that's a deliberate "give me only what's still missing"
// list, not a mistake to override. The numbered first column is the
// actual point: this is for physically counting/checking parts off
// against a cart while cross-checking (e.g. "check off number 14"),
// not just a data dump.
function printPartList(){
  if(!currentLabelsBatch)return;
  const rows=filteredBatchLabels();
  if(!rows.length){alert('Nothing to print - the current filter has no matching parts.');return;}
  $('lpsTitle').textContent='Part List — '+currentLabelsBatch;
  $('lpsSub').textContent=($('labelsSub').textContent||'')+' · '+rows.length+' part'+(rows.length===1?'':'s')+' · Printed '+new Date().toLocaleString();
  $('lpsBody').innerHTML=rows.map((l,i)=>{
    const size=[l.width,l.height].filter(Boolean).join(' X ');
    return`<tr>
      <td style="border:1px solid #000;padding:5px 8px;text-align:center">${i+1}</td>
      <td style="border:1px solid #000;padding:5px 8px">${esc(l.tag||l.unique_id)}</td>
      <td style="border:1px solid #000;padding:5px 8px">${esc(l.part_type||'')}</td>
      <td style="border:1px solid #000;padding:5px 8px">${esc(size)}</td>
      <td style="border:1px solid #000;padding:5px 8px;text-align:center">${esc(l.qty||'')}</td>
      <td style="border:1px solid #000;padding:5px 8px">${esc(l.colour||'')}</td>
    </tr>`;
  }).join('');
  window.print();
}
function labelRowsHtml(labels){
  if(!labels.length)return'<div class="empty">No labels in this batch.</div>';
  return labels.map(l=>{
    const dc=l.void==='Yes'?'void':l.delivered_internally==='Yes'?'internal':l.scanned==='Yes'?'scanned':'';
    const statusText=l.void==='Yes'?'VOID':l.delivered_internally==='Yes'?'Delivered (Internal)':l.scanned==='Yes'?'Scanned':'Not scanned';
    const sub=[l.project,l.floor,l.part_type,[l.width,l.height].filter(Boolean).join(' X '),l.qty,l.colour].filter(Boolean).map(esc).join(' · ');
    // Already-voided labels can't be voided again (the endpoint rejects
    // it), so they get no checkbox - nothing for a bulk action to do to
    // them.
    const cb=l.void==='Yes'?'<span style="width:16px;flex-shrink:0"></span>':`<input type="checkbox" style="flex-shrink:0" ${selectedLabelIds.has(l.unique_id)?'checked':''} onclick="event.stopPropagation()" onchange="toggleLabelSelect('${esc(l.unique_id)}',this.checked)">`;
    return`<div class="bl-row" onclick="openLabelDetail('${esc(l.unique_id)}')" style="cursor:pointer">${cb}<div class="bl-dot ${dc}"></div><div class="bl-info"><div class="bl-name">${esc(l.tag||l.unique_id)}</div><div class="bl-sub">${sub?sub+' · ':''}${esc(statusText)}</div></div></div>`;
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
    <button class="danger-solid" onclick="bulkVoidSelectedLabels()">Void Selected</button>
    <button class="secondary" onclick="bulkMarkInternalDeliverySelectedLabels()" title="These parts were delivered on-site instead of shipped - they'll no longer be offered on any packing slip for this batch">Delivered Within Building (No Slip Needed)</button>`;
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
// ── INTERNAL DELIVERY — for parts moved on-site instead of shipped out,
// so they never need to appear on a packing slip. Reuses the same
// selection checkboxes Void Selected already has (one bulk-action bar,
// two things you can do with a selection) rather than a separate
// selection mechanism.
async function bulkMarkInternalDeliverySelectedLabels(){
  const ids=[...selectedLabelIds];
  if(!ids.length)return;
  if(!confirm('Mark '+ids.length+' part'+(ids.length===1?'':'s')+' as delivered within the building?\n\nThey will no longer be offered on any packing slip for this batch.'))return;
  let failed=0,failMsg='';
  for(const uid of ids){
    try{await api('/admin/api/parts/internal-delivery',{method:'POST',body:JSON.stringify({unique_id:uid})});}
    catch(e){failed++;failMsg=e.message;}
  }
  if(failed)alert(failed+' of '+ids.length+' could not be marked ('+failMsg+') - the rest went through.');
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
loadCustomColumns();
loadStageDefinitions();