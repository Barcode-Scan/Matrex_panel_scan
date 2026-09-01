const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const db = require('./db');

// ── ADMIN KEY — generated once, kept out of git (server/data/ is gitignored) ──
const ADMIN_KEY_PATH = path.join(__dirname, 'data', 'admin-key.txt');
let ADMIN_KEY;
if (fs.existsSync(ADMIN_KEY_PATH)) {
  ADMIN_KEY = fs.readFileSync(ADMIN_KEY_PATH, 'utf8').trim();
} else {
  ADMIN_KEY = require('crypto').randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(ADMIN_KEY_PATH), { recursive: true });
  fs.writeFileSync(ADMIN_KEY_PATH, ADMIN_KEY, 'utf8');
  console.log('Generated new admin key — see server/data/admin-key.txt');
}

// ── INGEST KEY — separate from the admin key, scoped only to registering
// new parts (used by the Excel macro, not by people). If this ever leaks
// out of a shared workbook, the blast radius is "someone can register
// fake labels," not admin access or scan data.
const INGEST_KEY_PATH = path.join(__dirname, 'data', 'ingest-key.txt');
let INGEST_KEY;
if (fs.existsSync(INGEST_KEY_PATH)) {
  INGEST_KEY = fs.readFileSync(INGEST_KEY_PATH, 'utf8').trim();
} else {
  INGEST_KEY = require('crypto').randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(INGEST_KEY_PATH), { recursive: true });
  fs.writeFileSync(INGEST_KEY_PATH, INGEST_KEY, 'utf8');
  console.log('Generated new ingest key — see server/data/ingest-key.txt');
}

// ── VIEWER KEY — separate from the admin key, scoped read-only to the
// Batch Status tab (phone app + web). A human types this on a phone, so
// unlike the other two it's a chosen value, not randomly generated. If it
// ever leaks, the blast radius is "someone can view batch progress," not
// device approval, voiding, or notes — same narrow-scope principle as the
// ingest key above.
const VIEWER_KEY_PATH = path.join(__dirname, 'data', 'viewer-key.txt');
let VIEWER_KEY;
if (fs.existsSync(VIEWER_KEY_PATH)) {
  VIEWER_KEY = fs.readFileSync(VIEWER_KEY_PATH, 'utf8').trim();
} else {
  VIEWER_KEY = require('crypto').randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(VIEWER_KEY_PATH), { recursive: true });
  fs.writeFileSync(VIEWER_KEY_PATH, VIEWER_KEY, 'utf8');
  console.log('Generated new viewer key — see server/data/viewer-key.txt');
}

const app = express();
// Chrome's Private Network Access (PNA) requires this explicit opt-in header
// on top of standard CORS before a public HTTPS page (the phone app on
// GitHub Pages) is allowed to reach a private-LAN server like this one.
// Without it, any request that triggers a CORS preflight (e.g. a JSON POST)
// is silently blocked by the browser before it ever reaches this server —
// plain GETs can slip through, which is why /health can work while
// /devices/register (or any other JSON POST) fails with no server-side
// trace of the request at all.
app.use((req, res, next) => {
  if (req.get('Access-Control-Request-Private-Network')) {
    res.set('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(cors());
app.use(express.json({ limit: '5mb' })); // /upload carries the whole day's rows
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.get('X-Admin-Key') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'bad admin key' });
  next();
}
// Free-text name the person typed in once (not a verified identity -
// there's no per-person login here, everyone with the admin dashboard
// shares the one admin key) so an edit is attributable when reviewed
// later, especially now that the GM has their own copy of the dashboard.
function actorFrom(req) {
  return (req.get('X-Actor-Name') || '').trim() || 'ADMIN';
}
const insertAuditLog = db.prepare('INSERT INTO audit_log (at, actor, action, target, details) VALUES (?, ?, ?, ?, ?)');
function logAudit(actor, action, target, details) {
  try { insertAuditLog.run(new Date().toISOString(), actor, action, target || null, details || null); }
  catch (e) { console.error('audit log write failed:', e.message); }
}
function requireIngest(req, res, next) {
  if (req.get('X-Ingest-Key') !== INGEST_KEY) return res.status(401).json({ ok: false, error: 'bad ingest key' });
  next();
}
// Admins get in too, so they aren't forced to juggle a second credential.
function requireViewer(req, res, next) {
  const viewerKey = req.get('X-Viewer-Key');
  const adminKey = req.get('X-Admin-Key');
  if (viewerKey !== VIEWER_KEY && adminKey !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'bad viewer key' });
  }
  next();
}

// ── DEVICE APPROVAL — gate on the app's own /upload calls ──
const upsertDevice = db.prepare(`
  INSERT INTO devices (device_id, device_name, status, first_seen, last_seen, ip)
  VALUES (@device_id, @device_name, 'PENDING', @now, @now, @ip)
  ON CONFLICT(device_id) DO UPDATE SET device_name=@device_name, last_seen=@now, ip=@ip
`);
const getDevice = db.prepare('SELECT * FROM devices WHERE device_id = ?');
const listDevices = db.prepare('SELECT * FROM devices ORDER BY first_seen DESC');
const setDeviceStatus = db.prepare(`UPDATE devices SET status=@status, approved_at=CASE WHEN @status='APPROVED' THEN @now ELSE approved_at END WHERE device_id=@device_id`);

