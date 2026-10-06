/* Home-screen install + offline (I139). Loaded by the Grow Log and the Culture Library only.

   Why it exists: growers keep this log at the bench and in the grow room, scan block labels
   with a phone there, and that is where the signal is worst. Added to the home screen it
   opens like an app, full screen, and with the offline worker (/sw.js) it opens with no
   signal at all. The log itself already lives on the device (localStorage), so offline costs
   nothing but the backup push, which the page already retries when signal returns (I132).

   Rules:
   (a) never a nag. One button in the toolbar, nothing on load, nothing that pops up.
   (b) the button is hidden once the page IS the installed app (standalone).
   (c) where the browser can install it in one tap (Chrome/Edge/Android: beforeinstallprompt)
       the button does that; everywhere else (iPhone Safari above all, which has no such
       event) it shows the two steps in words. Never a dead button.
   (d) `track` is resolved at EVENT time: track.js is deferred and loads after this file
       (I121 rule d). An `app_open` taken before it exists is queued, not lost. */
(function(){
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var deferred = null;

  function send(name, props){
    var tries = 0;
    (function go(){
      if(window.track){ try{ track(name, props || {}); }catch(_){} return; }
      if(++tries < 40) setTimeout(go, 250);
    })();
  }
  function os(){
    var ua = navigator.userAgent || '';
    if(/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if(/Android/.test(ua)) return 'android';
    return 'desktop';
  }
  window.mycroInstallHelp = function(kind){
    if(kind === 'ios') return 'On iPhone or iPad: open this page in Safari, tap the Share button (the square with an arrow), then <b>Add to Home Screen</b>.';
    if(kind === 'android') return 'On Android: open your browser’s menu (⋮) and tap <b>Add to Home screen</b> or <b>Install app</b>.';
    return 'On a computer: in Chrome or Edge, use the install icon at the right of the address bar, or the menu’s <b>Install</b> item. In Safari on a Mac: File, then <b>Add to Dock</b>.';
  };

  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('/sw.js').catch(function(){});
    });
  }
  if(standalone) send('app_open', {os: os()});

  /* Kept, NOT preventDefault'ed: on Android that would also hide the browser's own install bar. */
  window.addEventListener('beforeinstallprompt', function(e){ deferred = e; });
  window.addEventListener('appinstalled', function(){ send('pwa_installed', {os: os()}); var b = document.getElementById('installApp'); if(b) b.style.display = 'none'; });

  function wire(){
    var b = document.getElementById('installApp'), help = document.getElementById('installHelp');
    if(!b) return;
    if(standalone){ b.style.display = 'none'; return; }
    b.addEventListener('click', function(){
      var k = os();
      if(deferred){
        var p = deferred; deferred = null;
        send('pwa_install_click', {os: k, prompt: '1'});
        p.prompt();
        if(p.userChoice) p.userChoice.then(function(c){ send('pwa_install_choice', {os: k, outcome: (c && c.outcome) || ''}); }).catch(function(){});
        return;
      }
      send('pwa_install_click', {os: k, prompt: '0'});
      if(help){
        help.innerHTML = window.mycroInstallHelp(k) + ' It then opens full screen from its own icon, and opens with no signal. Your log stays on this device either way.';
        help.style.display = 'block';
      }
    });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
