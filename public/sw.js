// 새 버전을 먼저 받아오고, 인터넷이 안 될 때만 저장해 둔 화면을 보여줘요.
const CACHE = "fridge-v8";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("./")))
  );
});

// 앱을 닫아도 오는 알림: 신호를 받으면 서버에 오늘 내용을 물어보고 보여줘요.
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let msg = null;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch("/api/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        msg = await r.json();
      }
    } catch (err) {}
    const title = (msg && msg.title) || "🧊 냉장고 알리미";
    const body = (msg && msg.body) || "유통기한이 가까운 음식이 있어요. 눌러서 확인해 보세요.";
    await self.registration.showNotification(title, {
      body, icon: "icon-192.png", tag: "fridge-daily", renotify: true, data: { url: "./" },
    });
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ("focus" in w) return w.focus();
    return clients.openWindow("./");
  }));
});
