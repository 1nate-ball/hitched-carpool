// Run with: node --test tests/test_notifications.cjs
// In-app notifications: the bell, the list, opening an alert, and mark read, using the real app code and an
// in-memory database that creates alerts the way the database triggers do. The database rules (only after a
// saved change, one per event, recipient only) are checked by scripts/check_notifications_schema.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');

// One shared "database", so a second fixture for the same user is like refreshing the page.
function database() {
  const db = {
    trip:{id:'trip-1', driver_id:'driver', destination_id:'moab', departure_at:'2099-11-20T23:00:00Z', return_at:null,
      pickup_location:'WILK', dropoff_location:'Moab', total_seats:2, price_per_seat:25},
    names:{driver:'Dana Driver', rider:'Riley Rider', other:'Olive Other'},
    requests:[], notes:[], marked:[], n:0,
  };
  db.notify = (recipient, kind, r) => { // the trigger: one per request per event
    if (db.notes.some(x => x.request_id === r.id && x.kind === kind)) return;
    db.notes.unshift({id:`n${++db.n}`, recipient, kind, request_id:r.id, trip_id:r.trip_id, created_at:new Date().toISOString(), read_at:null});
  };
  return db;
}

function fixture(db, me) {
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout, setInterval(){ return 1; }, clearInterval(){},
    document:{getElementById:() => ({hidden:true, textContent:''}), addEventListener(){}, querySelectorAll(){ return []; }, hidden:false},
    window:{scrollTo(){}}});
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  context.api = {
    getSession:async () => ({accessToken:'token', user:{id:me}}),
    loadMyProfile:async () => ({id:me, full_name:db.names[me]}),
    loadProfileDetails:async () => ({hometown:'', bio:'', color:''}),
    loadVerification:async () => ({[me]:true}),
    isAdmin:async () => false,
    loadTrips:async () => [db.trip],
    loadMyRequests:async (token, riderId) => db.requests.filter(r => r.rider_id === riderId),
    loadTripRequests:async () => db.trip.driver_id === me ? db.requests : [],
    loadProfiles:async (token, ids) => ids.map(id => ({id, full_name:db.names[id]})),
    loadSeatsAvailable:async () => ({'trip-1':db.trip.total_seats - db.requests.filter(r => r.status === 'accepted').length}),
    requestSeat:async (token, tripId, note) => {
      const r = {id:`r${db.requests.length + 1}`, trip_id:tripId, rider_id:me, note, status:'pending'};
      db.requests.push(r); db.notify(db.trip.driver_id, 'seat_requested', r); return r;
    },
    decideRequest:async (token, id, status) => {
      const r = db.requests.find(x => x.id === id);
      if (db.trip.driver_id !== me || r.status !== 'pending') throw Object.assign(new Error('Refused'), {code:'42501'});
      r.status = status; db.notify(r.rider_id, `request_${status}`, r); return {id, status};
    },
    loadNotifications:async () => db.notes.filter(n => n.recipient === me).map(n => {
      const r = db.requests.find(x => x.id === n.request_id);
      return {...n, destination_id:'moab', departure_at:db.trip.departure_at, other_name:db.names[n.kind === 'seat_requested' ? r.rider_id : db.trip.driver_id]};
    }),
    markNotificationsRead:async (token, ids) => {
      db.marked.push(ids);
      let c = 0;
      for (const n of db.notes) if (n.recipient === me && !n.read_at && (!ids || ids.includes(n.id))){ n.read_at = new Date().toISOString(); c++; }
      return c;
    },
  };
  run("DB.api = api; S.me = {first:'Me', last:'User', color:'#3B6EA8', verified:'verified', hometown:'', bio:''}; toast = msg => { S.notice = msg; }; render = () => {};");
  const signIn = () => run('(async () => { DB.session = await api.getSession(); await loadAccount(); await loadNotes({quiet:true}); await loadDbTrips(); })()');
  return {run, signIn};
}

test('a saved seat request alerts the driver, not the rider', async () => {
  const db = database();
  const rider = fixture(db, 'rider'); await rider.signIn();
  await rider.run("sendSeatRequest(TRIPS.find(t => t.id === 'trip-1'), 'Can I bring skis?')");
  await rider.run('loadNotes()');
  assert.equal(rider.run('unreadNotes()'), 0);

  const driver = fixture(db, 'driver'); await driver.signIn();
  assert.equal(driver.run('unreadNotes()'), 1);
  assert.match(driver.run('nav()'), /data-note-badge >1<\/span>/);
  assert.match(driver.run('nav()'), /aria-label="Notifications, 1 unread"/);
  driver.run("S.screen = 'notes'");
  const screen = driver.run('SCREENS.notes()');
  assert.match(screen, /<b>Riley<\/b> requested a seat on your trip to Moab/);
  assert.match(screen, /class="note unread"/);
  assert.match(screen, />Review</);
});

