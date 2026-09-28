// Service worker: makes the app installable/offline, and receives items shared from Android's share sheet.
const SHELL = 'readout-shell-v1';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('readout-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(networkFirst(e.request));
});

// Network first so updates show up right away, with the cache as the offline fallback.
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
    return res;
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) || caches.match('index.html');
  }
}

async function handleShare(req) {
  const form = await req.formData();
  const cache = await caches.open('share-inbox');
  let n = 0;
  const key = () => `share-inbox/${Date.now()}-${n++}`;
  const text = form.get('text') || form.get('title') || '';
  if (String(text).trim()) {
    await cache.put(key(), new Response(text, { headers: { 'x-kind': 'text' } }));
  }
  for (const f of form.getAll('files')) {
    if (f && f.size) {
      await cache.put(key(), new Response(f, {
        headers: { 'x-kind': 'file', 'x-name': encodeURIComponent(f.name || 'shared'), 'content-type': f.type || 'application/octet-stream' },
      }));
    }
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}
