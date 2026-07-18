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

  return db.prepare('SELECT * FROM stock_records WHERE id = ?').get(id);
}

function seedIfEmpty(seedRows, sourceLabel) {
  if (count() === 0 && Array.isArray(seedRows) && seedRows.length) {
    replaceAll(seedRows.map(r => ({
      cell: r.c, article: r.a, name: r.n, qty: r.q, mfg: r.m, exp: r.e, te: r.te
    })), sourceLabel);
  }
}

module.exports = { db, classifyCell, listRecords, replaceAll, updateRecord, getMeta, setMeta, count, seedIfEmpty };
