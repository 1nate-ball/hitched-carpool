// Run with: node --test tests/test_stats.cjs
// Admin Stats screen: Objective 2 seat fill rate, loaded live from the database (in-memory API here).
// The database side (admin-only, the math, live updates) is checked by scripts/check_seat_fill_stats_schema.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');

// Same numbers as database/kr_seat_fill_test_seed.sql: 0.75 and 0.3333 -> 0.5417.
const STATS = {departed_trips:2, avg_fill_rate:0.5417, departed_accepted_seats:4, departed_total_seats:7,
  upcoming_trips:1, upcoming_accepted_seats:1, upcoming_total_seats:2, target_fill_rate:0.70, computed_at:'2099-01-01T00:00:00Z'};

function fixture({admin = true, stats = () => STATS} = {}) {
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout, setInterval(){ return 1; }, clearInterval(){},
    document:{getElementById:() => null, addEventListener(){}, querySelectorAll(){ return []; }, hidden:false}, window:{scrollTo(){}}});
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  let calls = 0;
  context.api = {
    getSession:async () => ({accessToken:'token', user:{id:'me-1', email:'me@byu.edu'}}),
    loadMyProfile:async () => ({id:'me-1', full_name:'Avery Admin'}),
    loadProfileDetails:async () => ({hometown:'', bio:'', color:''}),
    loadVerification:async ids => ({}),
    isAdmin:async () => admin,
    loadSeatFillStats:async () => { calls++; return stats(); },
  };
  run("DB.api = api; S.me = {first:'Avery', last:'Admin', color:'#3B6EA8', verified:'verified', hometown:'', bio:''}; render = () => {};");
  return {run, calls:() => calls, signIn:() => run('(async () => { DB.session = await api.getSession(); await loadAccount(); })()')};
}

test('admins get a Stats link on Profile; everyone else does not', async () => {
  const a = fixture({admin:true}); await a.signIn();
  assert.match(a.run('SCREENS.profile()'), /data-act="openstats"/);
  const b = fixture({admin:false}); await b.signIn();
  assert.doesNotMatch(b.run('SCREENS.profile()'), /openstats/);
  const c = fixture(); c.run('api.isAdmin = undefined'); await c.signIn(); // older cached helper file
  assert.doesNotMatch(c.run('SCREENS.profile()'), /openstats/);
  assert.equal(c.run('DB.profile.full_name'), 'Avery Admin'); // the rest of the profile still loaded
});

test('stats screen shows the KR average, target, and seat totals from the database', async () => {
  const f = fixture(); await f.signIn();
  f.run("S.screen = 'stats'"); await f.run('loadStats()');
  const screen = f.run('SCREENS.stats()');
  assert.match(screen, /<b class="tnum">54%<\/b><span class="pill warn">Below target<\/span>/);
  assert.match(screen, /Average across 2 trips that have departed\. Target 70%/);
  assert.match(screen, /4 of 7 seats<\/b>/); assert.match(screen, /\(57% of all seats\)/);
  assert.match(screen, /1 of 2 seats<\/b>/); assert.match(screen, /across 1 trip\./);
  assert.match(screen, /aria-label="54% average seat fill rate, target 70%"/);
  assert.match(screen, /Updated /);
});

test('numbers are not stored: every load asks the database again', async () => {
  let rate = 0.5417;
  const f = fixture({stats:() => ({...STATS, avg_fill_rate:rate})}); await f.signIn();
  f.run("S.screen = 'stats'"); await f.run('loadStats()');
  rate = 0.75; await f.run('loadStats()');
  assert.equal(f.calls(), 2);
  assert.match(f.run('SCREENS.stats()'), /75%<\/b><span class="pill ok">On target/);
});

test('before any trip departs, the KR shows a dash instead of 0%', async () => {
  const f = fixture({stats:() => ({...STATS, departed_trips:0, avg_fill_rate:null, departed_accepted_seats:0, departed_total_seats:0})});
  await f.signIn(); f.run("S.screen = 'stats'"); await f.run('loadStats()');
  const screen = f.run('SCREENS.stats()');
  assert.match(screen, /<b class="tnum">—<\/b><span class="pill neutral">No departed trips yet/);
  assert.doesNotMatch(screen, /NaN/);
});

test('refusals and a missing migration are explained', async () => {
  const fail = (code, status) => () => { throw Object.assign(new Error('x'), {code, status}); };
  const a = fixture({stats:fail('42501', 400)}); await a.signIn(); a.run("S.screen = 'stats'"); await a.run('loadStats()');
  assert.match(a.run('SCREENS.stats()'), /Only Hitch admins can see stats/);
  const b = fixture({stats:fail('PGRST202', 404)}); await b.signIn(); b.run("S.screen = 'stats'"); await b.run('loadStats()');
  assert.match(b.run('SCREENS.stats()'), /aren&#39;t turned on in the database yet/);
  // A failed refresh keeps the last numbers on screen.
  let ok = true;
  const c = fixture({stats:() => { if (ok) return STATS; throw new Error('offline'); }}); await c.signIn();
  c.run("S.screen = 'stats'"); await c.run('loadStats()'); ok = false; await c.run('loadStats()');
  const screen = c.run('SCREENS.stats()');
  assert.match(screen, /couldn&#39;t reach the database/); assert.match(screen, /54%/);
});

test('stats is a signed-in screen', () => {
  const f = fixture();
  assert.equal(f.run("AUTH_SCREENS.has('stats')"), true);
});
