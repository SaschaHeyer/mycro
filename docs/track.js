/* Mycro — first-party, privacy-light analytics.
   No cookies, no PII, no third party, no cross-site identifier, no consent banner needed.
   Beacons {name, path, ref-host, props} to our own Cloud Run endpoint; stored in
   Firestore. Read the funnel headless with tools/funnel.sh. Must NEVER break a page.
   localStorage holds exactly two non-identifying things: the ?dev=1 flag that keeps our own
   testing out of the numbers, and the first-touch CHANNEL LABEL (referrer host + utm tags),
   both of which stay on the visitor's device unless they choose to give us their email. */
(function () {
  "use strict";
  var ENDPOINT = "https://mycro-806349486128.us-central1.run.app/api/event";
  // AEO/citation source: dedicated answer engines (ChatGPT, Perplexity, …) usually strip
  // document.referrer, so the ONLY signal a real grower arrived via an AI answer is the
  // utm_source tag on the link the engine cited (e.g. ?utm_source=chatgpt.com — exactly how
  // Mycro's first real conversion arrived). utm_source is a marketing channel label, not PII.
  var UTM = "";
  try { UTM = (new URLSearchParams(location.search).get("utm_source") || "").slice(0, 80); } catch (e) {}
  // Our own testing looks EXACTLY like a grower's session, so every per-page conclusion was
  // drawn from a pool polluted with it (hundreds of grow-log views in a week were ours).
  // Open any page once with ?dev=1 to mark this browser as ours for good; ?dev=0 clears it.
  // Flagged events are still stored, just kept out of the real/human numbers server-side.
  // A local origin is ALWAYS ours: the regression suite drives real pages against a local
  // static server and beacons to production, so a 38-test run landed hundreds of pageviews
  // and dozens of harvests in the live funnel — 917 "real" pageviews in a week of which the
  // overwhelming majority were the test runner. A browser cannot opt a test runner in with
  // ?dev=1, so the origin has to decide. (I79)
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname) ||
              location.protocol === "file:";
  var DEV = LOCAL;
  try {
    var q = new URLSearchParams(location.search).get("dev");
    if (q === "1") localStorage.setItem("mycro_dev", "1");
    else if (q === "0") localStorage.removeItem("mycro_dev");
    DEV = LOCAL || localStorage.getItem("mycro_dev") === "1";
  } catch (e) {}
  /* ---- first-touch attribution (I81) ----
     Every lead record used to carry the referrer at the moment of SUBMIT, which for anyone
     who browsed at all is usemycro.com — so 4 of 8 real leads had no recoverable channel and
     the honest answer to "where did they come from" was "I don't know". The arrival is the
     only moment the channel exists, and it is usually a different page and often a different
     day from the signup.

     Stored once on the FIRST page of the FIRST visit and never overwritten, so a grower who
     arrives from ChatGPT, reads three guides and signs up a week later is still attributed to
     ChatGPT. Channel labels only: referrer HOSTNAME, utm tags, landing path, date. No PII, no
     full URL, no cross-site identifier — the same bar as the rest of this file. */
  var FT_KEY = "mycro_first_touch";
  function firstTouch() {
    try {
      var saved = localStorage.getItem(FT_KEY);
      if (saved) return JSON.parse(saved);
      var q = new URLSearchParams(location.search);
      var ft = {
        ref: document.referrer ? new URL(document.referrer).hostname.slice(0, 80) : "",
        utm: (q.get("utm_source") || "").slice(0, 80),
        med: (q.get("utm_medium") || "").slice(0, 40),
        cmp: (q.get("utm_campaign") || "").slice(0, 60),
        page: location.pathname.slice(0, 120),
        day: new Date().toISOString().slice(0, 10)
      };
      // Our own domain is not a source. If the first thing we ever see is an internal
      // referrer the visit began somewhere we did not observe, and "" says that honestly
      // rather than crediting ourselves for it.
      if (ft.ref && /(^|\.)usemycro\.com$/i.test(ft.ref)) ft.ref = "";
      if (DEV) ft.dev = 1;
      localStorage.setItem(FT_KEY, JSON.stringify(ft));
      return ft;
    } catch (e) { return null; }
  }
  // Read (and on a first visit, write) immediately: a bounce still records where it came from.
  var FT = firstTouch();
  window.mycroFirstTouch = function () { return FT || firstTouch(); };

  function send(name, props) {
    try {
      var body = JSON.stringify({
        name: String(name || "").slice(0, 40),
        props: props || {},
        path: location.pathname,
        // referrer HOSTNAME only (where the visit came from) — never the full URL, no PII
        ref: document.referrer ? new URL(document.referrer).hostname.slice(0, 80) : "",
        utm: UTM,  // utm_source (channel tag) — captures AI-answer-engine citations that drop the referrer
        dev: DEV   // our own testing — stored, but excluded from every "real traffic" number
      });
      // text/plain keeps this a CORS "simple request" → no preflight → beacons aren't dropped.
      var blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
      fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body, keepalive: true });
    } catch (e) {}                                     // analytics must NEVER throw into the page
  }
  window.track = send;                                 // call track('signup', {...}) anywhere

  // auto page_view — but NOT inside an iframe (avoids inflating embedded-demo loads)
  var topFrame = (function () { try { return window.top === window.self; } catch (e) { return false; } })();
  function pv() { if (topFrame) send("page_view", {}); }
  if (/interactive|complete/.test(document.readyState)) pv();
  else window.addEventListener("DOMContentLoaded", pv);

  // declarative click tracking: <a data-track="event_name">…</a>
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest("[data-track]");
    if (el) send(el.getAttribute("data-track"), { label: (el.textContent || "").trim().slice(0, 40) });
  }, true);
})();
