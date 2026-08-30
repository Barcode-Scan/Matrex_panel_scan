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

-- ════════════════════════════════════════════════════════════════════
-- INVENTORY & SCANNER SYSTEM — folded into this system 2026-08-30 per
-- the owner's decision to run everything as one app rather than a
-- separate React/Supabase system (see "Matrex Panel Scan - Inventory
-- System Pivot Note.md" in the docs folder for the full record).
--
-- Reuses this schema's existing conventions throughout: TEXT 'Yes'/'No'
-- for booleans (not 0/1), INTEGER PRIMARY KEY AUTOINCREMENT for pure
-- surrogate keys, a natural TEXT key where one already exists (matching
-- parts_index.unique_id). Reuses `devices` (already has PENDING/
-- APPROVED/REVOKED + deviceGate) for scanner device management instead
-- of a second device table, and `audit_log` (already exists above)
-- instead of a second audit table. Attribution uses device_id or a
-- free-text actor name, not a real per-user identity — this system has
-- no login/accounts, matching audit_log's own existing comment above.
-- ════════════════════════════════════════════════════════════════════

-- ── ITEM MASTER ────────────────────────────────────────────────────
-- item_number is the primary key directly (no separate surrogate id) -
-- same pattern as parts_index.unique_id: one server-generated,
-- immutable, natural identifier, not a uuid-plus-natural-key pair.
CREATE TABLE IF NOT EXISTS items (
  item_number       TEXT PRIMARY KEY,        -- server-generated 'ITM-000001', see item_number_counter below
  description       TEXT NOT NULL DEFAULT '',
  category_id       INTEGER REFERENCES categories(id),
  costing_method    TEXT NOT NULL DEFAULT 'FIFO' CHECK (costing_method IN ('FIFO', 'Standard', 'Average')),
  posting_group     TEXT,
  reorder_point     REAL,
  lead_time_days    INTEGER,
  default_vendor    TEXT,
  order_multiple    REAL,
  status            TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Blocked', 'Obsolete')),
  base_uom_code     TEXT REFERENCES uoms(code),
  created_at        TEXT NOT NULL,
  created_by        TEXT,
  updated_at        TEXT,
  updated_by        TEXT
);

-- Single-row counter for item_number allocation - the server-side
-- equivalent of a Postgres sequence. Incremented inside a transaction by
-- the /inventory/items POST handler, never client-supplied.
CREATE TABLE IF NOT EXISTS item_number_counter (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  next_value  INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO item_number_counter (id, next_value) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER REFERENCES categories(id),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attributes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  value_type  TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'enum', 'date'))
);

CREATE TABLE IF NOT EXISTS attribute_options (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute_id  INTEGER NOT NULL REFERENCES attributes(id),
  value         TEXT NOT NULL,
  UNIQUE (attribute_id, value)
);

CREATE TABLE IF NOT EXISTS item_attributes (
  item_number           TEXT NOT NULL REFERENCES items(item_number),
  attribute_id          INTEGER NOT NULL REFERENCES attributes(id),
  value_text            TEXT,
  value_number          REAL,
  value_enum_option_id  INTEGER REFERENCES attribute_options(id),
  value_date            TEXT,
  PRIMARY KEY (item_number, attribute_id)
);

CREATE TABLE IF NOT EXISTS item_variants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_number   TEXT NOT NULL REFERENCES items(item_number),
  variant_code  TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE (item_number, variant_code)
);

-- ── LOCATIONS, ZONES, BINS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id  INTEGER NOT NULL REFERENCES locations(id),
  name         TEXT NOT NULL,
  zone_type    TEXT NOT NULL CHECK (zone_type IN ('Receive', 'Bulk', 'WIP', 'Ship', 'Yard')),
  created_at   TEXT NOT NULL
);

