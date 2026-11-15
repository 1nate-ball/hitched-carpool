// Run with: node --test tests/test_cancel.cjs
// Rider cancels a seat request; driver cancels a posted trip. Uses the real app code and an in-memory API.
// The database rules (who can cancel, only once, not after departure, seat given back) are checked by
// scripts/check_cancel_schema.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');

function fixture({me = 'rider-1', status = 'pending', seats = 2} = {}) {
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout,
    document:{getElementById:() => ({hidden:true, textContent:''}), addEventListener(){}, querySelectorAll(){ return []; }},
    window:{scrollTo(){}}});
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  // Fake database: one future trip driven by driver-a; rider-1 has a request, rider-2 is accepted.
  const db = {
    trip:{id:'trip-1', driver_id:'driver-a', destination_id:'moab', departure_at:'2099-11-06T23:00:00Z', return_at:null,
      pickup_location:'Helaman Halls', dropoff_location:'Moab Main Street', total_seats:seats, price_per_seat:25, cancelled_at:null},
    requests:[
      {id:'r1', trip_id:'trip-1', rider_id:'rider-1', note:'hi', status, created_at:'2099-01-01T00:00:00Z'},
      {id:'r2', trip_id:'trip-1', rider_id:'rider-2', note:'', status:'accepted', created_at:'2099-01-01T00:01:00Z'},
    ],
  };
  const accepted = () => db.requests.filter(r => r.status === 'accepted').length;
  const refuse = (message, code, status = 400) => { throw Object.assign(new Error(message), {code, status}); };
  context.api = {
    getSession:async () => ({accessToken:'token', user:{id:me}}),
    loadTrips:async () => [db.trip],
    loadMyRequests:async (token, riderId) => db.requests.filter(r => r.rider_id === riderId),
    loadTripRequests:async (token, ids) => db.trip.driver_id === me ? db.requests.filter(r => ids.includes(r.trip_id)) : [],
    loadProfiles:async (token, ids) => ids.map(id => ({id, full_name:`${id} Smith`})),
    loadSeatsAvailable:async () => (!db.trip.cancelled_at && seats - accepted() > 0 ? {'trip-1':seats - accepted()} : {}),
    requestSeat:async (token, tripId, note) => {
      if (db.trip.cancelled_at) refuse('This trip was cancelled.', '23514');
      if (db.requests.some(r => r.rider_id === me && r.status !== 'cancelled')) refuse('duplicate', '23505', 409);
      const row = {id:`r${db.requests.length + 1}`, trip_id:tripId, rider_id:me, note, status:'pending', created_at:'2099-02-01T00:00:00Z'};
      db.requests.push(row); return row;
    },
    cancelRequest:async (token, id) => { // same rules as the database trigger + policy
      const r = db.requests.find(x => x.id === id);
      if (!r || r.rider_id !== me) refuse('Only the rider can cancel this request.', '42501');
      if (!['pending', 'accepted'].includes(r.status)) refuse(`This request was already ${r.status}.`, '23514');
      r.status = 'cancelled'; return {id, status:'cancelled'};
    },
    cancelTrip:async () => {
      if (db.trip.driver_id !== me) refuse('Only the driver can cancel this trip.', '42501');
      if (db.trip.cancelled_at) refuse('This trip was already cancelled.', '23514');
      db.trip.cancelled_at = '2099-01-02T00:00:00Z'; return {id:'trip-1', cancelled_at:db.trip.cancelled_at};
    },
  };
  run("DB.api = api; S.me = {first:'Riley', last:'Rider', color:'#3B6EA8', verified:'verified', hometown:'', bio:''}; toast = msg => { S.notice = msg; }; render = () => {};");
  const trip = () => run("TRIPS.find(t => t.id === 'trip-1')");
  const myTrips = tab => run(`S.tripsTab = '${tab}'; SCREENS.mytrips()`);
  return {run, db, trip, myTrips, reload:async () => { run('clearDbTrips()'); await run('loadDbTrips()'); }};
}

test('rider cancels a pending request: saved in the database and shown on My Trips', async () => {
  const f = fixture(); await f.reload();
  assert.match(f.myTrips('rider'), /data-act="cancelreq" data-id="trip-1"[^>]*>Cancel request</);
  await f.run('cancelMyRequest(TRIPS.find(t => t.id === "trip-1"))');
  assert.equal(f.db.requests[0].status, 'cancelled');
  assert.equal(f.run('S.notice'), 'Request cancelled.');
  await f.reload(); // the database still agrees after a reload
  assert.equal(f.run('myStatus(TRIPS.find(t => t.id === "trip-1"))'), 'cancelled');
  const screen = f.myTrips('rider');
  assert.match(screen, /You cancelled/);
  assert.doesNotMatch(screen, /data-act="cancelreq" data-id="trip-1"/);
});

