/* Mycro — two runs off one bag lost to the same mould (I188)
   ==================================================================================
   ONE answer, shared by the Grow Log and the Culture Library, to: "has the spawn this came
   from already lost more than one run to the same contaminant?"

   Why. On 2026-11-26 a real farm marked both block runs made from one wood ear grain bag
   (WDE-LF-B00) lost to Trichoderma, on the same day. The bag in the Culture Library still
   read "used", because the farm flagged a second copy of the bag they keep in the Grow Log
   (it counts days there). So the traceback this product exists for said nothing: two more
   grain bags, a third bag made from one of them, and two runs of four blocks each were still
   colonising from that same bag, with no warning on any of them.

   A flag is the grower's call. This is the clue that should make them look. Rules:
   (a) only a contaminant counts (MycroCauses.isMould): a stalled run or "not sure" says
       nothing about the spawn;
   (b) at least TWO direct children lost to the SAME named mould, and they are at least half of
       that parent's finished children (harvested runs + lost runs + lost cultures): one loss is
       a bag, two of two is a pattern, two of nine is the room;
   (c) a parent already flagged contaminated is not a suspect: the existing flag warns already;
   (d) seeded examples never count, as parent or as child (I78): our fictional losses are not
       evidence about their spawn;
   (e) display only. It never flags, never pre-selects a cause and never changes a number (I117);
   (f) every walk has a depth guard: a synced document can arrive in any shape.
   ================================================================================== */
