/* Service worker : coquille de l'application en cache (fonctionnement hors ligne),
   données toujours cherchées sur le réseau d'abord. */
var VERSION = 'immo-v3-e4';
var SHELL = ['./', './index.html', './engine.js', './xlsx.js', './donnees.js', './v3.js',
             './manifest.webmanifest', './icone-192.png', './icone-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (k) {
    return Promise.all(k.filter(function (n) { return n !== VERSION; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // données : réseau d'abord, cache de secours
  // le gabarit est volumineux : réseau uniquement, jamais mis en cache
  if (url.pathname.endsWith('/gabarit.json')) return;

  if (url.pathname.endsWith('/data.json')) {
    e.respondWith(
      fetch(e.request).then(function (r) {
        var copie = r.clone();
        caches.open(VERSION).then(function (c) { c.put('./data.json', copie); });
        return r;
      }).catch(function () {
        return caches.match('./data.json');
      })
    );
    return;
  }

  // coquille : cache d'abord, réseau en arrière-plan
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(function (rep) {
        var reseau = fetch(e.request).then(function (r) {
          if (r && r.ok) { var c2 = r.clone(); caches.open(VERSION).then(function (c) { c.put(e.request, c2); }); }
          return r;
        }).catch(function () { return rep; });
        return rep || reseau;
      })
    );
  }
});
