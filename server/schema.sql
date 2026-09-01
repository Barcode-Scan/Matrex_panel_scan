CREATE TABLE IF NOT EXISTS scans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id       TEXT NOT NULL UNIQUE,
  date          TEXT NOT NULL,
  scanned_at    TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  device        TEXT,
  device_id     TEXT,
  unique_id     TEXT,  -- the scanned parts-registry ID, if this was a SCAN (blank for MANUAL)
  match_status  TEXT,  -- MATCHED_NEW | MATCHED_ALREADY | VOIDED | NOT_FOUND | UNVERIFIED | '' (MANUAL)
  batch_sheet   TEXT,
  project       TEXT,
  floor         TEXT,
  part_type     TEXT,
  part_name     TEXT,
  size          TEXT,
  qty           TEXT,
  colour        TEXT,
  skid          TEXT,
  method        TEXT,
  flag          TEXT,
  raw           TEXT,
  mode          TEXT NOT NULL DEFAULT 'FREE',  -- 'FREE' | 'DIRECTED' - which scanning flow this came from
  batch         TEXT,  -- production batch, populated for DIRECTED rows (parts_panel.batch)
  acknowledged  TEXT NOT NULL DEFAULT 'No',  -- 'Yes' | 'No' - supervisor triage on the admin Exception Queue
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scans_date   ON scans(date);
CREATE INDEX IF NOT EXISTS idx_scans_device ON scans(device_id);

-- Device approval gate: a phone must be explicitly approved here before
-- /upload accepts anything from it. Unknown or pending device_ids are
-- rejected — this is the access control for the public tunnel URL.
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  device_name  TEXT,
  status       TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REVOKED
  first_seen   TEXT NOT NULL,
  last_seen    TEXT,
  approved_at  TEXT,
  ip           TEXT
);

-- SQLite has no stored procedures; views are the portable equivalent for
-- canned reports and translate directly to CREATE VIEW on Postgres/MySQL/
-- SQL Server later.
CREATE VIEW IF NOT EXISTS v_daily_summary AS
  SELECT date, flag, COUNT(*) AS cnt
  FROM scans
  GROUP BY date, flag;

-- ── PARTS REGISTRY (pre-registered labels, checked at scan time) ──────
-- Two-table split so future departments (Windows, etc.) get their own
-- detail table with a totally different structure, without ever having
-- to touch this one. parts_index is the *only* place status/void live —
-- department detail tables are pure write-once reference data from
-- Excel, never mutated after registration.
CREATE TABLE IF NOT EXISTS parts_index (
  unique_id      TEXT PRIMARY KEY,     -- the 10-char ID encoded in the QR
  department     TEXT NOT NULL,        -- 'PANEL' today; 'WINDOWS' etc. later
  scanned        TEXT NOT NULL DEFAULT 'No',  -- 'Yes' | 'No'
  void           TEXT NOT NULL DEFAULT 'No',  -- 'Yes' | 'No' — voided/rejected, independent of scanned
  notes          TEXT,                 -- deprecated, unused — see part_notes below
  created_at     TEXT NOT NULL,        -- when Excel registered this label
  scanned_at     TEXT,
  scanned_by_device TEXT,
  voided_at      TEXT,
  voided_by_device  TEXT
);
CREATE INDEX IF NOT EXISTS idx_parts_index_department ON parts_index(department);

-- Append-only defect/note log — one row per note, never overwritten, so
-- a history survives even if multiple people flag the same part over
-- time. category is one of a fixed list (see server.js NOTE_CATEGORIES)
-- including 'OTHER'; note is optional elaboration text, required when
-- category is 'OTHER'. action distinguishes a plain note from the
-- reason logged when a part is voided (same category/text mechanism,
-- reused rather than building a second form) — 'NOTE' | 'VOID'.
CREATE TABLE IF NOT EXISTS part_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unique_id   TEXT NOT NULL REFERENCES parts_index(unique_id),
  category    TEXT NOT NULL,
  note        TEXT,
  action      TEXT NOT NULL DEFAULT 'NOTE',
  device_id   TEXT,
  device      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_part_notes_unique_id ON part_notes(unique_id);

-- Panel department detail table — one row per unique_id, written once by
-- the Excel macro at label-registration time. Column names mirror the
-- macro's LABEL LIST sheet exactly (Sheet Name, Tag, Width, Height, etc.)
-- so the register endpoint can accept that data with zero translation.
CREATE TABLE IF NOT EXISTS parts_panel (
  unique_id     TEXT PRIMARY KEY REFERENCES parts_index(unique_id),
  batch         TEXT,
  sheet_name    TEXT,
  project       TEXT,
  floor         TEXT,
  tag           TEXT,
  part_type     TEXT,
  width         TEXT,
  height        TEXT,
  qty           TEXT,
  colour        TEXT,
  generated_on  TEXT,
  sequence_no   INTEGER  -- directed-scan order within its batch; defaults to registration order, admin-editable
);

