/* Mycro — bring a spreadsheet grow log into the Grow Log (I134)
   ==================================================================================
   Why this exists. /grow-log-template.html ranks near the top of Google for the grow-log
   template query and hands out a CSV to keep a grow log in a spreadsheet. The Grow Log
   exported CSV and could read back only its own JSON. So a grower whose history already
   lives in a spreadsheet (our template, our own export, or their own sheet) had exactly
   one way in: retype every batch. On 2026-09-26 a real farm arrived from that page and
   typed thirteen batches by hand, one a minute.

   This module is PURE: text in, proposed batches out. It never touches the page's state.
   The page shows what it found and asks before adding anything.

   ⚠️ Rules, each pinned by tests/csv-import.spec.js:
   (a) ADD, never replace. An import is somebody's history arriving, not a restore, so
       nothing already in the log is removed or rewritten.
   (b) A row already in the log is skipped, not duplicated (same batch number, or same
       name and inoculation date), so importing your own export twice is harmless.
   (c) The template's two worked-example rows are OUR fiction and never enter a grower's
       log, even if they forgot to delete them (the seeded-demo rule, I78/I116).
   (d) A row we cannot read (no date, no weight) is skipped and COUNTED with its reason.
       Guessing a weight or a date would write a biological efficiency nobody measured.
   (e) The unit comes from the file (a `_kg` / `_lb` / `_g` header, or a `unit` column)
       before it comes from the page. A kg file read as lb is off by 2.2x on every BE.
   (f) A species we do not have is kept as the grower's own name on an "Other" batch
       (I130), never forced onto the nearest oyster.
   (g) Every lookup is hasOwnProperty. A column or a cause called "constructor" is text.
   ================================================================================== */
