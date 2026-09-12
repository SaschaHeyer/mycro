/* Mycro — the seeded examples (I116)
   ==================================================================================
   The Grow Log and the Culture Library share ONE localStorage document, and each of
   them seeds fictional records into it so a first visit is not a blank page. This file
   is the single answer to two questions both tools have to agree on:

     1. which records did WE write, and
     2. has this grower any work of their own yet.

   Why it is shared rather than copied. I78 gave the Culture Library a "Remove the
   examples" banner and the Grow Log never got one, so the flagship tool — the page the
   ICP actually lands on from Google — seeded 8 batches with costs, harvests, two
   contacts and two deliveries, and offered no way to take them out that did not also
   take the grower's own work. On 2026-09-10 at 02:50 a real grower deleted TEN batches
   one at a time in 78 seconds, losing the two they had just added, then started over.
   The library's own copy of this logic also knew the batch ids (they were sitting in
   its SAMPLE_IDS map) and swept everything except them, and its "have they own work"
   test could not see a batch at all — so a grower whose own work was a BATCH was shown
   nothing on either page. Two doors, one document: the answer has to come from one
   place or they drift again (the I92 rule).

   ⚠️ isSample() and every id map here are read with hasOwnProperty. A bare `map[id]`
   returns a truthy function for "constructor" (the PLAN_KINDS bug, I91, and again in
   I115) — here that would mean refusing to delete a record, or worse, deleting one of
   the grower's own because it happened to be named after something on Object.prototype.
   ================================================================================== */
