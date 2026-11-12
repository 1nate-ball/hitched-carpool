// Run with: node --test tests/test_sprint3.cjs
// Robbie's Sprint 3 cards: show/hide + confirm password, any destination,
// pickup identification, and the "Arrival destination" wording. In-memory DOM and API only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const html = fs.readFileSync('public/index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const fields = new Map();
  const get = id => {
    if (!fields.has(id)) fields.set(id, {
      id, value:'', type:'password', validity:{badInput:false}, checked:false, hidden:true, disabled:false,
      textContent:'', innerHTML:'', dataset:{}, attrs:{}, listeners:{},
      addEventListener(event, fn){ this.listeners[event] = fn; },
      setAttribute(k,v){ this.attrs[k]=String(v); }, removeAttribute(k){ delete this.attrs[k]; },
      closest(){ return {classList:{toggle(){}}}; }, focus(){ this.focused=true; },
    });
    return fields.get(id);
  };
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout, Promise,
    document:{getElementById:get, addEventListener(){}, querySelectorAll(){ return []; }, querySelector(){ return null; }},
    window:{scrollTo(){}}, localStorage:{getItem(){ return null; }, setItem(){}, removeItem(){}},
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run("S.me = {first:'Robbie',last:'McVey',color:'#3B6EA8',verified:'verified'}; go = (screen,params) => {S.screen=screen; S.params=params;}; toast = msg => {S.notice=msg;}; openPublishedDialog = t => {S.dialogTrip=t.id;}; render = () => {};");
  return {get, run, context};
}

test('eye button switches the password between hidden and shown, with a screen reader label', () => {
  const {get, run} = fixture();
  assert.match(run("passInput('li-pass','current-password')"), /type="password"[\s\S]*aria-label="Show password"/);
  const btn = {dataset:{for:'li-pass'}, attrs:{}, setAttribute(k,v){ this.attrs[k]=v; }, innerHTML:''};
  get('li-pass').type = 'password';
  run('togglePassword')(btn);
  assert.equal(get('li-pass').type, 'text');
  assert.equal(btn.attrs['aria-label'], 'Hide password');
  assert.equal(btn.attrs['aria-pressed'], 'true');
  run('togglePassword')(btn);
  assert.equal(get('li-pass').type, 'password');
  assert.equal(btn.attrs['aria-label'], 'Show password');
});

test('every password box on log in, sign up, and reset has an eye button', () => {
  const {run} = fixture();
  for (const screen of ['login', 'signup', 'reset']) {
    const out = run(`SCREENS.${screen}()`);
    const boxes = (out.match(/type="password"/g) || []).length, eyes = (out.match(/data-act="togglepass"/g) || []).length;
    assert.ok(boxes >= 1 && boxes === eyes, `${screen}: ${boxes} boxes, ${eyes} eye buttons`);
  }
  assert.match(run('SCREENS.signup()'), /Confirm password/);
});

test('sign up is not sent when the two passwords differ, or when confirm is empty', async () => {
  const {get, run} = fixture();
  let calls = 0;
  run('DB.api = {signUp: async () => { globalThis.signupCalls = (globalThis.signupCalls || 0) + 1; return {needsConfirmation:true}; }};');
  run('BIND.signup()');
  get('su-name').value = 'New Student'; get('su-email').value = 'new@byu.edu'; get('su-pass').value = 'abc12345';
  get('su-pass2').value = 'abc12346';
  await get('suForm').listeners.submit({preventDefault(){}});
  assert.equal(get('se-pass2').innerHTML, "Passwords don't match.");
  get('su-pass2').value = '';
  await get('suForm').listeners.submit({preventDefault(){}});
  assert.equal(get('se-pass2').innerHTML, 'Type your password again.');
  assert.equal(run('globalThis.signupCalls || 0'), calls);
  get('su-pass2').value = 'abc12345';
  await get('suForm').listeners.submit({preventDefault(){}});
  assert.equal(get('se-pass2').innerHTML, '');
  assert.equal(run('globalThis.signupCalls'), 1);
});

