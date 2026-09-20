(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RadarCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const countries = { AU:'Australia',AT:'Austria',BE:'Belgium',BR:'Brazil',BG:'Bulgaria',CA:'Canada',CN:'China',HR:'Croatia',CY:'Cyprus',CZ:'Czech Republic',DK:'Denmark',EE:'Estonia',FI:'Finland',FR:'France',DE:'Germany',GR:'Greece',HU:'Hungary',IN:'India',IE:'Ireland',IT:'Italy',JP:'Japan',LV:'Latvia',LT:'Lithuania',LU:'Luxembourg',MT:'Malta',NL:'Netherlands',PL:'Poland',PT:'Portugal',RO:'Romania',SK:'Slovakia',SI:'Slovenia',KR:'South Korea',ES:'Spain',SE:'Sweden',GB:'United Kingdom',UA:'Ukraine',US:'United States' };
  const genreIds = [28,12,16,35,80,99,18,10751,14,36,27,10402,9648,10749,878,10770,53,10752,37];
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T12:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
  }
  function day(value = new Date()) { return value.getFullYear()+'-'+String(value.getMonth()+1).padStart(2,'0')+'-'+String(value.getDate()).padStart(2,'0'); }
  function addDays(value, count) { const date = new Date(value+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()+count); return date.toISOString().slice(0,10); }
  function formatDate(value, long = false) { return validDate(value) ? new Date(value+'T12:00:00Z').toLocaleDateString('en-US',{month:long?'long':'short',day:'numeric',year:'numeric',timeZone:'UTC'}) : 'Local date not announced'; }
  function localDate(movie, country) { const date = movie?.countryReleases?.[country] || movie?.releaseGroups?.find(group=>(' '+group[1]+' ').includes(' '+country+' '))?.[0]; return validDate(date) ? date : null; }
  function releaseLabel(movie, country) { return movie.releaseDataVersion === 2 ? (movie.countryReleaseTypes?.[country] === 2 ? 'Limited cinema release' : 'In cinemas') : 'Reported local release'; }
  function extractReleases(payload) {
    if (!Array.isArray(payload?.results)) throw new Error('Release dates response is incomplete');
    const countryReleases={}, countryDigitalReleases={}, countryReleaseTypes={};
    for (const country of payload.results) {
      if (!/^[A-Z]{2}$/.test(country.iso_3166_1)) continue;
      const records=(country.release_dates||[]).filter(r=>validDate(r.release_date?.slice(0,10))).sort((a,b)=>a.release_date.localeCompare(b.release_date));
      const theatrical=records.find(r=>r.type===2||r.type===3), digital=records.find(r=>r.type===4);
      if(theatrical){countryReleases[country.iso_3166_1]=theatrical.release_date.slice(0,10);countryReleaseTypes[country.iso_3166_1]=theatrical.type;}
      if(digital)countryDigitalReleases[country.iso_3166_1]=digital.release_date.slice(0,10);
    }
    return {countryReleases,countryDigitalReleases,countryReleaseTypes,releaseDataVersion:2};
  }
  function safeProviderLink(value) {
    try { const url=new URL(value);return url.protocol==='https:' && url.hostname==='www.themoviedb.org' ? url.href : null; } catch{return null;}
  }
  function extractProviders(payload) {
    if(!payload || typeof payload.results!=='object' || payload.results===null || Array.isArray(payload.results)) throw new Error('Provider response is incomplete');
    const result={};
    for(const [country,entry] of Object.entries(payload.results)){
      if(!/^[A-Z]{2}$/.test(country))continue;
      const record={link:safeProviderLink(entry.link)};
      for(const kind of ['flatrate','free','ads','rent','buy'])record[kind]=(entry[kind]||[]).filter(p=>Number.isInteger(p.provider_id)&&typeof p.provider_name==='string').map(p=>({id:p.provider_id,name:p.provider_name,logo:/^\/[\w.-]+$/.test(p.logo_path||'')?p.logo_path:null}));
      result[country]=record;
    }
    return result;
  }
  function parseView(search) {
    const p=new URLSearchParams(search),out={};const country=p.get('country'),month=p.get('month')||p.get('m');
    if(countries[country])out.country=country;
    if(month&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))out.month=month;
    if(['calendar','list'].includes(p.get('view')))out.view=p.get('view');
    if(p.has('genre'))out.genre=genreIds.includes(Number(p.get('genre')))?p.get('genre'):'';
    if(p.has('rating'))out.rating=['G','PG','PG-13','R','NC-17'].includes(p.get('rating'))?p.get('rating'):'';
    if(p.has('q'))out.query=p.get('q').slice(0,200);
    return out;
  }
  function viewQuery(state) {
    const p=new URLSearchParams();if(countries[state.country])p.set('country',state.country);
    if(state.month)p.set('month',state.month);if(state.genre)p.set('genre',state.genre);if(state.rating)p.set('rating',state.rating);
    p.set('view',state.view==='list'?'list':'calendar');if(state.query?.trim())p.set('q',state.query.trim());return '?'+p.toString();
  }
  function recentPopularity(movie, history, today, days = 7) {
    const cutoff = addDays(today, 1 - days);
    const samples = new Map();
    for (const [date, score] of history) {
      if (validDate(date) && date >= cutoff && date < today && Number.isFinite(score) && score >= 0) samples.set(date, score);
    }
    samples.set(today, Number.isFinite(movie.popularity) && movie.popularity >= 0 ? movie.popularity : 0);
    return [...samples.values()].reduce((sum, score) => sum + score, 0) / samples.size;
  }
  function normalize(value) { return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
  function searchMovies(movies, state) {
    const query=normalize(state.query).trim(),terms=query.split(/\s+/).filter(Boolean);
    return movies.filter(m=>terms.every(t=>normalize(m.title+' '+(m.original_title||'')).includes(t))&&(!state.genre||(m.genre_ids||[]).includes(Number(state.genre)))&&(!state.rating||m.certification===state.rating))
      .sort((a,b)=>Number(normalize(b.title)===query)-Number(normalize(a.title)===query)||(b.popularity||0)-(a.popularity||0)||a.title.localeCompare(b.title));
  }
  function changesFor(movie, history, country, since='') {
    return (history||[]).filter(h=>h.scope===country&&validDate(h.on)&&(!since||h.on>=since)&&h.from!==h.to&&(!h.to||validDate(h.to))).sort((a,b)=>b.on.localeCompare(a.on));
  }
  function diffReleases(previous, movie, on) {
    const entries=[];
    for(const cc of new Set([...Object.keys(previous?.countryReleases||{}),...Object.keys(movie.countryReleases||{})])){
      const from=localDate(previous,cc),to=localDate(movie,cc);
      if(from!==to)entries.push({on,scope:cc,from,to,kind:!from?'announced':!to?'withdrawn':'changed'});
    }
    return entries;
  }
  function icsEscape(value) { return String(value||'').replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;'); }
  function foldLine(line) {
    const parts=[];let chunk='',bytes=0;
    for(const c of line){const size=new TextEncoder().encode(c).length;if(bytes+size>75){parts.push(chunk);chunk=' ';bytes=1;}chunk+=c;bytes+=size;}
    parts.push(chunk);return parts.join('\r\n');
  }
  function calendar(movies,country,now=new Date()) {
    const eligible=movies.filter(m=>localDate(m,country));
    if(!eligible.length)return null;
    const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Movie Release Radar//Release Calendar//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
    const stamp=now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
    for(const m of eligible){const date=localDate(m,country);const url='https://moviereleaseradar.com/'+(m.slug?'movie/'+encodeURIComponent(m.slug)+'/':viewQuery({country,month:date.slice(0,7),query:m.title}));
      lines.push('BEGIN:VEVENT','UID:movie-'+m.id+'-'+country+'@moviereleaseradar.com','DTSTAMP:'+stamp,'DTSTART;VALUE=DATE:'+date.replace(/-/g,''),'DTEND;VALUE=DATE:'+addDays(date,1).replace(/-/g,''),'SUMMARY:'+icsEscape(m.title+' — '+countries[country]+' release'),'DESCRIPTION:'+icsEscape(releaseLabel(m,country)+'. Dates may change.\n'+url),'URL:'+url,'END:VEVENT');}
    lines.push('END:VCALENDAR');return lines.map(foldLine).join('\r\n')+'\r\n';
  }
  return {countries,genreIds,validDate,day,addDays,formatDate,localDate,releaseLabel,extractReleases,extractProviders,safeProviderLink,parseView,viewQuery,recentPopularity,normalize,searchMovies,changesFor,diffReleases,calendar};
});
