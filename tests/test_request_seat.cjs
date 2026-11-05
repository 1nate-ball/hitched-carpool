// Run with: node --test tests/test_request_seat.cjs
// Exercises the real seat-request logic from index.html with an in-memory API, without live writes.
// Database rules (no own-trip, no duplicates, pending only) are checked by scripts/check_request_seat_schema.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');

const TRIP = {id:'trip-1', driver_id:'driver-a', destination_id:'moab', departure_at:'2099-11-06T23:00:00Z', return_at:null,
  pickup_location:'Helaman Halls', dropoff_location:'Moab Main Street', total_seats:3, price_per_seat:25};

function fixture(uid = 'rider-b') {
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout,
    document:{getElementById:() => null, addEventListener(){}, querySelectorAll(){ return []; }}, window:{scrollTo(){}}});
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const requests = []; // the fake ride_requests table, with the same unique/own-trip rules as the database
  const api = context.api = {
    getSession:async () => ({accessToken:'token', user:{id:uid}}),
    loadTrips:async () => [TRIP],
    loadMyRequests:async (token, riderId) => requests.filter(r => r.rider_id === riderId),
    requestSeat:async (token, tripId, note) => {
      if (TRIP.driver_id === uid) throw Object.assign(new Error('rls'), {status:403, code:'42501'});
      if (requests.some(r => r.trip_id === tripId && r.rider_id === uid)) throw Object.assign(new Error('dup'), {status:409, code:'23505'});
      const row = {id:'req-' + requests.length, trip_id:tripId, rider_id:uid, note, status:'pending'};
      requests.push(row); return row;
    },
  };
  run('DB.api = api;');
  return {run, api, requests, send:note => run(`sendSeatRequest(TRIPS.find(t => t.id === 'trip-1'), ${JSON.stringify(note)})`)};
}

test('request saves trip, note and pending status, then the trip shows as requested', async () => {
  const f = fixture(); await f.run('loadDbTrips()');
  assert.equal(f.run("myStatus(TRIPS.find(t => t.id === 'trip-1'))"), null);
  const res = await f.send('Can bring snacks');
  assert.equal(res.ok, true);
  assert.deepEqual(f.requests.map(r => [r.trip_id, r.rider_id, r.note, r.status]), [['trip-1', 'rider-b', 'Can bring snacks', 'pending']]);
  assert.equal(f.run("myStatus(TRIPS.find(t => t.id === 'trip-1'))"), 'pending');
});

test('second request for the same trip is reported as already requested, not sent twice', async () => {
  const f = fixture(); await f.run('loadDbTrips()');
  await f.send('');
  const res = await f.send('again');
  assert.equal(res.ok, false); assert.equal(res.already, true);
  assert.equal(f.requests.length, 1);
});

test('saved requests come back after a reload', async () => {
  const f = fixture(); await f.run('loadDbTrips()'); await f.send('hi');
  f.run('clearDbTrips()'); await f.run('loadDbTrips()');
  assert.equal(f.run("myStatus(TRIPS.find(t => t.id === 'trip-1'))"), 'pending');
});

test('driver sees Manage, and the database refusal for an own-trip request is explained', async () => {
  const f = fixture('driver-a'); await f.run('loadDbTrips()');
  assert.equal(f.run("myStatus(TRIPS.find(t => t.id === 'trip-1'))"), 'driver');
  const res = await f.send('');
  assert.equal(res.ok, false); assert.match(res.message, /your own trip/);
  assert.equal(f.requests.length, 0);
});

test('network failure and expired sign-in leave no request and say so', async () => {
  const f = fixture(); await f.run('loadDbTrips()');
  f.api.requestSeat = async () => { throw new TypeError('Failed to fetch'); };
  assert.match((await f.send('')).message, /was not sent/);
  f.api.getSession = async () => null;
  assert.match((await f.send('')).message, /sign-in expired/);
  assert.equal(f.run("myStatus(TRIPS.find(t => t.id === 'trip-1'))"), null);
});
