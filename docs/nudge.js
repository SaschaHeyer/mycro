/* What the after-action prompt may say on THIS device (I140).
   Both tools show the same prompt after a real action (a harvest, a label print, a logged
   culture). It was written for a first visit and said, on every device, "this log lives only
   in this browser, clear it and it's gone", then asked for an email to send a backup link.
   The farm that uses Mycro most saw it at the end of nearly every session: their log has
   synced to a private link since September and that link has been in their inbox the whole
   time. A prompt that is false about the device it is shown on teaches people to ignore it.

   So there are three states, read off the device, and the page shows the copy for its state:
     'unlinked'  nothing backed up yet: the log really is only in this browser.
     'linked'    syncing to a private link that has not been emailed from here.
     'emailed'   syncing, and the link is already in their inbox. Nothing to ask for, so the
                 prompt is the honest paid pitch, and it is shown at most once a fortnight:
                 the people in this state are the ones using the product every day.

   ONE copy of the "has this link been emailed" memory (the key I138 introduced), read by the
   Grow Log's backup box and written by both tools' email buttons. If this file fails to load
   the pages fall back to 'unlinked', which is the copy they always had. */
(function(){
  var CLOUD_KEY='mycro_growlog_cloud_id', EMAILED_KEY='mycro_growlog_link_emailed',
      PITCH_KEY='mycro_nudge_pitch_at', PITCH_GAP=14*864e5;
  function get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function cloudId(){ return get(CLOUD_KEY)||''; }
  function emailedAt(id){
    try{ var o=JSON.parse(get(EMAILED_KEY)||'null');
         return (o && id && o.id===id && typeof o.at==='number') ? o.at : null; }catch(e){ return null; }
  }
  function rememberEmailed(id){ if(id) set(EMAILED_KEY, JSON.stringify({id:id, at:Date.now()})); }
  function state(){
    var id=cloudId();
    if(!id) return 'unlinked';
    return emailedAt(id) ? 'emailed' : 'linked';
  }
  /* The pitch is rationed, the capture is not: an unlinked or linked device has something
     real to gain from the prompt every time. */
  function due(now){
    if(state()!=='emailed') return true;
    var t=Number(get(PITCH_KEY));
    return !(t>0 && (now||Date.now())-t < PITCH_GAP);
  }
  function shown(){ if(state()==='emailed') set(PITCH_KEY, String(Date.now())); }
  /* Show exactly the blocks marked for this state. Fills any [data-ns-when] with the date
     the link was emailed, so the sentence names a real day. */
  function paint(root, st){
    if(!root) return;
    var els=root.querySelectorAll('[data-ns]');
    for(var i=0;i<els.length;i++){
      var el=els[i], want=(' '+el.getAttribute('data-ns')+' ').indexOf(' '+st+' ')>=0;
      /* Keep a block's own display (the email row is flex); remember it before hiding. */
      if(el.getAttribute('data-ns-display')==null)
        el.setAttribute('data-ns-display', el.style.display==='none' ? '' : el.style.display);
      el.style.display = want ? el.getAttribute('data-ns-display') : 'none';
    }
    var at=emailedAt(cloudId()), whens=root.querySelectorAll('[data-ns-when]');
    for(var j=0;j<whens.length;j++) whens[j].textContent = at
      ? new Date(at).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : 'earlier';
  }
  window.MycroNudge={ state:state, emailedAt:emailedAt, rememberEmailed:rememberEmailed,
                      due:due, shown:shown, paint:paint, PITCH_GAP:PITCH_GAP };
})();
