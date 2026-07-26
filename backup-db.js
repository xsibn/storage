// backup-db.js — лёгкий бэкап базы без лишнего места на диске.
//
// Что делает:
//   1. Безопасно снимает копию базы (через встроенный .backup() —
//      корректно работает даже пока сервер пишет в базу, включая WAL).
//   2. Сразу сжимает её gzip'ом (SQLite обычно жмётся в 5-10 раз) и
//      удаляет несжатую копию — на диске остаётся только маленький .gz.
//   3. Хранит только последние BACKUP_KEEP файлов (по умолчанию 7) —
//      старые удаляются автоматически, место не растёт бесконечно.
//   4. Если задана переменная BACKUP_REMOTE (например,
//      user@host:/path/ или бакет через rclone-remote:path/), после
//      успешного сжатия копия отправляется туда, и локально можно
//      держать совсем мало копий (см. BACKUP_KEEP_LOCAL ниже).
//
// Запуск вручную:
//   node backup-db.js
//
// Через cron (например, каждую ночь в 03:15):
//   15 3 * * * cd /path/to/project && /usr/bin/node backup-db.js >> data/backup.log 2>&1
//
// Настройка через переменные окружения (необязательно):
//   BACKUP_DIR         — куда класть бэкапы (по умолчанию ./data/backups)
//   BACKUP_KEEP         — сколько последних копий хранить локально (по умолчанию 7)
//   BACKUP_REMOTE       — если задано, копия дополнительно отправляется
//                         через rsync (формат user@host:/path/ или локальный путь
//                         на смонтированный внешний диск/сетевую папку)

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'warehouse.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 7;
const REMOTE = process.env.BACKUP_REMOTE || null;
const FILE_RE = /^warehouse-\d{8}-\d{4}\.db\.gz$/;

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Снимает свежий бэкап и возвращает информацию о созданном файле. Используется
// и из cron/CLI (см. main() ниже), и из веб-API (см. server.js) — единая
// логика в одном месте, чтобы бэкап через сайт ничем не отличался от бэкапа
// по расписанию.
async function createBackup() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`База не найдена: ${DB_PATH}`);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const rawTmpPath = path.join(BACKUP_DIR, `.tmp-${ts()}-${process.pid}.db`);
  const gzPath = path.join(BACKUP_DIR, `warehouse-${ts()}.db.gz`);

  // .backup() — официальный безопасный способ снять копию живой SQLite-базы
  // (использует SQLite Online Backup API, не просто копирует файл байт в
  // байт — так не бывает повреждённой копии, даже если в это время идёт
  // запись, и WAL-режим не проблема).
  const db = new Database(DB_PATH, { readonly: true });
  try {
    await db.backup(rawTmpPath);
  } finally {
    db.close();
  }

  // Сжимаем и сразу убираем несжатую версию — на диске должен остаться
  // только маленький .gz.
  await new Promise((resolve, reject) => {
    const src = fs.createReadStream(rawTmpPath);
    const dst = fs.createWriteStream(gzPath);
    const gzip = zlib.createGzip({ level: 9 });
    src.pipe(gzip).pipe(dst).on('finish', resolve).on('error', reject);
  });
  fs.unlinkSync(rawTmpPath);

  const sizeBytes = fs.statSync(gzPath).size;

  // Опционально — увезти копию за пределы сервера. rsync есть почти везде
  // из коробки, ставить ничего дополнительно не нужно. Если rsync не найден
  // или отправка не удалась — просто пропускаем этот шаг, локальная копия
  // всё равно остаётся (см. ротацию ниже).
  let remoteError = null;
  if (REMOTE) {
    try {
      execFileSync('rsync', ['-az', gzPath, REMOTE], { stdio: 'ignore' });
    } catch (err) {
      remoteError = err.message;
    }
  }

  // Ротация: держим только последние KEEP файлов, старые — в топку.
  const removed = [];
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => FILE_RE.test(f))
    .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  files.slice(KEEP).forEach(({ f }) => {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    removed.push(f);
  });

  return { file: path.basename(gzPath), sizeBytes, remoteError, removed };
}

// Список существующих бэкапов, самые свежие первыми.
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => FILE_RE.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Проверяет, что имя файла — это ровно один из наших бэкапов (защита от
// path traversal вроде "../../etc/passwd"), и возвращает полный путь.
function resolveBackupPath(file) {
  if (typeof file !== 'string' || !FILE_RE.test(file)) return null;
  const full = path.join(BACKUP_DIR, file);
  if (path.dirname(full) !== BACKUP_DIR) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function deleteBackup(file) {
  const full = resolveBackupPath(file);
  if (!full) throw new Error('Файл бэкапа не найден');
  fs.unlinkSync(full);
}

module.exports = { createBackup, listBackups, resolveBackupPath, deleteBackup, BACKUP_DIR };

// Запуск как самостоятельного скрипта (вручную или через cron) — поведение
// не изменилось, просто теперь опирается на createBackup() выше.
if (require.main === module) {
  createBackup()
    .then(({ file, sizeBytes, remoteError, removed }) => {
      console.log(`[${new Date().toISOString()}] Бэкап готов: ${file} (${(sizeBytes / 1024).toFixed(1)} КБ)`);
      if (REMOTE) {
        if (remoteError) console.error(`Не удалось отправить на ${REMOTE}: ${remoteError} — локальная копия оставлена.`);
        else console.log(`Отправлено на ${REMOTE}`);
      }
      removed.forEach(f => console.log(`Удалена старая копия: ${f}`));
    })
    .catch(err => {
      console.error('Бэкап не удался:', err);
      process.exit(1);
    });
}