-- granularity implements DEC-002's accepted call from the original
-- Supabase design (rack-bay for bulk, shelf-position for pick-face) -
-- carried forward as-is, it's a domain decision, not stack-specific.
CREATE TABLE IF NOT EXISTS bins (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id          INTEGER NOT NULL REFERENCES zones(id),
  code             TEXT NOT NULL,
  bin_type         TEXT NOT NULL CHECK (bin_type IN ('PickFace', 'Bulk', 'Staging')),
  granularity      TEXT NOT NULL CHECK (granularity IN ('RackBay', 'ShelfPosition')),
  pick_rank        INTEGER,
  capacity_qty     REAL,
  capacity_weight  REAL,
  created_at       TEXT NOT NULL,
  UNIQUE (zone_id, code)
);

CREATE TABLE IF NOT EXISTS bin_contents (
  bin_id        INTEGER NOT NULL REFERENCES bins(id),
  item_number   TEXT NOT NULL REFERENCES items(item_number),
  variant_code  TEXT NOT NULL DEFAULT '',  -- '' means "no variant", so it can sit in a PRIMARY KEY (SQLite allows NULL to repeat, '' cannot)
  qty           REAL NOT NULL DEFAULT 0,
  updated_at    TEXT,
  PRIMARY KEY (bin_id, item_number, variant_code)
);

-- ── UOM & BARCODE CROSS-REFERENCE ──────────────────────────────────
CREATE TABLE IF NOT EXISTS uoms (
  code         TEXT PRIMARY KEY,
  description  TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO uoms (code, description) VALUES
  ('EA', 'Each'), ('MM', 'Millimeter'), ('FT', 'Foot'), ('KG', 'Kilogram'), ('LB', 'Pound');

CREATE TABLE IF NOT EXISTS item_uoms (
  item_number             TEXT NOT NULL REFERENCES items(item_number),
  uom_code                TEXT NOT NULL REFERENCES uoms(code),
  conversion_factor       REAL NOT NULL,
  is_purchase_default     TEXT NOT NULL DEFAULT 'No',
  is_consumption_default  TEXT NOT NULL DEFAULT 'No',
  is_shipment_default     TEXT NOT NULL DEFAULT 'No',
  PRIMARY KEY (item_number, uom_code)
);

-- The barcode cross-reference table - resolve_scan (server.js) is the
-- scan-resolution service (equivalent of the Supabase build's INV-018).
-- reference_code is globally unique so a scan can never resolve
-- ambiguously to two different items.
CREATE TABLE IF NOT EXISTS item_references (
  reference_code  TEXT PRIMARY KEY,
  item_number     TEXT NOT NULL REFERENCES items(item_number),
  variant_code    TEXT,
  reference_type  TEXT NOT NULL CHECK (reference_type IN ('Vendor', 'Customer', 'GS1', 'Internal')),
  uom_code        TEXT REFERENCES uoms(code),
  is_void         TEXT NOT NULL DEFAULT 'No',
  created_at      TEXT NOT NULL
);

-- ── LABELS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS label_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label_type    TEXT NOT NULL CHECK (label_type IN ('Item', 'Bin', 'Lot', 'PanelUID', 'Pallet')),
  name          TEXT NOT NULL,
  field_layout  TEXT NOT NULL DEFAULT '{}',  -- JSON, same catch-all pattern as production_schedule.extra_fields
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS printers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  station     TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- ── PURCHASING & RECEIVING ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  po_number   TEXT PRIMARY KEY,   -- server-generated 'PO-000001', see po_number_counter below
  vendor      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Issued', 'PartiallyReceived', 'Closed')),
  created_at  TEXT NOT NULL,
  created_by  TEXT
);

CREATE TABLE IF NOT EXISTS po_number_counter (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  next_value  INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO po_number_counter (id, next_value) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number     TEXT NOT NULL REFERENCES purchase_orders(po_number),
  item_number   TEXT NOT NULL REFERENCES items(item_number),
  variant_code  TEXT,
  uom_code      TEXT REFERENCES uoms(code),
  qty_ordered   REAL NOT NULL,
  qty_received  REAL NOT NULL DEFAULT 0,  -- maintained by the receipt-posting handler, never hand-edited
  unit_cost     REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_po_lines_po_number ON purchase_order_lines(po_number);

CREATE TABLE IF NOT EXISTS lots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_number    TEXT NOT NULL REFERENCES items(item_number),
  lot_number     TEXT NOT NULL,
  mill_cert_url  TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (item_number, lot_number)
);

CREATE TABLE IF NOT EXISTS receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number     TEXT NOT NULL REFERENCES purchase_orders(po_number),
  location_id   INTEGER NOT NULL REFERENCES locations(id),
  received_at   TEXT NOT NULL,
  received_by   TEXT
);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id     INTEGER NOT NULL REFERENCES receipts(id),
  po_line_id     INTEGER NOT NULL REFERENCES purchase_order_lines(id),
  item_number    TEXT NOT NULL REFERENCES items(item_number),
  variant_code   TEXT,
  uom_code       TEXT,
  qty_expected   REAL NOT NULL,
  qty_received   REAL NOT NULL,
  is_over_under  TEXT NOT NULL DEFAULT 'No',  -- set by the handler (qty_received <> qty_expected), not a generated column
  damage_notes   TEXT,
  lot_id         INTEGER REFERENCES lots(id)
);

