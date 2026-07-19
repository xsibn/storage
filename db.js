// db.js — вся работа с базой данных (SQLite через better-sqlite3).
// База хранится в файле data/warehouse.db рядом с проектом — это и есть
// "реальная база данных": она переживает перезапуск сервера и одинакова
// для всех, кто открывает сайт, в отличие от прежней версии, где данные
// лежали внутри самого HTML-файла.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'warehouse.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS stock_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cell        TEXT NOT NULL,
    article     TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    qty         INTEGER NOT NULL DEFAULT 0,
    mfg         TEXT NOT NULL DEFAULT '',
    exp         TEXT NOT NULL DEFAULT '',
    te          TEXT NOT NULL DEFAULT '',
    is_service  INTEGER NOT NULL DEFAULT 0,
    row_code    TEXT,
    rack        INTEGER,
    level_code  TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_stock_article ON stock_records(article);
  CREATE INDEX IF NOT EXISTS idx_stock_cell ON stock_records(cell);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Same address format as the frontend: РЯД-СТЕЛЛАЖ-УРОВЕНЬ, e.g. "01-12-02".
// Anything that doesn't match is a service zone (Карантин, Брак, Приёмка, ...).
const CELL_RE = /^(\d{2})-(\d{2})-([A-Za-zА-Яа-я0-9]+)$/;
function classifyCell(rawCell) {
  const m = String(rawCell).trim().match(CELL_RE);
  if (m) return { isService: 0, row: m[1], rack: parseInt(m[2], 10), level: m[3] };
  return { isService: 1, row: null, rack: null, level: null };
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setMeta(key, value) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

// ---------- Warehouse layout (structure) ----------
// The grid needs to know which racks/levels EXIST per row, independent of
// which cells currently happen to hold stock — otherwise a rack that becomes
// fully empty (e.g. after a swap) would silently vanish from the map, even
// though it's still a real physical location. This is stored in meta as JSON
// and only ever grows (never shrinks) once a location has been seen.
function computeLayout(rows) {
  const layout = {};
  for (const r of rows) {
    const cls = classifyCell(r.cell);
    if (cls.isService) continue;
    if (!layout[cls.row]) layout[cls.row] = { minRack: cls.rack, maxRack: cls.rack, levels: new Set() };
    const L = layout[cls.row];
    if (cls.rack < L.minRack) L.minRack = cls.rack;
    if (cls.rack > L.maxRack) L.maxRack = cls.rack;
    L.levels.add(cls.level);
  }
  const out = {};
  for (const row of Object.keys(layout)) {
    out[row] = { minRack: layout[row].minRack, maxRack: layout[row].maxRack, levels: Array.from(layout[row].levels) };
  }
  return out;
}

function getLayout() {
  const raw = getMeta('layout');
  return raw ? JSON.parse(raw) : {};
}
function setLayout(layout) {
  setMeta('layout', JSON.stringify(layout));
}

function mergeLayouts(a, b) {
  const out = {};
  for (const row of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const la = a[row], lb = b[row];
    if (la && lb) {
      out[row] = {
        minRack: Math.min(la.minRack, lb.minRack),
        maxRack: Math.max(la.maxRack, lb.maxRack),
        levels: Array.from(new Set([...la.levels, ...lb.levels]))
      };
    } else {
      out[row] = la || lb;
    }
  }
  return out;
}

// Called at server startup: guarantees the stored layout covers at least the
// full extent of the given seed rows, merged with whatever is already stored
// (so manual expansions since then aren't lost, and nothing ever shrinks).
function ensureLayoutFromSeed(seedRows) {
  const seedLayout = computeLayout(seedRows.map(r => ({ cell: r.c })));
  const current = getLayout();
  setLayout(mergeLayouts(current, seedLayout));
}

// Widen the stored layout with a single new location, if it isn't already covered.
function expandLayout(row, rack, level) {
  if (!row || rack == null || !level) return;
  const layout = getLayout();
  if (!layout[row]) {
    layout[row] = { minRack: rack, maxRack: rack, levels: [level] };
  } else {
    layout[row].minRack = Math.min(layout[row].minRack, rack);
    layout[row].maxRack = Math.max(layout[row].maxRack, rack);
    if (!layout[row].levels.includes(level)) layout[row].levels.push(level);
  }
  setLayout(layout);
}

function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM stock_records').get().n;
}

