// Run with: node --test tests/test_accept_decline.cjs
// Driver accepts/declines seat requests on a saved trip, using the real app code and an in-memory API.
// The database rules (driver only, pending only, no overbooking) are checked by
// scripts/check_accept_decline_schema.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');

function fixture({me = 'driver-a', seats = 2} = {}) {
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout,
    document:{getElementById:() => ({hidden:true, textContent:''}), addEventListener(){}, querySelectorAll(){ return []; }},
    window:{scrollTo(){}}});
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  // Fake database: one trip driven by driver-a, three pending requests.
  const db = {
    trip:{id:'trip-1', driver_id:'driver-a', destination_id:'moab', departure_at:'2099-11-06T23:00:00Z', return_at:null,
      pickup_location:'Helaman Halls', dropoff_location:'Moab Main Street', total_seats:seats, price_per_seat:25},
    requests:['r1', 'r2', 'r3'].map((id, i) => ({id, trip_id:'trip-1', rider_id:`rider-${i + 1}`, note:`note ${i + 1}`, status:'pending'})),
  };
  const accepted = () => db.requests.filter(r => r.status === 'accepted').length;
  context.api = {
    getSession:async () => ({accessToken:'token', user:{id:me}}),
    loadTrips:async () => [db.trip],
    loadMyRequests:async (token, riderId) => db.requests.filter(r => r.rider_id === riderId),
    loadTripRequests:async (token, ids) => db.trip.driver_id === me ? db.requests.filter(r => ids.includes(r.trip_id)) : [],
    loadProfiles:async (token, ids) => ids.map(id => ({id, full_name:`Rider ${id.slice(-1)} Smith`})),
    loadSeatsAvailable:async () => (db.trip.total_seats - accepted() > 0 ? {'trip-1':db.trip.total_seats - accepted()} : {}),
    decideRequest:async (token, id, status) => { // same rules as the database trigger + policy
      const r = db.requests.find(x => x.id === id);
      if (db.trip.driver_id !== me) throw Object.assign(new Error('Only the driver can respond to this request.'), {code:'42501'});
      if (r.status !== 'pending') throw Object.assign(new Error(`This request was already ${r.status}.`), {status:400, code:'23514'});
      if (status === 'accepted' && accepted() >= db.trip.total_seats) throw Object.assign(new Error('This trip is full.'), {status:400, code:'23514'});
      r.status = status; return {id, status};
    },
  };
  run("DB.api = api; S.me = {first:'Dana', last:'Driver', color:'#3B6EA8', verified:'verified', hometown:'', bio:''}; toast = msg => { S.notice = msg; }; render = () => {};");
  const trip = () => run("TRIPS.find(t => t.id === 'trip-1')");
  return {run, db, trip, decide:(id, v) => run(`decideDbRequest(TRIPS.find(t => t.id === 'trip-1'), '${id}', '${v}')`)};
}

test('driver sees pending requests on their trip, with rider names and notes', async () => {
  const f = fixture(); await f.run('loadDbTrips()');
  f.run("S.screen = 'manage'; S.params = {id:'trip-1'}");
  const screen = f.run('SCREENS.manage()');
  assert.match(screen, /Pending requests<\/h2><span class="small muted">3</);
  assert.match(screen, /Rider 1 Smith/); assert.match(screen, /note 2/);
  assert.match(screen, /data-rid="r1"/);
  assert.match(screen, /<b>2<\/b> of 2 seats left/);
});

test('accept saves to the database, confirms the rider and lowers seats left', async () => {
  const f = fixture(); await f.run('loadDbTrips()');
  await f.decide('r1', 'accepted');
  assert.equal(f.db.requests[0].status, 'accepted');
  assert.equal(f.trip().available, 1);
  assert.equal(JSON.stringify(f.trip().passengers), '["rider-1"]');
  assert.match(f.run('S.notice'), /Rider is confirmed\. 1 of 2 seats left/);
  // After a reload the database still agrees.
  f.run('clearDbTrips()'); await f.run('loadDbTrips()');
  assert.equal(f.trip().available, 1); assert.equal(f.trip().passengers.length, 1);
  assert.equal(f.trip().requests.filter(r => r.status === 'pending').length, 2);
});

test('decline saves the status and leaves seats unchanged', async () => {
  const f = fixture(); await f.run('loadDbTrips()');
  await f.decide('r2', 'declined');
  assert.equal(f.db.requests[1].status, 'declined');
  assert.equal(f.trip().available, 2);
  f.run("S.params = {id:'trip-1'}");
  assert.match(f.run('SCREENS.manage()'), /Pending requests<\/h2><span class="small muted">2</);
});

test('a full trip disables Accept and reports seats as 0 (it drops out of search)', async () => {
  const f = fixture({seats:1}); await f.run('loadDbTrips()');
  await f.decide('r1', 'accepted');
  assert.equal(f.trip().available, 0);
  f.run("S.params = {id:'trip-1'}");
  assert.match(f.run('SCREENS.manage()'), /data-rid="r2" data-v="accepted" disabled/);
  assert.equal(f.run("openTrips('moab').some(t => t.id === 'trip-1')"), false);
});

test('database refusals are explained and the screen reloads the real state', async () => {
  const f = fixture({seats:1}); await f.run('loadDbTrips()');
  f.db.requests[0].status = 'accepted'; // another device accepted r1 meanwhile
  await f.decide('r2', 'accepted');
  assert.match(f.run('S.notice'), /trip is full/);
  assert.equal(f.trip().available, 0); // reloaded from the database
  f.db.requests[2].status = 'declined';
  f.trip().requests.find(r => r.id === 'r3').status = 'pending'; // stale screen
  await f.decide('r3', 'declined');
  assert.match(f.run('S.notice'), /already responded/);
});

test('a rider whose request was accepted sees the seat as confirmed', async () => {
  const f = fixture({me:'rider-1'});
  f.db.requests[0].status = 'accepted';
  await f.run('loadDbTrips()');
  assert.equal(f.run("myStatus(TRIPS.find(t => t.id === 'trip-1'))"), 'confirmed');
  assert.equal(f.trip().available, 1);
});
