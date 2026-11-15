// Run with: node --test tests/test_my_trips.cjs
// My Trips: trips are grouped by departure date (design review, Module 06, Finding 3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function stubElement() {
  return {dataset:{}, innerHTML:'', value:'', hidden:true, focus(){}, addEventListener(){}, setAttribute(){},
    closest(){ return {classList:{toggle(){}}}; }, querySelectorAll(){ return []; }};
}
function app() {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout, sessionStorage:{getItem(){ return null; }, setItem(){}, removeItem(){}},
    document:{getElementById:() => stubElement(), addEventListener(){}, querySelectorAll(){ return []; }}, window:{scrollTo(){}}});
  vm.runInContext(source, context);
  return code => vm.runInContext(code, context);
}

test('sample trips are grouped Today / This week / This month / Later / Past against the prototype date', () => {
  const run = app(); // prototype NOW is Sat Oct 3 2026, 10:00
  const g = depart => run(`tripGroup({depart:'${depart}'})`);
  assert.equal(g('2026-10-03T18:00'), 'Today');
  assert.equal(g('2026-10-04T08:00'), 'This week');
  assert.equal(g('2026-10-09T23:59'), 'This week');
  assert.equal(g('2026-10-10T08:00'), 'This month');
  assert.equal(g('2026-11-02T08:00'), 'Later');
  assert.equal(g('2026-10-03T07:00'), 'Past');
});

test('database trips are grouped against the real current time', () => {
  const run = app();
  const soon = run("denverWall(new Date(Date.now() + 60 * 1000))");
  assert.equal(run(`tripGroup({dbTrip:true, depart:'${soon}'})`) === 'Past', false);
  const old = run("denverWall(new Date(Date.now() - 86400 * 1000))");
  assert.equal(run(`tripGroup({dbTrip:true, depart:'${old}'})`), 'Past');
});

test('My Trips renders a heading per group, in order, with every trip still shown', () => {
  const run = app();
  run("S.me = {first:'Jo', last:'Smith', color:'#3B6EA8', verified:'verified', hometown:'', bio:''};");
  for (const tab of ['rider', 'driver']) {
    run(`S.tripsTab = '${tab}'`);
    const html = run('SCREENS.mytrips()');
    const groups = [...html.matchAll(/<section class="tgroup" aria-label="([^"]+)"/g)].map(m => m[1]);
    const order = JSON.parse(run('JSON.stringify(TRIP_GROUPS)')); // plain array from outside the VM realm
    assert.deepEqual(groups, order.filter(g => groups.includes(g)), `${tab}: groups in order`);
    const cards = (html.match(/class="mcard"/g) || []).length;
    if (cards) assert.ok(groups.length > 0, `${tab}: cards sit inside a group`);
    assert.match(html, /class="seg seg-lg"/);
  }
});
