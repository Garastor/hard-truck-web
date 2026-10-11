/*
 * Service worker: офлайн-режим для коду гри (не для файлів гри — вони в IndexedDB).
 * Під час збирання (vite.config.ts, precacheManifest) сюди вписуються версія й список усіх файлів збірки:
 * при встановленні кешуються всі одразу — гра працює офлайн після першого ж відкриття.
 * Нова версія не підміняє стару сама: чекає, доки гравець натисне «Оновити» (повідомлення 'skipWaiting').
 * Працює лише в захищеному контексті (HTTPS або localhost).
 */
const VERSION = '__VERSION__';
const PRECACHE = [/* PRECACHE */];
const PREFIX = 'hard-truck-';
const CACHE = PREFIX + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload' — повз HTTP-кеш браузера, щоб не закешувати старі файли під новою версією.
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      // Перше встановлення — одразу; оновлення — лише за згодою гравця.
      .then(() => (self.registration.active ? undefined : self.skipWaiting())),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/game/')) return;
  // Сторінка (з будь-якими параметрами адреси) — з кешу цієї версії; без кешу — з мережі.
  // ignoreVary: сервер може віддати `Vary: Origin`, а динамічний import() модуля надсилає Origin — без цього
  // закешований модуль (код режиму їзди) не знаходився, і офлайн заїзд не запускався.
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(key, { ignoreSearch: req.mode === 'navigate', ignoreVary: true }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && req.mode !== 'navigate') c.put(req, res.clone());
            return res;
          }),
      ),
    ),
  );
});