(function (root) {
  'use strict';

  var LB = 453.59237;
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  // RFC 4180-ish: quoted cells, doubled quotes, commas/newlines inside quotes, CRLF or LF.
  // Also accepts ';' as the separator, which is what Excel writes in most of Europe.
  function parseCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    var firstLine = text.split(/\r?\n/)[0] || '';
    var sep = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function key(h) { return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

  // Column aliases. The first two families are ours (the Grow Log's export and the
  // template); the rest are what a grower's own sheet is likely to be called.
  var COLS = {
    name:    ['label', 'batch_name', 'name', 'batch'],
    code:    ['batch_number', 'batch_id', 'lot', 'lot_code', 'batch_no', 'id'],
    species: ['species', 'species_strain', 'strain', 'mushroom'],
    blocks:  ['blocks', 'num_blocks', 'number_of_blocks', 'bags', 'num_bags', 'block_count'],
    dry:     ['dry_per_block', 'dry_weight_per_block', 'dry_substrate_weight', 'dry_weight', 'dry_substrate', 'substrate_weight'],
    unit:    ['unit', 'units'],
    date:    ['inoculated_on', 'inoculation_date', 'inoculated', 'spawn_date', 'date'],
    stage:   ['stage', 'status'],
    colon:   ['colonized_date', 'colonised_date', 'colonized_on'],
    pin:     ['pinning_date', 'pinned_on'],
    harvest: ['harvest_date', 'harvested_on'],
    yield:   ['fresh_yield', 'yield', 'total_yield', 'fresh_weight'],
    flushes: ['flushes'],
    method:  ['method', 'substrate', 'recipe'],
    spawn:   ['spawn_type_ratio', 'spawn', 'spawn_ratio'],
    contam:  ['contaminated_yn', 'contaminated', 'contam'],
    cause:   ['contam_cause', 'cause', 'contam_cause_stage'],
    lostAt:  ['lost_at_stage'],
    cSub:    ['cost_substrate'], cSpawn: ['cost_spawn'], cSup: ['cost_supplies'], cLab: ['cost_labor'],
    price:   ['price_per'],
    notes:   ['notes', 'note', 'comments']
  };
  var UNIT_SUFFIX = /_(lb|lbs|kg|g)(_per_block)?$/;

  // Map a header row to {field: {i, unit}}. A header like `dry_kg_per_block` or
  // `fresh_yield_lb` carries its own unit and is matched with the unit stripped off.
  function mapHeader(header) {
    var out = {};
    header.forEach(function (h, i) {
      var k = key(h), u = null, m = k.match(UNIT_SUFFIX);
      var bare = k;
      if (m) { u = m[1] === 'lbs' ? 'lb' : m[1]; bare = k.replace(UNIT_SUFFIX, '') + (m[2] || ''); }
      // our export writes dry_<unit>_per_block: normalise to dry_per_block
      var mm = k.match(/^dry_(lb|kg|g)_per_block$/);
      if (mm) { u = mm[1]; bare = 'dry_per_block'; }
      var mp = k.match(/^price_per_(lb|kg|g)$/);
      if (mp) { u = mp[1]; bare = 'price_per'; }
      for (var f in COLS) {             // COLS is a literal: for-in sees its own keys only
        if (has(out, f)) continue;
        if (COLS[f].indexOf(bare) >= 0 || COLS[f].indexOf(k) >= 0) { out[f] = { i: i, unit: u }; break; }
      }
    });
    return out;
  }

  // Dates: ISO first. A spreadsheet that re-saved the file may have turned 2026-07-01 into
  // 7/1/2026 or 01.07.2026; a day over 12 settles which is which, otherwise the locale does.
  function parseDate(s, dayFirst) {
    s = String(s || '').trim();
    if (!s) return null;
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    var y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
      if (!m) return null;
      var a = +m[1], b = +m[2]; y = +m[3]; if (y < 100) y += 2000;
      if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; }
      else if (dayFirst || m[0].indexOf('.') >= 0) { d = a; mo = b; } else { mo = a; d = b; }
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null;          // 31 February
    return dt.toISOString().slice(0, 10);
  }

  function num(s) {
    s = String(s == null ? '' : s).trim().replace(/[^\d.,\-]/g, '');
    if (!s) return null;
    // "1,5" (decimal comma) vs "1,500" (thousands): a single comma followed by 1-2 digits is decimal.
    if (/^\-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); else s = s.replace(/,/g, '');
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  function toG(v, u) { return u === 'kg' ? v * 1000 : u === 'g' ? v : v * LB; }
  function normUnit(s) { s = String(s || '').trim().toLowerCase(); return s === 'kg' ? 'kg' : (s === 'g' || s === 'grams') ? 'g' : (s === 'lb' || s === 'lbs' || s === 'pound' || s === 'pounds') ? 'lb' : null; }

  // Species text -> our key. Exact labels first (our own export), then the unambiguous
  // words. "King oyster" is checked before plain "oyster"; a named oyster we do not carry
  // (phoenix, snow, italian, elm) is the grower's own name, not a pearl oyster.
  function speciesOf(text, SPECIES) {
    var t = String(text || '').trim();
    if (!t) return null;
    var low = t.toLowerCase();
    for (var k in SPECIES) if (has(SPECIES, k) && SPECIES[k].label.toLowerCase() === low) return { key: k, name: null };
    var rules = [
      [/king|eryngii/, 'king'], [/pink|yellow|golden|citrin|djamor/, 'pink'],
      [/lion|hericium/, 'lions'], [/shiitake|edodes/, 'shiitake'], [/chestnut|pholiota adiposa/, 'chestnut'],
      [/pioppino|poplar|agrocybe/, 'pioppino'], [/nameko/, 'nameko'], [/reishi|ganoderma/, 'reishi'],
      [/^(blue |pearl |grey |gray )?oyster( mushroom)?s?$|ostreatus/, 'pearl']
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(low) && has(SPECIES, rules[i][1])) return { key: rules[i][1], name: null };
    return { key: 'other', name: t.slice(0, 40) };
  }

  function causeOf(text, CAUSE) {
    var t = String(text || '').trim().toLowerCase();
    if (!t) return 'unknown';
    for (var k in CAUSE) if (has(CAUSE, k) && CAUSE[k].toLowerCase() === t) return k;
    if (/trich|green/.test(t)) return 'trich';
    if (/cobweb|dactyl/.test(t)) return 'cobweb';
    if (/black|pin mou?ld|aspergill|rhizop/.test(t)) return 'black';
    if (/wet ?spot|sour|bacill/.test(t)) return 'wetspot';
    if (/blotch|pseudomon/.test(t)) return 'blotch';
    if (/bacteri|yeast/.test(t)) return 'bactyeast';
    return 'other';
  }

  // The template's two worked-example rows (docs/grow-log-template.html). Matched on the
  // batch id AND the inoculation date AND the note, so a grower who reuses "B-001" for a
  // real batch is not thrown away.
  var TEMPLATE_EXAMPLES = [
    ['b-001', '2026-07-01', 'first flush, strong pins'],
    ['b-002', '2026-07-03', 'spawn may have been under-shaken']
  ];

  /* ctx = {SPECIES, STAGE_LABEL, CAUSE, pageUnit:'lb'|'kg', existing:[batches], today:'YYYY-MM-DD',
            dayFirst:bool, newId:fn}
     returns {ok, error?, batches:[], skipped:{reason:n}, dupes, examples, units:[...], rows} */
  function plan(text, ctx) {
    var rows = parseCsv(text);
    var res = { ok: false, batches: [], skipped: {}, dupes: 0, examples: 0, units: [], rows: 0 };
    if (rows.length < 2) { res.error = 'That file has no rows under its header.'; return res; }
    var col = mapHeader(rows[0]);
    if (!has(col, 'date') || !has(col, 'dry') || !(has(col, 'species') || has(col, 'name') || has(col, 'code'))) {
      res.error = 'That file does not have the columns a grow log needs: an inoculation date, a dry substrate weight and a species or batch name.';
      return res;
    }
    var skip = function (why) { res.skipped[why] = (res.skipped[why] || 0) + 1; };
    var seenCodes = {}, seenNameDate = {};
    (ctx.existing || []).forEach(function (b) {
      if (b.code) seenCodes[String(b.code).trim().toLowerCase()] = 1;
      seenNameDate[String(b.name || '').trim().toLowerCase() + '|' + b.inoculatedOn] = 1;
    });
    var units = [];
    var cell = function (r, f) { return has(col, f) && col[f].i < r.length ? String(r[col[f].i]).trim() : ''; };
    for (var ri = 1; ri < rows.length; ri++) {
      var r = rows[ri];
      res.rows++;
      var code = cell(r, 'code'), name = cell(r, 'name'), spText = cell(r, 'species');
      var date = parseDate(cell(r, 'date'), ctx.dayFirst);
      var noteText = cell(r, 'notes');
      if (TEMPLATE_EXAMPLES.some(function (e) { return e[0] === code.toLowerCase() && e[1] === date && e[2] === noteText.toLowerCase(); })) { res.examples++; continue; }
      if (!date) { skip('no inoculation date we could read'); continue; }
      var u = normUnit(cell(r, 'unit')) || col.dry.unit || ctx.pageUnit || 'lb';
      var dry = num(cell(r, 'dry'));
      if (dry == null || dry <= 0) { skip('no dry substrate weight'); continue; }
      var sp = speciesOf(spText, ctx.SPECIES) || { key: 'other', name: null };
      var blocks = Math.round(num(cell(r, 'blocks')) || 1); if (blocks < 1) blocks = 1;
      if (!name) name = code || (sp.name || ctx.SPECIES[sp.key].label) + ' ' + date;
      var codeKey = code.toLowerCase();
      if ((codeKey && seenCodes[codeKey]) || seenNameDate[name.toLowerCase() + '|' + date]) { res.dupes++; continue; }
      if (codeKey) seenCodes[codeKey] = 1; seenNameDate[name.toLowerCase() + '|' + date] = 1;
      if (units.indexOf(u) < 0) units.push(u);

      var yu = (has(col, 'yield') && col.yield.unit) || u;
      var flushes = null;
      var fl = cell(r, 'flushes');
      if (fl) {
        var fu = (has(col, 'flushes') && col.flushes.unit) || yu;
        flushes = fl.split(/[;|+]/).map(num).filter(function (x) { return x != null && x >= 0; }).map(function (x) { return toG(x, fu); });
        if (!flushes.length) flushes = null;
      }
      var y = num(cell(r, 'yield'));
      if (!flushes && y != null && y > 0) flushes = [toG(y, yu)];

      var contamRaw = cell(r, 'contam').toLowerCase();
      var contaminated = /^(y|yes|true|1|x)$/.test(contamRaw);
      var stageRaw = key(cell(r, 'stage'));
      var harvestD = parseDate(cell(r, 'harvest'), ctx.dayFirst), pinD = parseDate(cell(r, 'pin'), ctx.dayFirst), colD = parseDate(cell(r, 'colon'), ctx.dayFirst);
      var stage, since;
      if (has(ctx.STAGE_LABEL, stageRaw)) stage = stageRaw;
      else if (contaminated) stage = 'contaminated';
      else if (flushes || harvestD) stage = 'harvested';
      else if (pinD || colD) stage = 'fruiting';
      else stage = date < ctx.today ? 'colonizing' : 'inoculated';
      since = (stage === 'harvested' && harvestD) || ((stage === 'fruiting' || stage === 'harvested') && (pinD || colD)) || date;
      if (since < date) since = date;

      var notes = [];
      if (noteText) notes.push(noteText);
      var spawn = cell(r, 'spawn'); if (spawn) notes.push('Spawn: ' + spawn);
      var b = {
        id: ctx.newId(), name: name.slice(0, 80), species: sp.key, dryG: toG(dry, u), blocks: blocks,
        inoculatedOn: date, stage: stage, stageSince: since, yieldG: null,
        parentId: null,
        method: cell(r, 'method') ? cell(r, 'method').slice(0, 60) : null,
        code: code ? code.slice(0, 40) : null,
        speciesName: sp.key === 'other' ? sp.name : null,
        notes: ''
      };
      if (flushes) b.flushes = flushes;
      if (stage === 'contaminated') {
        var ct = cell(r, 'cause');
        b.cause = causeOf(ct, ctx.CAUSE);
        // The template's cause column is free text ("trich (green) at colonization"): keep
        // the grower's words even when we could name the mould.
        if (ct && (!has(ctx.CAUSE, b.cause) || ctx.CAUSE[b.cause].toLowerCase() !== ct.toLowerCase())) notes.push('Cause noted: ' + ct);
        var la = cell(r, 'lostAt').toLowerCase();
        for (var sk in ctx.STAGE_LABEL) if (has(ctx.STAGE_LABEL, sk) && ctx.STAGE_LABEL[sk].toLowerCase() === la) b.lostAt = sk;
      }
      var costs = {}, anyCost = false;
      [['substrate', 'cSub'], ['spawn', 'cSpawn'], ['supplies', 'cSup'], ['labor', 'cLab']].forEach(function (p) {
        var v = num(cell(r, p[1])); if (v != null && v >= 0) { costs[p[0]] = v; anyCost = true; }
      });
      if (anyCost) b.costs = costs;
      var price = num(cell(r, 'price'));
      if (price != null && price > 0) b.priceG = price / toG(1, (has(col, 'price') && col.price.unit) || u);
      b.notes = notes.join(' · ').slice(0, 500);
      res.batches.push(b);
    }
    // A header that does not SAY per block, on a file where some batch has several blocks,
    // is the one reading a spreadsheet cannot settle: the page states which one it used.
    var dryHeader = key(rows[0][col.dry.i]);
    res.dryAmbiguous = dryHeader.indexOf('per_block') < 0 && res.batches.some(function (b) { return b.blocks > 1; });
    res.units = units;
    res.ok = true;
    return res;
  }

  // Does this text look like a CSV grow log rather than a JSON backup?
  function looksLikeCsv(text, filename) {
    if (/\.csv$/i.test(filename || '')) return true;
    var t = String(text || '').replace(/^﻿/, '').trim();
    if (!t || t[0] === '{' || t[0] === '[') return false;
    var col = mapHeader(parseCsv(t.split(/\r?\n/)[0])[0] || []);
    return has(col, 'date') && has(col, 'dry');
  }

  root.MycroCsvImport = { parseCsv: parseCsv, mapHeader: mapHeader, parseDate: parseDate, num: num,
    speciesOf: speciesOf, causeOf: causeOf, plan: plan, looksLikeCsv: looksLikeCsv };
})(typeof window !== 'undefined' ? window : globalThis);
