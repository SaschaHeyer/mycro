/* Mycro — did anyone actually TOUCH the free tool on this page? (I121)
 *
 * WHY THIS EXISTS. Between I98 and I119 this site shipped eleven interactive tools onto
 * content pages: three calculators on the tool pages, four on guides, and the
 * contaminant identifier, pin diagnostic and harvest checker. Not one of them fired a
 * single event. The only instrumentation any of them carried was on the EMAIL step
 * (`be_report_email`, `calc_plan_email`, `farm_plan_email`), so "0 be-report leads" has
 * been read for weeks as "the capture failed" when it is equally consistent with
 * "nobody ever touched the calculator". Those are opposite findings with opposite next
 * moves, and they were indistinguishable.
 *
 * A capture count with no denominator is not a rate. This module is the denominator.
 *
 * THE RULES, each load-bearing, each pinned by tests/tool-use.spec.js:
 *
 * (a) A DEFAULT RESULT IS NOT A USE. Every one of these tools computes on load and
 *     renders the worked example printed beside it. Firing there would count a pageview
 *     as a use — the I115 double-count in a new shape, running in the flattering
 *     direction. Only a change the grower made counts.
 *
 * (b) ONE EVENT PER TOOL PER PAGE LOAD. A slider drag must not mint fifty uses.
 *
 * (c) AN EMAIL FIELD IS NEVER A TOOL USE. `tool_*` is the denominator for the `*_email`
 *     captures on the same page; if typing an address counted, every send would be
 *     preceded by a use and the ratio would answer itself. (I98's own audit trap: your
 *     email capture is an <input> too.)
 *
 * (d) RESOLVE `track` AT EVENT TIME, NEVER AT INIT. `track.js` is loaded `defer` and
 *     AFTER the inline tool scripts on every one of these pages, so `window.track` does
 *     not exist when this runs. Capturing it at init would make the whole thing silently
 *     do nothing, and a counter that fires nothing looks exactly like a tool nobody uses
 *     (I105). The flag is set only once a send really happened, so a very early keystroke
 *     is retried rather than swallowed (I85/I93/I109: only success records the flag).
 *
 * (e) BUTTONS DO NOT COUNT. The lb/kg toggles are <button>s and so are the email submits;
 *     including them would catch the submit, and excluding them undercounts the grower
 *     who only flipped units. Every measurement error in this codebase's history has run
 *     in the flattering direction, so the conservative one is the right one here.
 *
 * Scoped by CONTAINER, never by a list of field ids — a field added to the tool next
 * month is covered on the day it ships (the I110 rule).
 */
(function () {
  window.mycroToolUse = function (name, sel) {
    if (!name || !sel) return;
    var root = document.querySelector(sel);
    if (!root) return;
    var sent = false;
    function hit(e) {
      if (sent) return;
      // NOT guarded on e.isTrusted, and that is a decision, not an oversight. It would
      // enforce rule (a) against a synthetic repaint — which nothing here does — at the
      // cost of silently dropping every real grower whose browser fires untrusted input
      // events (password managers, some assistive tech, translate extensions). A counter
      // that cannot fire is indistinguishable from a tool nobody uses, which is the exact
      // failure this whole module exists to end (I105). Undercounting invisibly is worse
      // than the hypothetical it would prevent. Rule (a) is instead enforced structurally:
      // nothing outside this handler can reach the send, and every page is tested to fire
      // nothing on load.
      var t = e && e.target;
      if (!t || !t.tagName) return;
      var tag = t.tagName.toLowerCase();
      if (tag !== "input" && tag !== "select" && tag !== "textarea") return;   // rule (e)
      if (tag === "input" && String(t.type || "").toLowerCase() === "email") return; // rule (c)
      if (typeof window.track !== "function") return;                          // rule (d)
      sent = true;                                                             // rule (b)
      window.track(name);
    }
    // Capture phase, on the container: fires for fields that did not exist at init and
    // cannot be stopped by a handler further in.
    root.addEventListener("input", hit, true);
    root.addEventListener("change", hit, true);
  };
})();
