const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = 'data:text/javascript;base64,'+Buffer.from(fs.readFileSync('public/hitch-ai.js','utf8')).toString('base64');
const tick = () => new Promise(resolve=>setImmediate(resolve));

async function fixture(){
  const api = await import(url), elements = new Map(), listeners = {};
  const form = {querySelector(selector){return get(selector.slice(1));},
    addEventListener(name,fn){(listeners[name] ||= new Set()).add(fn);},
    removeEventListener(name,fn){listeners[name]?.delete(fn);}};
  const get = id => {
    if(!elements.has(id)) elements.set(id,{id,value:'',checked:false,disabled:false,textContent:'',dataset:{},listeners:{},
      dispatchEvent(event){for(const fn of listeners[event.type] || []) fn({target:this});},
      addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(name){delete this.listeners[name];},
      setAttribute(){},removeAttribute(){},focus(){this.focused=true;}});
    return elements.get(id);
  };
  get('pt-origin').value='Provo';
  get('pt-ai-description').value='Driving from Provo to Moab on November 20, 2026 at 4 PM, with 3 seats for $25 each.';
  let owner = 'driver-a', current = true;
  const cleanup = api.bindTripDraft({form,getSession:async()=>({accessToken:'test-token',user:{id:owner}}),getAccount:()=>owner,isCurrent:()=>current});
  return {api,form,get,cleanup,fill:()=>get('pt-ai-fill').listeners.click(),logout:()=>{owner=null;current=false;cleanup();}};
}

test('AI fills blank fields using normal picker events, without submitting a trip',async()=>{
  const f=await fixture();
  f.get('pt-dest').value='old-destination';f.get('pt-dest').dataset={lat:'40',lng:'-111'};
  let events=0;f.form.addEventListener('input',()=>events++);
  const count=f.api.applyTripDraft(f.form,{origin_city:'Orem',destination_name:'Moab',pickup_location:'UVU',seats:3,price_per_seat:25,return_requested:true,return_date:'2026-11-22',return_time:'18:00'});
  assert.ok(count>=7);assert.equal(f.get('pt-origin').value,'Orem');assert.equal(f.get('pt-seats').value,'3');
  assert.equal(f.get('pt-dest').value,'');assert.deepEqual(f.get('pt-dest').dataset,{});assert.ok(events>=7);
  assert.equal(f.get('pt-ret').checked,true);f.cleanup();
});

test('manual values, an edited default origin, return choice and car details are preserved',async()=>{
  const f=await fixture();f.get('pt-pickup').value='My meeting place';f.get('pt-plate').value='ABC 123';
  f.api.applyTripDraft(f.form,{origin_city:'Orem',pickup_location:'AI meeting place',return_requested:true,return_date:'2026-11-22',return_time:'18:00'},new Set(['pt-origin','pt-ret']));
  assert.equal(f.get('pt-origin').value,'Provo');assert.equal(f.get('pt-pickup').value,'My meeting place');
  assert.equal(f.get('pt-ret').checked,false);assert.equal(f.get('pt-return').value,'');assert.equal(f.get('pt-plate').value,'ABC 123');f.cleanup();
});

test('one click calls only the protected Hitch endpoint and applies the response',async()=>{
  const f=await fixture(), old=global.fetch;let calls=0;
  global.fetch=async(path,options)=>{
    calls++;assert.equal(path,'/api/ai/trip-draft');assert.equal(options.headers.Authorization,'Bearer test-token');
    assert.deepEqual(Object.keys(JSON.parse(options.body)),['description']);
    return {ok:true,json:async()=>({fields:{destination_name:'Moab',seats:3},missing:['departure date']})};
  };
  try{await f.fill();assert.equal(calls,1);assert.equal(f.get('pt-dest-name').value,'Moab');assert.match(f.get('pt-ai-status').textContent,/Review the form/);}
  finally{f.cleanup();global.fetch=old;}
});

test('edits during generation discard the response and duplicate clicks do not call AI twice',async()=>{
  const f=await fixture(),old=global.fetch;let resolve,calls=0;
  global.fetch=()=>{calls++;return new Promise(r=>resolve=r);};
  try{
    const pending=f.fill();await tick();await f.fill();assert.equal(calls,1);
    f.get('pt-time').value='10:00';f.get('pt-time').dispatchEvent(new Event('input'));
    resolve({ok:true,json:async()=>({fields:{departure_time:'16:00',seats:3}})});await pending;
    assert.equal(f.get('pt-time').value,'10:00');assert.equal(f.get('pt-seats').value,'');assert.match(f.get('pt-ai-status').textContent,/No AI changes/);
  }finally{f.cleanup();global.fetch=old;}
});

test('logout makes an outstanding response unable to fill another account form',async()=>{
  const f=await fixture(),old=global.fetch;let resolve;
  global.fetch=()=>new Promise(r=>resolve=r);
  try{const pending=f.fill();await tick();f.logout();resolve({ok:true,json:async()=>({fields:{seats:3}})});await pending;assert.equal(f.get('pt-seats').value,'');}
  finally{f.cleanup();global.fetch=old;}
});

test('provider errors and unknown or invalid fields leave manual posting available',async()=>{
  const f=await fixture(),old=global.fetch;
  global.fetch=async()=>({ok:false,json:async()=>({error:'AI drafting is unavailable.'})});
  try{await f.fill();assert.equal(f.get('pt-ai-fill').disabled,false);assert.equal(f.get('pt-seats').value,'');assert.match(f.get('pt-ai-status').textContent,/unavailable/);
    assert.equal(f.api.applyTripDraft(f.form,{seats:true,price_per_seat:151,departure_time:'25:00',driver_id:'other'}),0);
  }finally{f.cleanup();global.fetch=old;}
});
