// server.js — REST API + отдача статического фронтенда.
// Запуск: npm install && npm start (по умолчанию слушает порт 3000, можно
// переопределить переменной окружения PORT).

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');

const db = require('./db');
const auth = require('./auth');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(auth.attachUser);

// ---- первичное создание сервисного аккаунта, если пользователей ещё нет ----
if (db.countUsers() === 0) {
  const username = process.env.SERVICE_USERNAME || 'admin';
  const password = process.env.SERVICE_PASSWORD || crypto.randomBytes(6).toString('hex');
  db.insertUser({
    username,
    displayName: 'Сервисный аккаунт',
    passwordHash: auth.hashPassword(password),
    role: 'service',
    createdBy: null
  });
  console.log('================================================================');
  console.log(' Создан сервисный аккаунт (полный контроль над системой):');
  console.log(`   логин:  ${username}`);
  if (process.env.SERVICE_PASSWORD) {
    console.log('   пароль: задан через переменную окружения SERVICE_PASSWORD');
  } else {
    console.log(`   пароль: ${password}  (сгенерирован автоматически, смените после входа)`);
  }
  console.log(' Эти данные больше нигде не показываются — сохраните их сейчас.');
  console.log('================================================================');
}

// Всё под /api/*, кроме входа и health-check, требует авторизации.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/api/auth/') || req.path === '/api/health') return next();
  return auth.requireAuth(req, res, next);
});

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
      zones: db.listZones(),
      storageRange: JSON.parse(db.getMeta('storageRange') || 'null'),
      abcCols: JSON.parse(db.getMeta('abcCols') || 'null')
    }
  });
});

