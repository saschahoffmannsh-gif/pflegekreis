/* Pflegekreis Service Worker: Push + einfacher Offline-Cache (App-Shell) */
const CACHE = "pf-1793564947";
// Notfallkarte offline: PDF-Bausteine liegen mit im Cache
const SHELL = ["./", "app.css?v=1793564947", "app.js?v=1793564947", "fonts/inter-var.woff2", "demo.js?v=1793564947", "config.js?v=1793564947", "vendor/supabase.js", "icons/logo.svg?v=2", "icons/spoo-mark.webp?v=s2", "icons/spoo-word.webp?v=s2", "icons/icon-192.png?v=2", "manifest.webmanifest", "pdf.js?v=1793564947", "partners.js?v=1793564947", "vendor/jspdf.umd.min.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // Supabase-Aufrufe nie cachen
  // Network-first, damit Updates sofort ankommen; offline aus dem Cache
  // Seitenaufruf (index.html) immer beim Server nachfragen, nie aus dem Browser-HTTP-Cache – sonst lädt ein alter Stand alte Skripte
  const req = e.request.mode === "navigate" ? fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(e.request);
  e.respondWith(req.then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match(new URL("./", self.registration.scope).href))));
});
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: "Pflegekreis", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Pflegekreis", {
    body: d.body || "", icon: new URL("icons/icon-192.png?v=2", self.registration.scope).href, badge: new URL("icons/badge-96.png?v=2", self.registration.scope).href,
    tag: d.tag, renotify: !!d.tag, data: { url: d.url || "" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope)) { c.postMessage({ type: "open", url }); return c.focus(); }
    const u = new URL(url); u.searchParams.set("pf_push", "1"); // frischer Start aus Push: ohne Ladebildschirm direkt zum Ziel
    return self.clients.openWindow(u.href);
  }));
});