(function (root) {
  'use strict';
  var C = function () { return root.MycroCauses; };
  function seeded(kind, id) { return !!(root.MycroSamples && root.MycroSamples.isSample(kind, id)); }
  function arr(x) { return Array.isArray(x) ? x : []; }

  function index(state) {
    var cul = {}, bat = {};
    arr(state && state.cultures).forEach(function (c) { if (c && typeof c.id === 'string') cul[c.id] = c; });
    arr(state && state.batches).forEach(function (b) { if (b && typeof b.id === 'string') bat[b.id] = b; });
    var has = Object.prototype.hasOwnProperty;
    return {
      culture: function (id) { return (typeof id === 'string' && has.call(cul, id)) ? cul[id] : null; },
      batch: function (id) { return (typeof id === 'string' && has.call(bat, id)) ? bat[id] : null; }
    };
  }
  // The parent of a record: a culture wins over a batch with the same id (what parentId always meant).
  function parentOf(ix, rec, kind) {
    if (!rec || !rec.parentId) return null;
    if (kind === 'culture' && rec.parentKind === 'source') return null;
    var c = ix.culture(rec.parentId);
    if (c) return { kind: 'culture', rec: c };
    if (kind === 'batch') { var b = ix.batch(rec.parentId); if (b && b !== rec) return { kind: 'batch', rec: b }; }
    return null;
  }
  function childrenOf(state, ix, id, kind) {
    var out = [];
    arr(state.cultures).forEach(function (c) {
      if (!c || c.id === id || c.parentId !== id || c.parentKind === 'source') return;
      if (kind === 'culture') out.push({ kind: 'culture', rec: c });
    });
    arr(state.batches).forEach(function (b) {
      if (!b || b.id === id || b.parentId !== id) return;
      // A batch names a batch parent only when no culture holds that id. Defensive only: parentOf
      // already resolves a clashing id to the culture, so the pages never reach this branch.
      if (kind === 'batch' && ix.culture(id)) return;
      out.push({ kind: 'batch', rec: b });
    });
    return out;
  }
  function isLost(n) { return n.kind === 'batch' ? n.rec.stage === 'contaminated' : n.rec.status === 'contaminated'; }
  function isFlagged(kind, rec) {
    if (kind === 'culture') return rec.status === 'contaminated';
    return rec.stage === 'contaminated';
  }
  function codeOf(n) { return n.kind === 'culture' ? (n.rec.code || 'culture') : ((n.rec.code && String(n.rec.code).trim()) || n.rec.name || 'run'); }

  // Is this parent a suspect? -> {cause, lost:[nodes], finished} or null.
  function suspectOf(state, kind, rec, ix) {
    ix = ix || index(state);
    var Cz = C(); if (!Cz || !rec) return null;
    if (isFlagged(kind, rec)) return null;                                     // (c)
    if (seeded(kind === 'culture' ? 'cultures' : 'batches', rec.id)) return null; // (d)
    var kids = childrenOf(state, ix, rec.id, kind).filter(function (n) {
      return !seeded(n.kind === 'culture' ? 'cultures' : 'batches', n.rec.id);
    });
    var finished = 0, by = {};
    kids.forEach(function (n) {
      var done = isLost(n) || (n.kind === 'batch' && n.rec.stage === 'harvested');
      if (done) finished++;
      if (!isLost(n)) return;
      var k = Cz.of(n.rec);
      if (!Cz.isMould(k)) return;                                              // (a)
      (by[k] = by[k] || []).push(n);
    });
    var best = null;
    Object.keys(by).forEach(function (k) { if (!best || by[k].length > by[best].length) best = k; });
    if (!best || by[best].length < 2 || by[best].length * 2 < finished) return null; // (b)
    return { cause: best, lost: by[best], finished: finished, code: codeOf({ kind: kind, rec: rec }) };
  }

  // Everything still running below a record: healthy cultures and runs not yet harvested or lost.
  function liveBelow(state, kind, rec, ix) {
    ix = ix || index(state);
    var out = { cultures: [], batches: [], blocks: 0 }, seen = {};
    (function walk(k, r, depth) {
      if (depth > 200) return;                                                  // (f)
      childrenOf(state, ix, r.id, k).forEach(function (n) {
        var key = n.kind + ':' + n.rec.id;
        if (seen[key]) return; seen[key] = 1;
        if (seeded(n.kind === 'culture' ? 'cultures' : 'batches', n.rec.id)) return;
        if (n.kind === 'culture') {
          if (n.rec.status === 'healthy' && n.rec.archived !== true) out.cultures.push(n.rec);
        } else if (n.rec.stage !== 'harvested' && n.rec.stage !== 'contaminated') {
          out.batches.push(n.rec);
          out.blocks += (Number(n.rec.blocks) > 0 ? Number(n.rec.blocks) : 1);
        }
        walk(n.kind, n.rec, depth + 1);
      });
    })(kind, rec, 0);
    return out;
  }

  // The nearest suspect strictly ABOVE a record -> {kind, rec, code, cause, lost} or null.
  function suspectAbove(state, kind, rec) {
    var ix = index(state), cur = parentOf(ix, rec, kind), guard = 0;
    while (cur && guard++ < 200) {                                              // (f)
      if (isFlagged(cur.kind, cur.rec)) return null;   // a real flag above already warns
      var s = suspectOf(state, cur.kind, cur.rec, ix);
      if (s) return { kind: cur.kind, rec: cur.rec, code: s.code, cause: s.cause, lost: s.lost, finished: s.finished };
      cur = parentOf(ix, cur.rec, cur.kind);
    }
    return null;
  }

  /* "2 runs made from WDE-LF-B00 were lost to Trichoderma, green mould (A, B), and none came
     through." The one sentence both pages print, so the two can never disagree. `esc` is the
     page's HTML escaper; the cause label is passed in already looked up. */
  function lossSentence(sus, esc, causeLabel) {
    var allB = sus.lost.every(function (n) { return n.kind === 'batch'; });
    var allC = sus.lost.every(function (n) { return n.kind === 'culture'; });
    var noun = allB ? 'runs' : allC ? 'cultures' : 'things';
    var rest = sus.finished - sus.lost.length;
    return sus.lost.length + ' ' + noun + ' made from <code>' + esc(sus.code) + '</code> were lost to ' + esc(causeLabel) +
      ' (' + sus.lost.map(function (n) { return '<code>' + esc(codeOf(n)) + '</code>'; }).join(', ') + ')' +
      (rest > 0 ? ', out of ' + sus.finished + ' finished.' : ', and nothing made from it has come through yet.');
  }

  root.MycroLineClue = { suspectOf: suspectOf, suspectAbove: suspectAbove, liveBelow: liveBelow, codeOf: codeOf, lossSentence: lossSentence };
})(typeof window !== 'undefined' ? window : this);