function postFixture() {
  const f = fixture();
  const session = {accessToken:'tok', user:{id:'driver-a'}};
  f.ensured = []; f.published = []; f.pickups = [];
  f.context.api = {
    getSession: async () => session, loadTrips: async () => [], loadMyRequests: async () => [], signOut(){},
    ensureDestination: async (token, dest) => { f.ensured.push(dest); return {id:'d-abc123', name:dest.name, latitude:dest.latitude, longitude:dest.longitude}; },
    publishTrip: async (token, payload) => { f.published.push({...payload}); return {id:'trip-1', driver_id:'driver-a', ...payload}; },
    savePickupDetails: async (token, tripId, car) => { f.pickups.push({tripId, ...car}); return {trip_id:tripId, pickup_code:'4821', vehicle_make_model:car.makeModel, vehicle_color:car.color, license_plate:car.plate}; },
  };
  f.run('DB.api = api; DB.session = {accessToken:"tok", user:{id:"driver-a"}};');
  const g = f.get;
  g('pt-origin').value = 'Provo'; g('pt-depart').value = '2099-11-06'; g('pt-time').value = '16:00';
  g('pt-pickup').value = 'Helaman Halls'; g('pt-dropoff').value = 'Old Faithful';
  g('pt-seats').value = '3'; g('pt-price').value = '40';
  f.run('BIND.post();');
  f.submit = () => g('ptForm').listeners.submit({preventDefault(){}});
  return f;
}

test('a typed new destination is created first, then the trip saves with its id', async () => {
  const f = postFixture();
  f.get('pt-dest-name').value = 'Yellowstone National Park';
  f.get('pt-dest').dataset = {lat:'44.6', lng:'-110.5'};
  await f.submit(); await tick();
  assert.equal(JSON.stringify(f.ensured), JSON.stringify([{name:'Yellowstone National Park', latitude:44.6, longitude:-110.5}]));
  assert.equal(f.published[0].destination_id, 'd-abc123');
  assert.equal(f.run("D('d-abc123').name"), 'Yellowstone National Park');
  assert.ok(f.run("allDests().some(d => d.id === 'd-abc123')"), 'riders can now search the new place');
  assert.equal(f.run('S.dialogTrip'), 'trip-1');
});

test('typing a preset name exactly uses the preset, without creating a destination', async () => {
  const f = postFixture();
  f.get('pt-dest-name').value = 'moab';
  await f.submit(); await tick();
  assert.equal(f.ensured.length, 0);
  assert.equal(f.published[0].destination_id, 'moab');
});

test('an empty destination is rejected before anything is saved', async () => {
  const f = postFixture();
  await f.submit();
  assert.match(f.get('pe-dest').textContent, /where you are driving/);
  assert.equal(f.published.length + f.ensured.length, 0);
});

test('new destinations get a price and drive-time estimate from distance, close to the presets', () => {
  const {run} = fixture();
  const moab = run('estimateFor({lat:38.5733, lng:-109.5498})'), preset = run("D('moab')");
  assert.ok(Math.abs(moab.est - preset.est) <= 6, `estimate ${moab.est} vs preset ${preset.est}`);
  assert.match(moab.drive, /^3 hr/);
  assert.equal(run('estimateFor(null)'), null);
  assert.equal(run("D('d-unknown').name"), 'New destination', 'unknown ids render instead of crashing');
});

test('car details and a pickup code are saved right after publishing', async () => {
  const f = postFixture();
  f.get('pt-dest-name').value = 'Moab';
  f.get('pt-car').value = 'Honda Civic'; f.get('pt-color').value = 'Gray'; f.get('pt-plate').value = 'abc 123';
  await f.submit(); await tick(); await tick();
  assert.equal(JSON.stringify(f.pickups), JSON.stringify([{tripId:'trip-1', makeModel:'Honda Civic', color:'Gray', plate:'ABC 123'}]));
  assert.equal(f.run("PICKUP['trip-1'].row.pickup_code"), '4821');
});

test('an invalid license plate blocks publishing', async () => {
  const f = postFixture();
  f.get('pt-dest-name').value = 'Moab'; f.get('pt-plate').value = 'NOT<A>PLATE!!';
  await f.submit();
  assert.match(f.get('pe-plate').textContent, /letters, numbers/);
  assert.equal(f.published.length, 0);
});

