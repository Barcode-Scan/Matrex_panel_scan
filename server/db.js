const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'matrex.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// CREATE TABLE IF NOT EXISTS in schema.sql only applies to brand-new
// databases — a table that already exists never gets new columns from it.
// This adds any columns schema.sql has picked up since the table was
// first created, safe to run on every boot (no-op once already applied).
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('scans', 'unique_id', 'TEXT');
ensureColumn('scans', 'match_status', 'TEXT');
ensureColumn('parts_index', 'voided_at', 'TEXT');
ensureColumn('parts_index', 'voided_by_device', 'TEXT');
ensureColumn('part_notes', 'action', "TEXT NOT NULL DEFAULT 'NOTE'");
ensureColumn('parts_panel', 'sequence_no', 'INTEGER');
ensureColumn('scans', 'mode', "TEXT NOT NULL DEFAULT 'FREE'");
ensureColumn('scans', 'batch', 'TEXT');
ensureColumn('scans', 'acknowledged', "TEXT NOT NULL DEFAULT 'No'");
ensureColumn('scans', 'acknowledged_at', 'TEXT');
// Index depends on sequence_no, so it's created here (after ensureColumn
// guarantees the column exists) rather than in schema.sql — CREATE TABLE
// IF NOT EXISTS is a no-op on an already-existing table, so a CREATE INDEX
// baked into schema.sql referencing this column would fail on any DB that
// predates the column (as it did in production on first deploy of this).
db.exec('CREATE INDEX IF NOT EXISTS idx_parts_panel_batch_seq ON parts_panel(batch, sequence_no)');

// One-time backfill for rows registered before sequence_no existed — orders
// each batch by rowid (its original registration order), same default the
// register endpoint now assigns going forward. No-op once every row has a
// value, so safe to run on every boot.
db.exec(`
  UPDATE parts_panel SET sequence_no = (
    SELECT COUNT(*) FROM parts_panel p2
    WHERE p2.batch IS parts_panel.batch AND p2.rowid <= parts_panel.rowid
  )
  WHERE sequence_no IS NULL
`);

module.exports = db;
