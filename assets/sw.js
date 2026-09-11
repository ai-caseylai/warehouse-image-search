// Image Vector Search — PWA service worker
const CACHE = "ivs-cache-v26";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const p = url.pathname;
  // 頁面殼：網絡優先（確保永遠是最新版），離線先用快取頂住
  if (e.request.mode === "navigate" || SHELL.includes(p)) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // 圖片檔案：快取優先 + 網絡回填
  if (p.startsWith("/files/")) {
    e.respondWith(
      caches.match(e.request).then((c) => {
        if (c) return c;
        return fetch(e.request).then((r) => {
          if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, cp)); }
          return r;
        });
      })
    );
  }
});
