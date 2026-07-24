#!/usr/bin/env node
// cli.js — управление пользователями из консоли, без веб-интерфейса.
// Работает напрямую с той же базой (data/warehouse.db), что и сервер, так
// что сервер можно не останавливать — better-sqlite3 в WAL-режиме спокойно
// переживает параллельный доступ.
//
// Примеры:
//   node cli.js list
//   node cli.js create ivanov "S3cret!" boss "Иванов И.И."
//   node cli.js set-role ivanov warehouse_manager
//   node cli.js set-password ivanov "NewPass123"
//   node cli.js disable ivanov
//   node cli.js enable ivanov
//   node cli.js delete ivanov
//
// Роли: service (один на систему, создаётся автоматически), boss (начальник),
// warehouse_manager (завсклад), employee (сотрудник).

const db = require('./db');
const auth = require('./auth');

const ROLE_LABELS = auth.ROLE_LABELS;
const CREATABLE_ROLES = ['boss', 'warehouse_manager', 'employee'];

function printUsage() {
  console.log(`
Использование: node cli.js <команда> [аргументы]

  list                                          — список всех аккаунтов
  create <логин> <пароль> <роль> [имя]          — создать аккаунт
  set-role <логин> <роль>                       — изменить роль
  set-password <логин> <новый_пароль>           — сменить пароль
  disable <логин>                               — заблокировать аккаунт
  enable <логин>                                — разблокировать аккаунт
  delete <логин>                                — удалить аккаунт

Роли: ${CREATABLE_ROLES.join(', ')}  (service — единственный, создаётся автоматически при первом запуске сервера)
`);
}

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

function printUsersTable(users) {
  if (!users.length) { console.log('Пользователей пока нет.'); return; }
  const rows = users.map(u => ({
    id: u.id,
    login: u.username,
    имя: u.display_name || '',
    роль: ROLE_LABELS[u.role] || u.role,
    статус: u.disabled ? 'заблокирован' : 'активен',
    создан: u.created_at
  }));
  console.table(rows);
}

function main() {
  const [, , cmd, ...args] = process.argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    return;
  }

  switch (cmd) {
    case 'list': {
      printUsersTable(db.listUsers());
      break;
    }

    case 'create': {
      const [username, password, role, ...nameParts] = args;
      if (!username || !password || !role) {
        fail('нужно: create <логин> <пароль> <роль> [имя]\nРоли: ' + CREATABLE_ROLES.join(', '));
      }
      if (!CREATABLE_ROLES.includes(role)) {
        fail(`недопустимая роль "${role}". Доступно: ${CREATABLE_ROLES.join(', ')}`);
      }
      const pwErr = auth.validatePasswordStrength(password);
      if (pwErr) fail(pwErr);
      const displayName = nameParts.join(' ') || username;
      try {
        const user = db.insertUser({
          username, displayName, role,
          passwordHash: auth.hashPassword(password),
          createdBy: 'cli'
        });
        console.log(`Создан пользователь: ${user.username} (${ROLE_LABELS[user.role]})`);
      } catch (err) {
        fail(err.message);
      }
      break;
    }

    case 'set-role': {
      const [username, role] = args;
      if (!username || !role) fail('нужно: set-role <логин> <роль>');
      const user = db.getUserByUsername(username);
      if (!user) fail(`пользователь "${username}" не найден`);
      try {
        db.updateUserRole(user.id, role);
        console.log(`Роль пользователя ${username} изменена на: ${ROLE_LABELS[role] || role}`);
      } catch (err) {
        fail(err.message);
      }
      break;
    }

    case 'set-password': {
      const [username, password] = args;
      if (!username || !password) fail('нужно: set-password <логин> <новый_пароль>');
      const user = db.getUserByUsername(username);
      if (!user) fail(`пользователь "${username}" не найден`);
      const pwErr = auth.validatePasswordStrength(password);
      if (pwErr) fail(pwErr);
      db.setUserPasswordHash(user.id, auth.hashPassword(password));
      db.deleteAllSessionsForUser(user.id);
      console.log(`Пароль пользователя ${username} обновлён (все его сессии сброшены).`);
      break;
    }

    case 'disable':
    case 'enable': {
      const [username] = args;
      if (!username) fail(`нужно: ${cmd} <логин>`);
      const user = db.getUserByUsername(username);
      if (!user) fail(`пользователь "${username}" не найден`);
      try {
        db.setUserDisabled(user.id, cmd === 'disable');
        console.log(`Пользователь ${username} ${cmd === 'disable' ? 'заблокирован' : 'разблокирован'}.`);
      } catch (err) {
        fail(err.message);
      }
      break;
    }

    case 'delete': {
      const [username] = args;
      if (!username) fail('нужно: delete <логин>');
      const user = db.getUserByUsername(username);
      if (!user) fail(`пользователь "${username}" не найден`);
      try {
        db.deleteUser(user.id);
        console.log(`Пользователь ${username} удалён.`);
      } catch (err) {
        fail(err.message);
      }
      break;
    }

    default:
      console.error(`Неизвестная команда: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

main();
