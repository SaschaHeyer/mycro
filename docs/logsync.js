/* One log, several devices (I170).

   The private link used to hold whatever device spoke last. A device linked to it never
   read it again unless it was opened through a ?log= URL, and the installed home-screen app
   opens plain /grow-log.html, so a farm with a laptop and a phone had two copies that each
   believed they were the log. On 2026-11-08 a real farm added four batches across two
   devices and the link kept two.

   Three pieces, all here so both tools get them:
   - merge(base, local, remote): a three-way merge by record id. base is the copy this device
     last agreed with the link on. A record only one side changed takes that side's change;
     a record one side removed goes, unless the other side changed it, because keeping
     something a person edited beats losing it. Pure, so it can be tested on its own.
   - push: says which version it was based on. If another device has written since, the
     server answers 409 with its copy, we merge and send again.
   - pull: every open, and every return to the app, reads the link.

   With no base (a device from before this file) nothing can be called a deletion, so it is
   a union: every record either side has survives. A record may come back once; a record is
   never lost. */
(function(root){
  var CLOUD='mycro_growlog_cloud_id', DIRTY='mycro_growlog_unsynced', BASE='mycro_growlog_synced', KEY='mycro_growlog_v1';

  function get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function has(o,k){ return Object.prototype.hasOwnProperty.call(o,k); }
  function same(a,b){
    if(a===b) return true;
    if(a==null || b==null) return a==b;
    if(typeof a!=='object' || typeof b!=='object') return false;
    if(Array.isArray(a)!==Array.isArray(b)) return false;
    var ka=Object.keys(a).filter(function(k){ return a[k]!==undefined; }),
        kb=Object.keys(b).filter(function(k){ return b[k]!==undefined; });
    if(ka.length!==kb.length) return false;
    return ka.every(function(k){ return has(b,k) && same(a[k],b[k]); });
  }
  function isRecordList(v){
    return Array.isArray(v) && v.every(function(r){ return r && typeof r==='object' && typeof r.id==='string'; });
  }
  function fields(base,local,remote,prefer){
    var out={}, keys={};
    [base,local,remote].forEach(function(o){ if(o) Object.keys(o).forEach(function(k){ keys[k]=1; }); });
    Object.keys(keys).forEach(function(k){
      var l=has(local,k)?local[k]:undefined, r=has(remote,k)?remote[k]:undefined, v;
      if(same(l,r)) v=l;
      else if(base){
        var b=has(base,k)?base[k]:undefined;
        v = same(l,b) ? r : same(r,b) ? l : (prefer==='remote'?r:l);
      } else v = prefer==='remote' ? (r!==undefined?r:l) : (l!==undefined?l:r);
      if(v!==undefined) out[k]=v;
    });
    return out;
  }
  function records(base,local,remote,prefer){
    function index(a){ var m=Object.create(null); (a||[]).forEach(function(r){ m[r.id]=r; }); return m; }
    var B=base?index(base):null, L=index(local), R=index(remote), out=[], done=Object.create(null);
    function one(id){
      if(done[id]) return; done[id]=1;
      var b=B&&B[id], l=L[id], r=R[id];
      if(l && r){ out.push(fields(b||null,l,r,prefer)); return; }
      var only=l||r;
      if(b && same(only,b)) return;      // the other side removed it and this side never touched it
      out.push(only);
    }
    (remote||[]).forEach(function(r){ one(r.id); });
    (local||[]).forEach(function(r){ one(r.id); });
    return out;
  }
  function merge(base,local,remote,opts){
    var prefer=(opts&&opts.prefer)||'local', out={}, keys={};
    [local,remote].forEach(function(o){ Object.keys(o).forEach(function(k){ keys[k]=1; }); });
    Object.keys(keys).forEach(function(k){
      var l=has(local,k)?local[k]:undefined, r=has(remote,k)?remote[k]:undefined, b=base&&has(base,k)?base[k]:undefined;
      if((l===undefined||isRecordList(l)) && (r===undefined||isRecordList(r)) && (l!==undefined||r!==undefined)
         && (b===undefined||isRecordList(b))){
        out[k]=records(base?(b||[]):null,l||[],r||[],prefer);
        return;
      }
      var one=fields(base?{x:b}:null,{x:l},{x:r},prefer);
      if(one.x!==undefined) out[k]=one.x;
    });
    return out;
  }

  /* ---- the base: what this device last agreed with the link on ---- */
  function readBase(){
    try{
      var b=JSON.parse(get(BASE));
      return (b && b.doc && b.id===get(CLOUD)) ? b : null;
    }catch(e){ return null; }
  }
  function writeBase(id,at,docStr){
    try{ localStorage.setItem(BASE,'{"id":'+JSON.stringify(id)+',"at":'+JSON.stringify(at||'')+',"doc":'+docStr+'}'); }
    catch(e){ try{ localStorage.removeItem(BASE); }catch(_){} }   // no base just means a union next time
  }
  function dirty(){ return get(DIRTY)||''; }
  function markDirty(){ try{ localStorage.setItem(DIRTY,String(Date.now())+Math.random().toString(36).slice(2,6)); }catch(e){} }
  function clearDirty(stamp){ try{ if(get(DIRTY)===stamp) localStorage.removeItem(DIRTY); }catch(e){} }

  function attach(cfg){
    var API=cfg.api, timer=null, running=null, again=false;
    function status(t,err){ if(cfg.status) cfg.status(t,err); }
    /* The link's copy gets the same tidying a load gives this device's, or fields the tidy
       fills in read as edits and every pull would push straight back. */
    function norm(d){ return cfg.normalize ? cfg.normalize(d) : d; }
    function send(id,data,base){
      var body={id:id||undefined,data:data};
      if(base) body.base=base;
      return fetch(API+'/api/growlog/backup',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(body)});
    }
    function fetchRemote(id){
      return fetch(API+'/api/growlog/backup/'+id).then(function(r){
        if(r.status===404) return null;
        if(!r.ok) throw new Error(r.status);
        return r.json();
      }).then(function(j){
        return (j && j.data && cfg.valid(j.data)) ? {data:norm(j.data), updatedAt:j.updatedAt||''} : null;
      });
    }
    function adopt(merged,prev){
      if(same(merged,prev)) return false;
      cfg.apply(merged);
      return true;
    }
    function post(id,at,tries){
      var stamp=dirty(), docStr=JSON.stringify(cfg.state());
      return send(id,cfg.state(),at).then(function(r){
        if(r.status===409 && tries>0){
          return r.json().then(function(j){
            var b=readBase(), theirs=norm(j.data);
            adopt(merge(b?b.doc:null,cfg.state(),theirs,{prefer:'local'}),cfg.state());
            writeBase(id,j.updatedAt,JSON.stringify(theirs));
            return post(id,j.updatedAt,tries-1);
          });
        }
        if(!r.ok) throw new Error(r.status);
        return r.json().then(function(j){
          writeBase(j.id||id,j.updatedAt,docStr);
          clearDirty(stamp);
          return j;
        });
      });
    }
    function attempt(id){
      var b=readBase();
      if(b && b.at) return post(id,b.at,3);
      /* No base yet, so ask first: a push from here would be the old blind overwrite. If
         the link cannot be read the change stays marked and goes out on the next try. */
      return fetchRemote(id).then(function(remote){
        if(!remote) return post(id,'',3);
        adopt(merge(null,cfg.state(),remote.data,{prefer:dirty()?'local':'remote'}),cfg.state());
        writeBase(id,remote.updatedAt,JSON.stringify(remote.data));
        return post(id,remote.updatedAt,3);
      });
    }
    function push(){
      var id=get(CLOUD);
      if(!id || (cfg.canPush && !cfg.canPush())) return Promise.resolve(null);
      if(running){ again=true; return running; }
      status('Syncing…');
      running=attempt(id).then(function(j){
        status('All changes synced to your private link ✓');
        return j;
      },function(){
        status('Saved on this device — we’ll sync when the connection is back.',true);
        return null;
      }).then(function(j){
        running=null;
        if(again){ again=false; push(); }
        return j;
      });
      return running;
    }
    function schedule(){
      if(!get(CLOUD)) return;
      markDirty();
      if(timer) clearTimeout(timer);
      timer=setTimeout(function(){ timer=null; push(); },1500);
    }
    /* Read the link. Resolves true when what is on screen changed. */
    function pull(){
      var id=get(CLOUD);
      if(!id || running || timer) return Promise.resolve(false);
      if(dirty()) return push().then(function(){ return false; });
      var b=readBase();
      return fetchRemote(id).then(function(remote){
        if(!remote || running || timer || dirty()) return false;
        if(b && b.at && remote.updatedAt===b.at) return false;
        var before=cfg.state(), merged=merge(b?b.doc:null,before,remote.data,{prefer:'remote'});
        writeBase(id,remote.updatedAt,JSON.stringify(remote.data));
        var changed=adopt(merged,before);
        if(!same(merged,remote.data)){ markDirty(); push(); }
        return changed;
      }).catch(function(){ return false; });
    }
    /* Every other write to the link goes through here, so none of them can overwrite blind.
       Answers like fetch, because the callers were written against fetch. */
    function backup(){
      var id=get(CLOUD), p;
      if(id){
        if(timer){ clearTimeout(timer); timer=null; }
        p=attempt(id);
      } else {
        var docStr=JSON.stringify(cfg.state());
        p=send('',cfg.state(),'').then(function(r){
          if(!r.ok) throw new Error(r.status);
          return r.json().then(function(j){ writeBase(j.id,j.updatedAt,docStr); return j; });
        });
      }
      return p.then(function(j){ return {ok:true,status:200,json:function(){ return Promise.resolve(j); }}; });
    }
    function quiet(){
      if(document.visibilityState!=='visible') return;
      if(cfg.busy && cfg.busy()) return;
      pull();
    }
    document.addEventListener('visibilitychange',quiet);
    window.addEventListener('online',function(){ if(dirty()) push(); else quiet(); });
    /* The other tool, or another tab, wrote this browser's copy: this page's is now old. */
    window.addEventListener('storage',function(e){ if(e.key===KEY && e.newValue && cfg.reload) cfg.reload(); });
    return {schedule:schedule,push:push,pull:pull,backup:backup,
      setBase:function(id,at,doc){ writeBase(id,at,JSON.stringify(doc)); }};
  }
  root.MycroLogSync={merge:merge,same:same,attach:attach};
})(window);
