'use strict';
const fs=require('node:fs');
const path=require('node:path');
function buildCatalog(movies,manifest,hits,history,dataDir){
  const shards=Array.from({length:64},()=>({}));
  const search=[];
  for(const movie of movies){
    const slug=hits.has(movie.id)?manifest[movie.id]?.slug:null;
    const details={...movie,slug,history:history[movie.id]||[]};
    shards[movie.id%64][movie.id]=details;
    // Many countries share a release date. Group them in the search payload
    // instead of repeating the same date up to 37 times per movie.
    const grouped={};for(const [cc,date] of Object.entries(movie.countryReleases||{})){(grouped[date] ||= []).push(cc);}
    const releaseGroups=Object.entries(grouped).map(([date,codes])=>[date,codes.join(' ')]);
    const item={id:movie.id,title:movie.title,year:(movie.release_date||'').slice(0,4),poster_path:movie.poster_path,backdrop_path:movie.backdrop_path,genre_ids:movie.genre_ids||[],releaseGroups,popularity:movie.popularity||0,slug,certification:manifest[movie.id]?.certification||null};
    if(movie.original_title&&movie.original_title!==movie.title)item.original_title=movie.original_title;
    search.push(item);
  }
  fs.mkdirSync(path.join(dataDir,'catalog'),{recursive:true});
  for(let n=0;n<64;n++)fs.writeFileSync(path.join(dataDir,'catalog',String(n).padStart(2,'0')+'.json'),JSON.stringify(shards[n]));
  fs.writeFileSync(path.join(dataDir,'search-index.json'),JSON.stringify({updatedAt:new Date().toISOString(),movies:search}));
  console.log('Catalog written: '+search.length+' search records, 64 detail shards');
}
module.exports={buildCatalog};
