// Combined real form handlers + actual Supabase helper, with an isolated fake HTTP API.
// No live accounts, passwords, or database rows are created.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const source=fs.readFileSync('public/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/,'');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture({confirmation=false}={}){
  const local=new Map(), calls=[], rows=[], fields=new Map(), warnings=[];
  const storage=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)});
  const get=id=>{
    if(!fields.has(id)) fields.set(id,{value:'',checked:false,hidden:true,disabled:false,validity:{badInput:false},dataset:{},innerHTML:'',textContent:'',listeners:{},
      focus(){},addEventListener(event,fn){this.listeners[event]=fn;},setAttribute(){},removeAttribute(){},
      closest(){return {classList:{toggle(){}}};},querySelectorAll(){return [];}});
    return fields.get(id);
  };
  const names=new Map([['driver','Driver One'],['rider','Rider Two']]);
  const account=id=>({id,email:`${id}@byu.edu`});
  global.localStorage=storage(local);
  global.fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;
    calls.push({url,body});
    const reply=data=>({ok:true,status:200,json:async()=>data});
    if(url==='/supabase-config.json') return reply({url:'https://hitch.test',publishableKey:'public-test'});
    const u=new URL(url), who=options.headers?.Authorization?.replace('Bearer token-','');
    if(u.pathname.endsWith('/token')){
      const id=body.email.split('@')[0];
      return reply({access_token:`token-${id}`,refresh_token:`refresh-${id}`,expires_in:3600,user:account(id)});
    }
    if(u.pathname.endsWith('/signup')){
      const id=body.email.split('@')[0]; names.set(id,body.data.full_name);
      if(confirmation) return reply({user:{...account(id),identities:[{}]}});
      return reply({access_token:`token-${id}`,refresh_token:`refresh-${id}`,expires_in:3600,user:account(id)});
    }
    if(u.pathname.endsWith('/logout')) return reply({});
    if(u.pathname.endsWith('/profiles')) return reply([{id:who,full_name:names.get(who)||'Test Student'}]);
    if(u.pathname.endsWith('/ride_requests')) return reply([]);
    if(u.pathname.endsWith('/trips') && body){
      const row={id:`trip-${rows.length+1}`,driver_id:who,...body};rows.push(row);return reply([row]);
    }
    if(u.pathname.endsWith('/available_trips')) return reply(rows.filter(r=>!u.searchParams.get('origin_city')||r.origin_city.toLowerCase()===u.searchParams.get('origin_city').slice(6).toLowerCase()).map(r=>({...r,seats_available:r.total_seats})));
    if(u.pathname.endsWith('/trips')) return reply(rows);
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const api=await import(pathToFileURL(path.resolve('public/hitch-supabase.js')).href+'?integration='+Math.random());
  const context=vm.createContext({console:{...console,warn(...parts){warnings.push(parts.join(' '));}},Date,Intl,setTimeout,clearTimeout,
    sessionStorage:storage(new Map()),document:{getElementById:get,addEventListener(){},querySelectorAll(){return [];},querySelector(){return get('query-match');}},window:{scrollTo(){}}});
  vm.runInContext(source,context);context.api=api;
  const run=code=>vm.runInContext(code,context);
  run("DB.api=api; S.me={first:'Jordan',last:'Hale',color:'#3B6EA8',verified:'verified',hometown:'',bio:''};");
  const submit=id=>get(id).listeners.submit({preventDefault(){}});
  async function login(id){get('li-email').value=`${id}@byu.edu`;get('li-pass').value='fake-password1';await submit('liForm');await tick();}
  return {run,get,login,submit,api,calls,rows,warnings};
}

test('protected post -> Robbie login -> account name -> publish -> logout -> another account search',async()=>{
  const f=await fixture();
  f.run("go('post',{},false)");assert.equal(f.run('S.screen'),'login');assert.equal(f.run('S.after.screen'),'post');
  await f.login('driver');assert.equal(f.run('S.screen'),'post');assert.equal(f.run('fullName(S.me)'),'Driver One');
  const values={'pt-origin':'Orem','pt-dest':'moab','pt-depart':'2099-11-06T16:00','pt-pickup':'UVU','pt-dropoff':'Moab','pt-seats':'3','pt-price':'25'};
  for(const [id,value] of Object.entries(values)) f.get(id).value=value;
  await f.submit('ptForm');assert.equal(f.run('S.screen'),'manage');
  assert.equal(f.rows[0].driver_id,'driver');assert.equal(f.rows[0].origin_city,'Orem');
  assert.equal(f.calls.find(c=>c.body?.destination_id).body.driver_id,undefined);
  await f.run("logOut('Logged out')");assert.equal(f.run('S.screen'),'login');assert.equal(f.run('TRIPS.filter(t=>t.dbTrip).length'),0);
  await f.login('rider');assert.equal(f.run('fullName(S.me)'),'Rider Two');
  f.run("S.screen='results';S.params={dest:'moab'};S.search={from:'Orem',dest:'Moab',date:''};");
  await f.run('searchDbTrips()');
  assert.equal(f.run('S.dbSearch.ids.length'),1);assert.equal(f.run("TRIPS.find(t=>t.dbTrip).driver"),'driver');
  assert.doesNotMatch(f.run('resultsList()'),/Your trip/);
});