test('rider cancels an accepted seat and the seat goes back to the trip', async () => {
  const f = fixture({status:'accepted', seats:2}); await f.reload();
  assert.equal(f.trip().available, 0); // r1 + r2 accepted: full
  assert.match(f.myTrips('rider'), />Cancel my seat</);
  await f.run('cancelMyRequest(TRIPS.find(t => t.id === "trip-1"))');
  assert.equal(f.db.requests[0].status, 'cancelled');
  assert.equal(f.trip().available, 1);
  assert.equal(f.trip().passengers.includes('me'), false);
  assert.match(f.run('S.notice'), /open for other riders again/);
  await f.reload();
  assert.equal(f.trip().available, 1);
  assert.equal(f.run("openTrips('moab').some(t => t.id === 'trip-1')"), true); // back in Explore
});

test('after cancelling, the rider can request the same trip again', async () => {
  const f = fixture(); await f.reload();
  await f.run('cancelMyRequest(TRIPS.find(t => t.id === "trip-1"))');
  const res = await f.run('sendSeatRequest(TRIPS.find(t => t.id === "trip-1"), "back on")');
  assert.equal(res.ok, true);
  await f.reload(); // newest request wins over the cancelled one
  assert.equal(f.run('myStatus(TRIPS.find(t => t.id === "trip-1"))'), 'pending');
});

test('driver cancels a trip: saved, out of Explore, and riders see it as cancelled', async () => {
  const f = fixture({me:'driver-a'}); await f.reload();
  assert.match(f.myTrips('driver'), />Cancel trip</);
  await f.run('cancelMyTrip(TRIPS.find(t => t.id === "trip-1"))');
  assert.ok(f.db.trip.cancelled_at);
  assert.match(f.run('S.notice'), /Trip cancelled/);
  await f.reload();
  assert.equal(f.trip().cancelled, true);
  assert.match(f.myTrips('driver'), /Trip cancelled/);
  assert.doesNotMatch(f.myTrips("driver"), /data-act="canceltrip" data-id="trip-1"/);
  assert.equal(f.run("openTrips('moab').some(t => t.id === 'trip-1')"), false);
  f.run("S.params = {id:'trip-1'}");
  assert.match(f.run('SCREENS.manage()'), /data-v="accepted" disabled/); // no more decisions

  const r = fixture({me:'rider-1'}); r.db.trip.cancelled_at = f.db.trip.cancelled_at; await r.reload();
  const screen = r.myTrips('rider');
  assert.match(screen, /Trip cancelled/); assert.match(screen, /driver-a cancelled this trip/);
  r.run("S.params = {id:'trip-1'}");
  assert.match(r.run('SCREENS.detail()'), /<button class="btn" disabled>Trip cancelled<\/button>/);
});

test('refusals are explained and the screen reloads what the database has', async () => {
  const f = fixture(); await f.reload();
  f.db.requests[0].status = 'declined'; // the driver declined on another device meanwhile
  await f.run('cancelMyRequest(TRIPS.find(t => t.id === "trip-1"))');
  assert.match(f.run('S.notice'), /already changed/);
  assert.equal(f.run('myStatus(TRIPS.find(t => t.id === "trip-1"))'), 'declined');

  const g = fixture({me:'driver-a'}); await g.reload();
  g.db.trip.cancelled_at = '2099-01-02T00:00:00Z'; // cancelled in another tab
  await g.run('cancelMyTrip(TRIPS.find(t => t.id === "trip-1"))');
  assert.match(g.run('S.notice'), /already changed/);
  assert.equal(g.trip().cancelled, true);
});

test('cancelling is hidden once a trip has left', async () => {
  const f = fixture(); f.db.trip.departure_at = '2000-01-01T12:00:00Z'; await f.reload();
  assert.doesNotMatch(f.myTrips("rider"), /data-act="cancelreq" data-id="trip-1"/);
});

test('cancel buttons are off while a cancel is saving', async () => {
  const f = fixture(); await f.reload();
  f.run("S.cancelling = 'trip-1'");
  assert.match(f.myTrips('rider'), /data-act="cancelreq" data-id="trip-1"[^>]*disabled[^>]*aria-busy="true">Cancelling…</);
});
