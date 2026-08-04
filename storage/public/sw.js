// sw.js — service worker: формальное требование для "Установить приложение"
// (Chrome/Яндекс.Браузер) + обработка push-уведомлений (задания и чаты).
// Офлайн-кэширования данных склада тут нарочно нет: сток должен всегда
// приходить свежим прямо с сервера, а не отдаваться из кэша браузера.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

// ---------- Push-уведомления ----------
// Сервер шлёт JSON вида { title, body, tag, url }. tag группирует
// уведомления одного задания/чата, чтобы не заваливать человека десятком
// отдельных карточек, если он давно не открывал приложение.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Склад';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Клик по уведомлению — открыть (или сфокусировать) вкладку приложения на
// нужном разделе.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        client.focus();
        if ('navigate' in client) client.navigate(url).catch(() => {});
        return;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
