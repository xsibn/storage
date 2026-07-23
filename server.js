// server.js — REST API + отдача статического фронтенда.
// Запуск: npm install && npm start (по умолчанию слушает порт 3000, можно
// переопределить переменной окружения PORT).

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');

const db = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- первичная загрузка данных, если база пустая (первый запуск сервера) ----
const seedPath = path.join(__dirname, 'seed', 'seed.json');
if (fs.existsSync(seedPath)) {
  try {
    const seedRows = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    db.seedIfEmpty(seedRows, 'Сток_на_15_07_2026.xlsx (первичная загрузка)');
    // Always widen the stored layout to at least the seed's full extent — this
    // also repairs older databases where racks/levels "disappeared" from the
    // map after becoming fully empty (layout used to be inferred from current
    // occupancy only). Never shrinks anything already recorded.
    db.ensureLayoutFromSeed(seedRows);
    // Also reconcile the layout against whatever is ACTUALLY in the table right
    // now — repairs drift left over from row/rack swaps performed before this
    // safety net existed (the stock data itself was always fine; only the
    // display structure could lag behind it).
    db.rebuildLayoutFromCurrent();
  } catch (err) {
    console.error('Не удалось загрузить seed-данные:', err.message);
  }
}

// ---- фиксированная ABC-классификация (постоянная, задаётся файлом, не импортом) ----
const abcClassesPath = path.join(__dirname, 'seed', 'abc-classes.json');
if (fs.existsSync(abcClassesPath)) {
  try {
    const classMap = JSON.parse(fs.readFileSync(abcClassesPath, 'utf-8'));
    db.seedAbcClasses(classMap);
  } catch (err) {
    console.error('Не удалось загрузить ABC-классы:', err.message);
  }
}

// ---- регистрируем уже существующие зоны (Карантин, Приёмка и т.п.) как управляемые ----
db.ensureZonesFromData();

