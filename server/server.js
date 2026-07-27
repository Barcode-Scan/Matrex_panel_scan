const fs = require('fs');
const path = require('path');
const http = require('http');
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
  res.json({ ok: true });
});
app.post('/admin/api/devices/:id/revoke', requireAdmin, (req, res) => {
  setDeviceStatus.run({ device_id: req.params.id, status: 'REVOKED', now: new Date().toISOString() });
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
    skid, method, flag, raw
  ) VALUES (
    @scan_id, @date, @scanned_at, @received_at, @device, @device_id, @unique_id, @match_status,
    @batch_sheet, @project, @floor, @part_type, @part_name, @size, @qty, @colour,
    @skid, @method, @flag, @raw
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
        raw: row.raw || null
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
  INSERT INTO parts_panel (unique_id, batch, sheet_name, project, floor, tag, part_type, width, height, qty, colour, generated_on)
  VALUES (@unique_id, @batch, @sheet_name, @project, @floor, @tag, @part_type, @width, @height, @qty, @colour, @generated_on)
  ON CONFLICT(unique_id) DO NOTHING
`);
const getPartsIndexRow = db.prepare('SELECT unique_id FROM parts_index WHERE unique_id = ?');

app.post('/parts/panel/register', requireIngest, (req, res) => {
  const { batch, rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ ok: false, error: 'rows array required' });

  const now = new Date().toISOString();
  let inserted = 0, alreadyExisted = 0, skipped = 0;

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const uid = String(row.unique_id || '').trim();
      if (!uid || uid.length > 50) { skipped++; continue; }
      const existed = !!getPartsIndexRow.get(uid);
      insertPartsIndex.run({ unique_id: uid, now });
      insertPartsPanel.run({
        unique_id: uid,
        batch: row.batch || batch || null,
        sheet_name: row.sheet_name || null,
        project: row.project || null,
        floor: row.floor || null,
        tag: row.tag || null,
        part_type: row.part_type || null,
        width: row.width || null,
        height: row.height || null,
        qty: row.qty || null,
        colour: row.colour || null,
        generated_on: row.generated_on || null
      });
      if (existed) alreadyExisted++; else inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ ok: false, error: e.message });
  }

  res.json({ ok: true, inserted, already_existed: alreadyExisted, skipped, total: rows.length });
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

// ── BATCH STATUS — read-only, viewer-key gated. Powers the phone app's
// Batch Status tab: pick a batch, see every label's real-time status. Pure
// join of parts_panel (write-once from Excel) + parts_index (the only
// place status/scanned/void actually live) — no new table, nothing here
// mutates anything.
app.get('/viewer/api/batches', requireViewer, (req, res) => {
  const rows = db.prepare(`
    SELECT pp.batch, COUNT(*) AS total,
           SUM(pi.scanned='Yes') AS scanned,
           SUM(pi.void='Yes') AS voided
    FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
    WHERE pp.batch IS NOT NULL AND pp.batch != ''
    GROUP BY pp.batch ORDER BY pp.batch DESC
  `).all();
  res.json({ ok: true, batches: rows });
});

app.get('/viewer/api/batches/:batch', requireViewer, (req, res) => {
  const rows = db.prepare(`
    SELECT pi.unique_id, pp.tag, pp.project, pp.floor, pp.part_type,
           pp.width, pp.height, pp.qty, pp.colour,
           pi.scanned, pi.scanned_at, pi.scanned_by_device,
           pi.void, pi.voided_at,
           (SELECT COUNT(*) FROM part_notes pn WHERE pn.unique_id = pi.unique_id) AS note_count
    FROM parts_panel pp JOIN parts_index pi ON pi.unique_id = pp.unique_id
    WHERE pp.batch = ?
    ORDER BY pi.scanned ASC, pp.tag ASC
  `).all(req.params.batch);
  res.json({ ok: true, batch: req.params.batch, labels: rows });
});

// Read-only notes lookup for the Batch Status label-detail modal. Deliberately
// not the same route as GET /parts/:id/notes (device-approval gated) — the
// viewer key must work from a computer that's never scanned anything and so
// was never registered as a device, not just from an approved phone.
app.get('/viewer/api/parts/:id/notes', requireViewer, (req, res) => {
  res.json({ ok: true, notes: listNotes.all(req.params.id) });
});

const PORT = process.env.PORT || 8765;
// Plain HTTP — Cloudflare Tunnel (or a reverse proxy on the company server)
// terminates public TLS and forwards to this process over localhost only.
http.createServer(app).listen(PORT, () => console.log(`Matrex scan server listening on http://localhost:${PORT}`));
