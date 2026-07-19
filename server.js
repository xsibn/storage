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
  } catch (err) {
    console.error('Не удалось загрузить seed-данные:', err.message);
  }
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
      layout
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
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const rows = json.map(mapSheetRow).filter(r => r.cell !== '' && r.article !== '');
    if (!rows.length) return res.status(400).json({ error: 'файл не содержит распознаваемых строк' });
    db.replaceAll(rows, req.file.originalname);
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
  res.setHeader('Content-Disposition', 'attachment; filename="адресное_хранение.xlsx"');
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
