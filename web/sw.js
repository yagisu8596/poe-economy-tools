// Service worker: keeps the app shell available offline and fast.
// Price data always comes from the network (never served stale from here).
const CACHE = "pet-shell-v0.6.2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "lib.js", "api.js", "config.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // API, fonts, icons: network
  // Network first for the shell so updates show up; fall back to cache offline.
  e.respondWith(
    // revalidate with the server so a new release shows up on the next load (GitHub Pages caches ~10 min)
    fetch(e.request.mode === "navigate" ? e.request : new Request(e.request, { cache: "no-cache" }))
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))),
  );
});
