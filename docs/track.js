/* Mycro — first-party, privacy-light analytics.
   No cookies, no localStorage, no PII, no third party, no consent banner needed.
   Beacons {name, path, ref-host, props} to our own Cloud Run endpoint; stored in
   Firestore. Read the funnel headless with tools/funnel.sh. Must NEVER break a page. */
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
  var DEV = false;
  try {
    var q = new URLSearchParams(location.search).get("dev");
    if (q === "1") localStorage.setItem("mycro_dev", "1");
    else if (q === "0") localStorage.removeItem("mycro_dev");
    DEV = localStorage.getItem("mycro_dev") === "1";
  } catch (e) {}
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
