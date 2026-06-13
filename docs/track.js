/* Mycro — first-party, privacy-light analytics.
   No cookies, no localStorage, no PII, no third party, no consent banner needed.
   Beacons {name, path, ref-host, props} to our own Cloud Run endpoint; stored in
   Firestore. Read the funnel headless with tools/funnel.sh. Must NEVER break a page. */
(function () {
  "use strict";
  var ENDPOINT = "https://mycro-806349486128.us-central1.run.app/api/event";
  function send(name, props) {
    try {
      var body = JSON.stringify({
        name: String(name || "").slice(0, 40),
        props: props || {},
        path: location.pathname,
        // referrer HOSTNAME only (where the visit came from) — never the full URL, no PII
        ref: document.referrer ? new URL(document.referrer).hostname.slice(0, 80) : ""
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
