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
//
// Each row's racks are an explicit ORDERED list, not just a min/max range —
// real warehouses don't always run 1,2,3...N in a straight line (e.g.
// 75,74,73,1,2,3...), and that order is user-editable and persisted.
function computeLayout(rows) {
  const bounds = {};
  for (const r of rows) {
    const cls = classifyCell(r.cell);
    if (cls.isService) continue;
    if (!bounds[cls.row]) bounds[cls.row] = { min: cls.rack, max: cls.rack, levels: new Set() };
    const B = bounds[cls.row];
    if (cls.rack < B.min) B.min = cls.rack;
    if (cls.rack > B.max) B.max = cls.rack;
    B.levels.add(cls.level);
  }
  const out = {};
  for (const row of Object.keys(bounds)) {
    const { min, max, levels } = bounds[row];
    const racks = [];
    for (let i = min; i <= max; i++) racks.push(i); // default order: full consecutive range, gaps included
    out[row] = { racks, levels: Array.from(levels) };
  }
  return out;
}

// Old stored shape was {minRack, maxRack, levels}; convert on read so an
// already-deployed database keeps working without a manual migration step.
function normalizeLayoutEntry(entry) {
  if (entry.racks) return { racks: entry.racks.slice(), levels: (entry.levels || []).slice() };
  if (entry.minRack != null && entry.maxRack != null) {
    const racks = [];
    for (let i = entry.minRack; i <= entry.maxRack; i++) racks.push(i);
    return { racks, levels: (entry.levels || []).slice() };
  }
  return { racks: [], levels: (entry.levels || []).slice() };
}

function getLayout() {
  const raw = getMeta('layout');
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  const out = {};
  for (const row of Object.keys(parsed)) out[row] = normalizeLayoutEntry(parsed[row]);
  return out;
}
function setLayout(layout) {
  setMeta('layout', JSON.stringify(layout));
}

// Merge two layouts, preserving whatever custom rack ORDER is already in `a`
// (the previously-persisted / user-arranged one) and appending any racks
// found only in `b` to the end, rather than re-sorting everything.
function mergeLayouts(a, b) {
  const out = {};
  for (const row of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const la = a[row], lb = b[row];
    if (la && lb) {
      const seen = new Set(la.racks);
      const racks = [...la.racks];
      for (const rk of lb.racks) if (!seen.has(rk)) { racks.push(rk); seen.add(rk); }
      out[row] = { racks, levels: Array.from(new Set([...la.levels, ...lb.levels])) };
    } else {
      out[row] = la || lb;
    }
  }
  return out;
}

// Called at server startup: guarantees the stored layout covers at least the
// full extent of the given seed rows, merged with whatever is already stored
// (so manual expansions and custom ordering since then aren't lost, and
// nothing ever shrinks).
function ensureLayoutFromSeed(seedRows) {
  const seedLayout = computeLayout(seedRows.map(r => ({ cell: r.c })));
  const current = getLayout();
  setLayout(mergeLayouts(current, seedLayout));
}

// Widen the stored layout with a single new location, if it isn't already
// covered. A brand-new rack is appended to the end of the row's order —
// the user can drag it into place afterward if it belongs elsewhere.
function expandLayout(row, rack, level) {
  if (!row || rack == null || !level) return;
  const layout = getLayout();
  if (!layout[row]) {
    layout[row] = { racks: [rack], levels: [level] };
  } else {
    if (!layout[row].racks.includes(rack)) layout[row].racks.push(rack);
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

// Rename a row wholesale: relabels the row code itself (e.g. "07" -> "50"),
// rewriting every record's cell prefix and moving the layout entry. Fails if
// the target row code is already in use, to avoid silently merging two rows.
const renameRow = db.transaction((oldRow, newRow) => {
  if (oldRow === newRow) return { moved: 0 };
  const layout = getLayout();
  if (!layout[oldRow]) throw new Error(`ряд ${oldRow} не найден в структуре склада`);
  if (layout[newRow]) throw new Error(`ряд ${newRow} уже существует — выберите другое название`);

  const records = db.prepare('SELECT id, cell FROM stock_records WHERE row_code = ? AND is_service = 0').all(oldRow);
  const update = db.prepare(`
    UPDATE stock_records
    SET cell = @cell, row_code = @row, rack = @rack, level_code = @level, updated_at = datetime('now')
    WHERE id = @id
  `);
  const rewriteRow = (oldCell, targetRow) => targetRow + oldCell.slice(2);
  for (const r of records) {
    const newCell = rewriteRow(r.cell, newRow);
    const cls = classifyCell(newCell);
    update.run({ id: r.id, cell: newCell, row: cls.row, rack: cls.rack, level: cls.level });
  }

  layout[newRow] = layout[oldRow];
  delete layout[oldRow];
  setLayout(layout);

  return { moved: records.length };
});

// Add and/or remove racks for a row in one go — this is the "change the
// number of cells" operation. Adding is always safe (just a new empty
// position). Removing is blocked if that rack still holds any stock, so a
// careless edit can't silently delete inventory.
function setRacks(row, racks) {
  const layout = getLayout();
  if (!layout[row]) throw new Error(`ряд ${row} не найден в структуре склада`);

  const cleanRacks = [];
  const seen = new Set();
  for (const n of racks) {
    const v = parseInt(n, 10);
    if (Number.isInteger(v) && v > 0 && !seen.has(v)) { cleanRacks.push(v); seen.add(v); }
  }

  const removed = layout[row].racks.filter(rk => !seen.has(rk));
  if (removed.length) {
    const placeholders = removed.map(() => '?').join(',');
    const stillOccupied = db.prepare(
      `SELECT DISTINCT rack FROM stock_records WHERE row_code = ? AND is_service = 0 AND rack IN (${placeholders})`
    ).all(row, ...removed);
    if (stillOccupied.length) {
      throw new Error(`нельзя убрать стеллаж(и) ${stillOccupied.map(r => r.rack).join(', ')} — там ещё есть товар`);
    }
  }

  layout[row].racks = cleanRacks;
  setLayout(layout);
  return layout[row];
}

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

// Persist a user-chosen display order for a row's racks (e.g. 75,74,73,1,2,3...).
// `order` must be exactly a reordering of the racks already known for that row —
// it can't silently add or drop a rack, to avoid corrupting the structure.
function setRackOrder(row, order) {
  const layout = getLayout();
  if (!layout[row]) throw new Error(`ряд ${row} не найден в структуре склада`);
  const cleanOrder = order.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n));
  const current = new Set(layout[row].racks);
  const incoming = new Set(cleanOrder);
  if (current.size !== incoming.size || [...current].some(rk => !incoming.has(rk))) {
    throw new Error('новый порядок должен содержать ровно те же стеллажи, что и раньше — без добавления или удаления');
  }
  layout[row].racks = cleanOrder;
  setLayout(layout);
  return layout[row];
}

module.exports = {
  db, classifyCell, listRecords, replaceAll, updateRecord, createRecord, deleteRecord,
  swapRows, swapRacks, renameRow, setRacks, getMeta, setMeta, count, seedIfEmpty,
  getLayout, ensureLayoutFromSeed, rebuildLayoutFromCurrent, setRackOrder
};
