/* Royal Creek — Service Worker รับแจ้งเตือน Web Push */
self.addEventListener('push', function(e) {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch(_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Royal Creek', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window' }).then(function(list) {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
