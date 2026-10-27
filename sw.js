const SHELL_CACHE = 'werone-shell-v4';
const ASSET_CACHE = 'werone-assets-v4';
const VALID_CACHES = new Set([SHELL_CACHE, ASSET_CACHE]);

const PRECACHE_ASSETS = [
    './',
    './index.html',
    './backend/config.js',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(SHELL_CACHE).then(cache => {
            return cache.addAll(PRECACHE_ASSETS).catch(() => {});
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.map(key => {
                    if (!VALID_CACHES.has(key)) {
                        return caches.delete(key);
                    }
                })
            )
        ).then(() => self.clients.claim())
    );
});

function isCacheFirstAsset(url) {
    return (
        url.pathname.startsWith('/api/image-proxy') ||
        /\.(png|jpg|jpeg|webp|gif|svg|ico|woff2?)$/i.test(url.pathname) ||
        url.hostname === 'fonts.gstatic.com' ||
        url.hostname === 'fonts.googleapis.com' ||
        url.hostname === 'cdn.jsdelivr.net' ||
        url.hostname === 'cdn.tailwindcss.com' ||
        url.hostname === 'lh3.googleusercontent.com' ||
        url.hostname === 'wsrv.nl' ||
        (url.hostname === 'drive.google.com' && url.pathname.startsWith('/thumbnail'))
    );
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') return;

    // Strategy 1: Cache-First with background refresh for images, icons, fonts, and CDN scripts
    if (isCacheFirstAsset(url)) {
        event.respondWith(
            caches.open(ASSET_CACHE).then(async cache => {
                const cached = await cache.match(req);
                const networkFetch = fetch(req).then(response => {
                    if (response && (response.status === 200 || response.type === 'opaque')) {
                        cache.put(req, response.clone()).catch(() => {});
                    }
                    return response;
                }).catch(() => cached);

                return cached || networkFetch;
            })
        );
        return;
    }

    // Strategy 2: Stale-While-Revalidate for same-origin app shell (index.html, config.js)
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.open(SHELL_CACHE).then(async cache => {
                const cached = await cache.match(req);
                const networkFetch = fetch(req).then(response => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        cache.put(req, response.clone()).catch(() => {});
                    }
                    return response;
                }).catch(() => cached);

                return cached || networkFetch;
            })
        );
    }
});