(function (root) {
  'use strict';

  /* The seeded ids, per collection. Keep in sync with sampleState() in grow-log.html
     and sampleState() in culture-library.html — a test reads both files and fails if
     either seeds an id this map does not list. */
  var IDS = {
    sources:    { src1: 1, src2: 1 },
    cultures:   { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1, c6: 1, c7: 1 },
    batches:    { s1: 1, s2: 1, s3: 1, s4: 1, s5: 1, s6: 1, s7: 1, s8: 1 },
    contacts:   { k1: 1, k2: 1 },
    deliveries: { d1: 1, d2: 1 }
  };

  /* Every collection the shared document holds. The order is the order the note reads
     them out in, worst-offender first: batches are what a grower sees on the flagship. */
  var KINDS = ['batches', 'cultures', 'sources', 'contacts', 'deliveries'];

  var WORD = {
    batches:    ['example batch', 'example batches'],
    cultures:   ['example culture', 'example cultures'],
    sources:    ['example source', 'example sources'],
    contacts:   ['example contact', 'example contacts'],
    deliveries: ['example delivery', 'example deliveries']
  };

  function has(map, key) {
    return !!map && typeof key === 'string' &&
           Object.prototype.hasOwnProperty.call(map, key);
  }

  function isSample(kind, id) {
    return has(IDS, kind) && has(IDS[kind], id) && IDS[kind][id] === 1;
  }

  function list(state, kind) {
    return (state && Array.isArray(state[kind])) ? state[kind] : [];
  }

  /* How many of OUR records are still sitting in this document, per collection. */
  function seededCounts(state) {
    var out = {};
    KINDS.forEach(function (k) {
      out[k] = list(state, k).filter(function (r) {
        return r && isSample(k, r.id);
      }).length;
    });
    return out;
  }

  function seededTotal(state) {
    var c = seededCounts(state), n = 0;
    KINDS.forEach(function (k) { n += c[k]; });
    return n;
  }

  /* Has the grower logged anything of their own, ANYWHERE in the shared document?
     This has to span every collection: the whole bug was a test that looked only at
     cultures and sources while the grower's real work was a batch in the other tool. */
  function hasOwnData(state) {
    return KINDS.some(function (k) {
      return list(state, k).some(function (r) { return r && !isSample(k, r.id); });
    });
  }

  /* "8 example batches, 7 example cultures and 2 example sources" — one sentence, the
     same on both pages, so the two doors can never describe the document differently.
     It reads the REMOVABLE counts, not the seeded ones: a seeded record the grower's own
     work hangs off is staying, and naming it would promise a removal that will not
     happen. Never offer what cannot be delivered (I94). */
  function describe(state) {
    var c = preview(state).removed, parts = [];
    KINDS.forEach(function (k) {
      if (!c[k]) return;
      parts.push('<b>' + c[k] + ' ' + WORD[k][c[k] === 1 ? 0 : 1] + '</b>');
    });
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  /* What a sweep WOULD do, worked out by running the real sweep on a copy. Deliberately
     not a second implementation of the keep rules: the offer and the action have to agree,
     and the only way to guarantee that is for one of them to be the other. */
  function preview(state) {
    if (!state || !seededTotal(state)) return { removed: {}, kept: 0, total: 0 };
    var copy;
    try { copy = JSON.parse(JSON.stringify(state)); }
    catch (e) { return { removed: {}, kept: 0, total: 0 }; }
    var r = sweep(copy), total = 0;
    KINDS.forEach(function (k) { total += r.removed[k] || 0; });
    return { removed: r.removed, kept: r.kept, total: total };
  }

  /* The banner's own gate: there are examples we can actually take out, and the grower has
     something of their own for them to be sitting alongside. */
  function offerClear(state) {
    return hasOwnData(state) && preview(state).total > 0;
  }

  /* Everything made from a culture, walked downwards. Self-contained on purpose — this
     file must not depend on either page's helpers. The depth guard is here and not in
     the pages' own copy because a synced document from another device can arrive in any
     shape, and a cycle would hang the tab on the one action that is meant to rescue it. */
  function descendantsOf(state, id, out, depth) {
    out = out || { cultures: [], batches: [] };
    depth = (depth || 0) + 1;
    if (depth > 200) return out;
    list(state, 'cultures').forEach(function (c) {
      if (c && c.parentId === id) {
        out.cultures.push(c);
        descendantsOf(state, c.id, out, depth);
      }
    });
    list(state, 'batches').forEach(function (b) {
      if (b && b.parentId === id) out.batches.push(b);
    });
    return out;
  }

  function holdsOwnWork(state, id) {
    var d = descendantsOf(state, id);
    return d.cultures.some(function (c) { return !isSample('cultures', c.id); }) ||
           d.batches.some(function (b) { return !isSample('batches', b.id); });
  }

  /* Remove our examples and nothing else.

     Three keep rules, each one there because breaking it destroys the grower's own work:
       - a seeded culture or source that one of their own records hangs off stays, or the
         chain above their block goes silent (I80's archive-is-not-delete argument);
       - a seeded batch one of THEIR deliveries points at stays, or a delivery they made
         loses the run it was picked from;
       - a seeded contact one of their own deliveries points at stays, for the same reason.
     The grower's own deliveries are never touched even if they look dangling: a record
     they wrote is theirs, and blanking a field is recoverable where deleting a row is not.

     state.seller is deliberately absent from all of this. It is the grower's own name and
     phone, it was never seeded, and standing reference data survives a clear (I100). */
  function sweep(state) {
    if (!state) return { kept: 0, removed: {} };

    // Computed from the document as it stands, BEFORE anything is removed: otherwise
    // "does an own delivery point at this" changes underneath the sweep.
    var keepBatch = {}, keepContact = {};
    list(state, 'deliveries').forEach(function (d) {
      if (!d || isSample('deliveries', d.id)) return;
      if (typeof d.batchId === 'string') keepBatch[d.batchId] = 1;
      if (typeof d.contactId === 'string') keepContact[d.contactId] = 1;
    });

    var kept = 0;
    var removed = { batches: 0, cultures: 0, sources: 0, contacts: 0, deliveries: 0 };

    function keeper(kind, held) {
      return function (r) {
        if (!r || !isSample(kind, r.id)) return true;
        if (held(r)) { kept++; return true; }
        removed[kind]++;
        return false;
      };
    }

    // Cultures first; a source's descendants are then recomputed against what is left.
    var cultures = list(state, 'cultures').filter(
      keeper('cultures', function (c) { return holdsOwnWork(state, c.id); }));
    if (Array.isArray(state.cultures)) state.cultures = cultures;

    var sources = list(state, 'sources').filter(
      keeper('sources', function (s) {
        var d = descendantsOf(state, s.id);
        return !!(d.cultures.length || d.batches.length);
      }));
    if (Array.isArray(state.sources)) state.sources = sources;

    var batches = list(state, 'batches').filter(
      keeper('batches', function (b) { return has(keepBatch, b.id); }));
    if (Array.isArray(state.batches)) state.batches = batches;

    var contacts = list(state, 'contacts').filter(
      keeper('contacts', function (c) { return has(keepContact, c.id); }));
    if (Array.isArray(state.contacts)) state.contacts = contacts;

    var deliveries = list(state, 'deliveries').filter(
      keeper('deliveries', function () { return false; }));
    if (Array.isArray(state.deliveries)) state.deliveries = deliveries;

    // A link to a record that is gone reads as "not linked" on the card while still
    // sitting in the data (I78). Null it; never delete the row that carries it.
    var liveCulture = {};
    list(state, 'cultures').forEach(function (c) { if (c && typeof c.id === 'string') liveCulture[c.id] = 1; });
    list(state, 'batches').forEach(function (b) {
      if (b && b.parentId && !has(liveCulture, b.parentId)) b.parentId = null;
    });

    return { kept: kept, removed: removed };
  }

  root.MycroSamples = {
    IDS: IDS,
    KINDS: KINDS,
    isSample: isSample,
    seededCounts: seededCounts,
    seededTotal: seededTotal,
    hasOwnData: hasOwnData,
    describe: describe,
    preview: preview,
    offerClear: offerClear,
    sweep: sweep
  };
})(typeof window !== 'undefined' ? window : this);
