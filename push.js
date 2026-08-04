// push.js — отправка веб-пушей (Web Push API) через VAPID.
//
// Работает и на Android (Chrome/любой Chromium-браузер, установленный как
// PWA), и на iPhone (Safari, только когда сайт добавлен на экран "Домой" —
// это ограничение самой Apple, обойти его нельзя, только объяснить
// пользователю). Протокол один и тот же для всех платформ — VAPID +
// Web Push, никаких Firebase/APNs ключей заводить не нужно.
//
// VAPID-ключи генерируются один раз при первом запуске и сохраняются в
// data/vapid.json — тот же файл живёт рядом с базой данных и переживает
// перезапуски. Если файл удалить, ключи перегенерируются, но тогда все
// существующие подписки браузеров станут недействительными (это нормально
// для Web Push — просто пользователям придётся заново включить
// уведомления).

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

let vapidKeys;
if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
}

const CONTACT = process.env.VAPID_CONTACT_EMAIL || 'admin@example.com';
webpush.setVapidDetails(`mailto:${CONTACT}`, vapidKeys.publicKey, vapidKeys.privateKey);

function getPublicKey() {
  return vapidKeys.publicKey;
}

// Разослать один и тот же пуш набору подписок (могут принадлежать разным
// пользователям — вызывающий код сам решает, кому). Мёртвые подписки (410
// Gone / 404 Not Found — пользователь удалил приложение, отключил
// уведомления в ОС, и т.п.) автоматически подчищаются из базы через
// переданный onGone-колбэк, чтобы они не копились годами.
async function sendToSubscriptions(subs, payload, onGone) {
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (row) => {
    const pushSub = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth }
    };
    try {
      await webpush.sendNotification(pushSub, body);
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        if (onGone) onGone(row.endpoint);
      } else {
        console.error('push: не удалось отправить уведомление:', err && err.message);
      }
    }
  }));
}

module.exports = { getPublicKey, sendToSubscriptions, vapidKeys };
