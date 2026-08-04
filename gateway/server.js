// gateway/server.js — единая точка входа: один Node-процесс, один порт,
// один домен. Склад отдаётся из корня, «Учёт времени» смонтирован под /time.
//
// Технически это не переписывание обоих серверов в один файл, а монтирование
// двух уже готовых Express-приложений друг в друга: storage/server.js и
// timetracker/server.js экспортируют себя как обычные app'ы (см. в конце тех
// файлов module.exports = app), и здесь мы просто собираем их в одно дерево
// маршрутов. Cookie сессии `wh_session` ставится складом с Path=/, поэтому
// она автоматически видна и под /time — второй вход не нужен.
//
// Порядок app.use() важен: сначала /time (более специфичный путь), потом
// корень склада — у склада есть catch-all `app.get('*', ...)`, который
// перехватил бы вообще все запросы, если бы шёл первым.

const express = require('express');

// «Учёт времени» сам строит ссылку "← Портал" через GET /api/config
// (portalUrl). При таком монтировании портал — это просто корень домена.
if (!process.env.PORTAL_URL) process.env.PORTAL_URL = '/';

const storageApp = require('../storage/server');
const timetrackerApp = require('../timetracker/server');

const app = express();

app.use('/time', timetrackerApp);
app.use('/', storageApp);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('================================================================');
  console.log(` Портал запущен: http://localhost:${PORT}/`);
  console.log(`   Склад:         http://localhost:${PORT}/`);
  console.log(`   Учёт времени:  http://localhost:${PORT}/time/`);
  console.log('================================================================');
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
  process.exit(1);
});
