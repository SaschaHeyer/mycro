/* Mycro offline worker (I139). Lets the Grow Log and the Culture Library open with no
   signal, which is where a grow room usually is, and where a scanned block label is read.

   NETWORK FIRST, ALWAYS. When the network answers, the page gets exactly what it would
   have got with no worker at all, and the copy kept here is refreshed. The cache is only
   ever read when the network FAILS. A cache-first worker would serve an old page after
   every deploy, and these pages carry versioned scripts (account.js?v=N) whose whole point
   is that a stale copy never runs. Nothing here may change what an online visitor sees.

   Same-origin GETs only. The API, the analytics beacon and Google sign-in are other
   origins and are never touched: a backup push that fails must fail loudly to the page
   (it marks the device unsynced, I132), never be answered from a cache.

   Pages are kept under their path WITHOUT the query string, so every scanned label
   (grow-log.html?log=..&b=..) does not add its own copy, and an offline scan still opens
   the log. The page's own restore code then fails its fetch quietly and keeps the device's
   copy, which is the right answer with no signal. */
var CACHE = 'mycro-offline-v1';
var SHELL = ['/grow-log.html', '/culture-library.html'];

function pageKey(url){ var u = new URL(url); return u.origin + u.pathname; }

/* Install: fetch the two tool pages and every same-origin script and stylesheet they
   load, read off the pages themselves, so the list can never fall behind a version bump. */
self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return Promise.all(SHELL.map(function(p){
      return fetch(p, {cache:'no-cache'}).then(function(r){
        if(!r.ok) return;
        return r.clone().text().then(function(html){
          var urls = [], re = /<(?:script[^>]+src|link[^>]+href)="([^"]+)"/g, m;
          while((m = re.exec(html))){
            var u = new URL(m[1], self.location.origin + p);
            if(u.origin === self.location.origin && /\.(js|css)$/.test(u.pathname)) urls.push(u.href);
          }
          return Promise.all([c.put(pageKey(r.url || (self.location.origin + p)), r)].concat(urls.map(function(u){
            return fetch(u).then(function(x){ if(x.ok) return c.put(u, x); }).catch(function(){});
          })));
        });
      }).catch(function(){});
    }));
  }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){ return k.indexOf('mycro-offline-') === 0 && k !== CACHE; })
      .map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;
  var nav = req.mode === 'navigate';
  var key = nav ? pageKey(req.url) : req.url;
  e.respondWith(fetch(req).then(function(res){
    if(res.ok && res.type === 'basic'){
      var copy = res.clone();
      caches.open(CACHE).then(function(c){
        c.put(key, copy);
        /* One copy per script: when account.js?v=15 arrives, v=14 goes. */
        if(!nav && url.search) c.keys().then(function(ks){ ks.forEach(function(k){
          var ku = new URL(k.url); if(ku.pathname === url.pathname && k.url !== req.url) c.delete(k);
        }); });
      });
    }
    return res;
  }).catch(function(err){
    return caches.match(key).then(function(hit){
      if(hit) return hit;
      if(!nav) return caches.match(req, {ignoreSearch:true}).then(function(h){ if(h) return h; throw err; });
      throw err;
    });
  }));
});