-- ── PRODUCTION SCHEDULE — one row per batch, batch-level metadata that
-- doesn't belong on any individual label (job name, work order, target
-- finish, material, etc.). Separate from parts_panel (per-label, write-once
-- from Excel) — this can be created by Excel OR filled in manually later
-- from the admin dashboard for batches that predate this feature, and can
-- be corrected after the fact, so it's upsert, not insert-once.
-- extra_fields is a JSON object (stringified) — the one flexible/ad hoc
-- extension point in this schema, editable as key/value pairs from the
-- admin UI, for anything not worth a real column yet.
CREATE TABLE IF NOT EXISTS production_schedule (
  batch               TEXT PRIMARY KEY,
  job_name            TEXT,
  floor_or_work_order TEXT,
  target_finish       TEXT,
  material            TEXT,
  finish              TEXT,
  part_name           TEXT,
  sheet_qty           TEXT,
  comment             TEXT,
  tasked              TEXT,
  extra_fields        TEXT,
  source              TEXT NOT NULL DEFAULT 'MANUAL',  -- 'EXCEL' | 'MANUAL'
  created_at          TEXT NOT NULL,
  updated_at          TEXT,
  updated_by          TEXT
);

-- ── CUSTOM COLUMNS — admin-defined columns for Production Schedule
-- beyond the fixed set above, stored server-side (not per-browser) so
-- every dashboard/every admin sees the same set. Just the column
-- DEFINITION lives here (key + display label) - the actual per-batch
-- VALUE lives in production_schedule.extra_fields under that same key,
-- the existing catch-all JSON column, so adding a custom column never
-- needs a real schema migration. key is always server-generated
-- (derived from label, prefixed 'custom_') so the client can tell a
-- custom-column key from a real production_schedule column name just
-- by checking the prefix.
CREATE TABLE IF NOT EXISTS custom_columns (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT
);

-- ── MATERIAL STOCK — the minimal manual on-hand-qty input Phase 4 (Cross-
-- Job Material Conflict Detection) needs, not a real inventory system: one
-- row per material name (matching production_schedule.material free-text
-- values), admin-editable from the Material Demand tab, cross-referenced
-- against the same open-batch Sheet Qty totals Phase 1 already computes.
CREATE TABLE IF NOT EXISTS material_stock (
  material     TEXT PRIMARY KEY,
  on_hand_qty  REAL NOT NULL DEFAULT 0,
  updated_at   TEXT,
  updated_by   TEXT
);

-- ── PACKING SLIPS — generated once a batch is fully scanned. parts_snapshot
-- is a JSON array captured at creation time (not a live join against
-- parts_panel) since this is a shipping record: if a part later gets
-- voided or a label edited, an already-issued packing slip shouldn't
-- silently change out from under whoever's holding the printed copy.
-- job_name/floor_or_work_order are copied from production_schedule at
-- creation time for the same reason - a historical snapshot, not a live
-- lookup.
CREATE TABLE IF NOT EXISTS packing_slips (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  slip_number         TEXT NOT NULL UNIQUE,
  batch               TEXT NOT NULL,
  slip_date           TEXT NOT NULL,
  department          TEXT,
  ship_to             TEXT,
  job_name            TEXT,
  floor_or_work_order TEXT,
  comments            TEXT,
  special_handling    TEXT,
  checked_by          TEXT,
  parts_snapshot      TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT
);
CREATE INDEX IF NOT EXISTS idx_packing_slips_batch ON packing_slips(batch);

-- ── INTERNAL DELIVERIES — some parts never leave the building (moved to
-- another floor/area on-site instead of shipped out), so they don't need
-- a packing slip at all. One row per part marked this way. A part counts
-- toward its batch being "fully accounted for" either by landing on a
-- packing slip OR by being marked here - never both: the packing-slips
-- endpoint excludes anything marked here from what a new slip can offer,
-- and marking a part here that's already on a slip is rejected, so the
-- two sets stay disjoint without needing a join to prove it later.
CREATE TABLE IF NOT EXISTS internal_deliveries (
  unique_id     TEXT PRIMARY KEY REFERENCES parts_index(unique_id),
  batch         TEXT NOT NULL,
  delivered_at  TEXT NOT NULL,
  delivered_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_internal_deliveries_batch ON internal_deliveries(batch);

-- ── AUDIT LOG — every admin-dashboard write action (not scans - those
-- already have their own trail in `scans`/`scan_id`), so an edit made from
-- the GM's page is reviewable later. actor is a free-text name the person
-- typed in once (there's no per-person login in this system - everyone
-- with the admin dashboard shares the one admin key), not a verified
-- identity - a label for accountability/review, not an access-control
-- mechanism. Only ever displayed on the main admin.html, never gm.html.
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at);

-- ── DELETED BATCHES (recycle bin) — a snapshot of everything a batch
-- delete is about to remove (its production_schedule row, every part's
-- parts_index/parts_panel rows, their notes, and their scan history),
-- captured right before the real DELETE runs. The live tables still get
-- a real hard delete afterward - this table is what makes "restore" a
-- normal reversible action instead of the batch just being gone, without
-- having to soft-delete (and filter out everywhere) four different
-- tables. snapshot is one JSON blob rather than reconstructing the delete
-- across several tables, since it's only ever read back as a whole on
-- restore, never queried piecemeal.
CREATE TABLE IF NOT EXISTS deleted_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch          TEXT NOT NULL,
  deleted_at     TEXT NOT NULL,
  deleted_by     TEXT,
  part_count     INTEGER NOT NULL,
  scanned_count  INTEGER NOT NULL,
  snapshot       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deleted_batches_at ON deleted_batches(deleted_at);