-- ── THE LEDGER ─────────────────────────────────────────────────────
-- Append-only, signed qty (+ increases on-hand, - decreases). Every
-- future posting path (movement, consumption, pick, ship, adjustment)
-- must write through this same table the same way the receipt/put-away
-- handlers below do - not invent its own. posted_by is a device_id or
-- an admin-key request's identifying label - there is no real user
-- identity in this system to attribute to.
CREATE TABLE IF NOT EXISTS item_ledger_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type       TEXT NOT NULL CHECK (entry_type IN ('Receipt', 'PutAway', 'Movement', 'Consumption', 'Output', 'Pick', 'Ship', 'Adjustment')),
  item_number      TEXT NOT NULL REFERENCES items(item_number),
  variant_code     TEXT,
  lot_id           INTEGER REFERENCES lots(id),
  qty              REAL NOT NULL,
  uom_code         TEXT,
  bin_id           INTEGER REFERENCES bins(id),
  location_id      INTEGER REFERENCES locations(id),
  reference_table  TEXT,
  reference_id     TEXT,
  posted_at        TEXT NOT NULL,
  posted_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_item_number ON item_ledger_entries(item_number);
CREATE INDEX IF NOT EXISTS idx_ledger_bin_id ON item_ledger_entries(bin_id);

-- Basic costing (one FIFO layer per receipt, at the PO's unit cost).
-- Real FIFO layer *consumption* needs Feature 11/12-equivalent
-- consumption/shipment postings, which don't exist yet - same honest
-- limitation as the original Supabase design.
CREATE TABLE IF NOT EXISTS value_entries (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  item_ledger_entry_id   INTEGER NOT NULL REFERENCES item_ledger_entries(id),
  unit_cost              REAL NOT NULL,
  total_cost             REAL NOT NULL,
  costing_method_used    TEXT NOT NULL,
  posted_at              TEXT NOT NULL
);

-- ── PUT-AWAY & REPLENISHMENT ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS putaway_tasks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_line_id       INTEGER NOT NULL REFERENCES receipt_lines(id),
  item_number           TEXT NOT NULL REFERENCES items(item_number),
  variant_code          TEXT,
  qty                   REAL NOT NULL,
  suggested_bin_id      INTEGER REFERENCES bins(id),
  status                TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Completed')),
  completed_bin_id      INTEGER REFERENCES bins(id),
  completed_at          TEXT,
  completed_by          TEXT,
  override_reason_code  TEXT REFERENCES reason_codes(code)
);

CREATE TABLE IF NOT EXISTS reason_codes (
  code         TEXT PRIMARY KEY,
  category     TEXT NOT NULL CHECK (category IN ('Override', 'Scrap', 'Void', 'Adjustment', 'Damage')),
  description  TEXT NOT NULL DEFAULT ''
);

-- No scheduler reachable to trigger this automatically (same honest gap
-- as the original design) - callable on demand only.
CREATE TABLE IF NOT EXISTS replenishment_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bin_id       INTEGER NOT NULL REFERENCES bins(id),
  item_number  TEXT NOT NULL REFERENCES items(item_number),
  qty_needed   REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Completed')),
  created_at   TEXT NOT NULL
);
