(function () {
  'use strict';
  const C=window.RadarCore,U=window.RadarUI;
  let app=null,searchRequest=0,searchTimer=null,panelRequest=0,panelOpen=false,watchlistReturn=null;
  const $=id=>document.getElementById(id);
  function syncUrl(){if(!app)return;const state=app.state();history.replaceState(null,'',location.pathname+C.viewQuery(state)+location.hash);}
  function init(adapter){
    app=adapter;
    const state=app.state();U.setCountry(state.country);
    const share=document.createElement('button');share.id='share-view';share.className='radar-btn';share.textContent='↗ Share this view';share.onclick=openShare;document.querySelector('.filters-bar').append(share);
    window.addEventListener('radar:country',event=>{app.changeCountry(event.detail);syncUrl();showCountryHint();if(panelOpen)openWatchlist();});
    window.addEventListener('radar:watchlist',()=>{app.refreshWatchlist();document.querySelectorAll('[data-save]').forEach(button=>{const saved=U.watchlist().includes(Number(button.dataset.save));button.textContent=saved?'♥ Saved':'♡ Save';button.setAttribute('aria-pressed',String(saved));const title=(button.getAttribute('aria-label')||'movie').replace(/^(Save |Remove )/,'');button.setAttribute('aria-label',(saved?'Remove ':'Save ')+title);});if(panelOpen)openWatchlist();});
    window.addEventListener('popstate',()=>app.applyUrl(C.parseView(location.search)));
    showCountryHint();
  }
  function cancelSearch(){searchRequest++;clearTimeout(searchTimer);}
  function renderSearch(){
    if(!app)return;
    syncUrl();const request=++searchRequest;clearTimeout(searchTimer);
    const target=$('calendar');target.style.display='block';$('status').style.display='none';
    target.innerHTML='<p class="radar-small">Searching all months…</p>';
    searchTimer=setTimeout(async()=>{
      try{
        const index=await U.loadIndex();if(request!==searchRequest)return;
        const state=app.state(),matches=C.searchMovies(index,state);let visible=24;
        const draw=()=>{
          if(request!==searchRequest)return;
          target.innerHTML='<div class="radar-search-head"><div><div class="radar-kicker">All months</div><h2>Results for “'+U.esc(state.query)+'”</h2><p class="radar-small">'+matches.length.toLocaleString()+' matching '+(matches.length===1?'movie':'movies')+' · '+C.countries[state.country]+' dates</p></div><button class="radar-btn" id="clear-global-search">Clear search</button></div><div class="radar-results">'+matches.slice(0,visible).map(m=>{
            const local=C.localDate(m,state.country),genre=(m.genre_ids||[]).map(id=>app.genres[id]).filter(Boolean).join(' · '),saved=U.watchlist().includes(m.id),art=m.backdrop_path||m.poster_path;
            return '<article class="radar-result">'+(art?'<div class="radar-result-cover"><img src="https://image.tmdb.org/t/p/w780'+U.esc(art)+'" alt="'+U.esc(m.title)+'" loading="lazy"></div>':'<div class="radar-result-cover radar-no-art">'+U.esc(m.title)+'</div>')+'<div class="radar-result-body"><span class="radar-chip">'+(local?C.formatDate(local)+' · '+state.country:'Local date not announced')+'</span><h3>'+U.esc(m.title)+(m.year?' <span class="radar-small">('+U.esc(m.year)+')</span>':'')+'</h3><p>'+U.esc(genre)+'</p><div class="radar-actions">'+(m.slug?'<a class="radar-btn" href="/movie/'+encodeURIComponent(m.slug)+'/?country='+state.country+'" data-detail-link>View movie →</a>':'<button class="radar-btn" data-detail="'+m.id+'">View movie →</button>')+'<button class="radar-btn" data-save="'+m.id+'" aria-pressed="'+saved+'" aria-label="'+(saved?'Remove ':'Save ')+U.esc(m.title)+'">'+(saved?'♥ Saved':'♡ Save')+'</button></div></div></article>';
          }).join('')+'</div>'+(!matches.length?'<div class="radar-empty"><p>No titles match this search and these filters.</p><button class="radar-btn" id="reset-search-filters">Clear genre and rating filters</button></div>':'')+(matches.length>visible?'<button class="radar-btn radar-load-more" id="more-search">Show more results</button>':'');
          $('clear-global-search').onclick=()=>app.clearSearch();
          $('reset-search-filters')?.addEventListener('click',()=>app.clearFilters());
          $('more-search')?.addEventListener('click',()=>{visible+=24;draw();});
          target.querySelectorAll('[data-detail-link]').forEach(a=>a.onclick=()=>app.saveMonth());
          target.querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>{const saved=U.toggle(Number(b.dataset.save));b.textContent=saved?'♥ Saved':'♡ Save';b.setAttribute('aria-pressed',String(saved));});
          target.querySelectorAll('[data-detail]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const movie=await U.loadMovie(Number(b.dataset.detail));app.openMovie(movie);}catch(e){U.announce(e.message);}finally{b.disabled=false;}});
        };draw();
      }catch(error){if(request!==searchRequest)return;target.innerHTML='<div class="radar-empty"><p>'+U.esc(error.message)+'</p><button class="radar-btn" id="retry-search">Retry search</button></div>';$('retry-search').onclick=renderSearch;}
    },160);
  }
  function showCountryHint(){
    if(!app)return;
    const state=app.state();let hint=$('radar-country-hint');
    let confirmed=false;try{confirmed=localStorage.getItem('region_confirmed')===state.country;}catch{}
    if(confirmed){hint?.remove();return;}
    if(!hint){hint=document.createElement('div');hint.id='radar-country-hint';hint.className='radar-strip';document.querySelector('.seo-intro').after(hint);}
    hint.innerHTML='<div><strong>Showing releases in '+C.countries[state.country]+'</strong><p>Your country sets the dates you see. You can change it anytime.</p></div><div class="radar-actions"><button class="radar-btn" id="choose-country">Change country</button><button class="radar-btn primary" id="confirm-country">Looks right ✓</button></div>';
    $('choose-country').onclick=()=>{$('region-select').focus();$('region-select').scrollIntoView({block:'center',behavior:'smooth'});};
    $('confirm-country').onclick=()=>{try{localStorage.setItem('region_confirmed',state.country);}catch{}hint.remove();};
  }
  function focusDialog(dialog,close,returnTo){
    const keydown=event=>{if(event.key==='Escape'){event.preventDefault();close();return;}if(event.key!=='Tab')return;const items=[...dialog.querySelectorAll('button:not(:disabled),a[href],input,select')].filter(e=>!e.hidden&&e.getClientRects().length);const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}};
    dialog.addEventListener('keydown',keydown);dialog.querySelector('button,input,select,a[href]')?.focus();return()=>{dialog.removeEventListener('keydown',keydown);returnTo?.focus();};
  }
  function openShare(){
    const state=app.state();syncUrl();const url='https://moviereleaseradar.com/'+C.viewQuery(state),returnTo=document.activeElement;
    const overlay=document.createElement('div');overlay.className='radar-share-overlay';overlay.innerHTML='<div class="radar-share-box" role="dialog" aria-modal="true" aria-labelledby="share-title"><div class="radar-kicker">Share your selection</div><h2 id="share-title">Share this view</h2><p class="radar-small">'+C.countries[state.country]+' · '+U.esc(state.month)+' · '+state.view+' view</p><label class="radar-small" for="shared-url">Link</label><input id="shared-url" readonly value="'+U.esc(url)+'"><div class="radar-actions"><button class="radar-btn primary" id="copy-shared-url">Copy link</button><button class="radar-btn" id="close-share">Done</button></div><p id="copy-result" class="radar-small" role="status"></p></div>';
    document.body.append(overlay);const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';let cleanup=()=>{};const close=()=>{overlay.remove();document.body.style.overflow=previousOverflow;cleanup();};cleanup=focusDialog(overlay.querySelector('[role=dialog]'),close,returnTo);$('close-share').onclick=close;overlay.onclick=e=>{if(e.target===overlay)close();};
    $('copy-shared-url').onclick=async()=>{try{await navigator.clipboard.writeText(url);$('copy-result').textContent='Link copied.';}catch{$('shared-url').focus();$('shared-url').select();$('copy-result').textContent='Press Ctrl+C or ⌘C to copy the selected link.';}};
  }
  let panelCleanup=()=>{};
  async function openWatchlist(){
    if(!app)return;
    const request=++panelRequest,ids=U.watchlist(),country=app.state().country;
    if(!panelOpen){watchlistReturn=document.activeElement;panelOpen=true;$('watchlist-overlay').classList.add('open');document.body.style.overflow='hidden';panelCleanup=focusDialog($('watchlist-panel'),()=>app.closeWatchlist(),watchlistReturn);}
    const content=$('watchlist-content');content.innerHTML='<div class="spinner" style="margin:2rem auto"></div>';
    const result=await Promise.allSettled(ids.map(id=>U.loadMovie(id)));if(request!==panelRequest||!panelOpen)return;
    const movies=result.filter(r=>r.status==='fulfilled').map(r=>r.value),failed=ids.filter((_,i)=>result[i].status==='rejected');
    const today=C.day(),since=C.addDays(today,-30),meta=U.read('watchlistMeta',{});
    const updates=new Map(movies.map(m=>[m.id,C.changesFor(m,m.history,country,meta[m.id]?.savedAt>since?meta[m.id].savedAt:since)]));
    const count=[...updates.values()].filter(a=>a.length).length;
    let tools=$('radar-watchlist-tools');if(!tools){tools=document.createElement('div');tools.id='radar-watchlist-tools';tools.className='radar-panel-tools';$('watchlist-header').after(tools);}
    tools.innerHTML='<div class="radar-actions"><span class="radar-small">'+C.countries[country]+'</span>'+(count?'<span class="radar-chip">'+count+' local '+(count===1?'update':'updates')+'</span>':'')+'</div><p>Local release dates and recent changes for your saved movies.</p><button class="radar-btn" id="export-watchlist"'+(!movies.some(m=>C.localDate(m,country))?' disabled':'')+'>＋ Export watchlist (.ics)</button><p class="radar-small" id="watchlist-export-status" role="status"></p>';
    $('export-watchlist').onclick=()=>{const ics=C.calendar(movies,country);if(!ics)return;U.download(ics,'movie-release-radar-'+country+'.ics');const unknown=movies.filter(m=>!C.localDate(m,country)).length;$('watchlist-export-status').textContent='Calendar downloaded. '+(unknown?unknown+' movie(s) with unknown local dates were omitted. ':'')+'Downloaded events do not update automatically.';};
    const coming=movies.filter(m=>!C.localDate(m,country)||C.localDate(m,country)>=today).sort((a,b)=>(C.localDate(a,country)||'9999').localeCompare(C.localDate(b,country)||'9999'));
    const released=movies.filter(m=>C.localDate(m,country)&&C.localDate(m,country)<today).sort((a,b)=>C.localDate(b,country).localeCompare(C.localDate(a,country)));
    const cards=list=>list.map(m=>{const local=C.localDate(m,country),change=updates.get(m.id)?.[0];let badge='';if(change)badge='<div class="radar-update">'+(!change.from?'✦ Local release announced: '+C.formatDate(change.to):!change.to?'Release date no longer announced':'↻ Date changed: <s>'+C.formatDate(change.from)+'</s> → '+C.formatDate(change.to))+'<span class="radar-small radar-change-date">Updated '+C.formatDate(change.on)+'</span></div>';else if(local&&local>=today&&local<=C.addDays(today,7))badge='<span class="radar-chip green">Out '+(local===today?'today':'within 7 days')+'</span>';
      return '<article class="watchlist-item"><div class="watchlist-item-poster">'+(m.poster_path?'<img src="https://image.tmdb.org/t/p/w185'+U.esc(m.poster_path)+'" alt="" loading="lazy">':'')+'</div><div class="watchlist-item-info">'+(m.slug?'<a class="watchlist-item-title" href="/movie/'+encodeURIComponent(m.slug)+'/?country='+country+'">'+U.esc(m.title)+'</a>':'<button class="radar-title-button" data-movie="'+m.id+'">'+U.esc(m.title)+'</button>')+'<div class="watchlist-item-date">'+C.formatDate(local)+'</div>'+badge+'</div><button class="watchlist-remove-btn" data-remove="'+m.id+'" aria-label="Remove '+U.esc(m.title)+' from watchlist">♥</button></article>';}).join('');
    content.innerHTML=(!ids.length?'<p class="watchlist-empty">No movies saved yet.<br>Choose ♡ on a movie to start your release radar.</p>':'')+(coming.length?'<h3 class="watchlist-section-heading">Coming soon</h3>'+cards(coming):'')+(released.length?'<h3 class="watchlist-section-heading">Released</h3>'+cards(released):'')+(failed.length?'<p class="radar-small">'+failed.length+' saved movie(s) could not be loaded. They remain in your watchlist.</p><button class="radar-btn" id="retry-watchlist">Retry</button>':'');
    $('retry-watchlist')?.addEventListener('click',openWatchlist);
    content.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>U.toggle(Number(b.dataset.remove)));
    content.querySelectorAll('[data-movie]').forEach(b=>b.onclick=()=>{app.closeWatchlist();app.openMovie(movies.find(m=>m.id===Number(b.dataset.movie)));});
    content.querySelectorAll('a').forEach(a=>a.onclick=()=>app.saveMonth());
  }
  function closeWatchlist(){panelOpen=false;panelRequest++;panelCleanup();panelCleanup=()=>{};}
  window.RadarHome={init,renderSearch,cancelSearch,syncUrl,openWatchlist,closeWatchlist,showCountryHint};
})();
