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
  raw           TEXT
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
  generated_on  TEXT
);

-- Batch-level archive — admin-only, reversible hide of a batch from the
-- phone's Batch Status list. Deliberately its own table rather than a
-- column on parts_index/parts_panel: archiving never touches registry
-- data (scanned/void/notes all stay exactly as they are), matching this
-- project's existing principle that hide/flag actions never destroy a
-- record. Unarchiving is just deleting the row here.
CREATE TABLE IF NOT EXISTS archived_batches (
  batch         TEXT PRIMARY KEY,
  archived_at   TEXT NOT NULL,
  archived_by   TEXT
);
