const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
test('cached generation produces working catalog shards, local calendars and enhanced pages',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-generation-'));
  try{
    fs.mkdirSync(path.join(dir,'scripts'));fs.mkdirSync(path.join(dir,'assets'));fs.mkdirSync(path.join(dir,'data'));
    for(const name of ['generate.js','build-catalog.js'])fs.copyFileSync(path.join(__dirname,'..','scripts',name),path.join(dir,'scripts',name));
    fs.copyFileSync(path.join(__dirname,'..','assets','radar-core.js'),path.join(dir,'assets','radar-core.js'));
    fs.copyFileSync(path.join(__dirname,'..','index.html'),path.join(dir,'index.html'));
    const movie={id:65,title:'Test film',slug:'test-film',release_date:'2026-09-01',countryReleases:{NL:'2026-10-01'},countryReleaseTypes:{NL:3},countryDigitalReleases:{NL:'2026-11-01'},releaseDataVersion:2,genres:['Drama'],genre_ids:[18],cast:[],directors:[],popularity:20,vote_count:0,watchProviders:{NL:{link:'https://www.themoviedb.org/movie/65/watch?locale=NL',flatrate:[{id:8,name:'Netflix',logo:null}]}},providersUpdatedAt:'2026-09-20T00:00:00Z'};
    const write=(name,value)=>fs.writeFileSync(path.join(dir,'data',name),JSON.stringify(value));
    write('movies.json',[movie]);write('manifest.json',{'65':{title:'Test film',slug:'test-film',previousSlugs:[]}});write('hits.json',{globalHitIds:[65],hitsByCountry:{},hitRanks:{}});write('date-history.json',{});
    execFileSync(process.execPath,[path.join(dir,'scripts','generate.js')],{env:{...process.env,REGEN_ONLY:'1'},stdio:'pipe'});
    const read=name=>JSON.parse(fs.readFileSync(path.join(dir,'data',name)));
    assert.deepEqual(read('search-index.json').movies[0].releaseGroups,[['2026-10-01','NL']]);assert.equal(read('catalog/01.json')['65'].watchProviders.NL.flatrate[0].name,'Netflix');
    assert.equal(read('calendar/2026-10/NL.json')[0].release_date,'2026-10-01');assert.deepEqual(read('calendar/2026-09/NL.json'),[]);assert.deepEqual(read('calendar/2026-10/JP.json'),[]);
    const html=fs.readFileSync(path.join(dir,'movie','test-film','index.html'),'utf8');assert(html.includes('id="radar-local-release"'));assert(html.includes('id="radar-watch-providers"'));assert(html.includes('/assets/radar-ui.js'));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
