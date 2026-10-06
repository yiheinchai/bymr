/**
 * Service worker for the browser build.
 *
 * - Ruffle's hashed files (core.ruffle.<hash>.js, <hash>.wasm) never change: cache first.
 * - The shell, ruffle.js and the game SWF: network first, so a new client is picked up on the
 *   next launch, falling back to the cached copy offline. These always ask the server, because a
 *   static host may let the browser reuse its own copy for a while (GitHub Pages: 10 minutes).
 * - Game art, sounds and language files: served from cache and refreshed in the background.
 * - Everything else (the game API) goes straight to the network.
 */
const VERSION = "bymr-pwa-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

const SHELL = [
  "./",
  "index.html",
  "play.js",
  "play.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "ruffle/ruffle.js",
  "bymr.swf",
];

// The shell can be served from any path (/play/ by the game server, or a static host).
const SCOPE = new URL(self.registration.scope).pathname;
const HASHED = /^ruffle\/(.+\.[0-9a-f]{16,}\.(js|wasm)|[0-9a-f]{16,}\.wasm)$/;
const ASSETS = /^\/(assets|gamestage)\//;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  const inScope = url.pathname.startsWith(SCOPE);
  if (inScope && HASHED.test(url.pathname.slice(SCOPE.length))) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  } else if (inScope) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  } else if (ASSETS.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch((error) => {
      if (cached) return cached;
      throw error;
    });
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return refresh;
}
