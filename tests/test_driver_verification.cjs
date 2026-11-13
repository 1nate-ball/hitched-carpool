// Run with: node --test tests/test_driver_verification.cjs
// Objective 1 KR1: badges and gates use the real verification status (confirmed byu.edu email).
// The database rule itself is checked by scripts/check_driver_verification_schema.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');

const TRIP = {id:'trip-1', driver_id:'driver-a', destination_id:'moab', departure_at:'2099-11-06T23:00:00Z', return_at:null,
  pickup_location:'Helaman Halls', dropoff_location:'Moab Main Street', total_seats:3, price_per_seat:25};

function fixture({me = 'rider-b', verified = {}} = {}) {
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout,
    document:{getElementById:() => null, addEventListener(){}, querySelectorAll(){ return []; }}, window:{scrollTo(){}}});
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const calls = [];
  context.api = {
    getSession:async () => ({accessToken:'token', user:{id:me, email:`${me}@byu.edu`}}),
    loadTrips:async () => [TRIP],
    loadMyRequests:async () => [],
    loadMyProfile:async () => ({id:me, full_name:'Test Student'}),
    loadProfileDetails:async () => ({hometown:'', bio:'', color:''}),
    loadVerification:async (token, ids) => { calls.push(ids); return Object.fromEntries(ids.map(id => [id, !!verified[id]])); },
  };
  // The demo profile starts out "verified"; signed-in users must get their real status instead.
  run("DB.api = api; S.me = {first:'Demo', last:'User', color:'#3B6EA8', verified:'verified', hometown:'', bio:''};");
  return {run, api:context.api, calls, signIn:async () => { await run('(async () => { DB.session = await api.getSession(); await loadAccount(); })()'); }};
}

test('a signed-in user without a confirmed BYU email is not verified and cannot post', async () => {
  const f = fixture({verified:{}});
  await f.signIn();
  assert.equal(f.run('S.me.verified'), 'pending');
  assert.equal(f.run('isVerified()'), false);
  const post = f.run('SCREENS.post()');
  assert.match(post, /Verify your BYU email to post trips/);
  assert.doesNotMatch(post, /id="ptForm"/);
  assert.doesNotMatch(post, /mark me verified/); // no prototype bypass for real accounts
});

test('a verified user sees the Post a Trip form', async () => {
  const f = fixture({verified:{'rider-b':true}});
  await f.signIn();
  assert.equal(f.run('S.me.verified'), 'verified');
  assert.match(f.run('SCREENS.post()'), /id="ptForm"/);
});

test('driver badges on saved trips come from the database, in one lookup', async () => {
  const f = fixture({verified:{'rider-b':true, 'driver-a':true}});
  await f.signIn(); await f.run('loadDbTrips()');
  assert.equal(f.run("USERS['driver-a'].verified"), 'verified');
  assert.equal(JSON.stringify(f.calls.at(-1)), '["driver-a"]'); // array comes from the app's VM realm
  f.run("S.params = {id:'trip-1'}");
  const detail = f.run('SCREENS.detail()');
  assert.match(detail, /class="verified"/);
  assert.match(detail, /What does Verified mean\?/);
  assert.match(detail, /confirmed it by clicking the link/);
  assert.match(detail, /does not check a student ID/);
});

test('if the lookup fails, badges stay unverified and the trips still load', async () => {
  const f = fixture({verified:{'rider-b':true}});
  await f.signIn();
  f.api.loadVerification = async () => { throw new TypeError('Failed to fetch'); };
  const trips = await f.run('loadDbTrips()');
  assert.equal(trips.length, 1);
  assert.equal(f.run("USERS['driver-a'].verified"), 'pending');
});

test('a database refusal on posting explains the verification rule', () => {
  const f = fixture();
  assert.match(f.run("dbErrorMessage({status:403, code:'42501'})"), /Only verified drivers/);
});
