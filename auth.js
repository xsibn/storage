// auth.js — авторизация и роли. Пароли хэшируются встроенным crypto.scrypt
// (без внешних зависимостей), сессии — случайные токены, хранятся в SQLite
// и передаются httpOnly-cookie. Всё синхронно с остальным db.js — никаких
// новых npm-пакетов ставить не нужно.

const crypto = require('crypto');
const db = require('./db');

const COOKIE_NAME = 'wh_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// ---------- пароли ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function validatePasswordStrength(password) {
  if (!password || String(password).length < 6) {
    return 'Пароль должен быть не короче 6 символов';
  }
  return null;
}

// ---------- cookies (без cookie-parser — простой ручной парсинг/установка) ----------
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// ---------- права по ролям ----------
// Роли и их права больше не зашиты здесь — они хранятся в таблице `roles`
// (см. db.js) и настраиваются через /api/roles или cli.js. Права, которые
// реально на что-то влияют в этом приложении:
//   canManageUsers      — создавать/редактировать/удалять аккаунты и роли
//   canManageActivity    — очищать журнал и отменять чужие/старые действия
//   canReadActivity      — видеть журнал (хотя бы для чтения)
//   canManageTasks       — ставить задания сотрудникам (создавать/удалять,
//                          видеть прогресс по всей команде)
//   canImportData        — загружать новый .xlsx, полностью заменяя сток
const EMPTY_PERMS = { canManageUsers: false, canManageActivity: false, canReadActivity: false, canManageTasks: false, canImportData: false };

function permsFor(roleKey) {
  const role = db.getRole(roleKey);
  return role ? role.perms : EMPTY_PERMS;
}

function labelFor(roleKey) {
  const role = db.getRole(roleKey);
  return role ? role.label : roleKey;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    roleLabel: labelFor(u.role),
    perms: permsFor(u.role),
    createdAt: u.created_at,
    avatarUrl: u.avatar_path ? `/${u.avatar_path}` : null
  };
}

// ---------- middleware ----------
// Прикрепляет req.user (или null) и db.setCurrentActor(...) для подписи
// журнала. Не блокирует запрос — блокировку делает requireAuth ниже.
function attachUser(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  const user = token ? db.getSession(token) : null;
  req.user = user || null;
  req.sessionToken = token || null;
  db.setCurrentActor(user ? `${user.display_name || user.username} · ${labelFor(user.role)}` : null);
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
  next();
}

function requirePerm(permName) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
    if (!permsFor(req.user.role)[permName]) {
      return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
    }
    next();
  };
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_MS,
  hashPassword, verifyPassword, validatePasswordStrength,
  parseCookies, setSessionCookie, clearSessionCookie,
  permsFor, labelFor, publicUser,
  attachUser, requireAuth, requirePerm, newToken
};
