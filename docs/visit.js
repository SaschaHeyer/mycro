/* Visitor statistics without consent (no banner needed). One beacon per arrival on the site: moving
   between pages and reloading are skipped. Nothing is stored in the browser and no cookie is set;
   the collector counts unique visitors with a daily hash and never stores the IP address.
   Include on every page: <script src="/visit.js" defer></script>
   Replace ENDPOINT with the URL setup.sh prints ("Beacon endpoint"). */
(function () {
  try {
    var nav = performance.getEntriesByType('navigation')[0];
    if ((nav && nav.type === 'reload') || document.referrer.indexOf(location.origin) === 0) return;
    var utm = new URLSearchParams(location.search);
    var body = JSON.stringify({
      path: location.pathname,
      referrer: document.referrer || null,
      utm_source: utm.get('utm_source'),
      utm_medium: utm.get('utm_medium'),
      utm_campaign: utm.get('utm_campaign'),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: navigator.language
    });
    navigator.sendBeacon('https://stats-telemetry-806349486128.europe-west1.run.app/visit',
      new Blob([body], { type: 'text/plain' }));
  } catch (e) {
    // Statistics never get in the way of the page.
  }
})();
