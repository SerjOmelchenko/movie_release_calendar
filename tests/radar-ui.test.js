const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const {buildMoviePage,buildCalendarFiles}=require('../scripts/generate.js');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'index.html'),'utf8');
const mainScript=[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes("const IMG_BASE"));
const movies=[{id:1,title:'September Film',slug:'september-film',release_date:'2026-09-19',countryReleases:{NL:'2026-09-24',JP:'2026-10-09'},countryReleaseTypes:{NL:3,JP:3},countryDigitalReleases:{NL:'2026-11-01'},releaseDataVersion:2,genre_ids:[27],poster_path:'/poster.jpg',isHit:true,popularity:20,overview:'A movie.',watchProviders:{NL:{link:'https://www.themoviedb.org/movie/1/watch?locale=NL',flatrate:[{id:8,name:'Netflix',logo:'/logo.jpg'}],rent:[{id:2,name:'Apple TV',logo:null}]}},providersUpdatedAt:'2026-09-20T00:00:00Z',history:[{scope:'NL',on:'2026-09-20',from:'2026-09-23',to:'2026-09-24'}]},{id:2,title:'Digger',slug:null,release_date:'2026-10-01',countryReleases:{NL:'2026-10-01'},releaseDataVersion:2,genre_ids:[35],popularity:10,history:[]}];
function dom(html,url='https://moviereleaseradar.com/'){
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
  const page=new JSDOM(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''),{url,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=page.window;w.HTMLElement.prototype.scrollIntoView=function(){};w.TextEncoder=TextEncoder;w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=function(){};
  const RealDate=w.Date;w.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-09-20T12:00:00']));}};
  w.fetch=async url=>({ok:true,json:async()=>String(url).includes('manifest-public')?{'1':{slug:'september-film'}}:String(url).includes('search-index')?{movies}:String(url).includes('/catalog/')?Object.fromEntries(movies.map(m=>[m.id,m])):movies.filter(m=>m.release_date.startsWith('2026-09'))});
  w.localStorage.setItem('region','US');w.localStorage.setItem('cookie_consent','declined');
  for(const file of ['radar-core.js','radar-ui.js','radar-home.js'])w.eval(fs.readFileSync(path.join(root,'assets',file),'utf8'));
  return {page,w,errors,el:id=>w.document.getElementById(id)};
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('shared URL wins over browser preferences; no automatic tour or date shortcuts',async()=>{
  const {page,w,errors,el}=dom(source,'https://moviereleaseradar.com/?country=NL&month=2026-10&view=list&genre=27');w.eval(mainScript);await w.radarReady;
  assert.equal(el('region-select').value,'NL');assert.equal(el('genre-select').value,'27');assert(el('month-label').textContent.includes('October'));assert(el('view-toggle-track').classList.contains('on'));assert(!el('onboarding-overlay'));assert(!w.document.querySelector('[data-range]'));assert(!w.document.body.textContent.includes('Weekly digest'));
  el('share-view').click();assert(el('shared-url').value.includes('country=NL'));el('close-share').click();assert(!el('shared-url'));assert.equal(errors.length,0);page.window.close();
});
test('search finds a different month and a non-featured movie; clear restores calendar',async()=>{
  const {page,w,errors,el}=dom(source,'https://moviereleaseradar.com/?country=NL');w.eval(mainScript);await w.radarReady;
  el('search-input').value='Digger';el('search-input').dispatchEvent(new w.Event('input'));await wait(210);assert(el('calendar').textContent.includes('Digger'));assert(el('calendar').textContent.includes('Oct 1, 2026'));
  w.document.querySelector('[data-detail]').click();await wait(20);assert(el('modal-overlay').classList.contains('open'));assert(el('modal-radar-local').textContent.includes('October 1'));
  el('modal-close').click();el('clear-global-search').click();assert(!w.document.querySelector('.radar-results'));assert.equal(errors.length,0);page.window.close();
});
test('watchlist preserves IDs, shows local updates, and exports local dates',async()=>{
  const {page,w,errors,el}=dom(source,'https://moviereleaseradar.com/?country=NL');w.localStorage.setItem('watchlist','[1,2]');w.eval(mainScript);await w.radarReady;el('watchlist-btn').click();await wait(30);
  assert(el('watchlist-content').textContent.includes('Date changed'));assert(el('watchlist-content').textContent.includes('Sep 24'));assert.equal(w.RadarUI.watchlist().length,2);el('export-watchlist').click();assert(el('watchlist-export-status').textContent.includes('downloaded'));
  w.document.querySelector('[data-remove="2"]').click();await wait(20);assert.deepEqual([...w.RadarUI.watchlist()],[1]);el('watchlist-close').click();assert(!el('watchlist-overlay').classList.contains('open'));assert.equal(errors.length,0);page.window.close();
});
test('movie page updates local date, calendar link, providers and unknown states together',()=>{
  const html=buildMoviePage(movies[0]);const {page,w,errors,el}=dom(html,'https://moviereleaseradar.com/movie/september-film/?country=JP');w.RadarUI.mountMovie(movies[0]);
  assert(el('radar-local-release').textContent.includes('October 9'));assert(w.document.querySelector('[data-google]').href.includes('20261009'));assert(el('radar-watch-providers').textContent.includes('No subscription'));
  const select=el('radar-local-release').querySelector('[data-country]');select.value='NL';select.dispatchEvent(new w.Event('change'));assert(el('radar-local-release').textContent.includes('September 24'));assert(el('radar-watch-providers').textContent.includes('Netflix'));
  el('radar-watch-providers').querySelector('[data-kind="purchase"]').click();assert(el('radar-watch-providers').textContent.includes('Apple TV'));w.RadarUI.setCountry('DE');assert(el('radar-local-release').textContent.includes('Local date not announced'));assert(!w.document.querySelector('[data-google]'));assert.equal(errors.length,0);page.window.close();
});
test('search error offers a working retry',async()=>{
  const {page,w,el}=dom(source,'https://moviereleaseradar.com/?country=NL');const original=w.fetch;w.fetch=async url=>String(url).includes('search-index')?{ok:false}:original(url);w.eval(mainScript);await w.radarReady;
  el('search-input').value='Digger';el('search-input').dispatchEvent(new w.Event('input'));await wait(210);assert(el('retry-search'));w.fetch=original;el('retry-search').click();await wait(210);assert(el('calendar').textContent.includes('Digger'));page.window.close();
});
test('genre filters expose non-featured matches without duplicating Other releases',async()=>{
  const {page,w,el}=dom(source,'https://moviereleaseradar.com/?country=NL');const original=w.fetch;
  w.fetch=async url=>String(url).includes('/calendar/')?{ok:true,json:async()=>[{id:3,title:'Small horror film',release_date:'2026-09-24',countryReleases:{NL:'2026-09-24'},genre_ids:[27],isHit:false,popularity:1}]}:original(url);
  w.eval(mainScript);await w.radarReady;el('genre-select').value='27';el('genre-select').dispatchEvent(new w.Event('change'));
  const cell=w.document.querySelector('.day-cell[data-date="2026-09-24"]');assert(cell.textContent.includes('Small horror film'));assert(!cell.querySelector('.other-releases-pill'));page.window.close();
});
test('a slow search response cannot overwrite a newer query or a cleared search',async()=>{
  const {page,w,el}=dom(source,'https://moviereleaseradar.com/?country=NL');const original=w.fetch;let release;
  w.fetch=async url=>String(url).includes('search-index')?{ok:true,json:()=>new Promise(resolve=>{release=resolve;})}:original(url);
  w.eval(mainScript);await w.radarReady;
  el('search-input').value='Digger';el('search-input').dispatchEvent(new w.Event('input'));await wait(180);
  el('search-input').value='September';el('search-input').dispatchEvent(new w.Event('input'));await wait(180);release({movies});await wait(20);
  assert(el('calendar').textContent.includes('September Film'));assert(!el('calendar').textContent.includes('Digger'));
  el('search-input').value='Digger';el('search-input').dispatchEvent(new w.Event('input'));el('search-input').value='';el('search-input').dispatchEvent(new w.Event('input'));await wait(180);assert(w.document.querySelector('.calendar-grid'));page.window.close();
});
test('movie JSON escapes script-breaking titles',()=>{
  const html=buildMoviePage({...movies[0],title:'</script><script>alert(1)</script>'});const data=html.match(/id="radar-movie-data">([\s\S]*?)<\/script>/)[1];assert.equal(JSON.parse(data).title,'</script><script>alert(1)</script>');assert(!data.includes('</script>'));
});
test('provider section opens rental options when there are no subscription offers',()=>{
  const movie={...movies[0],watchProviders:{NL:{link:'https://www.themoviedb.org/movie/1/watch?locale=NL',rent:[{id:2,name:'Apple TV',logo:null}]}}};
  const {page,w,el}=dom(buildMoviePage(movie),'https://moviereleaseradar.com/movie/september-film/?country=NL');
  w.RadarUI.mountMovie(movie);
  const host=el('radar-watch-providers');
  assert(host.textContent.includes('Apple TV'));
  assert.equal(host.querySelector('[data-kind="purchase"]').getAttribute('aria-pressed'),'true');
  host.querySelector('[data-kind="subscription"]').click();
  assert(host.textContent.includes('No subscription'));
  page.window.close();
});
