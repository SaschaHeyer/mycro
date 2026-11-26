/* Bring the record a scanned label (or a link) names into view, and keep it there while
   the page finishes arriving (I187).

   Reported by a farm on 2026-11-24: "It tries to bring you to the entry you scanned, but
   you still need to either scroll up or down to find it", on the laptop and the phones.
   Two causes, both measured before this was written:
   (a) scrollIntoView({block:'start'}) put the card's top edge at y=0, which is UNDER the
       sticky nav (123px on both tools), so the card's first lines, the very line that says
       "the batch on the label you scanned" and the batch name, sat behind the bar;
   (b) the site sets html{scroll-behavior:smooth}, so that scroll was an animation whose
       target was fixed when it started, while the page went on drawing above it (the link
       pull, the backup box, the account bar, panels). It landed where the card USED to be.
   So: scroll instantly, leave room for whatever is pinned to the top, and re-check for a
   short while, putting it back if anything above moved it. The moment the grower touches,
   scrolls or types, stop: their own scrolling always wins over ours. */
(function(){
  var SETTLE_MS = 3000, GAP = 12;
  function pinnedHeight(){
    // Everything fixed or sticky at the top of the viewport covers the top of the card.
    var h = 0, els = document.querySelectorAll('.nav, [data-pinned-top]');
    for (var i = 0; i < els.length; i++){
      var cs = getComputedStyle(els[i]);
      if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
      var r = els[i].getBoundingClientRect();
      if (r.top <= 1 && r.bottom > h) h = r.bottom;
    }
    return h;
  }
  function place(el){
    var want = pinnedHeight() + GAP, top = el.getBoundingClientRect().top;
    if (Math.abs(top - want) <= 2) return false;
    window.scrollTo({ top: Math.max(0, window.scrollY + top - want), behavior: 'instant' });
    return true;
  }
  /* find: returns the element to show (called again each check, because a repaint can
     replace it). decorate(el): re-applies the ring when a repaint dropped it. */
  window.mycroScanFocus = function(find, decorate){
    var el = find(); if (!el) return;
    place(el);
    var start = Date.now(), stopped = false;
    function stop(){ stopped = true; ['wheel','touchstart','keydown','mousedown'].forEach(function(t){ window.removeEventListener(t, stop, true); }); }
    ['wheel','touchstart','keydown','mousedown'].forEach(function(t){ window.addEventListener(t, stop, true); });
    (function tick(){
      if (stopped) return;
      if (Date.now() - start > SETTLE_MS) return stop();
      var cur = find();
      if (cur){ if (decorate) decorate(cur); place(cur); }
      setTimeout(tick, 100);
    })();
  };
  window.mycroScanFocus.pinnedHeight = pinnedHeight;
})();