test('failed follow-up trip load is handled after login without clearing the post form',async()=>{
  const f=await fixture();
  f.run('DB.api={...api};');
  f.run("DB.api.loadTrips=async()=>{throw new Error('Trip service offline');}; go('post',{},false);");
  await f.login('driver');await tick();
  assert.equal(f.run('S.screen'),'post');assert.ok(f.warnings.some(w=>w.includes('Trip service offline')));
});

test('logout cancels an older trip/profile response instead of restoring the old account',async()=>{
  const f=await fixture();let tripsDone,profileDone;
  f.run("DB.session={accessToken:'token-driver',user:{id:'driver'}}; DB.api={...api};");
  const pendingTrips=new Promise(resolve=>tripsDone=resolve),pendingProfile=new Promise(resolve=>profileDone=resolve);
  f.run('(hooks)=>Object.assign(DB.api,hooks)')({loadTrips:()=>pendingTrips,loadMyProfile:()=>pendingProfile});
  const loadingTrips=f.run('loadDbTrips()'),loadingProfile=f.run('loadAccount()');await tick();
  await f.run("logOut('bye')");
  tripsDone([{id:'late',driver_id:'driver',destination_id:'moab',departure_at:'2099-11-06T23:00:00Z',total_seats:3,price_per_seat:25}]);
  profileDone({full_name:'Old Account'});await Promise.all([loadingTrips,loadingProfile]);
  assert.equal(f.run('DB.session'),null);assert.equal(f.run('DB.profile'),null);assert.equal(f.run('TRIPS.filter(t=>t.dbTrip).length'),0);
  assert.equal(f.run('S.screen'),'login');
});


test('Robbie signup returns a new account to the requested post screen',async()=>{
  const f=await fixture(); f.run("go('post',{},false); go('signup',{},false);");
  f.get('su-name').value='New Student';f.get('su-email').value='new-driver@byu.edu';f.get('su-pass').value='fake-password1';
  await f.submit('suForm');await tick();
  assert.equal(f.run('S.screen'),'post');assert.equal(f.run('DB.session.user.id'),'new-driver');
  assert.equal(f.run('fullName(S.me)'),'New Student');
  assert.match(f.get('app').innerHTML,/Choose pickup map pin/);
});

test('signup needing email confirmation stays signed out and preserves the return route',async()=>{
  const f=await fixture({confirmation:true});f.run("go('post',{},false); go('signup',{},false);");
  f.get('su-name').value='New Student';f.get('su-email').value='new-driver@byu.edu';f.get('su-pass').value='fake-password1';
  await f.submit('suForm');
  assert.equal(f.run('S.screen'),'login');assert.equal(f.run('DB.session'),null);
  assert.equal(f.run('S.after.screen'),'post');assert.match(f.run('S.loginNotice'),/confirmation link/);
});

test('a delayed search session cannot sign the user back in after logout',async()=>{
  const f=await fixture();let finishSession;
  const pending=new Promise(resolve=>finishSession=resolve);
  f.run("DB.api={...api};DB.session={accessToken:'token-driver',user:{id:'driver'}};S.screen='results';S.params={dest:'moab'};");
  f.run('(hooks)=>Object.assign(DB.api,hooks)')({getSession:()=>pending});
  const searching=f.run('searchDbTrips()');await tick();await f.run("logOut('bye')");
  finishSession({accessToken:'token-driver',user:{id:'driver'}});await searching;
  assert.equal(f.run('DB.session'),null);assert.equal(f.run('S.screen'),'login');
});

test('a publish response received after logout does not restore the old driver screen',async()=>{
  const f=await fixture();f.run("go('post',{},false)");await f.login('driver');
  f.run('DB.api={...api};');let finish;
  const pending=new Promise(resolve=>finish=resolve);
  f.run('(hooks)=>Object.assign(DB.api,hooks)')({publishTrip:()=>pending});
  for(const [id,value] of Object.entries({'pt-origin':'Orem','pt-dest':'moab','pt-depart':'2099-11-06T16:00','pt-pickup':'UVU','pt-dropoff':'Moab','pt-seats':'3','pt-price':'25'})) f.get(id).value=value;
  const saving=f.submit('ptForm');await tick();await f.run("logOut('bye')");
  finish({id:'late-save',driver_id:'driver',destination_id:'moab',departure_at:'2099-11-06T23:00:00Z',total_seats:3,price_per_seat:25});await saving;
  assert.equal(f.run('S.screen'),'login');assert.equal(f.run('DB.session'),null);
  assert.equal(f.run('TRIPS.filter(t=>t.dbTrip).length'),0);
});
