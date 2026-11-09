// Run with: node --test tests/test_post_trip.cjs
// Exercises the actual form handler with an in-memory DOM/API, without live writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');

function fixture() {
  const fields = new Map();
  const get = id => {
    if (!fields.has(id)) fields.set(id, {
      value:'', validity:{badInput:false}, checked:false, hidden:true, disabled:false,
      textContent:'', innerHTML:'', dataset:{}, attrs:{}, listeners:{},
      addEventListener(event, fn){ this.listeners[event] = fn; },
      setAttribute(k,v){ this.attrs[k]=v; }, removeAttribute(k){ delete this.attrs[k]; },
      closest(){ return {classList:{toggle(){}}}; }, focus(){ this.focused=true; },
    });
    return fields.get(id);
  };
  const context = vm.createContext({console, Date, Intl, setTimeout, clearTimeout,
    document:{getElementById:id => id === 'siForm' ? null : get(id), addEventListener(){}, querySelectorAll(){return [];}},
    window:{scrollTo(){}},
  });
  vm.runInContext(source, context); // also catches inline-script syntax errors
  const run = code => vm.runInContext(code, context);
  run("S.me = {first:'Demo',last:'Driver',color:'#3B6EA8',verified:'verified'}; go = (screen,params) => {S.screen=screen; S.params=params;}; toast = msg => {S.notice=msg;}; openPublishedDialog = t => {S.notice='Trip published'; S.dialogTrip=t.id;};");
  const session = {accessToken:'test-token',user:{id:'driver-a'}};
  const rows = [];
  context.api = {getSession:async()=>session, loadTrips:async()=>rows, publishTrip:async(token,payload)=>{
    assert.equal(token,'test-token');
    const row = {id:'saved-trip',driver_id:session.user.id,...payload}; rows.push(row); return row;
  },loadMyRequests:async()=>[],signOut(){}};
  run('DB.api = api;');
  get('pt-origin').value='Provo'; get('pt-dest').value='moab'; get('pt-depart').value='2099-11-06T16:00';
  get('pt-pickup').value='Helaman Halls'; get('pt-dropoff').value='Moab Main Street';
  get('pt-seats').value='3'; get('pt-price').value='25';
  run('BIND.post();');
  return {get,run,api:context.api,rows,session,submit:()=>get('ptForm').listeners.submit({preventDefault(){}})};
}

test('Utah conversion rejects invalid dates, DST gaps and ambiguous times',()=>{
  const {run} = fixture();
  assert.equal(run("denverISO('2099-11-06T16:00').iso"),'2099-11-06T16:00:00-07:00');
  assert.equal(run("denverISO('2099-07-06T16:00').iso"),'2099-07-06T16:00:00-06:00');
  for (const value of ['', '2026-06-31T18:23', '2026-13-01T12:00'])
    assert.match(run(`denverISO('${value}').error`),/valid date and time/);
  assert.match(run("denverISO('2027-03-14T02:30').error"),/skipped/);
  assert.match(run("denverISO('2027-11-07T01:30').error"),/twice/);
});

test('invalid native date input and return before departure never write',async()=>{
  const f=fixture(); let calls=0; f.api.publishTrip=async()=>{calls++;};
  f.get('pt-depart').value=''; f.get('pt-depart').validity.badInput=true;
  await f.submit(); assert.match(f.get('pe-depart').textContent,/valid departure/);
  f.get('pt-depart').value='2099-11-06T16:00'; f.get('pt-depart').validity.badInput=false;
  f.get('pt-ret').checked=true; f.get('pt-return').value='2099-11-06T15:00';
  await f.submit(); assert.match(f.get('pe-return').textContent,/after departure/);
  assert.equal(calls,0);
});

test('save waits for confirmation and suppresses concurrent submissions',async()=>{
  const f=fixture(); let resolve, calls=0;
  const publish=f.api.publishTrip;
  f.api.publishTrip=async(...args)=>{ calls++; await new Promise(r=>resolve=r); return publish(...args); };
  const pending=f.submit(); await new Promise(r=>setImmediate(r));
  await f.submit(); assert.equal(calls,1); assert.notEqual(f.run('S.notice'),'Trip published');
  resolve(); await pending;
  assert.equal(f.run('S.notice'),'Trip published'); assert.equal(f.run('S.published'),'saved-trip'); assert.equal(f.run('S.dialogTrip'),'saved-trip');
  assert.equal(f.rows[0].departure_at,'2099-11-06T16:00:00-07:00'); assert.equal(f.rows[0].return_at,null);
  await f.run('loadDbTrips()'); assert.equal(f.run("TRIPS.filter(t=>t.dbTrip).length"),1);
});

test('known database rejection preserves fields and allows retry',async()=>{
  const f=fixture(); f.api.publishTrip=async()=>{throw Object.assign(new Error('Rejected'),{status:400});};
  await f.submit(); assert.equal(f.get('pt-pickup').value,'Helaman Halls');
  assert.equal(f.get('pt-submit').disabled,false); assert.equal(f.get('pt-dberr').hidden,false);
  assert.notEqual(f.run('S.notice'),'Trip published');
});

test('lost response reconciles newly saved row; an old similar trip is not success',async()=>{
  const f=fixture(); const publish=f.api.publishTrip;
  f.api.publishTrip=async(...args)=>{await publish(...args); throw new Error('Lost response');};
  await f.submit(); assert.equal(f.run('S.notice'),'Trip published');
  const g=fixture();
  g.rows.push({id:'old-trip',driver_id:'driver-a',destination_id:'moab',departure_at:'2099-11-06T23:00:00Z',return_at:null,pickup_location:'Helaman Halls',dropoff_location:'Moab Main Street',total_seats:3,price_per_seat:25});
  await g.run('loadDbTrips()');
  g.api.publishTrip=async()=>{throw new Error('Offline');};
  await g.submit(); await g.submit();
  assert.notEqual(g.run('S.notice'),'Trip published');
  assert.equal(g.get('pt-submit').disabled,true);
  assert.match(g.get('pt-dberr').textContent,/couldn't confirm/);
});

test('switching account remaps ownership; signed-out state clears database rows',async()=>{
  const f=fixture(); await f.submit();
  assert.equal(f.run("TRIPS.find(t=>t.id==='saved-trip').driver"),'me');
  f.api.getSession=async()=>({accessToken:'other',user:{id:'driver-b'}});
  await f.run('loadDbTrips()');
  assert.equal(f.run("TRIPS.find(t=>t.id==='saved-trip').driver"),'driver-a');
  assert.equal(f.run("USERS['driver-a'].verified"),'pending');
  f.api.getSession=async()=>null; await f.run('loadDbTrips()');
  assert.equal(f.run('TRIPS.filter(t=>t.dbTrip).length'),0);
});