function deviceGate(req, res, next) {
  const id = (req.body && req.body.device_id) || '';
  if (!id) return res.status(403).json({ ok: false, error: 'device_id required', status: 'UNKNOWN' });
  const row = getDevice.get(id);
  if (!row) return res.status(403).json({ ok: false, error: 'not registered', status: 'UNKNOWN' });
  if (row.status !== 'APPROVED') return res.status(403).json({ ok: false, error: 'not approved', status: row.status });
  next();
}

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// The server has no real landing page - / would otherwise 404. This exists
// so the "Receiver URL" QR code in the admin Phone Setup tab has somewhere
// useful to open: a phone scans it, lands here, and copies the URL shown
// straight into the app's Settings screen instead of typing an IP by hand.
app.get('/', (req, res) => {
  const url = `${req.protocol}://${req.hostname}`;
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Matrex Scan Receiver</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F5F5F7;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}
  .card{background:#fff;border:1.5px solid #E5E7EB;border-radius:16px;padding:28px 24px;max-width:360px;width:100%}
  h1{font-size:17px;margin:0 0 6px}
  p{font-size:13px;color:#6B7280;margin:0 0 18px}
  .url{font-family:ui-monospace,Menlo,monospace;font-size:16px;font-weight:600;background:#F5F5F7;border-radius:10px;padding:14px;word-break:break-all;margin-bottom:14px}
  button{width:100%;padding:12px;border:none;border-radius:10px;background:#0071E3;color:#fff;font-weight:600;font-size:14px;cursor:pointer}
  button.copied{background:#16A34A}
</style></head><body>
<div class="card">
  <h1>Matrex Scan Receiver</h1>
  <p>Paste this into the app's Settings &gt; Receiver URL field.</p>
  <div class="url" id="u">${url}</div>
  <button id="b" onclick="navigator.clipboard.writeText(document.getElementById('u').textContent).then(()=>{const b=document.getElementById('b');b.textContent='Copied';b.classList.add('copied');}).catch(()=>{})">Copy</button>
</div>
</body></html>`);
});

// Serves only the public certificate (never the private key) so a phone
// can install it as a trusted profile instead of clicking through Safari's
// browser warning, which doesn't actually make the app's fetch() calls
// trust it - iOS treats "visit anyway" in Safari and system-level
// certificate trust as two separate things. application/x-x509-ca-cert is
// the MIME type that makes both iOS and Android recognize this as an
// installable certificate rather than just downloading a text file.
app.get('/tls-cert.pem', (req, res) => {
  if (!fs.existsSync(TLS_CERT_PATH)) return res.status(404).send('No certificate configured.');
  res.type('application/x-x509-ca-cert');
  res.sendFile(TLS_CERT_PATH);
});

// The free Cloudflare quick tunnel gets a brand-new random URL every time
// watchdog.ps1 restarts it (observed roughly every 1-2 hours) — reading
// the same file the watchdog writes means whoever's looking (the admin
// dashboard) always sees the real current URL instead of one that was
// only accurate at the moment someone last wrote it down somewhere.
const TUNNEL_URL_PATH = path.join(__dirname, 'current-tunnel-url.txt');
app.get('/admin/api/tunnel-url', requireAdmin, (req, res) => {
  try {
    const url = fs.readFileSync(TUNNEL_URL_PATH, 'utf8').trim();
    res.json({ ok: true, url: url || null });
  } catch (e) {
    res.json({ ok: true, url: null });
  }
});

// Lets every admin dashboard detect "a newer version of this app was
// deployed since I loaded" without any manual version-bumping - the
// live server serves public/ straight off disk (no build/pull step), so
// the newest mtime across the shared JS + all four dashboard HTML files
// IS the deploy time, updated the moment any of them is edited.
const APP_VERSION_FILES = ['admin-shared.js', 'admin.html', 'gm.html', 'damon.html', 'swar.html'];
app.get('/admin/api/app-version', requireAdmin, (req, res) => {
  let latest = 0;
  for (const f of APP_VERSION_FILES) {
    try {
      const mtime = fs.statSync(path.join(__dirname, 'public', f)).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch (e) { /* file missing shouldn't block the others */ }
  }
  res.json({ ok: true, version: latest });
});

app.post('/devices/register', (req, res) => {
  const { device_id, device_name } = req.body || {};
  if (!device_id) return res.status(400).json({ ok: false, error: 'device_id required' });
  const now = new Date().toISOString();
  upsertDevice.run({ device_id: String(device_id), device_name: device_name || '', now, ip: req.ip });
  res.json({ ok: true, status: getDevice.get(device_id).status });
});
app.get('/devices/:id/status', (req, res) => {
  const row = getDevice.get(req.params.id);
  res.json({ ok: true, status: row ? row.status : 'UNKNOWN' });
});

app.get('/admin/api/devices', requireAdmin, (req, res) => res.json(listDevices.all()));
app.post('/admin/api/devices/:id/approve', requireAdmin, (req, res) => {
  setDeviceStatus.run({ device_id: req.params.id, status: 'APPROVED', now: new Date().toISOString() });
  logAudit(actorFrom(req), 'DEVICE_APPROVE', req.params.id);
  res.json({ ok: true });
});
app.post('/admin/api/devices/:id/revoke', requireAdmin, (req, res) => {
  setDeviceStatus.run({ device_id: req.params.id, status: 'REVOKED', now: new Date().toISOString() });
  logAudit(actorFrom(req), 'DEVICE_REVOKE', req.params.id);
  res.json({ ok: true });
});
// Removes the device row entirely - unlike revoke, this isn't a status a
// phone can be put back into by re-approving it. If the same physical
// phone scans again later it just re-registers as a brand-new Pending
// device (device_id is generated client-side, so this has no effect on
// its past scans in the scans table, only on the approvals list itself).
app.delete('/admin/api/devices/:id', requireAdmin, (req, res) => {
  const row = getDevice.get(req.params.id);
  db.prepare('DELETE FROM devices WHERE device_id = ?').run(req.params.id);
  if (row) logAudit(actorFrom(req), 'DEVICE_DELETE', req.params.id, `was ${row.status}, "${row.device_name || ''}"`);
  res.json({ ok: true });
});

// ── UPLOAD — the phone resends the *whole day's* rows array on every
// call (debounced after each scan, plus midnight/manual/retry), so this
// upserts by scan_id rather than blindly inserting, and additionally
// writes the CSV to disk as a backup.
const upsertScan = db.prepare(`
  INSERT INTO scans (
    scan_id, date, scanned_at, received_at, device, device_id, unique_id, match_status,
    batch_sheet, project, floor, part_type, part_name, size, qty, colour,
    skid, method, flag, raw, mode, batch
  ) VALUES (
    @scan_id, @date, @scanned_at, @received_at, @device, @device_id, @unique_id, @match_status,
    @batch_sheet, @project, @floor, @part_type, @part_name, @size, @qty, @colour,
    @skid, @method, @flag, @raw, @mode, @batch
  )
  ON CONFLICT(scan_id) DO UPDATE SET
    skid=@skid, flag=@flag, match_status=@match_status
`);

// A decode that comes back the wrong length never reaches /upload at all
// today - it's rejected client-side before a "scan" even exists, so it
// leaves no record anywhere. This gives it one, reusing the scans table
// (unique_id/match_status are already nullable/free-text) and the
// existing Exception Queue (anything outside OK_STATUSES already shows
// up there automatically - no admin-side changes needed for this to be
// reviewable). Best-effort only: the phone fires this and moves on,
// no offline queue/retry, since losing a diagnostic log entry now and
// then is a fair tradeoff for not adding real complexity to a feature
// that only exists to help debug a device-specific problem.
app.post('/parts/decode-reject', deviceGate, (req, res) => {
  const { raw, device, device_id, scanned_at } = req.body || {};
  const now = new Date().toISOString();
  const scanId = `reject_${device_id || 'unknown'}_${now}_${Math.random().toString(36).slice(2, 8)}`;
  upsertScan.run({
    scan_id: scanId,
    date: (scanned_at || now).slice(0, 10),
    scanned_at: scanned_at || now,
    received_at: now,
    device: device || null,
    device_id: device_id || null,
    unique_id: null,
    match_status: 'DECODE_REJECTED',
    batch_sheet: null, project: null, floor: null, part_type: null,
    part_name: String(raw || '').slice(0, 60) || '(empty decode)',
    size: null, qty: null, colour: null, skid: null,
    method: 'SCAN', flag: null, raw: String(raw || '').slice(0, 500),
    mode: 'FREE', batch: null
  });
  res.json({ ok: true });
});

app.post('/upload', deviceGate, (req, res) => {
  const b = req.body || {};
  const { filename, csv, rows } = b;
  if (!filename || !csv) return res.status(400).json({ ok: false, error: 'filename and csv required' });

  const dir = path.join(__dirname, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename.replace(/[^a-zA-Z0-9_.-]/g, '_')), csv, 'utf8');

  if (Array.isArray(rows)) {
    const received = new Date().toISOString();
    for (const row of rows) {
      const scanId = row.scanId || `${b.device_id}_${row.time || received}_${row.partName || ''}`;
      upsertScan.run({
        scan_id: String(scanId),
        date: String(row.date || b.date || ''),
        scanned_at: String(row.time || received),
        received_at: received,
        device: b.device || null,
        device_id: b.device_id || null,
        unique_id: row.uniqueId || null,
        match_status: row.matchStatus || null,
        batch_sheet: row.batchSheet || null,
        project: row.project || null,
        floor: row.floor || null,
        part_type: row.partType || null,
        part_name: row.partName || null,
        size: row.size || null,
        qty: row.qty || null,
        colour: row.colour || null,
        skid: row.skid || null,
        method: row.method || null,
        flag: row.flag || null,
        raw: row.raw || null,
        mode: 'FREE',
        batch: null
      });
    }
  }
  res.json({ ok: true });
});

// Reporting only, admin-key protected.
app.get('/scans', requireAdmin, (req, res) => {
  const { date, device_id } = req.query;
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  let q = 'SELECT * FROM scans WHERE 1=1';
  const params = [];
  if (date) { q += ' AND date = ?'; params.push(date); }
  if (device_id) { q += ' AND device_id = ?'; params.push(device_id); }
  q += ' ORDER BY id DESC LIMIT ?'; params.push(limit);
  res.json(db.prepare(q).all(...params));
});

// ── PANEL PARTS REGISTRY — Excel calls this once per label batch, right
// after it generates UIDs locally and writes its own LABEL LIST/CSV/TSV.
// Idempotent per unique_id: safe to resend the same batch if the network
// drops mid-request, since already-registered IDs are just skipped, not
// duplicated or overwritten.
const insertPartsIndex = db.prepare(`
  INSERT INTO parts_index (unique_id, department, scanned, void, created_at)
  VALUES (@unique_id, 'PANEL', 'No', 'No', @now)
  ON CONFLICT(unique_id) DO NOTHING
`);
const insertPartsPanel = db.prepare(`
  INSERT INTO parts_panel (unique_id, batch, sheet_name, project, floor, tag, part_type, width, height, qty, colour, generated_on, sequence_no)
  VALUES (@unique_id, @batch, @sheet_name, @project, @floor, @tag, @part_type, @width, @height, @qty, @colour, @generated_on, @sequence_no)
  ON CONFLICT(unique_id) DO NOTHING
`);
const getPartsIndexRow = db.prepare('SELECT unique_id FROM parts_index WHERE unique_id = ?');
const getMaxSequenceNo = db.prepare('SELECT COALESCE(MAX(sequence_no),0) AS m FROM parts_panel WHERE batch IS ?');

// ── PRODUCTION SCHEDULE — batch-level metadata (job name, work order,
// target finish, material, finish, part name, sheet qty, comment, tasked),
// separate from parts_panel's per-label fields. Written by Excel at
// register time OR filled in manually later from the admin dashboard for
// batches that predate this feature — upsert, not insert-once, so either
// side can correct it after the fact. Only fields actually present in the
// request overwrite the stored value, so a partial edit never blanks out
// fields it didn't touch. extra_fields is the one flexible/ad hoc extension
// point — a JSON object, stored stringified, for anything not worth a real
// column yet.
const SCHEDULE_FIELDS = ['job_name', 'floor_or_work_order', 'target_finish', 'material', 'finish', 'part_name', 'sheet_qty', 'comment', 'tasked', 'task_status'];
const upsertProductionSchedule = db.prepare(`
  INSERT INTO production_schedule
    (batch, job_name, floor_or_work_order, target_finish, material, finish,
     part_name, sheet_qty, comment, tasked, task_status, extra_fields, source, created_at, updated_at, updated_by)
  VALUES
    (@batch, @job_name, @floor_or_work_order, @target_finish, @material, @finish,
     @part_name, @sheet_qty, @comment, @tasked, @task_status, @extra_fields, @source, @now, @now, @updated_by)
  ON CONFLICT(batch) DO UPDATE SET
    job_name=excluded.job_name, floor_or_work_order=excluded.floor_or_work_order,
    target_finish=excluded.target_finish, material=excluded.material, finish=excluded.finish,
    part_name=excluded.part_name, sheet_qty=excluded.sheet_qty, comment=excluded.comment,
    tasked=excluded.tasked, task_status=excluded.task_status, extra_fields=excluded.extra_fields,
    source=excluded.source, updated_at=excluded.updated_at, updated_by=excluded.updated_by
`);
const getProductionSchedule = db.prepare('SELECT * FROM production_schedule WHERE batch = ?');
// Separate from upsertSchedule below: that function's coalesce (skip a
// field when the request sent it blank) means it can never SET task_status
// back to blank once something's been picked — deliberate there, since it
// protects every other field from an accidental wipe, but wrong here, since
// "Not Started" (blank) is itself one of the four legitimate values a
// person can pick. This statement writes task_status directly instead, so
// picking blank actually clears it.
const setTaskStatus = db.prepare(`
  INSERT INTO production_schedule (batch, task_status, source, created_at, updated_at, updated_by)
  VALUES (@batch, @task_status, 'MANUAL', @now, @now, @updated_by)
  ON CONFLICT(batch) DO UPDATE SET
    task_status=excluded.task_status, updated_at=excluded.updated_at, updated_by=excluded.updated_by
`);

function hasScheduleFields(body) {
  return SCHEDULE_FIELDS.some(f => body[f] !== undefined && body[f] !== null && String(body[f]).trim() !== '')
    || (body.extra_fields && typeof body.extra_fields === 'object' && Object.keys(body.extra_fields).length > 0);
}

function upsertSchedule(batch, body, source, updatedBy) {
  const existing = getProductionSchedule.get(batch) || {};
  const now = new Date().toISOString();
  let extraFields = existing.extra_fields || null;
  if (body.extra_fields && typeof body.extra_fields === 'object') {
    extraFields = JSON.stringify(body.extra_fields);
  }
  const params = { batch, source, now, updated_by: updatedBy || null, extra_fields: extraFields };
  for (const f of SCHEDULE_FIELDS) {
    const v = body[f];
    params[f] = (v !== undefined && v !== null && String(v).trim() !== '') ? String(v) : (existing[f] || null);
  }
  upsertProductionSchedule.run(params);
}

function formatSchedule(row) {
  if (!row) return null;
  let extra = {};
  if (row.extra_fields) { try { extra = JSON.parse(row.extra_fields); } catch (e) { extra = {}; } }
  return {
    job_name: row.job_name || null,
    floor_or_work_order: row.floor_or_work_order || null,
    target_finish: row.target_finish || null,
    material: row.material || null,
    finish: row.finish || null,
    part_name: row.part_name || null,
    sheet_qty: row.sheet_qty || null,
    comment: row.comment || null,
    tasked: row.tasked || null,
    task_status: row.task_status || null,
    extra_fields: extra,
    schedule_source: row.source || null,
    schedule_updated_at: row.updated_at || null,
    schedule_updated_by: row.updated_by || null
  };
}

app.post('/parts/panel/register', requireIngest, (req, res) => {
  const { batch, rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ ok: false, error: 'rows array required' });

  const now = new Date().toISOString();
  let inserted = 0, alreadyExisted = 0, skipped = 0;
  const nextSeq = {}; // batch -> next sequence_no, seeded from current max on first use in this call

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const uid = String(row.unique_id || '').trim();
      if (!uid || uid.length > 50) { skipped++; continue; }
      const rowBatch = row.batch || batch || null;
      const existed = !!getPartsIndexRow.get(uid);
      insertPartsIndex.run({ unique_id: uid, now });
      if (!(rowBatch in nextSeq)) nextSeq[rowBatch] = getMaxSequenceNo.get(rowBatch).m;
      insertPartsPanel.run({
        unique_id: uid,
        batch: rowBatch,
        sheet_name: row.sheet_name || null,
        project: row.project || null,
        floor: row.floor || null,
        tag: row.tag || null,
        part_type: row.part_type || null,
        width: row.width || null,
        height: row.height || null,
        qty: row.qty || null,
        colour: row.colour || null,
        generated_on: row.generated_on || null,
        sequence_no: existed ? null : ++nextSeq[rowBatch]
      });
      if (existed) alreadyExisted++; else inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ ok: false, error: e.message });
  }

  const scheduleBatch = String(batch || '').trim();
  if (scheduleBatch && hasScheduleFields(req.body)) {
    upsertSchedule(scheduleBatch, req.body, 'EXCEL', 'excel-macro');
  }

  res.json({ ok: true, inserted, already_existed: alreadyExisted, skipped, total: rows.length });
});

// Manual add/edit of a batch's production-schedule metadata from the admin
// dashboard — same upsert as the Excel path above (§ SCHEDULE_FIELDS), so
// this also covers correcting a batch Excel already sent, not just filling
// in ones that predate this feature.
app.post('/admin/api/schedule/:batch', requireAdmin, (req, res) => {
  const batch = String(req.params.batch || '').trim();
  if (!batch) return res.status(400).json({ ok: false, error: 'batch required' });
  const actor = actorFrom(req);
  upsertSchedule(batch, req.body || {}, 'MANUAL', actor);
  logAudit(actor, 'SCHEDULE_EDIT', batch, JSON.stringify(req.body || {}));
  res.json({ ok: true, batch, schedule: formatSchedule(getProductionSchedule.get(batch)) });
});

// Manual process-stage pick (blank/Cut/Bending/Assembly) from the shop
// floor — a one-field, save-immediately action separate from the general
// schedule edit form above, and routed through setTaskStatus (not
// upsertSchedule) specifically so picking blank actually clears it back to
// "Not Started" instead of being ignored. "Complete" is never accepted here
// — it's derived from scanned===total wherever it's displayed, never
// stored, so it can't go stale.
app.post('/admin/api/schedule/:batch/task-status', requireAdmin, (req, res) => {
  const batch = String(req.params.batch || '').trim();
  if (!batch) return res.status(400).json({ ok: false, error: 'batch required' });
  const value = (req.body && typeof req.body.task_status === 'string') ? req.body.task_status : '';
  if (!['', 'Cut', 'Bending', 'Assembly'].includes(value)) {
    return res.status(400).json({ ok: false, error: 'invalid task_status' });
  }
  const actor = actorFrom(req);
  const now = new Date().toISOString();
  setTaskStatus.run({ batch, task_status: value || null, now, updated_by: actor || null });
  logAudit(actor, 'TASK_STATUS_EDIT', batch, JSON.stringify({ task_status: value }));
  res.json({ ok: true, batch, schedule: formatSchedule(getProductionSchedule.get(batch)) });
});

// ── CUSTOM COLUMNS — admin-defined extra columns for Production
// Schedule (see schema.sql for why this is just a key/label definition,
// not a place values are stored — those live in each batch's own
// extra_fields under the same key). key is always derived here, never
// client-supplied, specifically so it can be prefixed 'custom_' and
// the client can tell "this is a custom column" from "this is a real
// production_schedule column" by that prefix alone.
const listCustomColumns = db.prepare('SELECT key, label, created_at, created_by FROM custom_columns ORDER BY created_at ASC');
const insertCustomColumn = db.prepare('INSERT INTO custom_columns (key, label, created_at, created_by) VALUES (@key, @label, @now, @created_by)');
const deleteCustomColumn = db.prepare('DELETE FROM custom_columns WHERE key = ?');

app.get('/admin/api/custom-columns', requireAdmin, (req, res) => {
  res.json({ ok: true, columns: listCustomColumns.all() });
});
app.post('/admin/api/custom-columns', requireAdmin, (req, res) => {
  const label = String((req.body && req.body.label) || '').trim();
  if (!label) return res.status(400).json({ ok: false, error: 'label required' });
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'column';
  const existing = new Set(listCustomColumns.all().map(c => c.key));
  let key = 'custom_' + base, n = 2;
  while (existing.has(key)) { key = 'custom_' + base + '_' + n; n++; }
  const actor = actorFrom(req);
  insertCustomColumn.run({ key, label, now: new Date().toISOString(), created_by: actor || null });
  logAudit(actor, 'CUSTOM_COLUMN_ADD', key, label);
  res.json({ ok: true, key, label });
});
app.delete('/admin/api/custom-columns/:key', requireAdmin, (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'key required' });
  deleteCustomColumn.run(key);
  logAudit(actorFrom(req), 'CUSTOM_COLUMN_REMOVE', key, 'column definition removed - values already saved on batches are untouched');
  res.json({ ok: true });
});

// ── DELETED BATCHES (recycle bin) — see schema.sql for why this is a
// snapshot-then-hard-delete rather than a soft-delete flag on four
// different tables. insertDeletedBatch here; list/restore/purge routes
// sit right after the DELETE route below, since restoring is really just
// "undo" for what that route just did.
const insertDeletedBatch = db.prepare(`
  INSERT INTO deleted_batches (batch, deleted_at, deleted_by, part_count, scanned_count, snapshot)
  VALUES (@batch, @deleted_at, @deleted_by, @part_count, @scanned_count, @snapshot)
`);
const listDeletedBatches = db.prepare('SELECT id, batch, deleted_at, deleted_by, part_count, scanned_count FROM deleted_batches ORDER BY deleted_at DESC');
const getDeletedBatch = db.prepare('SELECT * FROM deleted_batches WHERE id = ?');

// Permanently deletes a batch: every registered part in it (parts_index +
// parts_panel), their notes and scan-log entries, and the production
// schedule row itself. Deliberately allowed even if parts were already
// scanned (the admin UI warns and requires typing the batch name first) —
// this is for cleaning up mistaken/test batches, not a safety-gated
// operation like void. Now logged to audit_log below (previously wasn't).
// A full snapshot of everything about to be removed is captured into
// deleted_batches first, in the same transaction, so this is undoable
// via POST /admin/api/deleted-batches/:id/restore below.
app.delete('/admin/api/schedule/:batch', requireAdmin, (req, res) => {
  const batch = String(req.params.batch || '').trim();
  if (!batch) return res.status(400).json({ ok: false, error: 'batch required' });

  const uids = db.prepare('SELECT unique_id FROM parts_panel WHERE batch = ?').all(batch).map(r => r.unique_id);
  const scheduleRow = db.prepare('SELECT * FROM production_schedule WHERE batch = ?').get(batch) || null;
  if (!uids.length && !scheduleRow) return res.status(404).json({ ok: false, error: 'batch not found' });

  const getIndexRow = db.prepare('SELECT * FROM parts_index WHERE unique_id = ?');
  const getPanelRow = db.prepare('SELECT * FROM parts_panel WHERE unique_id = ?');
  const getNotesFor = db.prepare('SELECT * FROM part_notes WHERE unique_id = ?');
  const getScansFor = db.prepare('SELECT * FROM scans WHERE unique_id = ?');
  const parts = uids.map(uid => ({
    index: getIndexRow.get(uid),
    panel: getPanelRow.get(uid),
    notes: getNotesFor.all(uid),
    scans: getScansFor.all(uid),
    // internal_deliveries is unique_id-keyed (one row max), unlike the
    // notes/scans arrays above - captured (and restored) the same way
    // regardless, so a deleted batch doesn't silently lose "this part
    // never needed a packing slip" and a restore doesn't silently make
    // it need one again.
    internalDelivery: getInternalDelivery.get(uid) || null
  }));
  const scannedCount = parts.filter(p => p.index && p.index.scanned === 'Yes').length;

  const delNotes = db.prepare('DELETE FROM part_notes WHERE unique_id = ?');
  const delScans = db.prepare('DELETE FROM scans WHERE unique_id = ?');
  const delPanel = db.prepare('DELETE FROM parts_panel WHERE unique_id = ?');
  const delIndex = db.prepare('DELETE FROM parts_index WHERE unique_id = ?');
  const now = new Date().toISOString();
  const actor = actorFrom(req);

  db.exec('BEGIN');
  try {
    insertDeletedBatch.run({
      batch, deleted_at: now, deleted_by: actor || null,
      part_count: uids.length, scanned_count: scannedCount,
      snapshot: JSON.stringify({ schedule: scheduleRow, parts })
    });
    for (const uid of uids) {
      delNotes.run(uid);
      delScans.run(uid);
      deleteInternalDelivery.run(uid);
      delPanel.run(uid);
      delIndex.run(uid);
    }
    db.prepare('DELETE FROM production_schedule WHERE batch = ?').run(batch);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ ok: false, error: e.message });
  }
  logAudit(actor, 'SCHEDULE_DELETE', batch, `deleted ${uids.length} parts`);

  res.json({ ok: true, deleted_parts: uids.length });
});

app.get('/admin/api/deleted-batches', requireAdmin, (req, res) => {
  res.json({ ok: true, deleted: listDeletedBatches.all() });
});

// Re-inserts everything from one deleted_batches snapshot back into the
// live tables, exactly as captured (original timestamps, original
// sequence_no, original scan history) rather than recreating it fresh -
// this is meant to look like the delete never happened. Rejects if the
// batch name is already in use by a real batch now (same collision-
// avoidance reasoning as rename), rather than silently merging two
// unrelated batches' history together. Any single row failing (e.g. a
// unique_id that's since been reused by something else) rolls back the
// whole restore rather than leaving it half-applied.
app.post('/admin/api/deleted-batches/:id/restore', requireAdmin, (req, res) => {
  const row = getDeletedBatch.get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'nothing here to restore' });

  const collision = db.prepare('SELECT 1 FROM parts_panel WHERE batch = ? UNION SELECT 1 FROM production_schedule WHERE batch = ?').get(row.batch, row.batch);
  if (collision) return res.status(409).json({ ok: false, error: `"${row.batch}" is already in use by a current batch — rename or delete that one first` });

  let snap;
  try { snap = JSON.parse(row.snapshot); } catch (e) { return res.status(500).json({ ok: false, error: 'stored snapshot is corrupt' }); }

  const insertIndex = db.prepare(`INSERT INTO parts_index (unique_id,department,scanned,void,notes,created_at,scanned_at,scanned_by_device,voided_at,voided_by_device) VALUES (@unique_id,@department,@scanned,@void,@notes,@created_at,@scanned_at,@scanned_by_device,@voided_at,@voided_by_device)`);
  const insertPanel = db.prepare(`INSERT INTO parts_panel (unique_id,batch,sheet_name,project,floor,tag,part_type,width,height,qty,colour,generated_on,sequence_no) VALUES (@unique_id,@batch,@sheet_name,@project,@floor,@tag,@part_type,@width,@height,@qty,@colour,@generated_on,@sequence_no)`);
  const insertNote = db.prepare(`INSERT INTO part_notes (unique_id,category,note,action,device_id,device,created_at) VALUES (@unique_id,@category,@note,@action,@device_id,@device,@created_at)`);
  const insertScan = db.prepare(`INSERT INTO scans (scan_id,date,scanned_at,received_at,device,device_id,unique_id,match_status,batch_sheet,project,floor,part_type,part_name,size,qty,colour,skid,method,flag,raw,mode,batch,acknowledged,acknowledged_at) VALUES (@scan_id,@date,@scanned_at,@received_at,@device,@device_id,@unique_id,@match_status,@batch_sheet,@project,@floor,@part_type,@part_name,@size,@qty,@colour,@skid,@method,@flag,@raw,@mode,@batch,@acknowledged,@acknowledged_at)`);
  const insertSchedule = db.prepare(`INSERT INTO production_schedule (batch,job_name,floor_or_work_order,target_finish,material,finish,part_name,sheet_qty,comment,tasked,task_status,extra_fields,source,created_at,updated_at,updated_by) VALUES (@batch,@job_name,@floor_or_work_order,@target_finish,@material,@finish,@part_name,@sheet_qty,@comment,@tasked,@task_status,@extra_fields,@source,@created_at,@updated_at,@updated_by)`);
  const insertInternalDeliveryRestore = db.prepare(`INSERT INTO internal_deliveries (unique_id,batch,delivered_at,delivered_by) VALUES (@unique_id,@batch,@delivered_at,@delivered_by)`);

  db.exec('BEGIN');
  try {
    if (snap.schedule) insertSchedule.run(snap.schedule);
    for (const p of (snap.parts || [])) {
      if (p.index) insertIndex.run(p.index);
      if (p.panel) insertPanel.run(p.panel);
      // part_notes/scans both have an autoincrement id in the snapshot
      // (captured via SELECT *) that isn't one of insertNote/insertScan's
      // named params - node:sqlite rejects an object with an extra key
      // the query never references, so it has to be stripped rather than
      // passed straight through. A fresh id on restore is also correct
      // here regardless: the old one has no meaning to preserve.
      (p.notes || []).forEach(n => { const { id, ...rest } = n; insertNote.run(rest); });
      (p.scans || []).forEach(s => { const { id, ...rest } = s; insertScan.run(rest); });
      // internal_deliveries has no autoincrement id (unique_id IS the
      // primary key) - captured/restored as one object, not an array.
      if (p.internalDelivery) insertInternalDeliveryRestore.run(p.internalDelivery);
    }
    db.prepare('DELETE FROM deleted_batches WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ ok: false, error: e.message });
  }
  logAudit(actorFrom(req), 'SCHEDULE_RESTORE', row.batch, `restored ${row.part_count} parts`);

  res.json({ ok: true, batch: row.batch });
});

// Permanently forgets one recycle-bin entry — no restore possible after
// this. Kept as its own explicit action (not part of restore) so
// clearing old entries out is never one accidental click away from
// losing something recoverable.
app.delete('/admin/api/deleted-batches/:id', requireAdmin, (req, res) => {
  const row = getDeletedBatch.get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'nothing here to remove' });
  db.prepare('DELETE FROM deleted_batches WHERE id = ?').run(req.params.id);
  logAudit(actorFrom(req), 'DELETED_BATCH_PURGE', row.batch, 'permanently discarded recycle-bin entry');
  res.json({ ok: true });
});

// Renames a batch everywhere it's referenced - parts_panel (what actually
// groups labels into this batch), production_schedule (its metadata row -
// batch is that table's primary key), scans (DIRECTED-mode rows carry the
// batch they were scanned against), and packing_slips (which batch a slip
// was issued for). All four in one transaction so a batch can never end
// up split across two names if something fails partway through. Rejects
// if new_batch already names a different real batch, rather than silently
// merging two unrelated batches' parts/history together.
app.post('/admin/api/schedule/:batch/rename', requireAdmin, (req, res) => {
  const batch = String(req.params.batch || '').trim();
  const newBatch = String((req.body && req.body.new_batch) || '').trim();
  if (!batch) return res.status(400).json({ ok: false, error: 'batch required' });
  if (!newBatch) return res.status(400).json({ ok: false, error: 'new batch name required' });
  if (newBatch.length > 100) return res.status(400).json({ ok: false, error: 'new batch name is too long' });
  if (newBatch === batch) return res.status(400).json({ ok: false, error: 'new name is the same as the current name' });

  const exists = db.prepare('SELECT 1 FROM parts_panel WHERE batch = ? UNION SELECT 1 FROM production_schedule WHERE batch = ?').get(batch, batch);
  if (!exists) return res.status(404).json({ ok: false, error: 'batch not found' });
  const collision = db.prepare('SELECT 1 FROM parts_panel WHERE batch = ? UNION SELECT 1 FROM production_schedule WHERE batch = ?').get(newBatch, newBatch);
  if (collision) return res.status(409).json({ ok: false, error: `"${newBatch}" is already in use by another batch` });

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE parts_panel SET batch = ? WHERE batch = ?').run(newBatch, batch);
    db.prepare('UPDATE production_schedule SET batch = ? WHERE batch = ?').run(newBatch, batch);
    db.prepare('UPDATE scans SET batch = ? WHERE batch = ?').run(newBatch, batch);
    db.prepare('UPDATE packing_slips SET batch = ? WHERE batch = ?').run(newBatch, batch);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ ok: false, error: e.message });
  }
  logAudit(actorFrom(req), 'BATCH_RENAME', newBatch, `renamed from "${batch}"`);

  res.json({ ok: true, old_batch: batch, new_batch: newBatch, schedule: formatSchedule(getProductionSchedule.get(newBatch)) });
});

// ── SCAN-TIME MATCH — the phone calls this for every scanned ID, live.
// parts_index is checked first (universal, fast); only if a match exists
// there do we join into that department's detail table. Adding a new
// department later means adding one more case here — parts_index and
// this endpoint's shape never change.
const getMatchIndex = db.prepare('SELECT * FROM parts_index WHERE unique_id = ?');
const getMatchPanel = db.prepare('SELECT * FROM parts_panel WHERE unique_id = ?');
const markScanned = db.prepare(`
  UPDATE parts_index SET scanned='Yes', scanned_at=@now, scanned_by_device=@device_id
  WHERE unique_id=@unique_id
`);
const countNotes = db.prepare('SELECT COUNT(*) AS c FROM part_notes WHERE unique_id = ?');

app.post('/parts/match', deviceGate, (req, res) => {
  const { unique_id, device_id, device } = req.body || {};
  const uid = String(unique_id || '').trim();
  if (!uid) return res.status(400).json({ ok: false, error: 'unique_id required' });

  const idx = getMatchIndex.get(uid);
  if (!idx) return res.json({ ok: true, status: 'NOT_FOUND' });

  let detail = null;
  if (idx.department === 'PANEL') detail = getMatchPanel.get(uid);
  // future departments: else if (idx.department === 'WINDOWS') detail = getMatchWindows.get(uid);

  const fields = detail || {};
  const note_count = countNotes.get(uid).c;

  if (idx.void === 'Yes') {
    return res.json({ ok: true, status: 'VOIDED', ...fields, note_count });
  }

  if (idx.scanned === 'Yes') {
    return res.json({
      ok: true, status: 'MATCHED_ALREADY', ...fields,
      scanned_at: idx.scanned_at, scanned_by_device: idx.scanned_by_device, note_count
    });
  }

  const now = new Date().toISOString();
  markScanned.run({ now, device_id: device_id || null, unique_id: uid });
  res.json({ ok: true, status: 'MATCHED_NEW', ...fields, scanned_at: now, scanned_by_device: device_id || '', note_count });
});

// ── DIRECTED SCAN MODE — sequence-aware scanning for a batch, on top of
// the same parts_index/parts_panel data /parts/match already uses (no new
// tables). "Next expected" is always the lowest sequence_no among that
// batch's lines that are neither scanned nor voided — a voided line is
// implicitly skipped, it never blocks the sequence. There's no separate
// "skipped" state: scanning out of order just leaves the earlier pending
// line(s) as pending, so they resurface as "next expected" again later —
// self-healing instead of needing a status to track intentional skips.
const getNextExpectedLine = db.prepare(`
  SELECT pp.* FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
  WHERE pp.batch = ? AND pi.scanned = 'No' AND pi.void = 'No'
  ORDER BY pp.sequence_no ASC LIMIT 1
`);
const getDirectedLine = db.prepare(`
  SELECT pp.*, pi.scanned, pi.void, pi.scanned_at, pi.scanned_by_device
  FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
  WHERE pp.batch = ? AND pp.unique_id = ?
`);
// Voided lines never block progress elsewhere (getNextExpectedLine above
// already skips them) - total has to exclude them too, or a voided line
// permanently caps completion below 100% since it can never become
// scanned='Yes'.
const countDirectedTotal = db.prepare(`
  SELECT COUNT(*) AS c FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
  WHERE pp.batch = ? AND pi.void = 'No'
`);
const countDirectedScanned = db.prepare(`
  SELECT COUNT(*) AS c FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
  WHERE pp.batch = ? AND pi.scanned = 'Yes'
`);
function formatDirectedLine(row) {
  if (!row) return null;
  const { unique_id, sequence_no, tag, part_type, width, height, qty, colour, project, floor } = row;
  return { unique_id, sequence_no, tag, part_type, width, height, qty, colour, project, floor };
}

// Every directed-scan attempt gets its own row in the same scans table
// free-scan already writes to (mode='DIRECTED' distinguishes them) - so
// admin Reports and the exception queue see this activity without a
// parallel audit path to keep in sync. line is null for UNKNOWN_UID,
// where there's nothing registered to pull details from.
function logDirectedScanEvent(batch, uid, status, line, device_id, device, input_method) {
  const now = new Date().toISOString();
  const size = line ? [line.width, line.height].filter(Boolean).join(' X ') : '';
  upsertScan.run({
    scan_id: require('crypto').randomUUID(),
    date: now.slice(0, 10),
    scanned_at: now,
    received_at: now,
    device: device || null,
    device_id: device_id || null,
    unique_id: line ? line.unique_id : uid,
    match_status: status,
    batch_sheet: null,
    project: line ? line.project : null,
    floor: line ? line.floor : null,
    part_type: line ? line.part_type : null,
    part_name: line ? (line.tag || line.unique_id) : uid,
    size: size || null,
    qty: line ? line.qty : null,
    colour: line ? line.colour : null,
    skid: null,
    method: input_method === 'MANUAL' ? 'MANUAL' : 'SCAN',
    flag: status === 'OK' || status === 'OK_OUT_OF_ORDER' ? null : status,
    raw: uid,
    mode: 'DIRECTED',
    batch
  });
}

// What the Directed Scan screen loads before any scan happens — the
// expected-item card plus progress, so JOB_LOADED has something to show
// immediately instead of waiting on a first scan attempt. POST (not GET)
// to match deviceGate, which reads device_id from the body like every
// other device-gated route in this file.
app.post('/parts/directed/next', deviceGate, (req, res) => {
  const b = String((req.body && req.body.batch) || '').trim();
  if (!b) return res.status(400).json({ ok: false, error: 'batch required' });

  const total = countDirectedTotal.get(b).c;
  if (!total) return res.json({ ok: true, status: 'NO_LINES', total: 0, scanned: 0, expected: null });

  const scanned = countDirectedScanned.get(b).c;
  const next = getNextExpectedLine.get(b);
  res.json({
    ok: true,
    status: next ? 'AWAITING_SCAN' : 'JOB_COMPLETE',
    total, scanned,
    expected: formatDirectedLine(next)
  });
});

app.post('/parts/directed/scan', deviceGate, (req, res) => {
  const { batch, unique_id, device_id, device, confirm, input_method } = req.body || {};
  const b = String(batch || '').trim();
  const uid = String(unique_id || '').trim();
  if (!b) return res.status(400).json({ ok: false, error: 'batch required' });
  if (!uid) return res.status(400).json({ ok: false, error: 'unique_id required' });

  const next = getNextExpectedLine.get(b);
  if (!next) {
    const total = countDirectedTotal.get(b).c;
    const status = total ? 'JOB_COMPLETE' : 'NO_LINES';
    if (total) logDirectedScanEvent(b, uid, status, null, device_id, device, input_method);
    return res.json({ ok: true, status, scanned_uid: uid, expected: null });
  }

  const line = getDirectedLine.get(b, uid);
  if (!line) {
    logDirectedScanEvent(b, uid, 'UNKNOWN_UID', null, device_id, device, input_method);
    return res.json({ ok: true, status: 'UNKNOWN_UID', scanned_uid: uid, expected: formatDirectedLine(next) });
  }
  if (line.void === 'Yes') {
    logDirectedScanEvent(b, uid, 'VOIDED', line, device_id, device, input_method);
    return res.json({ ok: true, status: 'VOIDED', ...formatDirectedLine(line), expected: formatDirectedLine(next) });
  }
  if (line.scanned === 'Yes') {
    logDirectedScanEvent(b, uid, 'DUPLICATE', line, device_id, device, input_method);
    return res.json({
      ok: true, status: 'DUPLICATE', ...formatDirectedLine(line),
      scanned_at: line.scanned_at, expected: formatDirectedLine(next)
    });
  }

  // Pending, but not the lowest pending sequence_no — out of order. Report
  // it and stop; only commit the write once the operator explicitly taps
  // confirm (never auto-skip, matching what was asked for).
  if (line.unique_id !== next.unique_id && !confirm) {
    logDirectedScanEvent(b, uid, 'OUT_OF_ORDER', line, device_id, device, input_method);
    return res.json({ ok: true, status: 'OUT_OF_ORDER', matched: formatDirectedLine(line), expected: formatDirectedLine(next) });
  }

  const now = new Date().toISOString();
  markScanned.run({ now, device_id: device_id || null, unique_id: line.unique_id });
  const status = line.unique_id === next.unique_id ? 'OK' : 'OK_OUT_OF_ORDER';
  logDirectedScanEvent(b, uid, status, line, device_id, device, input_method);
  // Recomputed fresh after the write above, so the client gets the new
  // next-expected item and progress in this same response - no second
  // round-trip needed just to find out what's next.
  const newNext = getNextExpectedLine.get(b);
  res.json({
    ok: true,
    status,
    ...formatDirectedLine(line),
    scanned_at: now,
    total: countDirectedTotal.get(b).c,
    scanned: countDirectedScanned.get(b).c,
    expected: formatDirectedLine(newNext),
    job_complete: !newNext
  });
});

// One level of undo for the Directed Scan screen — mistakes happen, and
// without this every one requires going into the data directly to fix.
// Not batch-scoped (just clears the scanned flag on parts_index, same
// state a fresh label starts in); the client only ever offers this for
// the single most recent scan in its own session.
app.post('/parts/directed/undo', deviceGate, (req, res) => {
  const uid = String((req.body && req.body.unique_id) || '').trim();
  if (!uid) return res.status(400).json({ ok: false, error: 'unique_id required' });
  db.prepare("UPDATE parts_index SET scanned='No', scanned_at=NULL, scanned_by_device=NULL WHERE unique_id=?").run(uid);
  res.json({ ok: true });
});

// ── DEFECT / NOTES LOG — append-only, one row per note, never
// overwritten. Same underlying insert/list logic for both the phone
// (device-gated) and the admin dashboard (admin-key gated); only the
// gate differs, matching how every other write in this system is split.
const NOTE_CATEGORIES = ['DAMAGE', 'DEFECT', 'SCRATCH', 'BENT', 'INCORRECT', 'DENT', 'COLOUR_MISMATCH', 'MISSING_COMPONENT', 'OTHER'];
const insertNote = db.prepare(`
  INSERT INTO part_notes (unique_id, category, note, action, device_id, device, created_at)
  VALUES (@unique_id, @category, @note, @action, @device_id, @device, @now)
`);
const listNotes = db.prepare('SELECT * FROM part_notes WHERE unique_id = ? ORDER BY id DESC');

// Shared by both the plain note-add and the void-reason path below —
// same category/text validation either way, only the caller differs.
function validateNoteInput(uid, cat, note) {
  if (!uid || !getMatchIndex.get(uid)) return 'unknown unique_id';
  if (!NOTE_CATEGORIES.includes(cat)) return 'invalid category';
  if (cat === 'OTHER' && !String(note || '').trim()) return 'note text required for OTHER';
  return null;
}

function addNote(req, res) {
  const { unique_id, category, note, device_id, device } = req.body || {};
  const uid = String(unique_id || '').trim();
  const cat = String(category || '').trim().toUpperCase();
  const err = validateNoteInput(uid, cat, note);
  if (err) return res.status(400).json({ ok: false, error: err });

  const now = new Date().toISOString();
  insertNote.run({ unique_id: uid, category: cat, note: note || null, action: 'NOTE', device_id: device_id || null, device: device || null, now });
  res.json({ ok: true, notes: listNotes.all(uid) });
}

app.post('/parts/notes', deviceGate, addNote);
app.post('/admin/api/parts/notes', requireAdmin, addNote);

// ── VOID — reuses the exact same category+text reason capture as a
// note (written to part_notes with action='VOID' so the reason has a
// permanent record), plus flips parts_index.void='Yes'. Reversible via
// /admin/api/parts/unvoid below - admin-only, since an accidental void
// on the floor (wrong ID typed, wrong button tapped) needs an undo, but
// only from someone who can be trusted to use it deliberately, not
// exposed to the device-gated /parts/void path scanners use.
const voidPartsIndex = db.prepare(`
  UPDATE parts_index SET void='Yes', voided_at=@now, voided_by_device=@device_id
  WHERE unique_id=@unique_id
`);
// void is independent of scanned (see schema.sql) - clearing it here
// never touches parts_index.scanned, so a part that was scanned before
// being accidentally voided comes back exactly as "scanned, not voided"
// with nothing else to restore.
const unvoidPartsIndex = db.prepare(`
  UPDATE parts_index SET void='No', voided_at=NULL, voided_by_device=NULL
  WHERE unique_id=@unique_id
`);

function voidPart(req, res) {
  const { unique_id, category, note, device_id, device } = req.body || {};
  const uid = String(unique_id || '').trim();
  const cat = String(category || '').trim().toUpperCase();
  const err = validateNoteInput(uid, cat, note);
  if (err) return res.status(400).json({ ok: false, error: err });
  const idx = getMatchIndex.get(uid);
  if (idx.void === 'Yes') return res.status(400).json({ ok: false, error: 'already voided' });

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    voidPartsIndex.run({ now, device_id: device_id || null, unique_id: uid });
    insertNote.run({ unique_id: uid, category: cat, note: note || null, action: 'VOID', device_id: device_id || null, device: device || null, now });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ ok: false, error: e.message });
  }
  res.json({ ok: true, index: getMatchIndex.get(uid), notes: listNotes.all(uid) });
}

app.post('/parts/void', deviceGate, voidPart);
app.post('/admin/api/parts/void', requireAdmin, voidPart);

// Shared by both routes, same pattern as voidPart above - device-gated
// for the phone (any approved device, same permission model voiding
// itself already has) and admin-gated for the dashboard. No reason
// code required here, unlike voiding: this is undoing a mistake, not
// logging a new observation about the part.
function unvoidPart(req, res) {
  const { unique_id, device_id, device } = req.body || {};
  const uid = String(unique_id || '').trim();
  if (!uid) return res.status(400).json({ ok: false, error: 'unique_id required' });
  const idx = getMatchIndex.get(uid);
  if (!idx) return res.status(404).json({ ok: false, error: 'not found' });
  if (idx.void !== 'Yes') return res.status(400).json({ ok: false, error: 'not currently voided' });
  unvoidPartsIndex.run({ unique_id: uid });
  // A phone request identifies itself by device, not X-Actor-Name - fall
  // back to actorFrom(req) (the admin dashboard's header) only when no
  // device name was sent, so the audit trail shows who actually did it.
  const actor = device || actorFrom(req);
  logAudit(actor, 'PART_UNVOID', uid, device_id ? 'restored to scanned/non-voided (device: ' + device_id + ')' : 'restored to scanned/non-voided');
  res.json({ ok: true, index: getMatchIndex.get(uid), notes: listNotes.all(uid) });
}
app.post('/parts/unvoid', deviceGate, unvoidPart);
app.post('/admin/api/parts/unvoid', requireAdmin, unvoidPart);

app.get('/parts/:id/notes', (req, res) => {
  // Read-only, low-sensitivity (same data an approved device already
  // sees embedded in /parts/match) — gated by device_id as a query
  // param instead of a body, since GET requests carry no body.
  const row = getDevice.get(req.query.device_id || '');
  if (!row || row.status !== 'APPROVED') return res.status(403).json({ ok: false, error: 'not approved' });
  res.json({ ok: true, notes: listNotes.all(req.params.id) });
});

app.get('/admin/api/parts/:id', requireAdmin, (req, res) => {
  const uid = req.params.id;
  const idx = getMatchIndex.get(uid);
  if (!idx) return res.json({ ok: true, found: false });
  const detail = idx.department === 'PANEL' ? getMatchPanel.get(uid) : null;
  const deliveredInternally = getInternalDelivery.get(uid) ? 'Yes' : 'No';
  res.json({ ok: true, found: true, index: { ...idx, delivered_internally: deliveredInternally }, detail, notes: listNotes.all(uid) });
});

// ── REPORTING — admin-key gated, read-only. Three separate small
// queries rather than one mega-endpoint, since the dashboard renders
// and CSV-exports each section independently.
const reportRegistry = db.prepare(`
  SELECT department,
         COUNT(*) AS total,
         SUM(scanned='Yes') AS scanned,
         SUM(scanned='No')  AS never_scanned,
         SUM(void='Yes')    AS voided
  FROM parts_index GROUP BY department
`);
const reportMatchStatus = db.prepare(`
  SELECT COALESCE(match_status,'(none)') AS match_status, COUNT(*) AS c
  FROM scans GROUP BY match_status ORDER BY c DESC
`);
app.get('/admin/api/report/summary', requireAdmin, (req, res) => {
  res.json({ ok: true, registry: reportRegistry.all(), match_status: reportMatchStatus.all() });
});

app.get('/admin/api/report/daily', requireAdmin, (req, res) => {
  // Defaults to the last 30 days (by scans.date, already indexed) if no
  // explicit range is given.
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT date, COALESCE(match_status,'(none)') AS match_status, COUNT(*) AS c
    FROM scans WHERE date BETWEEN ? AND ?
    GROUP BY date, match_status ORDER BY date
  `).all(from, to);
  res.json({ ok: true, from, to, rows });
});

app.get('/admin/api/report/notes', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT category, action, COUNT(*) AS c
    FROM part_notes GROUP BY category, action ORDER BY c DESC
  `).all();
  res.json({ ok: true, rows });
});

// Deliberately only ever surfaced on the main admin.html, not gm.html -
// so whoever holds the primary dashboard can review what changed on the
// GM's copy (or anyone else's), not the other way around.
app.get('/admin/api/audit-log', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all();
  res.json({ ok: true, entries: rows });
});

// ── EXCEPTION QUEUE — every scan that wasn't a clean match, from either
// scanning flow (mode distinguishes them). Capped to the most recent 500
// so the payload stays bounded; acknowledged is a lightweight triage flag,
// not a resolution workflow - supervisors use it to mark "seen", nothing
// more.
const OK_STATUSES = ['MATCHED_NEW', 'OK', 'OK_OUT_OF_ORDER'];
app.get('/admin/api/exceptions', requireAdmin, (req, res) => {
  const placeholders = OK_STATUSES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT scan_id, scanned_at, device, device_id, unique_id, match_status,
           part_name, mode, batch, method, acknowledged, acknowledged_at
    FROM scans
    WHERE match_status IS NULL OR match_status NOT IN (${placeholders})
    ORDER BY scanned_at DESC LIMIT 500
  `).all(...OK_STATUSES);
  res.json({ ok: true, exceptions: rows });
});
app.post('/admin/api/exceptions/:scanId/ack', requireAdmin, (req, res) => {
  db.prepare("UPDATE scans SET acknowledged='Yes', acknowledged_at=? WHERE scan_id=?")
    .run(new Date().toISOString(), req.params.scanId);
  logAudit(actorFrom(req), 'EXCEPTION_ACK', req.params.scanId);
  res.json({ ok: true });
});

// ── DEVICE ACTIVITY — last actual scan per approved device (not just last
// Settings-save/registration, which devices.last_seen tracks) so an idle
// handheld shows up even if the app itself has been open and "seen" the
// whole time without anyone scanning anything with it.
app.get('/admin/api/device-activity', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT d.device_id, d.device_name,
           (SELECT MAX(scanned_at) FROM scans s WHERE s.device_id = d.device_id) AS last_scan_at
    FROM devices d
    WHERE d.status = 'APPROVED'
    ORDER BY last_scan_at DESC
  `).all();
  res.json({ ok: true, devices: rows });
});

// ── MATERIAL STOCK — manual on-hand qty per material, the minimal input
// Phase 4 needs (no real inventory system exists to integrate with).
const upsertMaterialStock = db.prepare(`
  INSERT INTO material_stock (material, on_hand_qty, updated_at, updated_by)
  VALUES (@material, @on_hand_qty, @now, @updated_by)
  ON CONFLICT(material) DO UPDATE SET on_hand_qty=@on_hand_qty, updated_at=@now, updated_by=@updated_by
`);
app.get('/admin/api/material-stock', requireAdmin, (req, res) => {
  res.json({ ok: true, stock: db.prepare('SELECT * FROM material_stock').all() });
});
app.post('/admin/api/material-stock/:material', requireAdmin, (req, res) => {
  const material = String(req.params.material || '').trim();
  if (!material) return res.status(400).json({ ok: false, error: 'material required' });
  const qty = parseFloat(req.body && req.body.on_hand_qty);
  if (isNaN(qty)) return res.status(400).json({ ok: false, error: 'on_hand_qty must be a number' });
  const actor = actorFrom(req);
  upsertMaterialStock.run({ material, on_hand_qty: qty, now: new Date().toISOString(), updated_by: actor });
  logAudit(actor, 'MATERIAL_STOCK_EDIT', material, `on_hand_qty=${qty}`);
  res.json({ ok: true });
});

// ── PACKING SLIPS — generated once a batch is fully scanned, for internal
// pack-and-ship documentation. parts_snapshot (and the job/floor fields)
// are captured once at creation time rather than joined live (see
// schema.sql), so an issued slip stays accurate to what was actually
// packed even if the batch's data changes afterward.
const insertPackingSlip = db.prepare(`
  INSERT INTO packing_slips (
    slip_number, batch, slip_date, department, ship_to, job_name,
    floor_or_work_order, comments, special_handling, checked_by,
    parts_snapshot, created_at, created_by
  ) VALUES (
    @slip_number, @batch, @slip_date, @department, @ship_to, @job_name,
    @floor_or_work_order, @comments, @special_handling, @checked_by,
    @parts_snapshot, @now, @created_by
  )
`);
const listPackingSlips = db.prepare('SELECT id, slip_number, batch, slip_date, department, ship_to, created_at FROM packing_slips ORDER BY id DESC');
const getPackingSlip = db.prepare('SELECT * FROM packing_slips WHERE id = ?');
const getPackingSlipByNumber = db.prepare('SELECT * FROM packing_slips WHERE slip_number = ?');
const listPackingSlipPartsForBatch = db.prepare('SELECT parts_snapshot FROM packing_slips WHERE batch = ?');
// Every unique_id already sitting on ANY existing slip for this batch
// (split shipments - a batch can now have more than one slip, each
// covering a different subset of its parts). Computed fresh from the
// DB, never trusted from the client, same reasoning as includeUnscanned
// below - what's still eligible for a NEW slip has to be decided here.
function alreadyPackedUniqueIds(batch) {
  const ids = new Set();
  for (const row of listPackingSlipPartsForBatch.all(batch)) {
    let parts = [];
    try { parts = JSON.parse(row.parts_snapshot) || []; } catch (e) { parts = []; }
    for (const p of parts) { if (p && p.unique_id) ids.add(p.unique_id); }
  }
  return ids;
}

// ── INTERNAL DELIVERIES — see schema.sql for why this exists (a part
// delivered on-site instead of shipped never needs a packing slip).
const getPartBatch = db.prepare('SELECT batch FROM parts_panel WHERE unique_id = ?');
const getInternalDelivery = db.prepare('SELECT * FROM internal_deliveries WHERE unique_id = ?');
const insertInternalDelivery = db.prepare(`
  INSERT INTO internal_deliveries (unique_id, batch, delivered_at, delivered_by)
  VALUES (@unique_id, @batch, @now, @delivered_by)
  ON CONFLICT(unique_id) DO UPDATE SET delivered_at=excluded.delivered_at, delivered_by=excluded.delivered_by
`);
const deleteInternalDelivery = db.prepare('DELETE FROM internal_deliveries WHERE unique_id = ?');
const listInternalDeliveriesForBatch = db.prepare('SELECT unique_id FROM internal_deliveries WHERE batch = ?');
app.post('/admin/api/parts/internal-delivery', requireAdmin, (req, res) => {
  const uid = String((req.body && req.body.unique_id) || '').trim();
  if (!uid) return res.status(400).json({ ok: false, error: 'unique_id required' });
  const idx = getMatchIndex.get(uid);
  if (!idx) return res.status(404).json({ ok: false, error: 'not found' });
  if (idx.void === 'Yes') return res.status(400).json({ ok: false, error: 'this part is voided' });
  const row = getPartBatch.get(uid);
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  if (alreadyPackedUniqueIds(row.batch).has(uid)) {
    return res.status(400).json({ ok: false, error: 'this part is already on a packing slip' });
  }
  const actor = actorFrom(req);
  insertInternalDelivery.run({ unique_id: uid, batch: row.batch, now: new Date().toISOString(), delivered_by: actor });
  logAudit(actor, 'INTERNAL_DELIVERY_MARK', uid, `batch ${row.batch} - no packing slip needed`);
  res.json({ ok: true });
});
app.delete('/admin/api/parts/internal-delivery/:uniqueId', requireAdmin, (req, res) => {
  const uid = req.params.uniqueId;
  deleteInternalDelivery.run(uid);
  logAudit(actorFrom(req), 'INTERNAL_DELIVERY_UNMARK', uid, 'part is eligible for a packing slip again');
  res.json({ ok: true });
});
// COUNT(*)+1 looked right but breaks the moment any slip is ever deleted -
// deleting PS-26-001 drops the count back to 0, so the next slip computes
// "PS-26-001" again and collides with whatever's still using PS-26-002+.
// MAX of the actual numeric suffix never goes backwards on a deletion.
const maxSlipSeqWithPrefix = db.prepare(`
  SELECT MAX(CAST(SUBSTR(slip_number, LENGTH(?) + 1) AS INTEGER)) AS m
  FROM packing_slips WHERE slip_number LIKE ?
`);
// total excludes voided lines - same reasoning as countDirectedTotal
// above, otherwise a batch with any voided line could never be "fully
// scanned" and would permanently block packing slip creation.
const getBatchCompletion = db.prepare(`
  SELECT COUNT(*) AS total, SUM(pi.scanned='Yes') AS scanned
  FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
  WHERE pp.batch = ? AND pi.void = 'No'
`);
// Voided lines never shipped - a packing slip lists what actually left
// the floor, not everything ever registered under this batch name. This
// deliberately does NOT filter on pi.scanned in the query itself - a
// batch let through the completion gate below via the admin's manual-
// complete override can still have unscanned lines, and whether those
// belong on the slip is the admin's own choice at creation time (see
// include_unscanned below), not something to bake into this query.
// scanned is carried through into parts_snapshot too, both to let the
// POST handler filter it out when asked and so the printed slip can
// mark still-unscanned parts (a small dot - see packingSlipBodyRowsHtml
// client-side).
const getBatchParts = db.prepare(`
  SELECT pp.unique_id, pp.tag, pp.part_type, pp.width, pp.height, pp.qty, pp.colour, pi.scanned
  FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
  WHERE pp.batch = ? AND pi.void = 'No'
  ORDER BY pp.sequence_no ASC, pp.tag ASC
`);
function formatPackingSlip(row) {
  if (!row) return null;
  return { ...row, parts_snapshot: JSON.parse(row.parts_snapshot) };
}

app.get('/admin/api/packing-slips', requireAdmin, (req, res) => {
  res.json({ ok: true, slips: listPackingSlips.all() });
});

app.get('/admin/api/packing-slips/:id', requireAdmin, (req, res) => {
  const row = getPackingSlip.get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, slip: formatPackingSlip(row) });
});

app.post('/admin/api/packing-slips', requireAdmin, (req, res) => {
  const b = req.body || {};
  const batch = String(b.batch || '').trim();
  if (!batch) return res.status(400).json({ ok: false, error: 'batch required' });

  const completion = getBatchCompletion.get(batch);
  if (!completion || !completion.total) return res.status(400).json({ ok: false, error: 'batch has no registered parts' });
  const schedule = getProductionSchedule.get(batch) || {};
  // The admin dashboards already treat a manually-forced-complete batch
  // (Task Status -> "Complete (Manual)", see saveTaskStatus/isForceComplete
  // client-side) as done and let a packing slip be started for it even
  // when the real scan count is behind - that override has to be honored
  // here too, or the "Create Packing Slip" button they already see just
  // 400s the moment they click it.
  let scheduleExtra = {};
  if (schedule.extra_fields) { try { scheduleExtra = JSON.parse(schedule.extra_fields); } catch (e) { scheduleExtra = {}; } }
  const manuallyCompleted = !!scheduleExtra.forceComplete;
  const fullyScanned = completion.scanned === completion.total;
  if (!fullyScanned && !manuallyCompleted) {
    return res.status(400).json({ ok: false, error: 'batch is not fully scanned yet — cannot create a packing slip' });
  }

  const now = new Date().toISOString();
  const prefix = `PS-${new Date().getFullYear().toString().slice(-2)}-`;
  // A manually-completed batch that isn't fully scanned lets the admin
  // choose (a confirm dialog client-side) whether the slip should
  // include the still-unscanned parts or just the ones actually
  // scanned. Computed here off the real scan status pulled fresh from
  // the DB - never trusting the client's parts_snapshot for WHICH parts
  // are eligible, only for their order/grouping (see the reorder/group
  // validation below). A genuinely fully-scanned batch has nothing to
  // exclude either way, so include_unscanned is moot there.
  const includeUnscanned = fullyScanned || b.include_unscanned !== false;
  // ── SPLIT SHIPMENTS — a batch can now have more than one packing
  // slip, each covering a different subset of its parts (partial
  // shipments). Whatever's already on an earlier slip for this batch is
  // never eligible for a new one - excluded here, server-side, same as
  // includeUnscanned above, so a stale/tampered client can't double-pack
  // a part onto two slips. A part marked as delivered within the
  // building (internal_deliveries) is excluded the same way - it will
  // never need a packing slip at all.
  const packedIds = alreadyPackedUniqueIds(batch);
  const internalIds = new Set(listInternalDeliveriesForBatch.all(batch).map(r => r.unique_id));
  let authoritative = getBatchParts.all(batch).filter(p => !packedIds.has(p.unique_id) && !internalIds.has(p.unique_id));
  if (!includeUnscanned) authoritative = authoritative.filter(p => p.scanned === 'Yes');
  if (!authoritative.length) {
    return res.status(400).json({ ok: false, error: 'every part in this batch is already on a packing slip or marked as delivered within the building' });
  }

  // An explicitly-empty parts_snapshot (Remove Selected took every part
  // off this slip) means zero parts, not "not sent" - has to be caught
  // before the length check below, which would otherwise treat an empty
  // array the same as an omitted one and silently fall back to
  // authoritative (i.e. quietly ignore that everything was removed).
  if (Array.isArray(b.parts_snapshot) && !b.parts_snapshot.length) {
    return res.status(400).json({ ok: false, error: 'parts_snapshot is empty - a slip needs at least one part' });
  }
  // The admin UI lets someone reorder parts, cluster them into named
  // groups (e.g. "RAILINGS"), and - for a split shipment - remove some
  // of them from THIS slip entirely so they're left for a follow-up one
  // (Remove Selected). All of that comes back here as b.parts_snapshot.
  // Never trust it for the actual part *data* though (tag/type/size/qty/
  // colour always come from the authoritative query above, keyed by
  // unique_id) - only its order, grouping, and (now) which subset of
  // authoritative it kept are used. A genuine subset is fine (that's the
  // whole point of Remove Selected) - what's NOT fine is a unique_id
  // that isn't in authoritative at all (stale client, or the batch
  // changed underneath it) or a duplicate, either of which gets
  // rejected rather than silently falling back, since that would
  // quietly discard whatever arranging/splitting was just done.
  let parts = authoritative;
  if (Array.isArray(b.parts_snapshot) && b.parts_snapshot.length) {
    const byId = new Map(authoritative.map(p => [p.unique_id, p]));
    const seen = new Set();
    const reordered = [];
    let valid = authoritative.length >= b.parts_snapshot.length;
    if (valid) {
      for (const item of b.parts_snapshot) {
        const uid = item && item.unique_id;
        const src = uid != null ? byId.get(uid) : null;
        if (!src || seen.has(uid)) { valid = false; break; }
        seen.add(uid);
        const group = (item.group && typeof item.group === 'string') ? item.group.trim().slice(0, 60) : '';
        reordered.push({ ...src, group });
      }
    }
    if (!valid) {
      return res.status(409).json({ ok: false, error: 'Part list has changed since you loaded it — reload this batch and try again.' });
    }
    parts = reordered;
  }
  const actor = actorFrom(req);
  const insertFields = {
    batch,
    slip_date: b.slip_date || now.slice(0, 10),
    department: b.department || null,
    ship_to: b.ship_to || null,
    job_name: b.job_name || schedule.job_name || null,
    floor_or_work_order: b.floor_or_work_order || schedule.floor_or_work_order || null,
    comments: b.comments || null,
    special_handling: b.special_handling || null,
    checked_by: b.checked_by || null,
    parts_snapshot: JSON.stringify(parts),
    now,
    created_by: actor
  };

  // Four dashboards can now hit this at once - MAX+1 fixes the deletion-gap
  // bug, but two requests racing between the MAX read and the INSERT could
  // still both land on the same number. Retry with the next number instead
  // of 500ing if that happens; a handful of attempts is more than enough
  // for a UNIQUE collision that only occurs from real concurrent clicks.
  let slipNumber, lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = (maxSlipSeqWithPrefix.get(prefix, prefix + '%').m || 0) + 1;
    slipNumber = prefix + String(seq).padStart(3, '0');
    try {
      insertPackingSlip.run({ slip_number: slipNumber, ...insertFields });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (!/UNIQUE constraint failed: packing_slips\.slip_number/.test(e.message)) throw e;
    }
  }
  if (lastErr) return res.status(500).json({ ok: false, error: 'Could not allocate a packing slip number - try again.' });

  logAudit(actor, 'PACKING_SLIP_CREATE', slipNumber, `batch ${batch}`);

  res.json({ ok: true, slip: formatPackingSlip(getPackingSlipByNumber.get(slipNumber)) });
});

// Edit only touches the metadata fields a person filled in by hand
// (department/ship-to/job/floor/date/checked-by/comments/special
// handling) - batch and parts_snapshot are never touched here, staying
// locked to what was actually packed at creation time. @field ?? existing
// so an omitted key preserves what's there, but an explicit empty string
// still clears it (matches the upsertSchedule convention elsewhere).
const updatePackingSlip = db.prepare(`
  UPDATE packing_slips SET
    slip_date=@slip_date, department=@department, ship_to=@ship_to,
    job_name=@job_name, floor_or_work_order=@floor_or_work_order,
    comments=@comments, special_handling=@special_handling, checked_by=@checked_by
  WHERE id=@id
`);
app.post('/admin/api/packing-slips/:id', requireAdmin, (req, res) => {
  const row = getPackingSlip.get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  const b = req.body || {};
  updatePackingSlip.run({
    id: req.params.id,
    slip_date: b.slip_date ?? row.slip_date,
    department: b.department ?? row.department,
    ship_to: b.ship_to ?? row.ship_to,
    job_name: b.job_name ?? row.job_name,
    floor_or_work_order: b.floor_or_work_order ?? row.floor_or_work_order,
    comments: b.comments ?? row.comments,
    special_handling: b.special_handling ?? row.special_handling,
    checked_by: b.checked_by ?? row.checked_by
  });
  logAudit(actorFrom(req), 'PACKING_SLIP_EDIT', row.slip_number, JSON.stringify(b));
  res.json({ ok: true, slip: formatPackingSlip(getPackingSlip.get(req.params.id)) });
});
app.delete('/admin/api/packing-slips/:id', requireAdmin, (req, res) => {
  const row = getPackingSlip.get(req.params.id);
  db.prepare('DELETE FROM packing_slips WHERE id = ?').run(req.params.id);
  if (row) logAudit(actorFrom(req), 'PACKING_SLIP_DELETE', row.slip_number, `batch ${row.batch}`);
  res.json({ ok: true });
});

// ── BATCH STATUS — read-only, viewer-key gated. Powers the phone app's
// Batch Status tab: pick a batch, see every label's real-time status. Pure
// join of parts_panel (write-once from Excel) + parts_index (the only
// place status/scanned/void actually live) — no new table, nothing here
// mutates anything.
app.get('/viewer/api/batches', requireViewer, (req, res) => {
  const rows = db.prepare(`
    SELECT pp.batch, SUM(pi.void='No') AS total,
           SUM(pi.scanned='Yes' AND pi.void='No') AS scanned,
           SUM(pi.void='Yes') AS voided,
           MIN(pi.created_at) AS added_at,
           MAX(pi.scanned_at) AS last_scanned_at,
           -- Kanban "blocked" signal: an unscanned part with a logged defect
           -- note is plausibly still an open problem; a note on a part that
           -- went on to scan successfully was presumably resolved or worked
           -- around. part_notes has no resolved/open flag of its own, so
           -- this is the closest honest proxy available without adding one.
           (SELECT COUNT(DISTINCT pn.unique_id) FROM part_notes pn
            JOIN parts_index pi2 ON pi2.unique_id = pn.unique_id
            JOIN parts_panel pp2 ON pp2.unique_id = pi2.unique_id
            WHERE pp2.batch = pp.batch AND pi2.scanned = 'No' AND pi2.void = 'No'
           ) AS open_note_count,
           -- Parts marked as delivered within the building (see
           -- internal_deliveries in schema.sql) never need a packing
           -- slip - the Ready to Pack card's "still has parts to pack"
           -- math needs this count alongside packedUniqueIds client-side.
           (SELECT COUNT(*) FROM internal_deliveries idel
            JOIN parts_panel pp3 ON pp3.unique_id = idel.unique_id
            WHERE pp3.batch = pp.batch
           ) AS delivered_internally_count
    FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
    WHERE pp.batch IS NOT NULL AND pp.batch != ''
    GROUP BY pp.batch ORDER BY added_at DESC
  `).all();
  // Production-schedule metadata is batch-level, not per-label — enrich
  // each row here rather than adding a second request the phone/admin
  // would have to make (this endpoint is already polled every 5s).
  const batches = rows.map(r => Object.assign({}, r, formatSchedule(getProductionSchedule.get(r.batch))));
  res.json({ ok: true, batches });
});

app.get('/viewer/api/batches/:batch', requireViewer, (req, res) => {
  const rows = db.prepare(`
    SELECT pi.unique_id, pp.tag, pp.project, pp.floor, pp.part_type,
           pp.width, pp.height, pp.qty, pp.colour, pp.sequence_no,
           pi.scanned, pi.scanned_at, pi.scanned_by_device,
           pi.void, pi.voided_at,
           (SELECT COUNT(*) FROM part_notes pn WHERE pn.unique_id = pi.unique_id) AS note_count,
           CASE WHEN idel.unique_id IS NOT NULL THEN 'Yes' ELSE 'No' END AS delivered_internally
    FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
    LEFT JOIN internal_deliveries idel ON idel.unique_id = pi.unique_id
    WHERE pp.batch = ?
    ORDER BY pi.scanned ASC, pp.tag ASC
  `).all(req.params.batch);
  const schedule = formatSchedule(getProductionSchedule.get(req.params.batch));
  res.json({ ok: true, batch: req.params.batch, schedule, labels: rows });
});

// Read-only notes lookup for the Batch Status label-detail modal. Deliberately
// not the same route as GET /parts/:id/notes (device-approval gated) — the
// viewer key must work from a computer that's never scanned anything and so
// was never registered as a device, not just from an approved phone.
app.get('/viewer/api/parts/:id/notes', requireViewer, (req, res) => {
  res.json({ ok: true, notes: listNotes.all(req.params.id) });
});

const PORT = process.env.PORT || 8765;
// Plain HTTP — kept for LAN tools/scripts that don't need TLS, and for
// anything still pointed at :8765 directly. No host argument to listen()
// means Node binds all interfaces by default, not just localhost - this
// already accepts connections from any device on the LAN. The log line
// used to print "localhost" here, which was never actually the bind
// scope, just a misleading label.
http.createServer(app).listen(PORT, () => console.log(`Matrex scan server listening on http://192.168.20.15:${PORT} (all interfaces)`));

// HTTPS on 443 — self-signed, generated once for this server's static LAN
// IP (server/data/tls-*.pem, gitignored same as the API keys - regenerate
// with the openssl command in the deployment notes if the IP ever
// changes). Exists because the phone app is HTTPS (GitHub Pages), and
// browsers - Safari in particular, with no user-facing override at all -
// refuse to let an HTTPS page talk to a plain-HTTP receiver ("mixed
// content"). LAN-only by design: no port-forwarding, no external DNS,
// nothing outside this network can reach it. Each phone needs to trust
// this certificate once (Settings, not a code workaround); after that the
// URL just works permanently, like any other HTTPS site, for as long as
// the server keeps this IP.
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const TLS_KEY_PATH = path.join(__dirname, 'data', 'tls-key.pem');
const TLS_CERT_PATH = path.join(__dirname, 'data', 'tls-cert.pem');
if (fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH)) {
  https.createServer({
    key: fs.readFileSync(TLS_KEY_PATH),
    cert: fs.readFileSync(TLS_CERT_PATH)
  }, app).listen(HTTPS_PORT, () => console.log(`Matrex scan server also listening on https://192.168.20.15${HTTPS_PORT === 443 ? '' : ':' + HTTPS_PORT} (all interfaces)`));
} else {
  console.log(`No TLS cert found at server/data/tls-*.pem — HTTPS not started, only plain HTTP on ${PORT}`);
}
