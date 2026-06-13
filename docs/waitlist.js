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
        if(window.track) try{ track('waitlist_signup', {src: location.pathname}); }catch(_){}
        f.style.display='none';
        msg.textContent="You're on the list 🍄 Check your inbox — we just sent you a quick welcome with all the free tools. (Peek in spam if it's not there in a minute.)";
      } else { throw new Error("bad"); }
    }).catch(function(){
      btn.disabled=false; btn.textContent=orig;
      msg.textContent="Couldn't reach the server just now — please try again in a moment.";
    });
  return false;
}

/* Founding Grower presale -> Stripe Checkout (live).
   We capture the email as a waitlist lead first (so an abandoned checkout still
   becomes a lead, tagged source=founding-intent), then hand off to Stripe with the
   email pre-filled. Stripe handles the actual payment; on success the buyer lands
   on /success.html. */
window.MYCRO_FOUNDING_LINK = window.MYCRO_FOUNDING_LINK || "https://buy.stripe.com/9B66oJ4Bp1iV5BBfVHe7m01";
function mycroFounding(e){
  e.preventDefault();
  var f=e.target, msg=document.getElementById('fnd-msg');
  var input=f.querySelector('input[type=email]');
  var btn=f.querySelector('button');
  var email=(input.value||'').trim();
  if(msg) msg.style.display='block';
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){
    if(msg) msg.textContent="Please enter a valid email address."; return false;
  }
  var orig=btn.textContent; btn.disabled=true; btn.textContent="Taking you to checkout…";
  if(window.track) try{ track('founding_click', {src: location.pathname}); }catch(_){}
  try{ localStorage.setItem('mycro_waitlist_email', email); }catch(_){}
  var go=function(){ location.href = window.MYCRO_FOUNDING_LINK + "?prefilled_email=" + encodeURIComponent(email); };
  // Fire-and-forget lead capture; redirect regardless after a short beat so we never block the sale.
  var redirected=false, redirect=function(){ if(!redirected){ redirected=true; go(); } };
  try{
    fetch(window.MYCRO_API+"/api/waitlist",{
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ email: email, source: location.pathname, ref: document.referrer||"", note:"founding-intent" })
    }).then(redirect, redirect);
  }catch(_){ redirect(); }
  setTimeout(redirect, 1200);
  return false;
}
