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
const SCHEDULE_FIELDS = ['job_name', 'floor_or_work_order', 'target_finish', 'material', 'finish', 'part_name', 'sheet_qty', 'comment', 'tasked'];
const upsertProductionSchedule = db.prepare(`
  INSERT INTO production_schedule
    (batch, job_name, floor_or_work_order, target_finish, material, finish,
     part_name, sheet_qty, comment, tasked, extra_fields, source, created_at, updated_at, updated_by)
  VALUES
    (@batch, @job_name, @floor_or_work_order, @target_finish, @material, @finish,
     @part_name, @sheet_qty, @comment, @tasked, @extra_fields, @source, @now, @now, @updated_by)
  ON CONFLICT(batch) DO UPDATE SET
    job_name=excluded.job_name, floor_or_work_order=excluded.floor_or_work_order,
    target_finish=excluded.target_finish, material=excluded.material, finish=excluded.finish,
    part_name=excluded.part_name, sheet_qty=excluded.sheet_qty, comment=excluded.comment,
    tasked=excluded.tasked, extra_fields=excluded.extra_fields,
    source=excluded.source, updated_at=excluded.updated_at, updated_by=excluded.updated_by
`);
const getProductionSchedule = db.prepare('SELECT * FROM production_schedule WHERE batch = ?');

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

// Permanently deletes a batch: every registered part in it (parts_index +
// parts_panel), their notes and scan-log entries, and the production
// schedule row itself. Deliberately allowed even if parts were already
// scanned (the admin UI warns and requires typing the batch name first) —
// this is for cleaning up mistaken/test batches, not a safety-gated
// operation like void. Now logged to audit_log below (previously wasn't).
app.delete('/admin/api/schedule/:batch', requireAdmin, (req, res) => {
  const batch = String(req.params.batch || '').trim();
  if (!batch) return res.status(400).json({ ok: false, error: 'batch required' });

  const uids = db.prepare('SELECT unique_id FROM parts_panel WHERE batch = ?').all(batch).map(r => r.unique_id);
  const delNotes = db.prepare('DELETE FROM part_notes WHERE unique_id = ?');
  const delScans = db.prepare('DELETE FROM scans WHERE unique_id = ?');
  const delPanel = db.prepare('DELETE FROM parts_panel WHERE unique_id = ?');
  const delIndex = db.prepare('DELETE FROM parts_index WHERE unique_id = ?');

  db.exec('BEGIN');
  try {
    for (const uid of uids) {
      delNotes.run(uid);
      delScans.run(uid);
      delPanel.run(uid);
      delIndex.run(uid);
    }
    db.prepare('DELETE FROM production_schedule WHERE batch = ?').run(batch);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ ok: false, error: e.message });
  }
  logAudit(actorFrom(req), 'SCHEDULE_DELETE', batch, `deleted ${uids.length} parts`);

  res.json({ ok: true, deleted_parts: uids.length });
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
// permanent record), plus flips parts_index.void='Yes'. One-directional
// by design: un-voiding a mistake is a deliberate admin/DB action, not
// exposed here, so voiding stays a real decision rather than a toggle.
const voidPartsIndex = db.prepare(`
  UPDATE parts_index SET void='Yes', voided_at=@now, voided_by_device=@device_id
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
  res.json({ ok: true, found: true, index: idx, detail, notes: listNotes.all(uid) });
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
const countSlipsWithPrefix = db.prepare('SELECT COUNT(*) AS c FROM packing_slips WHERE slip_number LIKE ?');
// total excludes voided lines - same reasoning as countDirectedTotal
// above, otherwise a batch with any voided line could never be "fully
// scanned" and would permanently block packing slip creation.
const getBatchCompletion = db.prepare(`
  SELECT COUNT(*) AS total, SUM(pi.scanned='Yes') AS scanned
  FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
  WHERE pp.batch = ? AND pi.void = 'No'
`);
// Voided lines never shipped - a packing slip lists what actually left
// the floor, not everything ever registered under this batch name. The
// completion gate above already guarantees every non-voided line is
// scanned by the time a slip can be created, so this filter alone is
// enough to make the snapshot "scanned, non-voided parts only".
const getBatchParts = db.prepare(`
  SELECT pp.unique_id, pp.tag, pp.part_type, pp.width, pp.height, pp.qty, pp.colour
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
  if (completion.scanned !== completion.total) return res.status(400).json({ ok: false, error: 'batch is not fully scanned yet — cannot create a packing slip' });

  const now = new Date().toISOString();
  const prefix = `PS-${new Date().getFullYear().toString().slice(-2)}-`;
  const seq = countSlipsWithPrefix.get(prefix + '%').c + 1;
  const slipNumber = prefix + String(seq).padStart(3, '0');

  const schedule = getProductionSchedule.get(batch) || {};
  const parts = getBatchParts.all(batch);
  const actor = actorFrom(req);

  insertPackingSlip.run({
    slip_number: slipNumber,
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
  });
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
           MAX(pi.scanned_at) AS last_scanned_at
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
           (SELECT COUNT(*) FROM part_notes pn WHERE pn.unique_id = pi.unique_id) AS note_count
    FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
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