test('accept and decline alert the rider with the driver name', async () => {
  const db = database();
  db.names.second = 'Sam Second';
  const rider = fixture(db, 'rider'); await rider.signIn();
  await rider.run("sendSeatRequest(TRIPS.find(t => t.id === 'trip-1'), '')");
  const second = fixture(db, 'second'); await second.signIn();
  await second.run("sendSeatRequest(TRIPS.find(t => t.id === 'trip-1'), '')");

  const driver = fixture(db, 'driver'); await driver.signIn();
  await driver.run("decideDbRequest(TRIPS.find(t => t.id === 'trip-1'), 'r1', 'accepted')");
  await driver.run("decideDbRequest(TRIPS.find(t => t.id === 'trip-1'), 'r2', 'declined')");

  await rider.run('loadNotes()');
  assert.match(rider.run('SCREENS.notes()'), /<b>Dana<\/b> accepted your seat request for Moab/);
  assert.match(rider.run('S.notice'), /^New: Dana accepted your seat request for Moab$/); // arrived while open
  await second.run('loadNotes()');
  assert.match(second.run('SCREENS.notes()'), /<b>Dana<\/b> declined your seat request for Moab/);
});

test('the badge and list survive a refresh, with no duplicate alerts', async () => {
  const db = database();
  const rider = fixture(db, 'rider'); await rider.signIn();
  await rider.run("sendSeatRequest(TRIPS.find(t => t.id === 'trip-1'), '')");
  const driver = fixture(db, 'driver'); await driver.signIn();
  await driver.run('loadNotes()'); await driver.run('loadNotes()');
  assert.equal(driver.run('S.notes.list.length'), 1);
  const refreshed = fixture(db, 'driver'); await refreshed.signIn(); // a page refresh: new app, same database
  assert.equal(refreshed.run('unreadNotes()'), 1);
  assert.equal(refreshed.run('S.notes.list.length'), 1);
});

test('opening an alert marks it read and opens the request or the trip', async () => {
  const db = database();
  const rider = fixture(db, 'rider'); await rider.signIn();
  await rider.run("sendSeatRequest(TRIPS.find(t => t.id === 'trip-1'), 'hi')");
  const driver = fixture(db, 'driver'); await driver.signIn();
  await driver.run("openNote(S.notes.list[0].id)");
  assert.equal(driver.run('S.screen'), 'manage');
  assert.equal(driver.run('S.params.id'), 'trip-1');
  assert.match(driver.run('SCREENS.manage()'), /Rider/); // the new request is on Manage requests
  assert.equal(JSON.stringify(db.marked), '[["n1"]]');
  assert.equal(driver.run('unreadNotes()'), 0);

  await driver.run("decideDbRequest(TRIPS.find(t => t.id === 'trip-1'), 'r1', 'accepted')");
  await rider.run('loadNotes()');
  await rider.run("openNote(S.notes.list[0].id)");
  assert.equal(rider.run('S.screen'), 'detail');
  assert.equal(rider.run('S.params.id'), 'trip-1');
  assert.equal(rider.run("myStatus(TRIPS.find(t => t.id === 'trip-1'))"), 'confirmed'); // reloaded, so the status is current
});

test('mark all read clears the badge, and it stays cleared after a refresh', async () => {
  const db = database();
  db.names.second = 'Sam Second';
  for (const who of ['rider', 'second']) {
    const f = fixture(db, who); await f.signIn();
    await f.run("sendSeatRequest(TRIPS.find(t => t.id === 'trip-1'), '')");
  }
  const driver = fixture(db, 'driver'); await driver.signIn();
  assert.equal(driver.run('unreadNotes()'), 2);
  assert.match(driver.run('SCREENS.notes()'), /2 unread/);
  await driver.run('markNotesRead()');
  assert.equal(JSON.stringify(db.marked), '[null]');
  assert.match(driver.run('nav()'), /data-note-badge hidden>0</);
  assert.match(driver.run('SCREENS.notes()'), /All caught up/);
  const refreshed = fixture(db, 'driver'); await refreshed.signIn();
  assert.equal(refreshed.run('unreadNotes()'), 0);
});

test("other users' alerts never show up, and logging out clears them", async () => {
  const db = database();
  const rider = fixture(db, 'rider'); await rider.signIn();
  await rider.run("sendSeatRequest(TRIPS.find(t => t.id === 'trip-1'), '')");
  const other = fixture(db, 'other'); await other.signIn();
  assert.equal(other.run('S.notes.list.length'), 0);
  assert.match(other.run('SCREENS.notes()'), /No notifications yet/);

  const driver = fixture(db, 'driver'); await driver.signIn();
  driver.run('api.signOut = () => {}; globalThis.sessionStorage = {removeItem(){}, setItem(){}}');
  await driver.run("logOut('bye')");
  assert.equal(driver.run('S.notes'), null);
  assert.doesNotMatch(driver.run('nav()'), /nav-bell/); // signed out: no bell
  assert.ok(driver.run("AUTH_SCREENS.has('notes')"));
});

test('without the notifications migration the app still works and says why', async () => {
  const db = database();
  const f = fixture(db, 'driver');
  f.run("api.loadNotifications = async () => { throw Object.assign(new Error('Could not find the function'), {status:404, code:'PGRST202'}); }");
  await f.signIn();
  assert.equal(f.run('DB.profile.full_name'), 'Dana Driver'); // the rest of sign-in still loaded
  assert.match(f.run('SCREENS.notes()'), /Notifications aren&#39;t turned on in the database yet/);
  assert.match(f.run('nav()'), /data-note-badge hidden>0</);
  const old = fixture(db, 'driver'); old.run('api.loadNotifications = undefined'); await old.signIn(); // older cached helper file
  assert.match(old.run('SCREENS.notes()'), /run the notifications migration/);
});