function listRecords() {
  return db.prepare('SELECT * FROM stock_records ORDER BY id').all();
}

// Replace the entire dataset in one transaction (used on initial seed and on
// "Загрузить новые данные" — new file fully replaces the previous stock).
const replaceAll = db.transaction((rows, sourceLabel) => {
  db.prepare('DELETE FROM stock_records').run();
  const insert = db.prepare(`
    INSERT INTO stock_records (cell, article, name, qty, mfg, exp, te, is_service, row_code, rack, level_code)
    VALUES (@cell, @article, @name, @qty, @mfg, @exp, @te, @isService, @row, @rack, @level)
  `);
  for (const r of rows) {
    const cls = classifyCell(r.cell);
    insert.run({
      cell: r.cell,
      article: r.article,
      name: r.name || '',
      qty: Number(r.qty) || 0,
      mfg: r.mfg || '',
      exp: r.exp || '',
      te: r.te || '',
      isService: cls.isService,
      row: cls.row,
      rack: cls.rack,
      level: cls.level
    });
  }
  setMeta('source_label', sourceLabel || 'база данных');
  setMeta('imported_at', new Date().toISOString());
  setLayout(mergeLayouts(getLayout(), computeLayout(rows)));
});

function updateRecord(id, patch) {
  const existing = db.prepare('SELECT * FROM stock_records WHERE id = ?').get(id);
  if (!existing) return null;

  const next = {
    cell: patch.cell !== undefined ? String(patch.cell).trim() : existing.cell,
    qty: patch.qty !== undefined ? Math.max(0, Number(patch.qty) || 0) : existing.qty
  };
  const cls = classifyCell(next.cell);

  db.prepare(`
    UPDATE stock_records
    SET cell = @cell, qty = @qty, is_service = @isService, row_code = @row, rack = @rack, level_code = @level,
        updated_at = datetime('now')
    WHERE id = @id
  `).run({ id, cell: next.cell, qty: next.qty, isService: cls.isService, row: cls.row, rack: cls.rack, level: cls.level });

  if (!cls.isService) expandLayout(cls.row, cls.rack, cls.level);

  return db.prepare('SELECT * FROM stock_records WHERE id = ?').get(id);
}

function seedIfEmpty(seedRows, sourceLabel) {
  if (count() === 0 && Array.isArray(seedRows) && seedRows.length) {
    replaceAll(seedRows.map(r => ({
      cell: r.c, article: r.a, name: r.n, qty: r.q, mfg: r.m, exp: r.e, te: r.te
    })), sourceLabel);
  }
}

function createRecord(rec) {
  const cell = String(rec.cell || '').trim();
  const article = String(rec.article || '').trim();
  if (!cell || !article) return null;
  const cls = classifyCell(cell);
  const info = db.prepare(`
    INSERT INTO stock_records (cell, article, name, qty, mfg, exp, te, is_service, row_code, rack, level_code)
    VALUES (@cell, @article, @name, @qty, @mfg, @exp, @te, @isService, @row, @rack, @level)
  `).run({
    cell, article,
    name: rec.name || '',
    qty: Math.max(0, Number(rec.qty) || 0),
    mfg: rec.mfg || '',
    exp: rec.exp || '',
    te: rec.te || '',
    isService: cls.isService, row: cls.row, rack: cls.rack, level: cls.level
  });
  if (!cls.isService) expandLayout(cls.row, cls.rack, cls.level);
  return db.prepare('SELECT * FROM stock_records WHERE id = ?').get(info.lastInsertRowid);
}

