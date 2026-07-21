/* Minimal QR code generator — byte mode, error correction level M, versions 1–10.
   Used by the Grow Log's printable block labels. No dependencies, no network.
   QR.make(text) -> { size: n, get: function(x,y){return bool} }  */
(function (global) {
  'use strict';

  // ---- GF(256) tables (primitive polynomial 0x11d) ----
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // ---- RS block layout for ECC level M, versions 1..10: [totalCodewords, dataCodewords] per block ----
  var RS_M = {
    1: [[26, 16]],
    2: [[44, 28]],
    3: [[70, 44]],
    4: [[50, 32], [50, 32]],
    5: [[67, 43], [67, 43]],
    6: [[43, 27], [43, 27], [43, 27], [43, 27]],
    7: [[49, 31], [49, 31], [49, 31], [49, 31]],
    8: [[60, 38], [60, 38], [61, 39], [61, 39]],
    9: [[58, 36], [58, 36], [58, 36], [59, 37], [59, 37]],
    10: [[69, 43], [69, 43], [69, 43], [69, 43], [70, 44]]
  };
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function dataCodewords(v) {
    var t = 0, b = RS_M[v];
    for (var i = 0; i < b.length; i++) t += b[i][1];
    return t;
  }

  function utf8(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
      else { // surrogate pair
        i++;
        var cp = 0x10000 + (((c & 0x3ff) << 10) | (text.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return out;
  }

  // ---- Reed–Solomon error correction codewords ----
  function rsGenerator(n) {
    var poly = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(poly.length + 1);
      for (var j = 0; j < next.length; j++) next[j] = 0;
      for (var k = 0; k < poly.length; k++) {
        next[k] ^= poly[k];
        next[k + 1] ^= gmul(poly[k], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }
  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen), res = new Array(ecLen), i;
    for (i = 0; i < ecLen; i++) res[i] = 0;
    for (i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      for (var j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  // ---- build the final interleaved codeword stream ----
  function encode(text) {
    var bytes = utf8(text), v;
    for (v = 1; v <= 10; v++) {
      var lenBits = v < 10 ? 8 : 16;
      if (dataCodewords(v) * 8 >= 4 + lenBits + bytes.length * 8) break;
    }
    if (v > 10) throw new Error('QR: content too long');

    var bits = [];
    function put(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    put(4, 4);                       // byte mode
    put(bytes.length, v < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);

    var cap = dataCodewords(v) * 8;
    for (i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // terminator
    while (bits.length % 8) bits.push(0);
    var pads = [0xec, 0x11], p = 0;
    while (bits.length < cap) { put(pads[p % 2], 8); p++; }

    var codes = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
      codes.push(b);
    }

    var layout = RS_M[v], dataBlocks = [], ecBlocks = [], off = 0, maxData = 0, maxEc = 0;
    for (i = 0; i < layout.length; i++) {
      var dc = layout[i][1], ec = layout[i][0] - dc;
      var chunk = codes.slice(off, off + dc); off += dc;
      dataBlocks.push(chunk);
      ecBlocks.push(rsEncode(chunk, ec));
      if (dc > maxData) maxData = dc;
      if (ec > maxEc) maxEc = ec;
    }
    var out = [];
    for (i = 0; i < maxData; i++)
      for (var b2 = 0; b2 < dataBlocks.length; b2++)
        if (i < dataBlocks[b2].length) out.push(dataBlocks[b2][i]);
    for (i = 0; i < maxEc; i++)
      for (b2 = 0; b2 < ecBlocks.length; b2++)
        if (i < ecBlocks[b2].length) out.push(ecBlocks[b2][i]);
    return { version: v, codewords: out };
  }

  // ---- matrix construction ----
  function newMatrix(n) {
    var m = new Array(n);
    for (var i = 0; i < n; i++) { m[i] = new Array(n); for (var j = 0; j < n; j++) m[i][j] = null; }
    return m;
  }
  function placeFinder(m, r, c) {
    for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
      var rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      var inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
      var inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      m[rr][cc] = (inRing || inCore) ? 1 : 0;
    }
  }
  function reserveFormat(m) {
    var n = m.length, i;
    for (i = 0; i < 9; i++) { if (m[8][i] === null) m[8][i] = 2; if (m[i][8] === null) m[i][8] = 2; }
    for (i = 0; i < 8; i++) { if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 2; if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 2; }
  }
  function buildFunctions(m, version) {
    var n = m.length, i;
    placeFinder(m, 0, 0); placeFinder(m, 0, n - 7); placeFinder(m, n - 7, 0);
    for (i = 8; i < n - 8; i++) { m[6][i] = (i % 2 === 0) ? 1 : 0; m[i][6] = (i % 2 === 0) ? 1 : 0; }
    var pos = ALIGN[version];
    for (var a = 0; a < pos.length; a++) for (var b = 0; b < pos.length; b++) {
      var r = pos[a], c = pos[b];
      if ((r <= 7 && c <= 7) || (r <= 7 && c >= n - 8) || (r >= n - 8 && c <= 7)) continue;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++)
        m[r + dr][c + dc] = (Math.max(Math.abs(dr), Math.abs(dc)) !== 1) ? 1 : 0;
    }
    m[n - 8][8] = 1; // dark module
    reserveFormat(m);
    if (version >= 7) {
      var d = version, rem = version;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
      var vbits = (d << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = (vbits >> i) & 1, rr = Math.floor(i / 3), cc = i % 3;
        m[rr][n - 11 + cc] = bit; m[n - 11 + cc][rr] = bit;
      }
    }
  }
  function placeData(m, codewords) {
    var n = m.length, bitIdx = 0, total = codewords.length * 8;
    function bitAt(i) { return i < total ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0; }
    var upward = true;
    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < n; vert++) {
        for (var j = 0; j < 2; j++) {
          var c = right - j;
          var r = upward ? (n - 1 - vert) : vert;
          if (m[r][c] === null) { m[r][c] = bitAt(bitIdx++); }
        }
      }
      upward = !upward;
    }
  }
  function maskFn(k, r, c) {
    switch (k) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }
  function formatBits(mask) {
    var data = (0x00 << 3) | mask;   // ECC level M -> 00
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }
  function applyFormat(m, mask) {
    var n = m.length, bits = formatBits(mask), i;
    for (i = 0; i < 15; i++) {
      var bit = (bits >> i) & 1;
      // vertical strip beside the top-left finder (skips the timing row)
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[n - 15 + i][8] = bit;
      // horizontal strip below the top-left / left of the top-right finder
      if (i < 8) m[8][n - 1 - i] = bit;
      else if (i < 9) m[8][15 - i - 1 + 1] = bit;
      else m[8][15 - i - 1] = bit;
    }
    m[n - 8][8] = 1;
  }
  function penalty(m) {
    var n = m.length, score = 0, r, c, i, run, dark = 0;
    // rule 1 — runs of 5+
    for (r = 0; r < n; r++) {
      run = 1;
      for (c = 1; c < n; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    for (c = 0; c < n; c++) {
      run = 1;
      for (r = 1; r < n; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    // rule 2 — 2x2 blocks
    for (r = 0; r < n - 1; r++) for (c = 0; c < n - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    // rule 3 — finder-like patterns
    var p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function match(get, len) {
      var s = 0;
      for (var a = 0; a + 11 <= len; a++) {
        var ok1 = true, ok2 = true;
        for (var b = 0; b < 11; b++) {
          var val = get(a + b);
          if (val !== p1[b]) ok1 = false;
          if (val !== p2[b]) ok2 = false;
        }
        if (ok1) s += 40;
        if (ok2) s += 40;
      }
      return s;
    }
    for (r = 0; r < n; r++) score += match((function (rr) { return function (i2) { return m[rr][i2]; }; })(r), n);
    for (c = 0; c < n; c++) score += match((function (cc) { return function (i2) { return m[i2][cc]; }; })(c), n);
    // rule 4 — dark/light balance
    for (r = 0; r < n; r++) for (c = 0; c < n; c++) if (m[r][c]) dark++;
    var pct = dark * 100 / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function make(text, forceMask) {
    var enc = encode(text), v = enc.version, n = v * 4 + 17;
    var base = newMatrix(n);
    buildFunctions(base, v);
    var reserved = new Array(n);
    for (var r = 0; r < n; r++) { reserved[r] = new Array(n); for (var c = 0; c < n; c++) reserved[r][c] = base[r][c] !== null; }
    placeData(base, enc.codewords);

    var best = null, bestScore = Infinity;
    for (var k = 0; k < 8; k++) {
      if (forceMask != null && k !== forceMask) continue;
      var m = new Array(n);
      for (r = 0; r < n; r++) {
        m[r] = new Array(n);
        for (c = 0; c < n; c++) {
          var val = base[r][c] === 2 ? 0 : base[r][c];
          m[r][c] = (!reserved[r][c] && maskFn(k, r, c)) ? (val ^ 1) : val;
        }
      }
      applyFormat(m, k);
      var s = penalty(m);
      if (s < bestScore) { bestScore = s; best = m; }
    }
    return {
      version: v,
      size: n,
      modules: best,
      get: function (x, y) { return !!best[y][x]; }
    };
  }

  /** Render a QR as a crisp, print-safe SVG string. */
  function svg(text, px) {
    var q = make(text), n = q.size, quiet = 4, dim = n + quiet * 2, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++)
      if (q.modules[y][x]) d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px +
      '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  global.QR = { make: make, svg: svg };
})(typeof window !== 'undefined' ? window : this);
if (typeof module !== 'undefined') module.exports = (typeof window !== 'undefined' ? window : this).QR;
