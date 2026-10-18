/* Culture generation, the ONE answer for both tools (I150).
   A real farm keeps "Gen 1" in the notes of a dozen runs and told us what it counts, in its
   own words: a liquid culture or grain bag that arrives from a supplier is "Null"; the first
   culture they make from it as stock is Gen0; every transfer away from that is the next
   generation (Gen0 liquid to a grain bag = Gen1).
   So in the Culture Library the number is DERIVED, never typed:
   (a) a culture made straight from a source is Gen 0 (a wild sample is a source too: the first
       culture taken from it is the stock everything else comes off);
   (b) a culture made from another culture is that culture's generation plus one;
   (c) a culture whose parent does not resolve has NO generation (null), never a guess. An
       orphan reading "Gen 0" would be the most confident line on the screen and false.
   A batch in the Grow Log is different: whether a block counts as a transfer is the farm's call
   and their own records disagree with any one rule, so a batch keeps a typed `gen` and is only
   OFFERED its culture's generation plus one. */
(function(){
  function list(a){ return Array.isArray(a) ? a : []; }
  function byId(arr, id){
    for(var i=0;i<arr.length;i++) if(arr[i] && arr[i].id===id) return arr[i];
    return null;
  }
  // doc = {sources:[], cultures:[]}. Depth-guarded: a synced document can arrive in any shape.
  function ofCulture(c, doc){
    var cs=list(doc && doc.cultures), ss=list(doc && doc.sources), n=0, guard=0;
    while(c && guard++ < 60){
      if(!c.parentId) return null;
      // parentKind says which list to look in; a legacy culture without it is resolved by id.
      if(c.parentKind!=='culture' && byId(ss, c.parentId)) return n;
      var p = c.parentKind==='source' ? null : byId(cs, c.parentId);
      if(!p || p===c) return null;
      n++; c=p;
    }
    return null;
  }
  // A whole number from 0 to 99, or null. Anything else (text, a fraction, a negative) is null.
  function clean(v){
    if(v===null || v===undefined || v==='') return null;
    var n = typeof v==='number' ? v : (/^\s*\d{1,2}\s*$/.test(String(v)) ? parseInt(v,10) : NaN);
    return (isFinite(n) && n>=0 && n<=99 && Math.floor(n)===n) ? n : null;
  }
  /* The generation a grower already wrote into notes: "Gen 1", "Gen0", "Grain Spawn Gen 1",
     "generation 2". Two different numbers in one note say nothing (null): picking one would be
     a guess dressed as their own record. "Null" is their word for bought-in, not a number. */
  var RE=/\bgen(?:eration)?\s*[-#:]?\s*(\d{1,2})(?!\d)/gi;
  function fromNotes(text){
    if(typeof text!=='string' || !text) return null;
    var m, seen=null;
    RE.lastIndex=0;
    while((m=RE.exec(text))){
      var n=parseInt(m[1],10);
      if(seen!==null && seen!==n) return null;
      seen=n;
    }
    return seen;
  }
  function label(n){ return n==null ? '' : 'Gen '+n; }
  window.MycroGen = {ofCulture:ofCulture, clean:clean, fromNotes:fromNotes, label:label};
})();
