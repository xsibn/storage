#!/usr/bin/env node
// cli.js — управление пользователями и ролями из консоли, без веб-интерфейса.
// Работает напрямую с той же базой (data/warehouse.db), что и сервер, так
// что сервер можно не останавливать — better-sqlite3 в WAL-режиме спокойно
// переживает параллельный доступ.
//
// Пользователи:
//   node cli.js list
//   node cli.js create ivanov "S3cret!23" boss "Иванов И.И."
//   node cli.js set-role ivanov warehouse_manager
//   node cli.js set-password ivanov "NewPass123"
//   node cli.js disable ivanov
//   node cli.js enable ivanov
//   node cli.js delete ivanov
//
// Роли (можно свои — не только встроенные 4):
//   node cli.js roles
//   node cli.js create-role kladovshik "Кладовщик" --read-activity
//   node cli.js rename-role kladovshik "Старший кладовщик"
//   node cli.js set-role-perms kladovshik --manage-activity --read-activity
//   node cli.js delete-role kladovshik
//
// "service" — системная роль, одна на систему: её нельзя удалить, права
// у неё всегда полные, но название переименовать можно (как и у любой роли).

const db = require('./db');
const auth = require('./auth');

const PERM_FLAGS = [
  { flag: '--manage-users', key: 'canManageUsers' },
  { flag: '--manage-activity', key: 'canManageActivity' },
  { flag: '--read-activity', key: 'canReadActivity' }
];

function printUsage() {
  const roleList = db.listRoles().map(r => `${r.key} (${r.label})`).join(', ');
  console.log(`
Использование: node cli.js <команда> [аргументы]

Пользователи:
  list                                          — список всех аккаунтов
  create <логин> <пароль> <роль> [имя]          — создать аккаунт
  set-role <логин> <роль>                       — изменить роль
  set-password <логин> <новый_пароль>           — сменить пароль
  disable <логин>                               — заблокировать аккаунт
  enable <логин>                                — разблокировать аккаунт
  delete <логин>                                — удалить аккаунт

Роли:
  roles                                         — список ролей и их прав
  create-role <ключ> <название> [флаги прав]    — создать новую роль
  rename-role <ключ> <новое название>           — переименовать любую роль
  set-role-perms <ключ> [флаги прав]            — задать права роли (перезаписывает все три)
  delete-role <ключ>                            — удалить роль (если она никому не назначена)

  Флаги прав (можно указывать несколько, порядок не важен):
    --manage-users     — управлять аккаунтами и ролями
    --manage-activity  — очищать журнал и отменять действия
    --read-activity    — видеть журнал (только чтение)
  Ни один флаг не указан = роль без этих прав (но доступ к основным функциям склада есть всегда).

Текущие роли: ${roleList}
`);
}

function fail(msg) {
  console.error('Ошибка: ' + msg);
  process.exit(1);
}

function parsePermFlags(args) {
  const perms = { canManageUsers: false, canManageActivity: false, canReadActivity: false };
  const rest = [];
  args.forEach(a => {
    const found = PERM_FLAGS.find(f => f.flag === a);
    if (found) perms[found.key] = true;
    else rest.push(a);
  });
  return { perms, rest };
}

function printUsersTable(users) {
  if (!users.length) { console.log('Пользователей пока нет.'); return; }
  const rows = users.map(u => ({
    id: u.id,
    login: u.username,
    имя: u.display_name || '',
    роль: auth.labelFor(u.role),
    статус: u.disabled ? 'заблокирован' : 'активен',
    создан: u.created_at
  }));
  console.table(rows);
}

function printRolesTable(roles) {
  const rows = roles.map(r => ({
    ключ: r.key,
    название: r.label,
    системная: r.isSystem ? 'да' : '',
    'управление аккаунтами': r.perms.canManageUsers ? '✓' : '',
    'управление журналом': r.perms.canManageActivity ? '✓' : '',
    'чтение журнала': r.perms.canReadActivity ? '✓' : '',
    пользователей: db.listUsers().filter(u => u.role === r.key).length
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
        fail('нужно: create <логин> <пароль> <роль> [имя]\nСписок ролей: node cli.js roles');
      }
      if (role === 'service') fail('создать ещё один сервисный аккаунт нельзя — он один на систему');
      if (!db.roleExists(role)) fail(`роль "${role}" не найдена. Список ролей: node cli.js roles`);
      const pwErr = auth.validatePasswordStrength(password);
      if (pwErr) fail(pwErr);
      const displayName = nameParts.join(' ') || username;
      try {
        const user = db.insertUser({
          username, displayName, role,
          passwordHash: auth.hashPassword(password),
          createdBy: 'cli'
        });
        console.log(`Создан пользователь: ${user.username} (${auth.labelFor(user.role)})`);
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
        console.log(`Роль пользователя ${username} изменена на: ${auth.labelFor(role)}`);
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

    case 'roles': {
      printRolesTable(db.listRoles());
      break;
    }

    case 'create-role': {
      const { perms, rest } = parsePermFlags(args);
      const [key, ...labelParts] = rest;
      const label = labelParts.join(' ');
      if (!key || !label) fail('нужно: create-role <ключ> <название> [флаги прав]');
      try {
        const role = db.createRole({ key, label, perms });
        console.log(`Создана роль: ${role.key} («${role.label}»)`);
      } catch (err) {
        fail(err.message);
      }
      break;
    }

    case 'rename-role': {
      const [key, ...labelParts] = args;
      const label = labelParts.join(' ');
      if (!key || !label) fail('нужно: rename-role <ключ> <новое название>');
      try {
        const role = db.renameRole(key, label);
        console.log(`Роль "${role.key}" переименована в «${role.label}».`);
      } catch (err) {
        fail(err.message);
      }
      break;
    }

    case 'set-role-perms': {
      const { perms, rest } = parsePermFlags(args);
      const [key] = rest;
      if (!key) fail('нужно: set-role-perms <ключ> [флаги прав]');
      try {
        const role = db.updateRolePerms(key, perms);
        console.log(`Права роли "${role.key}" обновлены.`);
        printRolesTable([role]);
      } catch (err) {
        fail(err.message);
      }
      break;
    }

    case 'delete-role': {
      const [key] = args;
      if (!key) fail('нужно: delete-role <ключ>');
      try {
        db.deleteRole(key);
        console.log(`Роль "${key}" удалена.`);
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
