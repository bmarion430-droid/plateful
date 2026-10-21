// Plateful service worker.
// - App shell: cached at install, refreshed on each deploy (BUILD changes).
// - Nutrition data (/data/<version>/...): cache-first. Files are immutable per version,
//   so a barcode shard downloaded once is instant and works offline afterwards.
// - /api/*: always network.
const BUILD = "__BUILD__";
const DATA = "__DATA__";
const SHELL = "plateful-shell-" + BUILD;
const DATAC = "plateful-data-" + DATA;
const FONTS = "plateful-fonts";
const SHELL_FILES = ["/", "/app.js?v=" + BUILD, "/coach.js?v=" + BUILD, "/vendor/zxing.min.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(SHELL_FILES);
    if (DATA !== "none") {
      // Pre-load the food search list so search works offline from the first launch.
      try { await (await caches.open(DATAC)).add("/data/" + DATA + "/foods.json"); } catch {}
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, DATAC, FONTS]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const c = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 3500))]);
    if (res.ok) c.put("/", res.clone());
    return res;
  } catch {
    return (await c.match("/")) || Response.error();
  }
}

async function staleWhileRevalidate(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  const net = fetch(req).then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/api/")) return;
    if (url.pathname.startsWith("/data/")) return e.respondWith(cacheFirst(req, DATAC));
    if (req.mode === "navigate") return e.respondWith(networkFirst(req));
    return e.respondWith(cacheFirst(req, SHELL));
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    return e.respondWith(staleWhileRevalidate(req, FONTS));
  }
});
