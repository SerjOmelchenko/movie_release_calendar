'use strict';
// One-time migration of public movie pages to typed local dates and providers.
// The normal nightly generator refreshes these fields for its whole fetch window.
const fs=require('node:fs');
const path=require('node:path');
const {fetchMovieDetails}=require('./generate.js');
const C=require('../assets/radar-core.js');
async function main(){
  if(process.argv.includes('--check')){
    try { const movie=await fetchMovieDetails(1423191);console.log(JSON.stringify({releaseDataVersion:movie.releaseDataVersion,countries:Object.keys(movie.countryReleases).length,providerCountries:Object.keys(movie.watchProviders||{}).length})); }
    catch(error){console.error('TMDB check: '+error.message);process.exitCode=1;}
    return;
  }
  const dir=path.join(__dirname,'..','data');
  const movies=JSON.parse(fs.readFileSync(path.join(dir,'movies.json')));
  const hits=new Set(JSON.parse(fs.readFileSync(path.join(dir,'hits.json'))).globalHitIds);
  const requested=process.argv.slice(2).map(Number).filter(Number.isSafeInteger);
  const targets=movies.filter(m=>requested.length?requested.includes(m.id):hits.has(m.id));
  const history=JSON.parse(fs.readFileSync(path.join(dir,'date-history.json')));
  const today=new Date().toISOString().slice(0,10);let done=0,failed=0,providers=0;
  for(let i=0;i<targets.length;i+=10){
    const batch=targets.slice(i,i+10);
    const results=await Promise.allSettled(batch.map(m=>fetchMovieDetails(m.id)));
    results.forEach((r,n)=>{
      if(r.status!=='fulfilled'){if(r.reason.status===401||r.reason.status===403)throw r.reason;failed++;return;}
      const movie=batch[n],fresh=r.value;
      if(movie.releaseDataVersion===2){const changes=C.diffReleases(movie,fresh,today);if(changes.length)history[movie.id]=[...(history[movie.id]||[]),...changes].slice(-50);}
      if(fresh.watchProviders===null){fresh.watchProviders=movie.watchProviders??null;fresh.providersUpdatedAt=movie.providersUpdatedAt??null;}else providers++;
      Object.assign(movie,fresh,{dataUpdatedAt:today});done++;
    });
    if((i+10)%100===0)console.log(`${Math.min(i+10,targets.length)}/${targets.length} processed (${done} updated; ${failed} failed)`);
  }
  fs.writeFileSync(path.join(dir,'movies.json'),JSON.stringify(movies,null,2));
  fs.writeFileSync(path.join(dir,'date-history.json'),JSON.stringify(history));
  console.log(JSON.stringify({updated:done,providerResponses:providers,failed}));
  if(failed)process.exitCode=1;
}
main().catch(error=>{console.error('Catalog enrichment failed: '+error.message+'. Existing data was retained.');process.exitCode=1;});
