/* RefBoard: guarda o app no iPad para abrir sem internet. */
const VERSION = 'refboard-v1';
const FILES = [
  './', './index.html', './style.css', './app.js', './pur.js', './pur-worker.js', './manifest.webmanifest',
  './vendor/sql-wasm.js', './vendor/sql-wasm.wasm', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const heavy = /\/(vendor|icons)\//.test(req.url);
  if (heavy) {
    // bibliotecas e ícones não mudam: usa a cópia guardada
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return r;
    })));
    return;
  }
  // página e código: tenta a versão nova e cai na guardada se estiver sem internet
  e.respondWith(fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return r;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))));
});
