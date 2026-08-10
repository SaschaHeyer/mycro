/* Mycro accounts — passwordless sign-in shared by the Grow Log and the Culture Library.
   ------------------------------------------------------------------------------------
   Why it exists: a Founding Grower paid for "early access to the app", and until now the
   only thing behind that was an anonymous restore link you had to keep track of. This is
   the account: you type your email, we send a one-time link, and from then on your log
   lives against your identity and syncs on every change from any device you sign in on.

   Design rules this file keeps:
   - The device stays the source of truth. Sync is PUSH-only; the only pull is an explicit
     one at sign-in, and it asks first if there is anything on the device to lose.
   - Signing out never deletes local data. The log is still in localStorage afterwards.
   - Everything degrades: no network, no account, no problem — the tool works offline
     exactly as it did before, which is what people already rely on.
   - No passwords, anywhere. There is nothing here to leak.
*/
(function (w) {
  'use strict';
  var API = 'https://mycro-806349486128.us-central1.run.app';
  var TOKEN_KEY = 'mycro_session';
  var EMAIL_KEY = 'mycro_email';
  // Mirrors the server's rule. ":" is excluded on purpose — "mailto:you@farm.com" used to
  // pass as a valid address, and a paying grower was told he wasn't one because of it.
  // Apostrophes stay legal: o'brien@example.ie is a real address.
  var EMAIL_RE = /^[^@\s:,;<>\\]+@[^@\s:,;<>\\]+\.[^@\s:,;<>\\]+$/;
  // Absorb what people actually paste out of mail clients and contact cards.
  function cleanEmail(v) {
    var s = String(v == null ? '' : v).slice(0, 200).trim();
    var angled = s.match(/<([^<>]+)>\s*$/);        // "Michael Jones <m@farm.com>"
    if (angled) s = angled[1].trim();
    return s.replace(/^mailto:\s*/i, '').replace(/^["'<]+|["'>]+$/g, '').trim().toLowerCase();
  }

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k) || '';
      if (v === null) { localStorage.removeItem(k); return ''; }
      localStorage.setItem(k, v); return v;
    } catch (e) { return ''; }
  }
  var token = function () { return ls(TOKEN_KEY); };

  /* All calls use a text/plain body so they stay CORS-simple (no preflight), matching the
     rest of the site's endpoints. The session rides in the body, not a header. */
  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('http ' + r.status));
        return j;
      });
    });
  }

  var state = { email: '', founder: false, plan: '', ready: false };
  function badge() {
    if (state.founder) return '<span class="acctBadge">★ Founding Grower</span> ';
    if (state.plan === 'comp') return '<span class="acctBadge comp">Test access</span> ';
    return '';
  }
  var hooks = { getState: null, setState: null, onChange: null };
  var syncTimer = null, syncing = false;

  function signedIn() { return !!token() && !!state.email; }

  /* ---- sync (push-only, debounced) ---- */
  function scheduleSync() {
    if (!signedIn() || !hooks.getState) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(pushNow, 1200);
  }
  function pushNow() {
    if (!signedIn() || !hooks.getState || syncing) return Promise.resolve();
    syncing = true;
    setStatus('Saving to your account…');
    return post('/api/account/log', { token: token(), data: hooks.getState() })
      .then(function () { setStatus('Saved to your account ✓'); })
      .catch(function (e) {
        // Local-first: the log is safe on the device; a failed push retries on the next change.
        if (/not signed in/i.test(e.message)) { clearSession(); setStatus(''); render(); }
        else setStatus('Saved on this device — we’ll sync when the connection is back.', true);
      })
      .then(function () { syncing = false; });
  }

  function clearSession() { ls(TOKEN_KEY, null); ls(EMAIL_KEY, null); state.email = ''; state.founder = false; state.plan = ''; }

  /* ---- UI ---- */
  function el(id) { return document.getElementById(id); }
  function setStatus(msg, isErr) {
    var s = el('acctStatus'); if (!s) return;
    s.textContent = msg || '';
    s.style.color = isErr ? '#b23b3b' : 'var(--muted)';
    s.style.display = msg ? 'block' : 'none';
  }
  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    var box = el('acctBar'); if (!box) return;
    if (signedIn()) {
      box.innerHTML =
        '<div class="acctRow">' +
          '<span class="acctWho">' +
            badge() +
            'Signed in as <b>' + esc(state.email) + '</b>' +
          '</span>' +
          '<span class="acctActions">' +
            '<button type="button" class="mini" id="acctPull">Load from my account</button> ' +
            '<button type="button" class="mini" id="acctHist">Earlier versions</button> ' +
            '<button type="button" class="mini ghosty" id="acctOut">Sign out</button>' +
          '</span>' +
        '</div>' +
        '<p class="acctHint">Every change on this device saves to your account automatically. ' +
        'Sign in on your phone and the same log is there. Every version is kept, so a bad ' +
        'day is a step back and not an ending.</p>' +
        '<div id="acctHistBox" class="acctHist" style="display:none"></div>' +
        '<div id="acctStatus" class="acctStatus" style="display:none"></div>';
      el('acctOut').addEventListener('click', signOut);
      el('acctPull').addEventListener('click', function () { pull(true); });
      el('acctHist').addEventListener('click', showHistory);
    } else {
      box.innerHTML =
        '<div class="acctRow">' +
          '<label class="acctLbl" for="acctEmail">Sign in to your Mycro account</label>' +
          '<span class="acctActions">' +
            '<button type="button" class="mini gbtn" id="acctGoogle">' +
              '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"/><path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z"/><path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"/></svg>' +
              'Continue with Google</button>' +
            '<span class="acctOr">or</span>' +
            '<input id="acctEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@farm.com">' +
            '<button type="button" class="mini solid" id="acctGo">Email me a link</button>' +
          '</span>' +
        '</div>' +
        '<p class="acctHint">No password — we email you a one-time link. Just paid? Use ' +
        '<b>the same email you paid with</b>. Accounts are opened by a <b>Founding Grower</b> spot; ' +
        'the grow log itself stays free and uncapped without one.</p>' +
        '<div id="acctStatus" class="acctStatus" style="display:none"></div>';
      el('acctGo').addEventListener('click', requestLink);
      el('acctGoogle').addEventListener('click', googleSignIn);
      el('acctEmail').addEventListener('keydown', function (e) { if (e.key === 'Enter') requestLink(); });
    }
    if (hooks.onChange) try { hooks.onChange(state); } catch (e) {}
  }

  function requestLink() {
    var inp = el('acctEmail'), em = cleanEmail(inp.value);
    if (!EMAIL_RE.test(em)) { setStatus('Please enter a valid email.', true); inp.focus(); return; }
    var btn = el('acctGo'), prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'Sending…';
    ls(EMAIL_HINT, em);        // so opening the link on this device needs no retyping
    post('/api/auth/request', { email: em })
      .then(function (j) {
        // The server now says whether the mail actually left. Telling someone to check an
        // inbox for an email that was never sent leaves them waiting on nothing, and on this
        // screen that person may well have just paid us.
        if (j && j.sent === false) {
          setStatus('We could not send that email just now. Please tap send again in a moment.', true);
          return;
        }
        if (j && j.gated) {
          // Not a Founding Grower yet — say so here, not only in the email.
          setStatus('');
          el('acctBar').insertAdjacentHTML('beforeend',
            '<p class="acctHint" style="color:var(--ink)"><b>Accounts are Founding Grower early access.</b> ' +
            'We\'ve emailed you the details — everything you\'re using stays free and uncapped either way. ' +
            '<a href="/#founding">Become a Founding Grower · $99</a></p>');
          if (w.track) try { w.track('account_gated', {}); } catch (e) {}
          return;
        }
        setStatus('Check ' + em + ' — the link works once and expires in 30 minutes.');
        if (w.track) try { w.track('account_link_requested', {}); } catch (e) {}
      })
      .catch(function () { setStatus('Could not send just now — please try again in a moment.', true); })
      .then(function () { btn.disabled = false; btn.textContent = prev; });
  }

  function signOut() {
    var t = token();
    clearSession(); render();
    setStatus('Signed out. Your log is still saved on this device.');
    if (t) post('/api/auth/logout', { token: t }).catch(function () {});
    if (w.track) try { w.track('account_signout', {}); } catch (e) {}
  }

  /* ---- version history (I79) ----
     The account keeps every distinct version that was pushed. This lists them with what was
     actually in each one — "3 batches · 13 cultures" is the number a grower recognises as
     theirs or not — and puts any of them back. Restoring pushes, and a push snapshots, so
     the state you restored over is itself still there afterwards. */
  function whenWords(iso) {
    var t = Date.parse(iso); if (isNaN(t)) return iso;
    var mins = Math.round((Date.now() - t) / 60000), d = new Date(t);
    var clock = d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric',
                                       hour: '2-digit', minute: '2-digit' });
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago · ' + clock;
    if (mins < 60 * 24) return Math.round(mins / 60) + 'h ago · ' + clock;
    return Math.round(mins / 1440) + ' days ago · ' + clock;
  }
  function countWords(c) {
    if (!c) return 'saved log';
    var p = [];
    if (c.batches) p.push(c.batches + ' batch' + (c.batches === 1 ? '' : 'es'));
    if (c.cultures) p.push(c.cultures + ' culture' + (c.cultures === 1 ? '' : 's'));
    if (c.sources) p.push(c.sources + ' source' + (c.sources === 1 ? '' : 's'));
    return p.length ? p.join(' · ') : 'empty';
  }
  function showHistory() {
    var box = el('acctHistBox'); if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = '<p class="acctHint">Loading your earlier versions…</p>';
    post('/api/account/revisions', { token: token() }).then(function (j) {
      var rv = (j && j.revisions) || [];
      if (!rv.length) {
        box.innerHTML = '<p class="acctHint">No earlier versions yet — the next change you make ' +
          'starts the history.</p>';
        return;
      }
      box.innerHTML = '<p class="acctHint"><b>Earlier versions of your log.</b> Restoring replaces ' +
        'what is on this device — and keeps what you replaced, so you can come back.</p>' +
        '<ul class="acctRevs">' + rv.map(function (r) {
          return '<li><span class="revWhen">' + esc(whenWords(r.savedAt)) + '</span>' +
            '<span class="revWhat">' + esc(countWords(r.counts)) + '</span>' +
            '<button type="button" class="mini" data-rev="' + esc(r.id) + '">Restore this</button></li>';
        }).join('') + '</ul>';
      box.addEventListener('click', function (e) {
        var id = e.target && e.target.getAttribute && e.target.getAttribute('data-rev');
        if (id) restore(id, e.target);
      });
    }).catch(function () {
      box.innerHTML = '<p class="acctHint">Could not load your history just now.</p>';
    });
  }
  function restore(id, btn) {
    if (!hooks.setState) return;
    if (!w.confirm('Put this version back on this device? What is here now is kept in your ' +
                   'history, so this can be undone.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
    post('/api/account/revision', { token: token(), id: id }).then(function (j) {
      if (!j || !j.data) throw new Error('empty');
      var ok = hooks.setState(j.data);
      if (ok === false) throw new Error('rejected');
      el('acctHistBox').style.display = 'none';
      // Say it AFTER the push settles: pushNow() writes its own "Saved" line, and the
      // message that matters to someone who just got their work back is the restore.
      pushNow().then(function () {
        setStatus('Restored the version from ' + whenWords(j.savedAt) + ' ✓');
      });
      if (w.track) try { w.track('account_restore', {}); } catch (e) {}
    }).catch(function () {
      setStatus('Could not restore that version — nothing on this device was changed.', true);
      if (btn) { btn.disabled = false; btn.textContent = 'Restore this'; }
    });
  }

  /* Pull the account's copy onto this device. Always asks before replacing real work. */
  function pull(manual) {
    if (!signedIn()) return Promise.resolve();
    return post('/api/account', { token: token() }).then(function (j) {
      state.email = j.email; state.founder = !!j.founder; state.plan = j.plan || 'free';
      ls(EMAIL_KEY, j.email);
      if (!j.data) {                       // nothing stored yet → this device seeds the account
        render();
        if (hooks.getState) pushNow();
        else setStatus('Signed in.');
        return;
      }
      var localCount = hooks.countLocal ? hooks.countLocal() : 0;
      var remoteCount = hooks.countOf ? hooks.countOf(j.data) : 0;
      var replace = true;
      if (localCount > 0) {
        replace = w.confirm(
          'Your account has a saved log (' + remoteCount + ' batches). This device has ' +
          localCount + '. Load the account copy and replace what is on this device?');
      }
      render();
      if (replace && hooks.setState) {
        hooks.setState(j.data);
        setStatus('Loaded from your account ✓');
      } else if (manual) {
        setStatus('Kept this device’s log. It will sync to your account on the next change.');
      }
    }).catch(function (e) {
      if (/not signed in/i.test(e.message)) { clearSession(); render(); }
      else setStatus('Could not reach your account just now.', true);
    });
  }

  /* ---- Firebase sign-in link ----
     Firebase issues and verifies the identity; we exchange its ID token for a Mycro
     session so everything downstream (the gate, the account, the log) is unchanged.
     Loaded from the CDN only when a sign-in link is actually being opened, so a normal
     visit to a free tool still downloads nothing extra. */
  var FB = {
    apiKey: 'AIzaSyBd3BuSaAeaUqEX-ex6VZrzcxbveLXsD3k',
    authDomain: 'niche-ceo-3.firebaseapp.com',
    projectId: 'niche-ceo-3',
    appId: '1:806349486128:web:d496c1590d712289c215f5'
  };
  var EMAIL_HINT = 'mycro_signin_email';

  /* ---- Continue with Google ----
     The SDK is loaded ONLY when someone actually clicks the button — a grower who never
     signs in downloads none of it. The popup goes through the Firebase auth domain, which
     is what makes this work without adding our own domain to an OAuth client we cannot
     edit. Popups are unreliable on phones, so a blocked popup falls back to a redirect. */
  var FB_SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  var _fb = null;
  function loadFirebase() {
    if (_fb) return _fb;
    _fb = Promise.all([
      import(FB_SDK + 'firebase-app.js'),
      import(FB_SDK + 'firebase-auth.js')
    ]).then(function (mods) {
      var app = mods[0], auth = mods[1];
      var a = app.getApps().length ? app.getApp() : app.initializeApp(FB);
      return { app: a, auth: auth, instance: auth.getAuth(a) };
    });
    return _fb;
  }

  function exchangeIdToken(idToken, via) {
    return post('/api/auth/firebase', { idToken: idToken }).then(function (j) {
      if (!j || !j.token || !EMAIL_RE.test(j.email || '')) throw new Error('bad session');
      ls(TOKEN_KEY, j.token); ls(EMAIL_KEY, j.email); ls(EMAIL_HINT, null);
      state.email = j.email; state.founder = !!j.founder; state.plan = j.plan;
      render();
      setStatus('Signed in as ' + j.email + '.');
      if (w.track) try { w.track('account_signin', { via: via, founder: j.founder ? 1 : 0 }); } catch (e) {}
      return pull(false).then(function () { return true; });
    });
  }

  function googleSignIn() {
    setStatus('Opening Google…');
    var btn = el('acctGoogle'); if (btn) btn.disabled = true;
    return loadFirebase().then(function (fb) {
      var provider = new fb.auth.GoogleAuthProvider();
      return fb.auth.signInWithPopup(fb.instance, provider)
        .catch(function (e) {
          // phones block popups routinely; a redirect is the reliable path there
          if (/popup|not-supported|cancelled-popup/i.test(e.code || e.message || '')) {
            try { sessionStorage.setItem('mycro_google_redirect', '1'); } catch (x) {}
            return fb.auth.signInWithRedirect(fb.instance, provider).then(function () { return null; });
          }
          throw e;
        })
        .then(function (cred) {
          if (!cred) return false;                       // redirect took over
          return cred.user.getIdToken().then(function (t) { return exchangeIdToken(t, 'google'); });
        });
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      setStatus(/not a founding grower|gated/i.test(e.message)
        ? 'That Google account is not a Founding Grower yet.'
        : 'Google sign-in did not complete. You can use the email link instead.', true);
      return false;
    });
  }

  /* If we sent the browser away to Google, pick the result up when it comes back. */
  function completeGoogleRedirect() {
    var pending = false;
    try { pending = sessionStorage.getItem('mycro_google_redirect') === '1'; } catch (e) {}
    if (!pending) return Promise.resolve(false);
    try { sessionStorage.removeItem('mycro_google_redirect'); } catch (e) {}
    return loadFirebase()
      .then(function (fb) { return fb.auth.getRedirectResult(fb.instance); })
      .then(function (cred) {
        if (!cred || !cred.user) return false;
        return cred.user.getIdToken().then(function (t) { return exchangeIdToken(t, 'google-redirect'); });
      })
      .catch(function () { setStatus('Google sign-in did not complete — try again.', true); return false; });
  }

  function isFirebaseLink() {
    return /[?&]mode=signIn/.test(w.location.search) && /[?&]oobCode=/.test(w.location.search);
  }

  /* Redeem the link through the Identity Toolkit REST API rather than the full SDK — one
     small request instead of ~150KB of JavaScript on a page that is mostly used offline. */
  function completeFirebaseLink() {
    var oob = (/[?&]oobCode=([^&]+)/.exec(w.location.search) || [])[1];
    if (!oob) return Promise.resolve(false);
    // Strip the code from the address bar straight away — it is a credential, and it
    // should not sit in history or get copied into a message.
    try { history.replaceState({}, '', w.location.pathname + w.location.hash); } catch (e) {}

    var email = ls(EMAIL_HINT) || ls(EMAIL_KEY);
    if (EMAIL_RE.test(email)) return redeem(oob, email);

    // Opened on a different device from the one that asked (a link requested on a laptop
    // and opened on a phone is the normal case). Firebase requires the address to be
    // confirmed; ask for it properly rather than throwing a browser prompt at someone who
    // has just paid us.
    return askForEmail(oob);
  }

  function askForEmail(oob) {
    var box = el('acctBar');
    box.innerHTML =
      '<div class="acctRow">' +
        '<label class="acctLbl" for="acctConfirm">Confirm your email to finish signing in</label>' +
        '<span class="acctActions">' +
          '<input id="acctConfirm" type="email" inputmode="email" autocomplete="email" placeholder="you@farm.com">' +
          '<button type="button" class="mini solid" id="acctConfirmGo">Sign me in</button>' +
        '</span>' +
      '</div>' +
      '<p class="acctHint">You asked for this link on another device, so we need the address it ' +
      'was sent to. Nothing else is needed — there is no password.</p>' +
      '<div id="acctStatus" class="acctStatus" style="display:none"></div>';
    var inp = el('acctConfirm');
    try { inp.focus(); } catch (e) {}
    return new Promise(function (resolve) {
      var go = function () {
        var em = cleanEmail(inp.value);
        if (!EMAIL_RE.test(em)) { setStatus('Please enter the email the link was sent to.', true); return; }
        el('acctConfirmGo').disabled = true;
        redeem(oob, em).then(resolve);
      };
      el('acctConfirmGo').addEventListener('click', go);
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    });
  }

  function redeem(oob, email) {

    return fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=' + FB.apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, oobCode: decodeURIComponent(oob) })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.idToken) throw new Error((j.error && j.error.message) || 'link failed');
        return exchangeIdToken(j.idToken, 'email-link');   // one exchange path for both routes
      })
      .catch(function (e) {
        // Re-render so the grower has the sign-in controls back and can ask for a fresh link.
        render();
        setStatus(/not a founding grower|gated/i.test(e.message)
            ? 'That account is not a Founding Grower yet.'
          : /EXPIRED|INVALID/i.test(e.message)
            ? 'That sign-in link has expired or was already used — ask for a new one.'
            : 'Could not complete sign-in. Ask for a fresh link and try again.', true);
        return false;
      });
  }

  /* A ?login=<token> in the URL is the one-time link being opened. */
  function consumeLoginToken() {
    var m = /[?&]login=([a-f0-9]{16,64})/.exec(w.location.search);
    if (!m) return Promise.resolve(false);
    var t = m[1];
    // Strip it from the address bar immediately — a one-time token should not sit in history.
    try { history.replaceState({}, '', w.location.pathname + w.location.hash); } catch (e) {}
    return post('/api/auth/verify', { token: t }).then(function (j) {
      if (!j || !j.token || !EMAIL_RE.test(j.email || '')) throw new Error('bad session');
      ls(TOKEN_KEY, j.token); ls(EMAIL_KEY, j.email);
      state.email = j.email; state.founder = !!j.founder; state.plan = j.plan;
      render();
      setStatus('Signed in as ' + j.email + '.');
      if (w.track) try { w.track('account_signin', { founder: j.founder ? 1 : 0 }); } catch (e) {}
      return pull(false).then(function () { return true; });
    }).catch(function () {
      render();
      setStatus('That sign-in link has expired or was already used — ask for a new one.', true);
      return false;
    });
  }

  /* ---- public ---- */
  w.MycroAccount = {
    /* hooks: getState() -> the document to sync; setState(doc) -> adopt a pulled document;
       countLocal() / countOf(doc) -> batch counts, used only to warn before replacing. */
    init: function (opts) {
      hooks = Object.assign(hooks, opts || {});
      var em = ls(EMAIL_KEY);
      if (token() && em) { state.email = em; }
      render();
      var first = isFirebaseLink() ? completeFirebaseLink()
                : (/[?&]login=/.test(w.location.search) ? consumeLoginToken() : completeGoogleRedirect());
      first.then(function (didLogin) {
        if (!didLogin && signedIn()) pull(false);   // refresh badge + adopt newer server copy
        state.ready = true;
      });
    },
    signedIn: signedIn,
    email: function () { return state.email; },
    isFounder: function () { return !!state.founder; },
    scheduleSync: scheduleSync,
    pushNow: pushNow
  };
})(window);