test('plate and pickup code show only to the driver and confirmed riders', () => {
  const {run} = fixture();
  run("PICKUP['t9'] = {state:'done', row:{vehicle_make_model:'Honda Civic', vehicle_color:'Gray', license_plate:'ABC 123', pickup_code:'4821'}};");
  const trip = "({id:'t9', dbTrip:true})";
  assert.match(run(`pickupView(${trip}, 'confirmed')`), /ABC 123[\s\S]*4821/);
  assert.match(run(`pickupView(${trip}, 'driver')`), /Ask each rider for this code/);
  for (const st of ['pending', 'declined', null]) {
    const out = run(`pickupView(${trip}, ${JSON.stringify(st)})`);
    assert.doesNotMatch(out, /ABC 123|4821/);
    assert.match(out, /once your seat is confirmed/);
  }
});

test('profile photos (Nathan\'s upload) still show; no photo shows initials', () => {
  const {run} = fixture();
  assert.match(run("av({first:'Robbie',last:'McVey',color:'#000',photo:'https://x.supabase.co/storage/v1/object/sign/profile-photos/u/1.jpg'})"), /<img src="https:\/\/x\.supabase\.co/);
  assert.doesNotMatch(run(`av({first:'A',last:'B',color:'#000',photo:'https://x.test/a.jpg" onerror="alert(1)'})`), /onerror="alert/);
  assert.match(run("av({first:'Robbie',last:'McVey',color:'#000',photo:null})"), />RM</);
});

test('"Drop off" is renamed to "Arrival destination" on cards, details, and the form', () => {
  const {run} = fixture();
  assert.match(run("routeHTML('A','B')"), /Arrival destination/);
  run("S.me.verified = 'verified'; DB.session = {user:{email:'r@byu.edu'}};");
  const form = run('SCREENS.post()');
  assert.match(form, /<label for="pt-dropoff">Arrival destination<\/label>/);
  assert.match(form, /Return pickup date<\/label>/);
  assert.doesNotMatch(form + run("routeHTML('A','B')"), /Drop-off at destination/);
});

// ---- hitch-supabase.js request shapes ----
async function helper(handler) {
  global.localStorage = {getItem(){ return null; }, setItem(){}, removeItem(){}};
  const calls = [];
  global.fetch = async (url, init = {}) => {
    if (url === '/supabase-config.json') return {ok:true, json:async () => ({url:'https://db.test', publishableKey:'pk'})};
    calls.push({url, init, body:typeof init.body === 'string' ? JSON.parse(init.body) : init.body});
    const [status, data] = handler(url, init);
    return {ok:status < 300, status, json:async () => data};
  };
  const api = await import(pathToFileURL(path.resolve('public/hitch-supabase.js')).href + '?s3=' + Math.random());
  return {api, calls};
}

test('ensureDestination calls the database function; pickup details save as an upsert', async () => {
  const {api, calls} = await helper(url => url.includes('rpc/') ? [200, {id:'d-1', name:'Boise'}] : [201, [{trip_id:'t1', pickup_code:'0042'}]]);
  assert.equal((await api.ensureDestination('tok', {name:' Boise ', latitude:43.6, longitude:-116.2})).id, 'd-1');
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/find_or_create_destination$/);
  assert.deepEqual(calls[0].body, {p_name:'Boise', p_latitude:43.6, p_longitude:-116.2});
  await api.savePickupDetails('tok', 't1', {makeModel:'Civic', color:'Gray', plate:'abc 1'});
  assert.match(calls[1].url, /trip_pickup_details\?on_conflict=trip_id/);
  assert.match(calls[1].init.headers.Prefer, /resolution=merge-duplicates/);
  assert.deepEqual(calls[1].body, {trip_id:'t1', vehicle_make_model:'Civic', vehicle_color:'Gray', license_plate:'ABC 1'});
});

test('older databases without the new columns still load destinations', async () => {
  const {api} = await helper(url => /photo_url/.test(url) ? [400, {message:'column does not exist', code:'42703'}] : [200, [{id:'moab', name:'Moab'}]]);
  assert.deepEqual(await api.loadDestinations('tok'), [{id:'moab', name:'Moab'}]);
});
