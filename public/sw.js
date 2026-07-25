// sw.js — минимальный service worker.
// Единственная цель этого файла — выполнить формальное требование Chrome/
// Яндекс.Браузера для показа "Установить приложение" (наличие
// зарегистрированного service worker с обработчиком fetch). Никакого
// офлайн-кэширования данных склада тут нарочно нет: сток должен всегда
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