// Некоторые выгрузки (например, из «1С: ОтчетОстатки») содержат перед
// настоящей шапкой таблицы 1-2 служебные строки с названием отчёта и
// организации — сама шапка ("Ячейка", "Артикул", ...) идёт не первой
// строкой листа. Находим её, просматривая строки листа, вместо того чтобы
// всегда считать заголовками первую строку.
function sheetToRows(sheet) {
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const isHeaderRow = (row) =>
    row.some(c => String(c).trim().toLowerCase() === 'ячейка') &&
    row.some(c => String(c).trim().toLowerCase().startsWith('артикул'));
  const headerIdx = grid.findIndex(isHeaderRow);
  if (headerIdx === -1) {
    // шапка не найдена по ожидаемым названиям — отдаём как есть (первая
    // строка = заголовки), чтобы сохранить прежнее поведение для файлов
    // простой структуры
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }
  const headers = grid[headerIdx].map(h => String(h));
  return grid.slice(headerIdx + 1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

// Приводим строки заголовков к нужным полям вне зависимости от порядка
// колонок и небольших расхождений в написании ("Артикул " с пробелом и т.п.).
function mapSheetRow(row) {
  const get = (...names) => {
    for (const n of names) {
      const key = Object.keys(row).find(k => k.trim().toLowerCase() === n.toLowerCase());
      if (key !== undefined) return row[key];
    }
    return '';
  };
  const fmtDate = (v) => {
    if (!v) return '';
    if (v instanceof Date) return v.toLocaleDateString('ru-RU');
    return String(v);
  };
  return {
    cell: String(get('Ячейка')).trim(),
    article: String(get('Артикул', 'Артикул ')).trim(),
    name: String(get('Наименование')).trim(),
    qty: Number(get('Остаток')) || 0,
    mfg: fmtDate(get('Дата изготовления')),
    exp: fmtDate(get('Срок годности')),
    te: String(get('ТЕ') || '').trim()
  };
}

// ---------- API ----------

// GET /api/records — весь текущий сток + метаданные (источник, время импорта, структура склада)
app.get('/api/records', (req, res) => {
  const records = db.listRecords();
  let layout = db.getLayout();
  if (Object.keys(layout).length === 0 && records.length) {
    layout = db.rebuildLayoutFromCurrent();
  }
  res.json({
    records,
    meta: {
      source: db.getMeta('source_label') || 'база данных',
      importedAt: db.getMeta('imported_at'),
      count: records.length,
      layout,
      abcClasses: db.getAbcClasses(),
      zones: db.listZones()
    }
  });
});

// PATCH /api/records/:id — ручная правка одной записи (остаток и/или ячейка)
app.patch('/api/records/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { qty, cell } = req.body || {};
  if (qty === undefined && cell === undefined) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  const updated = db.updateRecord(id, { qty, cell });
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json({ record: updated });
});

// POST /api/records — добавить новый товар в ячейку (форма «+ Добавить товар»)
app.post('/api/records', (req, res) => {
  const { cell, article, name, qty, mfg, exp, te } = req.body || {};
  if (!cell || !article) return res.status(400).json({ error: 'обязательны поля "cell" и "article"' });
  const record = db.createRecord({ cell, article, name, qty, mfg, exp, te });
  if (!record) return res.status(400).json({ error: 'не удалось создать запись' });
  res.status(201).json({ record });
});

// DELETE /api/records/:id — удалить ошибочно добавленную запись
app.delete('/api/records/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const ok = db.deleteRecord(id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// POST /api/layout — создать новый ряд с нуля
app.post('/api/layout', (req, res) => {
  const { row, racks, levels } = req.body || {};
  if (!row || !/^\d{1,2}$/.test(String(row).trim())) {
    return res.status(400).json({ error: '"row" должен быть числом из 1-2 цифр' });
  }
  const r = String(row).trim().padStart(2, '0');
  if (!Array.isArray(racks) || !racks.length) {
    return res.status(400).json({ error: '"racks" должен быть непустым массивом номеров стеллажей' });
  }
  try {
    const created = db.createRow(r, racks, levels);
    res.status(201).json({ ok: true, row: r, ...created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/layout/:row — удалить ряд целиком (только если он пуст)
app.delete('/api/layout/:row', (req, res) => {
  const row = String(req.params.row).trim().padStart(2, '0');
  try {
    const result = db.deleteRow(row);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/layout/:row/rename — переименовать ряд (перенести все записи под новый код)
app.put('/api/layout/:row/rename', (req, res) => {
  const oldRow = String(req.params.row).trim().padStart(2, '0');
  const { newRow } = req.body || {};
  if (!newRow || !/^\d{1,2}$/.test(String(newRow).trim())) {
    return res.status(400).json({ error: '"newRow" должен быть числом из 1-2 цифр' });
  }
  const nr = String(newRow).trim().padStart(2, '0');
  try {
    const result = db.renameRow(oldRow, nr);
    res.json({ ok: true, oldRow, newRow: nr, moved: result.moved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/layout/:row/racks — задать список стеллажей ряда (добавление/удаление ячеек)
app.put('/api/layout/:row/racks', (req, res) => {
  const row = String(req.params.row).trim().padStart(2, '0');
  const { racks } = req.body || {};
  if (!Array.isArray(racks)) return res.status(400).json({ error: '"racks" должен быть массивом номеров стеллажей' });
  try {
    const updated = db.setRacks(row, racks);
    res.json({ ok: true, row, racks: updated.racks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/layout/:row/levels — задать список ярусов ряда (добавление/удаление строк по высоте)
app.put('/api/layout/:row/levels', (req, res) => {
  const row = String(req.params.row).trim().padStart(2, '0');
  const { levels } = req.body || {};
  if (!Array.isArray(levels)) return res.status(400).json({ error: '"levels" должен быть массивом ярусов' });
  try {
    const updated = db.setLevels(row, levels);
    res.json({ ok: true, row, levels: updated.levels });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Служебные зоны ----------

// POST /api/zones — создать новую зону
app.post('/api/zones', (req, res) => {
  const { name, isolate } = req.body || {};
  try {
    const zone = db.createZone(name, !!isolate);
    res.status(201).json({ ok: true, zone });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/zones/:name — переименовать и/или переключить изоляцию
app.patch('/api/zones/:name', (req, res) => {
  const name = req.params.name;
  const { newName, isolate } = req.body || {};
  try {
    let current = name;
    if (newName !== undefined && newName !== name) {
      db.renameZone(name, newName);
      current = String(newName).trim();
    }
    if (isolate !== undefined) db.setZoneIsolate(current, !!isolate);
    res.json({ ok: true, name: current });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/zones/:name — удалить зону (пустую; ?force=true — вместе с содержимым)
app.delete('/api/zones/:name', (req, res) => {
  const name = req.params.name;
  const force = req.query.force === 'true' || (req.body && req.body.force === true);
  try {
    const result = db.deleteZone(name, force);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Массовые операции (мультивыбор в таблице / перенос ряда-стеллажа-ячейки в зону) ----------

// POST /api/records/bulk-move — переместить несколько записей разом (в т.ч. в служебную зону)
app.post('/api/records/bulk-move', (req, res) => {
  const { ids, cell } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '"ids" должен быть непустым массивом' });
  if (!cell || !String(cell).trim()) return res.status(400).json({ error: '"cell" обязателен' });
  try {
    const result = db.bulkMove(ids.map(n => parseInt(n, 10)).filter(Number.isInteger), cell);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/records/bulk-delete — удалить несколько записей разом
app.post('/api/records/bulk-delete', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '"ids" должен быть непустым массивом' });
  try {
    const result = db.bulkDelete(ids.map(n => parseInt(n, 10)).filter(Number.isInteger));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Журнал изменений ----------

// GET /api/activity — последние записи журнала
app.get('/api/activity', (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
  res.json({ entries: db.listActivity(limit) });
});

// POST /api/activity/undo — отменить последнее действие
app.post('/api/activity/undo', (req, res) => {
  try {
    const result = db.undoLastAction();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/layout/:row/rack-order — сохранить пользовательский порядок стеллажей ряда
app.put('/api/layout/:row/rack-order', (req, res) => {
  const row = String(req.params.row).trim().padStart(2, '0');
  const { order } = req.body || {};
  if (!Array.isArray(order) || !order.length) {
    return res.status(400).json({ error: '"order" должен быть непустым массивом номеров стеллажей' });
  }
  try {
    const updated = db.setRackOrder(row, order);
    res.json({ ok: true, row, racks: updated.racks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/records/swap-rows — поменять местами весь товар двух рядов целиком
app.post('/api/records/swap-rows', (req, res) => {
  const { rowA, rowB } = req.body || {};
  if (!rowA || !rowB) return res.status(400).json({ error: 'обязательны поля "rowA" и "rowB"' });
  const a = String(rowA).trim().padStart(2, '0');
  const b = String(rowB).trim().padStart(2, '0');
  if (a === b) return res.status(400).json({ error: 'rowA и rowB совпадают' });
  try {
    const result = db.swapRows(a, b);
    res.json({ ok: true, rowA: a, rowB: b, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/records/swap-racks — поменять местами два стеллажа целиком внутри одного ряда
app.post('/api/records/swap-racks', (req, res) => {
  const { row, rackA, rackB } = req.body || {};
  if (!row || rackA === undefined || rackB === undefined) {
    return res.status(400).json({ error: 'обязательны поля "row", "rackA", "rackB"' });
  }
  const r = String(row).trim().padStart(2, '0');
  const a = parseInt(rackA, 10), b = parseInt(rackB, 10);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return res.status(400).json({ error: 'rackA и rackB должны быть числами' });
  if (a === b) return res.status(400).json({ error: 'rackA и rackB совпадают' });
  try {
    const result = db.swapRacks(r, a, b);
    res.json({ ok: true, row: r, rackA: a, rackB: b, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import — загрузка нового .xlsx: полностью заменяет текущие данные в базе
app.post('/api/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (field name "file")' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = sheetToRows(sheet);
    const rows = json.map(mapSheetRow).filter(r => r.cell !== '' && r.article !== '');
    if (!rows.length) return res.status(400).json({ error: 'файл не содержит распознаваемых строк' });
    // multer/busboy decode the multipart filename header as latin1 by default,
    // which turns Cyrillic (and any non-ASCII) filenames into mojibake — undo that.
    const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    db.replaceAll(rows, filename);
    res.json({ ok: true, imported: rows.length });
  } catch (err) {
    res.status(400).json({ error: 'не удалось прочитать файл: ' + err.message });
  }
});

// GET /api/export — выгрузка текущего состояния базы в .xlsx
app.get('/api/export', (req, res) => {
  const records = db.listRecords();
  const rows = records.map(r => ({
    'Ячейка': r.cell,
    'Артикул': r.article,
    'Наименование': r.name,
    'Остаток': r.qty,
    'Дата изготовления': r.mfg,
    'Срок годности': r.exp,
    'ТЕ': r.te,
    'Тип': r.is_service ? 'Служебная зона' : 'Адресная ячейка'
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Данные');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const encodedName = encodeURIComponent('адресное_хранение.xlsx');
  res.setHeader('Content-Disposition', `attachment; filename="warehouse-export.xlsx"; filename*=UTF-8''${encodedName}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Любой прочий путь — отдаём фронтенд (на случай прямых ссылок на подстраницы)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Адресное хранение склада: сервер запущен на порту ${PORT}`);
});
