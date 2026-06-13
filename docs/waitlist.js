/* Mycro waitlist capture -> API (Cloud Run + Firestore).
   Shared by every page. `source` is the page path so leads are segmented by which
   asset converted them. Message colour is left to CSS (.cta-band p is light on the
   dark bands; .muted is dark on light blocks) so this works on every page. */
window.MYCRO_API = window.MYCRO_API || "https://mycro-806349486128.us-central1.run.app";
function mycroWaitlist(e){
  e.preventDefault();
  var f=e.target, msg=document.getElementById('wl-msg');
  var input=f.querySelector('input[type=email]');
  var btn=f.querySelector('button');
  var email=(input.value||'').trim();
  msg.style.display='block';
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){
    msg.textContent="Please enter a valid email address."; return false;
  }
  var orig=btn.textContent; btn.disabled=true; btn.textContent="Joining…";
  try{ localStorage.setItem('mycro_waitlist_email', email); }catch(_){}
  fetch(window.MYCRO_API+"/api/waitlist",{
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ email: email, source: location.pathname, ref: document.referrer||"" })
  }).then(function(r){ return r.ok ? r.json().catch(function(){return {ok:true};}) : {ok:false}; })
    .then(function(d){
      if(d && d.ok){
        f.style.display='none';
        msg.textContent="You're on the list 🍄 We'll email you the moment early access opens. Meanwhile, every free tool here is yours to use right now.";
      } else { throw new Error("bad"); }
    }).catch(function(){
      btn.disabled=false; btn.textContent=orig;
      msg.textContent="Couldn't reach the server just now — please try again in a moment.";
    });
  return false;
}
