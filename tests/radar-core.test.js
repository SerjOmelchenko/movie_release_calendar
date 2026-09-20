const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('../assets/radar-core.js');
test('local dates never silently fall back to worldwide dates',()=>{
  assert.equal(C.localDate({release_date:'2026-09-16',countryReleases:{JP:'2026-10-09'}},'NL'),null);
  assert.equal(C.localDate({countryReleases:{NL:'2026-02-30'}},'NL'),null);
  assert.equal(C.localDate({releaseGroups:[['2026-10-01','NL BE'],['2026-10-02','US']]},'NL'),'2026-10-01');
  assert.equal(C.localDate({releaseGroups:[['2026-10-01','NL BE']]},'L'),null);
});
test('release extraction separates theatrical, digital, premiere and TV dates',()=>{
  const out=C.extractReleases({results:[{iso_3166_1:'NL',release_dates:[{type:1,release_date:'2026-09-01T00:00:00Z'},{type:3,release_date:'2026-09-24T00:00:00Z'},{type:2,release_date:'2026-09-20T00:00:00Z'},{type:4,release_date:'2026-10-20T00:00:00Z'}]},{iso_3166_1:'JP',release_dates:[{type:6,release_date:'2026-09-21T00:00:00Z'}]}]});
  assert.deepEqual(out.countryReleases,{NL:'2026-09-20'});assert.deepEqual(out.countryDigitalReleases,{NL:'2026-10-20'});assert.equal(out.countryReleaseTypes.NL,2);assert.equal(out.releaseDataVersion,2);
  assert.throws(()=>C.extractReleases({success:false}));
});
test('regional announcement, movement and withdrawal are distinct events',()=>{
  const previous={countryReleases:{NL:'2026-10-01',US:'2026-10-02'}};
  const next={countryReleases:{NL:'2026-10-08',JP:'2026-10-09'}};
  assert.deepEqual(C.diffReleases(previous,next,'2026-09-20').map(x=>x.kind),['changed','withdrawn','announced']);
  assert.equal(C.changesFor(next,C.diffReleases(previous,next,'2026-09-20'),'JP')[0].from,null);
  assert.equal(C.changesFor(next,C.diffReleases(previous,next,'2026-09-20'),'NL','2026-09-21').length,0);
});
test('search matches all months, accents and non-featured titles with filters',()=>{
  const movies=[{id:1,title:'Café Tomorrow',countryReleases:{NL:'2027-01-01'},genre_ids:[18],popularity:2},{id:2,title:'Tomorrow',countryReleases:{NL:'2026-09-01'},genre_ids:[27],popularity:10}];
  assert.equal(C.searchMovies(movies,{query:'cafe'}).length,1);assert.equal(C.searchMovies(movies,{query:'tomorrow',genre:'18'})[0].id,1);assert.equal(C.searchMovies(movies,{query:'tomorrow',rating:'R'}).length,0);
});
test('shared view round-trips and rejects invalid fields',()=>{
  const state={country:'NL',month:'2026-10',view:'list',query:'A & B',genre:'27',rating:'R'};assert.deepEqual(C.parseView(C.viewQuery(state)),state);
  assert.deepEqual(C.parseView('?country=XX&month=2026-13&genre=999&view=grid&rating=bad'),{genre:'',rating:''});assert.equal(C.parseView('?m=2026-10').month,'2026-10');
});
test('exports use local dates, stable IDs, next-day end and safe Unicode folding',()=>{
  const movies=[{id:1,title:'A, B;\n'+('🎬'.repeat(35)),slug:'a-b',release_date:'2026-01-01',countryReleases:{NL:'2026-12-31'},releaseDataVersion:2},{id:2,title:'Unknown',release_date:'2026-11-01'}];
  const ics=C.calendar(movies,'NL',new Date('2026-09-20T12:00:00Z'));
  assert(ics.includes('DTSTART;VALUE=DATE:20261231'));assert(ics.includes('DTEND;VALUE=DATE:20270101'));assert(ics.includes('UID:movie-1-NL@moviereleaseradar.com'));assert(!ics.includes('Unknown'));assert(ics.includes('A\\, B\\;\\n'));
  for(const line of ics.split('\r\n'))assert(Buffer.byteLength(line)<=75);
  assert.equal(C.calendar([movies[1]],'NL'),null);
});
test('provider links allow only the supplied TMDB HTTPS origin',()=>{
  assert.equal(C.safeProviderLink('javascript:alert(1)'),null);assert.equal(C.safeProviderLink('https://www.themoviedb.org.evil.test/'),null);
  const p=C.extractProviders({results:{NL:{link:'https://www.themoviedb.org/movie/1/watch?locale=NL',flatrate:[{provider_id:8,provider_name:'Netflix',logo_path:'/logo.jpg'}]}}});assert.equal(p.NL.flatrate[0].name,'Netflix');assert.deepEqual(p.NL.rent,[]);assert.throws(()=>C.extractProviders({}));
});

test('popularity uses only the last seven calendar days, deduplicates days and replaces today',()=>{
  const {recentPopularity}=require('../assets/radar-core.js');
  const today='2026-09-20';
  assert.equal(recentPopularity({popularity:70},[['2026-07-09',1],['2026-09-13',999],['2026-09-14',14],['2026-09-19',35],['2026-09-19',56],['2026-09-20',999],['2026-09-21',999]],today),(14+56+70)/3);
  assert.equal(recentPopularity({popularity:557},[['2026-07-09',7]],today),557);
});

test('moved and withdrawn releases cannot occupy ranks in the old country/month',()=>{
  const {computeFinalRanks}=require('../scripts/generate.js');
  const movies={991:{id:991,popularity:100,countryReleases:{NL:'2026-10-01'}},992:{id:992,popularity:20,countryReleases:{NL:'2026-09-10'}},993:{id:993,popularity:999,countryReleases:{}}};
  const hits={NL:{'2026-09':new Set([991,992,993]),'2026-10':new Set([991])}};
  const ranks=computeFinalRanks(hits,movies);
  assert.deepEqual(ranks.NL['2026-09'],{992:1});
  assert.deepEqual(ranks.NL['2026-10'],{991:1});
  assert.deepEqual([...hits.NL['2026-09']],[992]);
});
