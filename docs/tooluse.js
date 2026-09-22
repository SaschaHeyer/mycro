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
 *
 * ---------------------------------------------------------------------------------
 * (f) THE SAME PREDICATE ANSWERS "IS THIS PLAN THE GROWER'S OWN?" (I128).
 *
 * On 2026-09-21 the first `farm-plan` lead this business has ever produced pressed
 * `Email me this farm plan` having changed nothing, and was mailed a table of OUR
 * worked example under the subject "Your mushroom farm plan" and the sentence "Here
 * is the farm plan you just worked out": 50 blocks a week, $3,175 profit a month,
 * payback in 1.3 months. `tool_farm_plan` read 0 for that week and `farm_plan_email`
 * read 1, which is how it was found — the denominator shipped at I121 firing its
 * first warning, correctly.
 *
 * That is I127's axis (an artifact LEAVES and is read later, with no screen beside
 * it) applied to the one artifact that leaves by email. And the answer already lived
 * here: `hit()` is exactly "the grower changed something in this tool". So the three
 * capture pages read `mycroToolTouched(sel)` rather than keeping a second opinion —
 * a shared module holding the right answer while a surface keeps its own copy is the
 * shape behind I113, I115, I116 and I127 (backlog -80).
 *
 * (g) `touched` IS SET BEFORE THE `track` CHECK, AND `sent` AFTER. They are different
 *     facts: "the grower changed something" does not depend on whether we managed to
 *     count it. Conflating them means a page where track.js failed to load mails an
 *     EXAMPLE label on a plan the grower really did fill in, which rule (h) says is
 *     the worse error of the two.
 *
 * (h) AN UNKNOWN CONTAINER ANSWERS "THEIRS", NEVER "EXAMPLE". Marking a grower's own
 *     plan as an example is worse than leaving an example unmarked (I127 rule (e)),
 *     so the mark is applied only on a POSITIVE identification of untouched (I115
 *     rule (b)). A page that never registered, a selector that matches nothing and a
 *     module that failed to load all fall back to today's behaviour unchanged.
 */
(function () {
  // Keyed by the container selector the page registered, so the capture form on the same
  // page can ask about the same tool without a second listener and without a second idea
  // of what counts as a change.
  var TOUCHED = {};

  /* Did the grower change anything inside this tool? `true` when we cannot tell, because
     the only consumer uses it to decide whether an artifact leaving the building is
     labelled an example, and a wrong EXAMPLE on real work is the expensive direction
     (rule (h)). hasOwnProperty, not a bare lookup: `TOUCHED["constructor"]` walks the
     prototype chain and returns a truthy non-entry, which happens to be the safe answer
     here but has been a real bug four times in this codebase (I91, I115, I116, I117). */
  window.mycroToolTouched = function (sel) {
    if (!sel) return true;
    return Object.prototype.hasOwnProperty.call(TOUCHED, sel) ? TOUCHED[sel] === true : true;
  };

  window.mycroToolUse = function (name, sel) {
    if (!name || !sel) return;
    var root = document.querySelector(sel);
    if (!root) return;
    TOUCHED[sel] = false;
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
      // Rule (g): recorded here, ABOVE the `sent` guard and ABOVE the `track` check. A
      // second change is not a second event but it is still a change, and a beacon we
      // could not send is not a change that did not happen.
      TOUCHED[sel] = true;
      if (sent) return;                                                        // rule (b)
      if (typeof window.track !== "function") return;                          // rule (d)
      sent = true;
      window.track(name);
    }
    // Capture phase, on the container: fires for fields that did not exist at init and
    // cannot be stopped by a handler further in.
    // ONLY `input` and `change`, never `click`. Found at I128 by mutation: deleting rule
    // (e)'s tag filter changed nothing, because what actually keeps a lb/kg button out is
    // this line, not that one. The tag filter is defence in depth for a dispatched or
    // synthetic `input` on a non-field, and for the day somebody adds a third event here.
    // A documented rule that array order or event binding is really enforcing is how I102
    // lost a loop; say which line does the work.
    root.addEventListener("input", hit, true);
    root.addEventListener("change", hit, true);
  };
})();
