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
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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
            (state.founder ? '<span class="acctBadge">★ Founding Grower</span> ' : '') +
            'Signed in as <b>' + esc(state.email) + '</b>' +
          '</span>' +
          '<span class="acctActions">' +
            '<button type="button" class="mini" id="acctPull">Load from my account</button> ' +
            '<button type="button" class="mini ghosty" id="acctOut">Sign out</button>' +
          '</span>' +
        '</div>' +
        '<p class="acctHint">Every change on this device saves to your account automatically. ' +
        'Sign in on your phone and the same log is there.</p>' +
        '<div id="acctStatus" class="acctStatus" style="display:none"></div>';
      el('acctOut').addEventListener('click', signOut);
      el('acctPull').addEventListener('click', function () { pull(true); });
    } else {
      box.innerHTML =
        '<div class="acctRow">' +
          '<label class="acctLbl" for="acctEmail">Save this log to an account</label>' +
          '<span class="acctActions">' +
            '<input id="acctEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@farm.com">' +
            '<button type="button" class="mini solid" id="acctGo">Email me a sign-in link</button>' +
          '</span>' +
        '</div>' +
        '<p class="acctHint">No password. We email you a one-time link; after that your log syncs ' +
        'to your account on every change, and you can open it on any device.</p>' +
        '<div id="acctStatus" class="acctStatus" style="display:none"></div>';
      el('acctGo').addEventListener('click', requestLink);
      el('acctEmail').addEventListener('keydown', function (e) { if (e.key === 'Enter') requestLink(); });
    }
    if (hooks.onChange) try { hooks.onChange(state); } catch (e) {}
  }

  function requestLink() {
    var inp = el('acctEmail'), em = (inp.value || '').trim();
    if (!EMAIL_RE.test(em)) { setStatus('Please enter a valid email.', true); inp.focus(); return; }
    var btn = el('acctGo'), prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'Sending…';
    post('/api/auth/request', { email: em })
      .then(function () {
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

  /* A ?login=<token> in the URL is the one-time link being opened. */
  function consumeLoginToken() {
    var m = /[?&]login=([a-f0-9]{16,64})/.exec(w.location.search);
    if (!m) return Promise.resolve(false);
    var t = m[1];
    // Strip it from the address bar immediately — a one-time token should not sit in history.
    try { history.replaceState({}, '', w.location.pathname + w.location.hash); } catch (e) {}
    return post('/api/auth/verify', { token: t }).then(function (j) {
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
      consumeLoginToken().then(function (didLogin) {
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
