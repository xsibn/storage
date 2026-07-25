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

  CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL DEFAULT (datetime('now')),
    action     TEXT NOT NULL,
    summary    TEXT NOT NULL,
    undo_data  TEXT
  );

  CREATE TABLE IF NOT EXISTS abc_classes (
    article TEXT PRIMARY KEY,
    class   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS service_zones (
    name       TEXT PRIMARY KEY,
    isolate    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'employee',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    created_by    TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roles (
    key                  TEXT PRIMARY KEY,
    label                TEXT NOT NULL,
    can_manage_users     INTEGER NOT NULL DEFAULT 0,
    can_manage_activity  INTEGER NOT NULL DEFAULT 0,
    can_read_activity    INTEGER NOT NULL DEFAULT 0,
    can_manage_tasks     INTEGER NOT NULL DEFAULT 0,
    can_import_data      INTEGER NOT NULL DEFAULT 0,
    is_system            INTEGER NOT NULL DEFAULT 0,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    text             TEXT NOT NULL,
    created_by_id    INTEGER,
    created_by_name  TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_recipients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'new',
    read_at     TEXT,
    started_at  TEXT,
    done_at     TEXT,
    UNIQUE(task_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_recipients_task ON task_recipients(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_recipients_user ON task_recipients(user_id);

  CREATE TABLE IF NOT EXISTS registration_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL,
    display_name   TEXT NOT NULL DEFAULT '',
    password_hash  TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Безопасная миграция для БД, созданных до появления заданий: добавляем
// колонку can_manage_tasks, если её ещё нет (для новой БД CREATE TABLE выше
// уже создаёт её сразу — этот блок не выполнит лишней работы).
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(c => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  return true;
}
const rolesMigrated = ensureColumn('roles', 'can_manage_tasks', 'INTEGER NOT NULL DEFAULT 0');
if (rolesMigrated) {
  // На уже существующих базах право «ставить задания» по умолчанию получают
  // те же роли, что и раньше могли управлять аккаунтами/сервисная роль —
  // соответствует «завсклад и все роли выше».
  db.prepare(`UPDATE roles SET can_manage_tasks = 1 WHERE key IN ('service', 'boss', 'warehouse_manager')`).run();
}
// Право «Импортировать данные» — раньше загрузить новый .xlsx (полностью
// заменив сток) мог кто угодно из вошедших, отдельного права не было. При
// добавлении колонки на уже существующей базе включаем его тем же ролям,
// что и «ставить задания» — обычным сотрудникам импорт остаётся недоступен.
const importMigrated = ensureColumn('roles', 'can_import_data', 'INTEGER NOT NULL DEFAULT 0');
if (importMigrated) {
  db.prepare(`UPDATE roles SET can_import_data = 1 WHERE key IN ('service', 'boss', 'warehouse_manager')`).run();
}
// Аватарки пользователей: храним не сам файл в БД, а только имя файла на
// диске (см. public/avatars/ — отдельная папка, обработка в server.js
// пережимает/уменьшает картинку перед сохранением, так что место на диске
// не разрастается от исходников в несколько мегабайт).
ensureColumn('users', 'avatar_path', 'TEXT');

// Базовые роли — создаются один раз при первом запуске (INSERT OR IGNORE),
// дальше их можно свободно переименовывать и менять права через API/CLI;
// повторные запуски сервера ничего не перезаписывают поверх правок админа.
// "service" — системная роль, отмечена is_system: её нельзя удалить и её
// права всегда остаются полными (гарантия, что доступ к системе не потеряют).
const DEFAULT_ROLES = [
  { key: 'service', label: 'Сервисный аккаунт', canManageUsers: 1, canManageActivity: 1, canReadActivity: 1, canManageTasks: 1, canImportData: 1, isSystem: 1 },
  { key: 'boss', label: 'Начальник', canManageUsers: 1, canManageActivity: 1, canReadActivity: 1, canManageTasks: 1, canImportData: 1, isSystem: 0 },
  { key: 'warehouse_manager', label: 'Завсклад', canManageUsers: 0, canManageActivity: 0, canReadActivity: 1, canManageTasks: 1, canImportData: 1, isSystem: 0 },
  { key: 'employee', label: 'Сотрудник', canManageUsers: 0, canManageActivity: 0, canReadActivity: 0, canManageTasks: 0, canImportData: 0, isSystem: 0 }
];
const insertRoleStmt = db.prepare(`INSERT OR IGNORE INTO roles (key, label, can_manage_users, can_manage_activity, can_read_activity, can_manage_tasks, can_import_data, is_system) VALUES (@key, @label, @canManageUsers, @canManageActivity, @canReadActivity, @canManageTasks, @canImportData, @isSystem)`);
DEFAULT_ROLES.forEach(r => insertRoleStmt.run(r));

// Every mutating operation calls this. undoData is a small JSON-serialisable
// object with just enough info to reverse the action — null means it can't
// be undone (currently only bulk-import, since storing a full pre-import
// snapshot for every upload would bloat the log for little practical value).
// Entries older than ACTIVITY_RETENTION_DAYS are purged on every write, so the
// log always holds a rolling window rather than growing forever.
const ACTIVITY_RETENTION_DAYS = 14;
function purgeOldActivity() {
  db.prepare(`DELETE FROM activity_log WHERE ts < datetime('now', ?)`).run(`-${ACTIVITY_RETENTION_DAYS} days`);
}
// Кто выполняет текущий запрос — выставляется middleware'ом авторизации в
// начале каждого запроса (см. auth.js) и подмешивается в текст записи
// журнала. Все вызовы db.js в рамках одного запроса синхронны, поэтому
// между установкой актора и записью в журнал event loop не переключается
// на другой запрос — конфликтов между параллельными запросами нет.
let currentActor = null;
function setCurrentActor(label) { currentActor = label || null; }
function logActivity(action, summary, undoData) {
  const withActor = currentActor ? `[${currentActor}] ${summary}` : summary;
  db.prepare('INSERT INTO activity_log (action, summary, undo_data) VALUES (?, ?, ?)')
    .run(action, withActor, undoData ? JSON.stringify(undoData) : null);
  purgeOldActivity();
}
// Also sweep once on startup, so entries older than the retention window
// disappear even on days when nothing new gets logged.
purgeOldActivity();

function listActivity(limit) {
  return db.prepare('SELECT id, ts, action, summary, (undo_data IS NOT NULL) AS undoable FROM activity_log WHERE ts >= datetime(\'now\', ?) ORDER BY id DESC LIMIT ?')
    .all(`-${ACTIVITY_RETENTION_DAYS} days`, limit || 50);
}

function getLastActivity() {
  return db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 1').get();
}

// Удалить одну запись журнала (без отмены самого действия — просто убрать её из списка)
function deleteActivityEntry(id) {
  const entry = db.prepare('SELECT id FROM activity_log WHERE id = ?').get(id);
  if (!entry) throw new Error('Запись журнала не найдена (возможно, уже удалена)');
  db.prepare('DELETE FROM activity_log WHERE id = ?').run(id);
  return { id };
}

// Полностью очистить журнал изменений
function clearActivity() {
  const info = db.prepare('DELETE FROM activity_log').run();
  return { deleted: info.changes };
}

// ---------- Fixed ABC classification (supplied by the business, not computed) ----------
// This is a static article -> class ('A'/'B'/'C') lookup from an external file
// (e.g. product strength/priority planning), not derived from stock volume.
// It rarely changes, so there's no upload UI for it — only seeded from a
// bundled JSON file, and it only ever grows/updates (never cleared) so a
// re-seed doesn't wipe classes for articles no longer in the source file.
function seedAbcClasses(classMap) {
  const upsert = db.prepare(`INSERT INTO abc_classes (article, class) VALUES (?, ?)
                              ON CONFLICT(article) DO UPDATE SET class = excluded.class`);
  const tx = db.transaction((entries) => { for (const [article, klass] of entries) upsert.run(article, klass); });
  tx(Object.entries(classMap));
}

function getAbcClasses() {
  const rows = db.prepare('SELECT article, class FROM abc_classes').all();
  const out = {};
  rows.forEach(r => { out[r.article] = r.class; });
  return out;
}


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
  logActivity('import', `Загружен файл «${sourceLabel || 'без имени'}» (${rows.length} строк, вся база заменена)`, null);
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

  const bits = [];
  if (patch.cell !== undefined && next.cell !== existing.cell) bits.push(`ячейка ${existing.cell} → ${next.cell}`);
  if (patch.qty !== undefined && next.qty !== existing.qty) bits.push(`остаток ${existing.qty} → ${next.qty}`);
  if (bits.length) {
    logActivity('update', `${existing.article}: ${bits.join(', ')}`, { id, prevCell: existing.cell, prevQty: existing.qty });
  }

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
  logActivity('create', `Добавлен товар ${article} в ${cell}`, { id: info.lastInsertRowid });
  return db.prepare('SELECT * FROM stock_records WHERE id = ?').get(info.lastInsertRowid);
}

function deleteRecord(id) {
  const existing = db.prepare('SELECT * FROM stock_records WHERE id = ?').get(id);
  if (!existing) return false;
  db.prepare('DELETE FROM stock_records WHERE id = ?').run(id);
  logActivity('delete', `Удалена запись ${existing.article} из ${existing.cell}`, {
    record: {
      cell: existing.cell, article: existing.article, name: existing.name, qty: existing.qty,
      mfg: existing.mfg, exp: existing.exp, te: existing.te
    }
  });
  return true;
}

// Bulk operations below (swap, rename) move records with raw SQL instead of
// going through updateRecord(), so they don't get the automatic expandLayout()
// call. This re-derives the layout from the actual current table and merges
// it in (union, never shrinks) — a safety net so a row that receives racks
// it didn't previously "know about" doesn't lose them from the map.
function syncLayoutWithData() {
  const discovered = computeLayout(listRecords());
  setLayout(mergeLayouts(getLayout(), discovered));
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

  syncLayoutWithData();

  logActivity('swap-rows', `Обмен рядами ${rowA} ⇄ ${rowB} (${recordsA.length}/${recordsB.length} записей)`, { rowA, rowB });

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

  logActivity('rename-row', `Ряд ${oldRow} переименован в ${newRow} (${records.length} записей)`, { oldRow, newRow });

  return { moved: records.length };
});

// Create a brand-new row from scratch — used when the warehouse physically
// gains an aisle. Fails if the row code is already in use (rename/add-racks
// should be used to edit an existing row instead).
function createRow(row, racks, levels) {
  const layout = getLayout();
  if (layout[row]) throw new Error(`ряд ${row} уже существует`);

  const cleanRacks = [];
  const seen = new Set();
  for (const n of (racks || [])) {
    const v = parseInt(n, 10);
    if (Number.isInteger(v) && v > 0 && !seen.has(v)) { cleanRacks.push(v); seen.add(v); }
  }
  if (!cleanRacks.length) throw new Error('нужен хотя бы один стеллаж');

  const cleanLevels = (levels && levels.length) ? levels.slice() : ['01'];

  layout[row] = { racks: cleanRacks, levels: cleanLevels };
  setLayout(layout);

  logActivity('create-row', `Создан ряд ${row} (стеллажи: ${cleanRacks.join(', ')})`, { row });

  return layout[row];
}

// Delete a row entirely from the layout. Blocked if any stock still sits in
// that row (empty or service-only rows can go — never silently drop
// inventory), same safety rule as removing a single rack in setRacks.
function deleteRow(row) {
  const layout = getLayout();
  if (!layout[row]) throw new Error(`ряд ${row} не найден в структуре склада`);

  const stillOccupied = db.prepare(
    'SELECT COUNT(*) AS n FROM stock_records WHERE row_code = ? AND is_service = 0'
  ).get(row);
  if (stillOccupied && stillOccupied.n > 0) {
    throw new Error(`нельзя удалить ряд ${row} — там ещё есть товар (${stillOccupied.n} запис.)`);
  }

  const prevEntry = layout[row];
  delete layout[row];
  setLayout(layout);

  logActivity('delete-row', `Удалён ряд ${row}`, { row, prevEntry });

  return { row };
}

// Add and/or remove racks for a row in one go — this is the "change the
// number of cells" operation. Adding is always safe (just a new empty
// position). Removing is blocked if that rack still holds any stock, so a
// careless edit can't silently delete inventory.
// Add and/or remove levels (tiers) for a row in one go — same safety rule as
// setRacks: removing a level is blocked if any of its cells still hold stock.
function setLevels(row, levels) {
  const layout = getLayout();
  if (!layout[row]) throw new Error(`ряд ${row} не найден в структуре склада`);

  const VALID_LEVELS = ["01","02","03","04","05","06","07","08","A1","B1"];
  const cleanLevels = [];
  const seen = new Set();
  for (const lv of levels) {
    const v = String(lv).toUpperCase();
    if (VALID_LEVELS.includes(v) && !seen.has(v)) { cleanLevels.push(v); seen.add(v); }
  }
  if (!cleanLevels.length) throw new Error('нужен хотя бы один ярус');

  const removed = layout[row].levels.filter(lv => !seen.has(lv));
  if (removed.length) {
    const placeholders = removed.map(() => '?').join(',');
    const stillOccupied = db.prepare(
      `SELECT DISTINCT level FROM stock_records WHERE row_code = ? AND is_service = 0 AND level IN (${placeholders})`
    ).all(row, ...removed);
    if (stillOccupied.length) {
      throw new Error(`нельзя убрать ярус(ы) ${stillOccupied.map(r => r.level).join(', ')} — там ещё есть товар`);
    }
  }

  const prevLevels = layout[row].levels.slice();
  layout[row].levels = cleanLevels;
  setLayout(layout);

  const added = cleanLevels.filter(lv => !prevLevels.includes(lv));
  const bits = [];
  if (added.length) bits.push(`добавлены ${added.join(', ')}`);
  if (removed.length) bits.push(`убраны ${removed.join(', ')}`);
  if (bits.length) logActivity('set-levels', `Ряд ${row}: ярусы — ${bits.join('; ')}`, { row, prevLevels });

  return layout[row];
}


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

  const prevRacks = layout[row].racks.slice();
  layout[row].racks = cleanRacks;
  setLayout(layout);

  const added = cleanRacks.filter(rk => !prevRacks.includes(rk));
  const bits = [];
  if (added.length) bits.push(`добавлены ${added.join(', ')}`);
  if (removed.length) bits.push(`убраны ${removed.join(', ')}`);
  if (bits.length) logActivity('set-racks', `Ряд ${row}: ${bits.join('; ')}`, { row, prevRacks });

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

  syncLayoutWithData();

  logActivity('swap-racks', `Обмен стеллажами ${rackA} ⇄ ${rackB} в ряду ${row} (${recordsA.length}/${recordsB.length} записей)`, { row, rackA, rackB });

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

// ---------- Bulk operations (multi-select in the table) ----------

const bulkMove = db.transaction((ids, targetCell) => {
  const target = String(targetCell).trim();
  const cls = classifyCell(target);
  const moves = [];
  const update = db.prepare(`
    UPDATE stock_records
    SET cell = @cell, is_service = @isService, row_code = @row, rack = @rack, level_code = @level, updated_at = datetime('now')
    WHERE id = @id
  `);
  for (const id of ids) {
    const existing = db.prepare('SELECT id, cell FROM stock_records WHERE id = ?').get(id);
    if (!existing) continue;
    moves.push({ id, prevCell: existing.cell });
    update.run({ id, cell: target, isService: cls.isService, row: cls.row, rack: cls.rack, level: cls.level });
  }
  if (!cls.isService) expandLayout(cls.row, cls.rack, cls.level);
  if (moves.length) {
    logActivity('bulk-move', `Перемещено ${moves.length} записей в ${target}`, { moves });
  }
  return { moved: moves.length };
});

const bulkDelete = db.transaction((ids) => {
  const records = [];
  for (const id of ids) {
    const existing = db.prepare('SELECT * FROM stock_records WHERE id = ?').get(id);
    if (!existing) continue;
    records.push({
      cell: existing.cell, article: existing.article, name: existing.name, qty: existing.qty,
      mfg: existing.mfg, exp: existing.exp, te: existing.te
    });
    db.prepare('DELETE FROM stock_records WHERE id = ?').run(id);
  }
  if (records.length) {
    logActivity('bulk-delete', `Удалено ${records.length} записей`, { records });
  }
  return { deleted: records.length };
});

// ---------- Service zones (Карантин, Брак, Приёмка, etc.) as a managed entity ----------
// Previously a "zone" was just whatever distinct non-address string showed up
// in the cell column — there was no way to create one ahead of stock arriving,
// or to rename/delete one cleanly. This table makes zones first-class.

// Registers any zone name that's already in use (from an import, or from
// before this table existed) so nothing already on the floor goes missing.
function ensureZonesFromData() {
  const rows = db.prepare('SELECT DISTINCT cell FROM stock_records WHERE is_service = 1').all();
  const insert = db.prepare('INSERT OR IGNORE INTO service_zones (name) VALUES (?)');
  const tx = db.transaction((names) => { for (const n of names) insert.run(n); });
  tx(rows.map(r => r.cell));
}

function listZones() {
  return db.prepare(`
    SELECT z.name, z.isolate, z.created_at,
           COUNT(r.id) AS records, COALESCE(SUM(r.qty), 0) AS qty,
           COUNT(DISTINCT r.article) AS articles
    FROM service_zones z
    LEFT JOIN stock_records r ON r.cell = z.name AND r.is_service = 1
    GROUP BY z.name
    ORDER BY qty DESC, z.name
  `).all();
}

function createZone(name, isolate) {
  const n = String(name || '').trim();
  if (!n) throw new Error('укажите название зоны');
  if (classifyCell(n).isService === false) throw new Error('такое название выглядит как обычный адрес ячейки (РЯД-СТЕЛЛАЖ-ЯРУС) — зоне нужно другое имя');
  const existing = db.prepare('SELECT name FROM service_zones WHERE name = ?').get(n);
  if (existing) throw new Error(`зона «${n}» уже существует`);
  db.prepare('INSERT INTO service_zones (name, isolate) VALUES (?, ?)').run(n, isolate ? 1 : 0);
  logActivity('create-zone', `Создана служебная зона «${n}»`, null);
  return { name: n, isolate: !!isolate };
}

const renameZone = db.transaction((oldName, newName) => {
  const n = String(newName || '').trim();
  if (oldName === n) return { moved: 0 };
  if (!n) throw new Error('укажите новое название зоны');
  if (!db.prepare('SELECT name FROM service_zones WHERE name = ?').get(oldName)) throw new Error(`зона «${oldName}» не найдена`);
  if (db.prepare('SELECT name FROM service_zones WHERE name = ?').get(n)) throw new Error(`зона «${n}» уже существует`);

  const info = db.prepare('UPDATE stock_records SET cell = ?, updated_at = datetime(\'now\') WHERE cell = ? AND is_service = 1').run(n, oldName);
  db.prepare('UPDATE service_zones SET name = ? WHERE name = ?').run(n, oldName);

  logActivity('rename-zone', `Зона «${oldName}» переименована в «${n}» (${info.changes} записей)`, { oldName, newName: n });
  return { moved: info.changes };
});

function setZoneIsolate(name, isolate) {
  const res = db.prepare('UPDATE service_zones SET isolate = ? WHERE name = ?').run(isolate ? 1 : 0, name);
  if (!res.changes) throw new Error(`зона «${name}» не найдена`);
  return { name, isolate: !!isolate };
}

const deleteZone = db.transaction((name, force) => {
  if (!db.prepare('SELECT name FROM service_zones WHERE name = ?').get(name)) throw new Error(`зона «${name}» не найдена`);
  const inZone = db.prepare('SELECT COUNT(*) AS n FROM stock_records WHERE cell = ? AND is_service = 1').get(name).n;
  if (inZone > 0 && !force) {
    throw new Error(`в зоне «${name}» ещё ${inZone} записей — удалите/перенесите их или подтвердите удаление вместе с содержимым`);
  }
  if (inZone > 0 && force) {
    db.prepare('DELETE FROM stock_records WHERE cell = ? AND is_service = 1').run(name);
  }
  db.prepare('DELETE FROM service_zones WHERE name = ?').run(name);
  logActivity('delete-zone', `Удалена зона «${name}»${inZone ? ` вместе с ${inZone} записями` : ''}`, null);
  return { removedRecords: inZone };
});


// Every undoable action is reversed by replaying the inverse through the same
// public functions above — each of those calls also logs its own activity
// entry, so an undo shows up in the feed too (and undoing an undo redoes the
// original action, which is a reasonable and transparent side effect).
function reverseActivity(entry) {
  const data = JSON.parse(entry.undo_data);
  switch (entry.action) {
    case 'create': deleteRecord(data.id); break;
    case 'delete': createRecord(data.record); break;
    case 'update': updateRecord(data.id, { cell: data.prevCell, qty: data.prevQty }); break;
    case 'swap-rows': swapRows(data.rowA, data.rowB); break;
    case 'swap-racks': swapRacks(data.row, data.rackA, data.rackB); break;
    case 'rename-row': renameRow(data.newRow, data.oldRow); break;
    case 'rename-zone': renameZone(data.newName, data.oldName); break;
    case 'set-racks': setRacks(data.row, data.prevRacks); break;
    case 'set-levels': setLevels(data.row, data.prevLevels); break;
    case 'create-row': deleteRow(data.row); break;
    case 'delete-row': createRow(data.row, data.prevEntry.racks, data.prevEntry.levels); break;
    case 'bulk-move': data.moves.forEach(m => updateRecord(m.id, { cell: m.prevCell })); break;
    case 'bulk-delete': data.records.forEach(r => createRecord(r)); break;
    default: throw new Error('Неизвестное действие: ' + entry.action);
  }
}

const undoLastAction = db.transaction(() => {
  const last = getLastActivity();
  if (!last) throw new Error('Нет действий для отмены');
  if (!last.undo_data) throw new Error('Это действие нельзя отменить');
  reverseActivity(last);
  db.prepare('DELETE FROM activity_log WHERE id = ?').run(last.id);
  return { action: last.action, summary: last.summary };
});

// Undo any single entry from the journal by id — not just the most recent
// one. Useful for reversing a specific change several steps back without
// having to click "undo" repeatedly through everything that happened after
// it. This can't detect conflicts with later actions that touched the same
// data (e.g. the record was moved again since), so the frontend shows a
// warning when the chosen entry isn't the latest one — the operation itself
// still just replays the same inverse used for undoLastAction.
const undoActivityById = db.transaction((id) => {
  const entry = db.prepare('SELECT * FROM activity_log WHERE id = ?').get(id);
  if (!entry) throw new Error('Запись журнала не найдена (возможно, уже удалена или устарела)');
  if (!entry.undo_data) throw new Error('Это действие нельзя отменить');
  reverseActivity(entry);
  db.prepare('DELETE FROM activity_log WHERE id = ?').run(entry.id);
  return { action: entry.action, summary: entry.summary };
});

// ---------- Пользователи и роли ----------
// Роли больше не зашиты в коде — они хранятся в таблице `roles` и полностью
// настраиваются: можно переименовать любую (включая встроенные), поменять
// набор прав (canManageUsers / canManageActivity / canReadActivity) или
// добавить свою. Единственное исключение — системная роль "service": она
// одна на систему, её нельзя удалить, а права всегда остаются полными,
// чтобы доступ к управлению системой нельзя было потерять случайно.

function rowToRole(r) {
  if (!r) return null;
  return {
    key: r.key,
    label: r.label,
    isSystem: !!r.is_system,
    perms: {
      canManageUsers: !!r.can_manage_users,
      canManageActivity: !!r.can_manage_activity,
      canReadActivity: !!r.can_read_activity,
      canManageTasks: !!r.can_manage_tasks,
      canImportData: !!r.can_import_data
    },
    createdAt: r.created_at
  };
}

function listRoles() {
  return db.prepare('SELECT * FROM roles ORDER BY (key = \'service\') DESC, created_at ASC').all().map(rowToRole);
}

function getRole(key) {
  return rowToRole(db.prepare('SELECT * FROM roles WHERE key = ?').get(key));
}

function roleExists(key) {
  return !!db.prepare('SELECT 1 FROM roles WHERE key = ?').get(key);
}

function slugifyRoleKey(raw) {
  const key = String(raw || '').trim().toLowerCase()
    .replace(/[^a-z0-9а-яё_]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  return key;
}

function createRole({ key, label, perms }) {
  const k = slugifyRoleKey(key || label);
  if (!k) throw new Error('Не удалось определить идентификатор роли — укажите название латиницей или цифрами');
  if (k === 'service') throw new Error('Название "service" зарезервировано');
  if (roleExists(k)) throw new Error('Роль с таким идентификатором уже существует');
  if (!label || !String(label).trim()) throw new Error('Укажите название роли');
  const p = perms || {};
  db.prepare(`INSERT INTO roles (key, label, can_manage_users, can_manage_activity, can_read_activity, can_manage_tasks, can_import_data, is_system)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(k, String(label).trim(), p.canManageUsers ? 1 : 0, p.canManageActivity ? 1 : 0, p.canReadActivity ? 1 : 0, p.canManageTasks ? 1 : 0, p.canImportData ? 1 : 0);
  return getRole(k);
}

// Переименование — доступно для ЛЮБОЙ роли, включая системную "service".
function renameRole(key, label) {
  if (!label || !String(label).trim()) throw new Error('Укажите название роли');
  const info = db.prepare('UPDATE roles SET label = ? WHERE key = ?').run(String(label).trim(), key);
  if (!info.changes) throw new Error('Роль не найдена');
  return getRole(key);
}

// Права системной роли ("service") менять нельзя — это единственная гарантия,
// что управление системой не потеряется из-за случайной/ошибочной правки.
function updateRolePerms(key, perms) {
  const role = getRole(key);
  if (!role) throw new Error('Роль не найдена');
  if (role.isSystem) throw new Error('Права сервисной роли изменить нельзя');
  const p = perms || {};
  db.prepare(`UPDATE roles SET can_manage_users = ?, can_manage_activity = ?, can_read_activity = ?, can_manage_tasks = ?, can_import_data = ? WHERE key = ?`)
    .run(p.canManageUsers ? 1 : 0, p.canManageActivity ? 1 : 0, p.canReadActivity ? 1 : 0, p.canManageTasks ? 1 : 0, p.canImportData ? 1 : 0, key);
  return getRole(key);
}

function countUsersWithRole(key) {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(key).n;
}

function deleteRole(key) {
  const role = getRole(key);
  if (!role) throw new Error('Роль не найдена');
  if (role.isSystem) throw new Error('Сервисную роль удалить нельзя');
  const inUse = countUsersWithRole(key);
  if (inUse > 0) throw new Error(`Роль назначена ${inUse} пользователю(-ям) — сначала смените им роль`);
  db.prepare('DELETE FROM roles WHERE key = ?').run(key);
  return { key };
}

function listUsers() {
  return db.prepare('SELECT id, username, display_name, role, created_at, created_by, disabled, avatar_path FROM users ORDER BY id ASC').all();
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function insertUser({ username, displayName, passwordHash, role, createdBy }) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname) throw new Error('Логин не может быть пустым');
  if (!roleExists(role)) throw new Error('Некорректная роль');
  const existing = getUserByUsername(uname);
  if (existing) throw new Error('Пользователь с таким логином уже существует');
  const info = db.prepare('INSERT INTO users (username, display_name, password_hash, role, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(uname, displayName || uname, passwordHash, role, createdBy || null);
  return getUserById(info.lastInsertRowid);
}

function updateUserRole(id, role) {
  if (!roleExists(role)) throw new Error('Некорректная роль');
  const user = getUserById(id);
  if (!user) throw new Error('Пользователь не найден');
  if (user.role === 'service' && role !== 'service') {
    throw new Error('Нельзя понизить в правах единственный сервисный аккаунт');
  }
  if (role === 'service' && user.role !== 'service') {
    throw new Error('Назначить сервисную роль нельзя — она одна на систему и задаётся только при первом запуске');
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  return getUserById(id);
}

function setUserPasswordHash(id, passwordHash) {
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  if (!info.changes) throw new Error('Пользователь не найден');
  return getUserById(id);
}

// updateUserIdentity — изменить логин и/или отображаемое имя. Разрешено
// как администратору (для любого аккаунта), так и самому пользователю
// (для себя) — оба случая проходят через один и тот же PATCH-эндпоинт.
// username, если передан, нормализуется так же, как при регистрации
// (обрезка пробелов + нижний регистр) и проверяется на уникальность.
function updateUserIdentity(id, { username, displayName }) {
  const user = getUserById(id);
  if (!user) throw new Error('Пользователь не найден');

  let newUsername = user.username;
  if (username !== undefined) {
    newUsername = String(username || '').trim().toLowerCase();
    if (!newUsername) throw new Error('Логин не может быть пустым');
    if (newUsername !== user.username) {
      const existing = getUserByUsername(newUsername);
      if (existing && existing.id !== id) throw new Error('Пользователь с таким логином уже существует');
    }
  }

  let newDisplayName = user.display_name;
  if (displayName !== undefined) {
    newDisplayName = String(displayName || '').trim();
  }
  if (!newDisplayName) newDisplayName = newUsername;

  db.prepare('UPDATE users SET username = ?, display_name = ? WHERE id = ?')
    .run(newUsername, newDisplayName, id);
  return getUserById(id);
}

// avatarPath — просто относительный путь вида "avatars/3-a1b2c3d4.webp"
// (или null, чтобы вернуть аватарку по умолчанию — инициалы). Сам файл
// на диске создаёт/удаляет server.js, здесь только ссылка в БД.
function setUserAvatar(id, avatarPath) {
  const info = db.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(avatarPath || null, id);
  if (!info.changes) throw new Error('Пользователь не найден');
  return getUserById(id);
}

// ---------- Задания сотрудникам ----------
// Каждое задание — один текст + список получателей (task_recipients), у
// каждого получателя свой независимый статус: new → read → in_progress →
// done. "read" проставляется автоматически при первом обращении сотрудника
// к списку своих заданий (см. markMyNewTasksRead), остальные — по кнопкам.
const TASK_STATUSES = ['new', 'read', 'in_progress', 'done'];

function rowToTask(r) {
  return {
    id: r.id,
    text: r.text,
    createdById: r.created_by_id,
    createdByName: r.created_by_name,
    createdAt: r.created_at
  };
}

function rowToRecipient(r) {
  return {
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name || r.username,
    status: r.status,
    readAt: r.read_at,
    startedAt: r.started_at,
    doneAt: r.done_at
  };
}

// Создать задание и разослать его выбранным сотрудникам одним списком.
function createTask({ text, createdById, createdByName, userIds }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Текст задания не может быть пустым');
  const ids = Array.from(new Set((userIds || []).map(Number).filter(Boolean)));
  if (!ids.length) throw new Error('Выберите хотя бы одного сотрудника');
  for (const uid of ids) {
    if (!getUserById(uid)) throw new Error(`Пользователь #${uid} не найден`);
  }
  const info = db.prepare('INSERT INTO tasks (text, created_by_id, created_by_name) VALUES (?, ?, ?)')
    .run(t, createdById || null, createdByName || '');
  const taskId = info.lastInsertRowid;
  const insertRecipient = db.prepare('INSERT INTO task_recipients (task_id, user_id, status) VALUES (?, ?, \'new\')');
  for (const uid of ids) insertRecipient.run(taskId, uid);
  return getTask(taskId);
}

// Полная карточка задания вместе со статусами всех получателей — для тех,
// кто вправе ставить задания (обзор выполнения по команде).
function getTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;
  const recipients = db.prepare(`
    SELECT tr.*, u.username, u.display_name FROM task_recipients tr
    JOIN users u ON u.id = tr.user_id
    WHERE tr.task_id = ? ORDER BY u.display_name ASC, u.username ASC
  `).all(id).map(rowToRecipient);
  return { ...rowToTask(task), recipients };
}

// Все задания (с получателями) — видят только те, кто вправе их ставить.
function listAllTasks() {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  return tasks.map(t => getTask(t.id));
}

// Мои задания — свой статус в каждом. Перед выдачей списка "новые"
// автоматически помечаются прочитанными (см. markMyNewTasksRead).
function listMyTasks(userId) {
  const rows = db.prepare(`
    SELECT tr.*, t.text AS task_text, t.created_by_name, t.created_at AS task_created_at
    FROM task_recipients tr
    JOIN tasks t ON t.id = tr.task_id
    WHERE tr.user_id = ?
    ORDER BY t.created_at DESC
  `).all(userId);
  return rows.map(r => ({
    id: r.task_id,
    text: r.task_text,
    createdByName: r.created_by_name,
    createdAt: r.task_created_at,
    status: r.status,
    readAt: r.read_at,
    startedAt: r.started_at,
    doneAt: r.done_at
  }));
}

function markMyNewTasksRead(userId) {
  db.prepare(`UPDATE task_recipients SET status = 'read', read_at = datetime('now') WHERE user_id = ? AND status = 'new'`)
    .run(userId);
}

function countMyNewTasks(userId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM task_recipients WHERE user_id = ? AND status = 'new'`).get(userId).n;
}

// Сотрудник двигает свой статус вперёд: read → in_progress → done (только
// вперёд — так прогресс нельзя случайно "откатить" повторным нажатием).
function setMyTaskStatus(taskId, userId, status) {
  if (!TASK_STATUSES.includes(status)) throw new Error('Некорректный статус');
  const row = db.prepare('SELECT * FROM task_recipients WHERE task_id = ? AND user_id = ?').get(taskId, userId);
  if (!row) throw new Error('Задание не найдено');
  const from = TASK_STATUSES.indexOf(row.status);
  const to = TASK_STATUSES.indexOf(status);
  if (to !== from + 1) throw new Error('Задания можно двигать только на один шаг вперёд по порядку: прочитано → в работе → готово');
  const col = status === 'read' ? 'read_at' : status === 'in_progress' ? 'started_at' : status === 'done' ? 'done_at' : null;
  db.prepare(`UPDATE task_recipients SET status = ?${col ? `, ${col} = datetime('now')` : ''} WHERE task_id = ? AND user_id = ?`)
    .run(status, taskId, userId);
  return getTask(taskId);
}

function deleteTask(id) {
  const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (!info.changes) throw new Error('Задание не найдено');
  db.prepare('DELETE FROM task_recipients WHERE task_id = ?').run(id);
  return { id };
}

function listAssignableUsers() {
  return db.prepare(`SELECT id, username, display_name, role, disabled, avatar_path FROM users WHERE disabled = 0 ORDER BY display_name ASC, username ASC`).all();
}

function setUserDisabled(id, disabled) {
  const user = getUserById(id);
  if (!user) throw new Error('Пользователь не найден');
  if (user.role === 'service') throw new Error('Сервисный аккаунт нельзя заблокировать');
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
  return getUserById(id);
}

function deleteUser(id) {
  const user = getUserById(id);
  if (!user) throw new Error('Пользователь не найден');
  if (user.role === 'service') throw new Error('Сервисный аккаунт нельзя удалить');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { id };
}

// ---------- Заявки на регистрацию ----------
// Самостоятельная регистрация не создаёт аккаунт сразу — она кладёт заявку
// в отдельную таблицу; аккаунт появляется только после того, как кто-то с
// правом canManageUsers её одобрит (и выберет роль). Отклонённые и
// одобренные заявки не хранятся — счётчик уведомлений это просто
// количество строк в таблице.

function rowToRegRequest(r) {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name || r.username,
    createdAt: r.created_at
  };
}

function createRegistrationRequest({ username, displayName, passwordHash }) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname) throw new Error('Укажите логин');
  if (!/^[a-z0-9_.-]{2,32}$/i.test(uname)) {
    throw new Error('Логин может содержать только латинские буквы, цифры, точку, дефис и подчёркивание');
  }
  if (getUserByUsername(uname)) throw new Error('Такой логин уже занят');
  const pending = db.prepare('SELECT 1 FROM registration_requests WHERE username = ?').get(uname);
  if (pending) throw new Error('Заявка с таким логином уже отправлена — дождитесь решения администратора');
  const info = db.prepare('INSERT INTO registration_requests (username, display_name, password_hash) VALUES (?, ?, ?)')
    .run(uname, String(displayName || '').trim() || uname, passwordHash);
  return rowToRegRequest(db.prepare('SELECT * FROM registration_requests WHERE id = ?').get(info.lastInsertRowid));
}

function listRegistrationRequests() {
  return db.prepare('SELECT * FROM registration_requests ORDER BY created_at ASC').all().map(rowToRegRequest);
}

function countRegistrationRequests() {
  return db.prepare('SELECT COUNT(*) AS n FROM registration_requests').get().n;
}

function getRegistrationRequestRaw(id) {
  return db.prepare('SELECT * FROM registration_requests WHERE id = ?').get(id);
}

// Одобрить: создаёт полноценный аккаунт с выбранной ролью и удаляет заявку.
function approveRegistrationRequest(id, role, approvedBy) {
  const req = getRegistrationRequestRaw(id);
  if (!req) throw new Error('Заявка не найдена — возможно, её уже обработали');
  const user = insertUser({
    username: req.username,
    displayName: req.display_name,
    passwordHash: req.password_hash,
    role,
    createdBy: approvedBy ? `заявка, одобрил ${approvedBy}` : 'заявка'
  });
  db.prepare('DELETE FROM registration_requests WHERE id = ?').run(id);
  return user;
}

function rejectRegistrationRequest(id) {
  const info = db.prepare('DELETE FROM registration_requests WHERE id = ?').run(id);
  if (!info.changes) throw new Error('Заявка не найдена — возможно, её уже обработали');
  return { id };
}

// ---------- Сессии ----------
const SESSION_TTL_DAYS = 14;

function createSession(token, userId) {
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(token, userId, `+${SESSION_TTL_DAYS} days`);
}

function getSession(token) {
  purgeExpiredSessions();
  const row = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > datetime(\'now\')').get(token);
  if (!row) return null;
  const user = getUserById(row.user_id);
  if (!user || user.disabled) return null;
  return user;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function purgeExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
}

module.exports = {
  db, classifyCell, listRecords, replaceAll, updateRecord, createRecord, deleteRecord,
  swapRows, swapRacks, renameRow, setRacks, setLevels, createRow, deleteRow, getMeta, setMeta, count, seedIfEmpty,
  getLayout, ensureLayoutFromSeed, rebuildLayoutFromCurrent, setRackOrder,
  bulkMove, bulkDelete, listActivity, undoLastAction, undoActivityById, deleteActivityEntry, clearActivity,
  seedAbcClasses, getAbcClasses,
  ensureZonesFromData, listZones, createZone, renameZone, setZoneIsolate, deleteZone,
  setCurrentActor,
  listRoles, getRole, roleExists, createRole, renameRole, updateRolePerms, deleteRole,
  listUsers, getUserByUsername, getUserById, countUsers, insertUser, updateUserRole,
  setUserPasswordHash, setUserDisabled, deleteUser, listAssignableUsers, setUserAvatar, updateUserIdentity,
  createTask, getTask, listAllTasks, listMyTasks, markMyNewTasksRead, countMyNewTasks, setMyTaskStatus, deleteTask,
  createRegistrationRequest, listRegistrationRequests, countRegistrationRequests, approveRegistrationRequest, rejectRegistrationRequest,
  createSession, getSession, deleteSession, deleteAllSessionsForUser
};