function deleteRecord(id) {
  const existing = db.prepare('SELECT * FROM stock_records WHERE id = ?').get(id);
  if (!existing) return false;
  db.prepare('DELETE FROM stock_records WHERE id = ?').run(id);
  return true;
}

// Swap two aisles ("ряды") wholesale: every address record in rowA moves to
// rowB (keeping its rack/level) and every record in rowB moves to rowA — a
// true two-way exchange, done in one transaction so it can't half-apply.
const swapRows = db.transaction((rowA, rowB) => {
  if (rowA === rowB) return { movedA: 0, movedB: 0 };

  const recordsA = db.prepare('SELECT id, cell FROM stock_records WHERE row_code = ? AND is_service = 0').all(rowA);
  const recordsB = db.prepare('SELECT id, cell FROM stock_records WHERE row_code = ? AND is_service = 0').all(rowB);
  const update = db.prepare(`
    UPDATE stock_records
    SET cell = @cell, row_code = @row, rack = @rack, level_code = @level, updated_at = datetime('now')
    WHERE id = @id
  `);

  // cell format is always RR-SS-LL — swap just the two-digit row prefix, keep rack/level as-is
  const rewriteRow = (oldCell, targetRow) => targetRow + oldCell.slice(2);

  for (const r of recordsA) {
    const newCell = rewriteRow(r.cell, rowB);
    const cls = classifyCell(newCell);
    update.run({ id: r.id, cell: newCell, row: cls.row, rack: cls.rack, level: cls.level });
  }
  for (const r of recordsB) {
    const newCell = rewriteRow(r.cell, rowA);
    const cls = classifyCell(newCell);
    update.run({ id: r.id, cell: newCell, row: cls.row, rack: cls.rack, level: cls.level });
  }

  return { movedA: recordsA.length, movedB: recordsB.length };
});

// Swap two racks ("стеллажи") within the same row wholesale: every level of
// rackA moves to rackB and vice versa — same idea as swapRows, one segment down.
const swapRacks = db.transaction((row, rackA, rackB) => {
  if (rackA === rackB) return { movedA: 0, movedB: 0 };

  const recordsA = db.prepare('SELECT id, cell FROM stock_records WHERE row_code = ? AND rack = ? AND is_service = 0').all(row, rackA);
  const recordsB = db.prepare('SELECT id, cell FROM stock_records WHERE row_code = ? AND rack = ? AND is_service = 0').all(row, rackB);
  const update = db.prepare(`
    UPDATE stock_records
    SET cell = @cell, row_code = @row, rack = @rack, level_code = @level, updated_at = datetime('now')
    WHERE id = @id
  `);

  // cell format is RR-SS-LL — swap just the middle (rack) segment, keep row/level as-is
  const rewriteRack = (oldCell, targetRack) => oldCell.replace(/^(\d{2})-(\d{2})-/, (_, r) => `${r}-${String(targetRack).padStart(2, '0')}-`);

  for (const r of recordsA) {
    const newCell = rewriteRack(r.cell, rackB);
    const cls = classifyCell(newCell);
    update.run({ id: r.id, cell: newCell, row: cls.row, rack: cls.rack, level: cls.level });
  }
  for (const r of recordsB) {
    const newCell = rewriteRack(r.cell, rackA);
    const cls = classifyCell(newCell);
    update.run({ id: r.id, cell: newCell, row: cls.row, rack: cls.rack, level: cls.level });
  }

  return { movedA: recordsA.length, movedB: recordsB.length };
});

// Fallback for a DB that predates the layout feature: build it once from
// whatever is currently in the table (better than nothing) and persist it.
function rebuildLayoutFromCurrent() {
  const layout = computeLayout(listRecords());
  setLayout(mergeLayouts(getLayout(), layout));
  return getLayout();
}

module.exports = {
  db, classifyCell, listRecords, replaceAll, updateRecord, createRecord, deleteRecord,
  swapRows, swapRacks, getMeta, setMeta, count, seedIfEmpty,
  getLayout, ensureLayoutFromSeed, rebuildLayoutFromCurrent
};
