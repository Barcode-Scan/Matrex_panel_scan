// Exists only so the admin dashboards satisfy the "installable as a
// desktop app" checklist some Chrome/Edge versions still apply - not for
// offline support. Every fetch falls through to normal networking
// unchanged (no respondWith, no cache), so this can never serve stale
// content or need an update strategy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