// PUT /api/settings — сохранить пользовательские настройки (диапазон стеллажей
// зоны хранения по рядам, ширину пик-фейса по ABC-классам) в базе, а не в
// localStorage браузера — так они одинаковы на всех устройствах, а не только
// на том, где их поменяли.
app.put('/api/settings', (req, res) => {
  const { storageRange, abcCols } = req.body || {};
  if (storageRange !== undefined) db.setMeta('storageRange', JSON.stringify(storageRange));
  if (abcCols !== undefined) db.setMeta('abcCols', JSON.stringify(abcCols));
  res.json({ ok: true });
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
app.get('/api/activity', auth.requirePerm('canReadActivity'), (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
  res.json({ entries: db.listActivity(limit) });
});

// POST /api/activity/undo — отменить последнее действие
app.post('/api/activity/undo', auth.requirePerm('canManageActivity'), (req, res) => {
  try {
    const result = db.undoLastAction();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/activity/:id/undo — отменить конкретную запись журнала (не обязательно последнюю)
app.post('/api/activity/:id/undo', auth.requirePerm('canManageActivity'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Некорректный id записи журнала' });
  try {
    const result = db.undoActivityById(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/activity/:id — удалить одну запись журнала (не отменяя само действие)
app.delete('/api/activity/:id', auth.requirePerm('canManageActivity'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Некорректный id записи журнала' });
  try {
    const result = db.deleteActivityEntry(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/activity — полностью очистить журнал изменений
app.delete('/api/activity', auth.requirePerm('canManageActivity'), (req, res) => {
  try {
    const result = db.clearActivity();
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
app.post('/api/import', auth.requirePerm('canImportData'), upload.single('file'), (req, res) => {
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

// POST /api/export/reco — выгрузка таблицы «Рекомендация пикинга» в .xlsx.
// Ранжирование считается на клиенте (зависит от текущих поиска/фильтров на
// экране), поэтому сюда приходят уже готовые строки — сервер только льёт их
// в .xlsx тем же способом, что и обычный /api/export.
app.post('/api/export/reco', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'rows is required' });
  try {
    const sheetRows = rows.map(r => ({
      '№ (порядок размещения)': r.rank,
      'Артикул': r.article,
      'Наименование': r.name,
      'Материал': r.material,
      'Объём/вес ед.': r.vol != null ? r.vol + ' л/кг' : '',
      'Остаток всего, шт': r.qty,
      'Доля объёма стока': (typeof r.volShare === 'number' ? r.volShare.toFixed(1) : r.volShare) + '%',
      'ABC': r.abcClass,
      'Пикинг-адрес (ярус 1)': r.pickAddress || '',
      'Пополнение (резерв)': r.replenish || ''
    }));
    const ws = XLSX.utils.json_to_sheet(sheetRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Рекомендация пикинга');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const encodedName = encodeURIComponent('рекомендация_пикинга.xlsx');
    res.setHeader('Content-Disposition', `attachment; filename="picking-recommendation.xlsx"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ---------- Авторизация ----------

// POST /api/auth/login — вход по логину/паролю
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  const user = db.getUserByUsername(username);
  if (!user || user.disabled || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = auth.newToken();
  db.createSession(token, user.id);
  auth.setSessionCookie(res, token);
  res.json({ ok: true, user: auth.publicUser(user) });
});

// POST /api/auth/register — подать заявку на регистрацию (аккаунт создаётся
// только после того, как её кто-то одобрит — см. /api/registration-requests)
app.post('/api/auth/register', (req, res) => {
  const { username, displayName, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  const pwErr = auth.validatePasswordStrength(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    db.createRegistrationRequest({ username, displayName, passwordHash: auth.hashPassword(password) });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/logout — выход (только текущая сессия)
app.post('/api/auth/logout', (req, res) => {
  if (req.sessionToken) db.deleteSession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — кто я сейчас (для восстановления сессии на фронте)
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Не авторизован' });
  res.json({ user: auth.publicUser(req.user) });
});

// POST /api/auth/change-password — сменить собственный пароль
app.post('/api/auth/change-password', auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!auth.verifyPassword(currentPassword || '', req.user.password_hash)) {
    return res.status(401).json({ error: 'Текущий пароль неверен' });
  }
  const err = auth.validatePasswordStrength(newPassword);
  if (err) return res.status(400).json({ error: err });
  db.setUserPasswordHash(req.user.id, auth.hashPassword(newPassword));
  res.json({ ok: true });
});

// ---------- Аватарки пользователей ----------
// Храним не в базе, а обычными файлами в public/avatars/ — так их отдаёт
// express.static() бесплатно, без отдельного роута на скачивание.
// Сама обрезка/сжатие картинки до маленького квадрата делается в браузере
// (canvas, см. public/auth.js) ДО отправки на сервер — так на сервер в
// принципе не попадают тяжёлые исходники и не нужна нативная библиотека
// обработки изображений (sharp/jimp и т.п.) с её лишним весом и рисками
// при установке. Лимит здесь — просто подстраховка на случай, если запрос
// придёт не из нашего фронтенда.
const AVATARS_DIR = path.join(__dirname, 'public', 'avatars');
fs.mkdirSync(AVATARS_DIR, { recursive: true });
const AVATAR_MAX_BYTES = 1 * 1024 * 1024; // 1 МБ — с запасом; готовая аватарка с клиента обычно 15–40 КБ
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
      return cb(new Error('Разрешены только JPEG, PNG или WebP'));
    }
    cb(null, true);
  }
});

function extForMime(mimetype) {
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/webp') return 'webp';
  return 'jpg';
}

function deleteAvatarFile(avatarPath) {
  if (!avatarPath) return;
  const full = path.join(__dirname, 'public', avatarPath);
  // На всякий случай не даём выйти за пределы папки avatars/, даже если
  // значение в БД когда-нибудь окажется странным.
  if (!full.startsWith(AVATARS_DIR)) return;
  fs.unlink(full, () => {}); // не критично, если файла уже нет
}

// POST /api/profile/avatar — загрузить/заменить свою аватарку
app.post('/api/profile/avatar', auth.requireAuth, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

    const oldPath = req.user.avatar_path;
    const filename = `${req.user.id}-${crypto.randomBytes(6).toString('hex')}.${extForMime(req.file.mimetype)}`;
    const relPath = `avatars/${filename}`;
    fs.writeFileSync(path.join(AVATARS_DIR, filename), req.file.buffer);

    const updated = db.setUserAvatar(req.user.id, relPath);
    deleteAvatarFile(oldPath); // старую подчищаем уже после успешной записи новой

    res.json({ user: auth.publicUser(updated) });
  });
});

// DELETE /api/profile/avatar — вернуться к аватарке по умолчанию (инициалы)
app.delete('/api/profile/avatar', auth.requireAuth, (req, res) => {
  const oldPath = req.user.avatar_path;
  const updated = db.setUserAvatar(req.user.id, null);
  deleteAvatarFile(oldPath);
  res.json({ user: auth.publicUser(updated) });
});

// ---------- Управление пользователями (сервисный аккаунт / начальник) ----------

// GET /api/users — список аккаунтов
// GET /api/users/directory — упрощённый список коллег и их ролей, доступный
// любому вошедшему сотруднику (в отличие от /api/users — там ещё и данные
// для управления аккаунтами, это только для canManageUsers).
app.get('/api/users/directory', auth.requireAuth, (req, res) => {
  res.json({
    users: db.listUsers()
      .filter(u => !u.disabled)
      .map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name || u.username,
        role: u.role,
        roleLabel: auth.labelFor(u.role),
        avatarUrl: u.avatar_path ? `/${u.avatar_path}` : null
      }))
  });
});

app.get('/api/users', auth.requirePerm('canManageUsers'), (req, res) => {
  res.json({
    users: db.listUsers().map(u => ({
      ...u,
      roleLabel: auth.labelFor(u.role),
      avatarUrl: u.avatar_path ? `/${u.avatar_path}` : null
    }))
  });
});

// POST /api/users/reorder — сохранить порядок пользователей в списке
// (перемещение стрелками вверх/вниз в панели «Пользователи и роли»).
// Принимает полный список id в новом порядке.
app.post('/api/users/reorder', auth.requirePerm('canManageUsers'), (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'поле "order" должно быть массивом id' });
  try {
    const users = db.reorderUsers(order);
    res.json({ users: users.map(u => ({ ...u, roleLabel: auth.labelFor(u.role), avatarUrl: u.avatar_path ? `/${u.avatar_path}` : null })) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/users — создать аккаунт
app.post('/api/users', auth.requirePerm('canManageUsers'), (req, res) => {
  const { username, displayName, password, role } = req.body || {};
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'обязательны поля "username", "password", "role"' });
  }
  if (role === 'service') {
    return res.status(400).json({ error: 'Создать ещё один сервисный аккаунт нельзя — он один на систему' });
  }
  if (!db.roleExists(role)) return res.status(400).json({ error: 'Некорректная роль' });
  const pwErr = auth.validatePasswordStrength(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    const created = db.insertUser({
      username, displayName, role,
      passwordHash: auth.hashPassword(password),
      createdBy: req.user.username
    });
    res.status(201).json({ user: auth.publicUser(created) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/users/:id — изменить роль/блокировку и/или логин с именем.
// Роль и блокировку может менять только тот, у кого есть canManageUsers.
// А вот логин и отображаемое имя разрешено менять ещё и самому себе —
// даже без права управления аккаунтами, чтобы любой сотрудник мог
// поправить своё имя или логин, не обращаясь к начальнику.
app.patch('/api/users/:id', auth.requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { role, disabled, username, displayName } = req.body || {};
  const isSelf = req.user.id === id;
  const canManage = auth.permsFor(req.user.role).canManageUsers;

  if ((role !== undefined || disabled !== undefined) && !canManage) {
    return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
  }
  if ((username !== undefined || displayName !== undefined) && !canManage && !isSelf) {
    return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
  }

  try {
    let updated;
    if (role !== undefined) updated = db.updateUserRole(id, role);
    if (disabled !== undefined) updated = db.setUserDisabled(id, !!disabled);
    if (username !== undefined || displayName !== undefined) {
      updated = db.updateUserIdentity(id, { username, displayName });
    }
    if (!updated) updated = db.getUserById(id);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json({ user: auth.publicUser(updated) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/users/:id/reset-password — сбросить пароль сотрудника
app.post('/api/users/:id/reset-password', auth.requirePerm('canManageUsers'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { password } = req.body || {};
  const pwErr = auth.validatePasswordStrength(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    db.setUserPasswordHash(id, auth.hashPassword(password));
    db.deleteAllSessionsForUser(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/users/:id — удалить аккаунт (кроме сервисного и себя самого)
app.delete('/api/users/:id', auth.requirePerm('canManageUsers'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить собственный аккаунт' });
  try {
    db.deleteUser(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Управление ролями (сервисный аккаунт / начальник) ----------
// Роли хранятся в базе, а не в коде: можно добавлять свои, менять набор
// прав и переименовывать любую роль, включая встроенные и даже "Сервисный
// аккаунт" (её права при этом всё равно неприкосновенны — см. db.js).

// GET /api/roles — список ролей с правами
app.get('/api/roles', auth.requirePerm('canManageUsers'), (req, res) => {
  res.json({ roles: db.listRoles() });
});

// POST /api/roles — создать новую роль
app.post('/api/roles', auth.requirePerm('canManageUsers'), (req, res) => {
  const { key, label, perms } = req.body || {};
  if (!label) return res.status(400).json({ error: 'Укажите название роли' });
  try {
    const role = db.createRole({ key, label, perms });
    res.status(201).json({ role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/roles/:key — переименовать роль и/или изменить её права
app.patch('/api/roles/:key', auth.requirePerm('canManageUsers'), (req, res) => {
  const { label, perms } = req.body || {};
  try {
    let role;
    if (label !== undefined) role = db.renameRole(req.params.key, label);
    if (perms !== undefined) role = db.updateRolePerms(req.params.key, perms);
    if (!role) role = db.getRole(req.params.key);
    if (!role) return res.status(404).json({ error: 'Роль не найдена' });
    res.json({ role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/roles/:key — удалить роль (нельзя удалить системную или ту,
// что ещё назначена хотя бы одному пользователю)
app.delete('/api/roles/:key', auth.requirePerm('canManageUsers'), (req, res) => {
  try {
    db.deleteRole(req.params.key);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Заявки на регистрацию (одобряют/отклоняют те, кто может управлять аккаунтами) ----------

// GET /api/registration-requests/count — лёгкий счётчик для бейджа
app.get('/api/registration-requests/count', auth.requirePerm('canManageUsers'), (req, res) => {
  res.json({ count: db.countRegistrationRequests() });
});

// GET /api/registration-requests — список заявок, ожидающих решения
app.get('/api/registration-requests', auth.requirePerm('canManageUsers'), (req, res) => {
  res.json({ requests: db.listRegistrationRequests() });
});

// POST /api/registration-requests/:id/approve — одобрить и создать аккаунт
app.post('/api/registration-requests/:id/approve', auth.requirePerm('canManageUsers'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const role = (req.body && req.body.role) || 'employee';
  if (role === 'service') return res.status(400).json({ error: 'Сервисную роль назначить нельзя' });
  if (!db.roleExists(role)) return res.status(400).json({ error: 'Некорректная роль' });
  try {
    const user = db.approveRegistrationRequest(id, role, req.user.username);
    res.json({ user: auth.publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/registration-requests/:id/reject — отклонить без создания аккаунта
app.post('/api/registration-requests/:id/reject', auth.requirePerm('canManageUsers'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    db.rejectRegistrationRequest(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Задания сотрудникам ----------
// Ставить задания и видеть прогресс по всей команде могут роли с правом
// canManageTasks (по умолчанию — завсклад и выше). Любой сотрудник видит и
// ведёт только свои собственные задания через тот же GET /api/tasks —
// сервер сам решает, что вернуть, по правам текущего пользователя.

// GET /api/tasks/unread-count — лёгкий счётчик для бейджа на вкладке; в
// отличие от GET /api/tasks НЕ помечает задания прочитанными.
app.get('/api/tasks/unread-count', (req, res) => {
  res.json({ count: db.countMyNewTasks(req.user.id) });
});

// GET /api/tasks — мои задания всегда; плюс полный список с прогрессом,
// если есть право ставить задания. Обращение к списку автоматически
// помечает мои "новые" задания как прочитанные.
app.get('/api/tasks', (req, res) => {
  db.markMyNewTasksRead(req.user.id);
  const canManage = !!auth.permsFor(req.user.role).canManageTasks;
  const payload = { canManage, myTasks: db.listMyTasks(req.user.id) };
  if (canManage) payload.allTasks = db.listAllTasks();
  res.json(payload);
});

// GET /api/tasks/assignable-users — список сотрудников для выбора получателей
app.get('/api/tasks/assignable-users', auth.requirePerm('canManageTasks'), (req, res) => {
  res.json({
    users: db.listAssignableUsers().map(u => ({
      id: u.id, username: u.username, displayName: u.display_name || u.username,
      role: u.role, roleLabel: auth.labelFor(u.role),
      avatarUrl: u.avatar_path ? `/${u.avatar_path}` : null
    }))
  });
});

// POST /api/tasks — создать задание и разослать выбранным сотрудникам
app.post('/api/tasks', auth.requirePerm('canManageTasks'), (req, res) => {
  const { text, userIds } = req.body || {};
  try {
    const task = db.createTask({
      text, userIds,
      createdById: req.user.id,
      createdByName: `${req.user.display_name || req.user.username}`
    });
    res.status(201).json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/tasks/:id/status — сотрудник двигает статус СВОЕГО задания
// вперёд: read → in_progress → done ("В работу" / "Сделано" на фронте).
app.patch('/api/tasks/:id/status', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const { status } = req.body || {};
  try {
    const task = db.setMyTaskStatus(id, req.user.id, status);
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/tasks/:id — удалить задание целиком (только тот, кто вправе их ставить)
app.delete('/api/tasks/:id', auth.requirePerm('canManageTasks'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    db.deleteTask(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
