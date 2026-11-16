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

test('all trips use calendar groups; old sample trips are not presented as upcoming', () => {
  const run = app();
  const g = depart => run(`tripGroup({depart:'${depart}'}, new Date(2026, 9, 3, 10, 0))`);
  assert.equal(g('2026-10-03T18:00'), 'Today');
  assert.equal(g('2026-10-04T08:00'), 'This week');
  assert.equal(g('2026-10-09T23:59'), 'This week');
  assert.equal(g('2026-10-10T08:00'), 'This month');
  assert.equal(g('2026-11-02T08:00'), 'Later');
  assert.equal(g('2026-10-03T07:00'), 'Past');
  assert.equal(run("tripGroup({depart:'2026-10-09T15:30'}, new Date(2026, 10, 16))"), 'Past');
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
    if (tab === 'rider') assert.match(html, /Sample trip/);
  }
});

test('departure labels handle minutes, hours, days, passed times and UTC offsets',()=>{
  const run=app(), now=Date.parse('2026-11-16T12:00:00Z');
  const label=seconds=>run(`departureLabel('${new Date(now+seconds*1000).toISOString()}',${now})`);
  assert.equal(label(30),'Leaving in less than a minute');
  assert.equal(label(60),'Leaves in 1 minute');assert.equal(label(120),'Leaves in 2 minutes');
  assert.equal(label(3600),'Leaves in 1 hour');assert.equal(label(5400),'Leaves in 1h 30m');
  assert.equal(label(86400),'Leaves in 1 day');assert.equal(label(86400*3),'Leaves in 3 days');
  assert.equal(label(0),'Departure time passed');assert.equal(run(`departureLabel('invalid',${now})`),'');
  assert.equal(run("departureLabel('2026-11-01T01:30:00-07:00', Date.parse('2026-11-01T01:30:00-06:00'))"),'Leaves in 1 hour');
});

test('countdowns only accompany real confirmed rides and the driver’s trips',()=>{
 const run=app();
 run("globalThis.testTrip={dbTrip:true,driver:'me',passengers:[],requests:[],departureAt:'2099-01-01T12:00:00Z'}");
 assert.match(run('departureCountdown(testTrip)'),/data-departure=/);
 run("testTrip.driver='other';testTrip.requests=[{uid:'me',status:'pending'}]");assert.equal(run('departureCountdown(testTrip)'),'');
 run("testTrip.passengers=['me']");assert.match(run('departureCountdown(testTrip)'),/Leaves in/);
 for(const change of ["testTrip.cancelled=true","testTrip.cancelled=false;testTrip.dbTrip=false","testTrip.dbTrip=true;testTrip.departureAt='2000-01-01T12:00:00Z'"]){run(change);assert.equal(run('departureCountdown(testTrip)'),'');}
});

test('countdown refreshes in place, skips hidden pages, and cleans up its timer',()=>{
 const source=fs.readFileSync('public/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/,'');
 let now=Date.parse('2026-11-16T12:00:00Z'),tick,cleared=false,removed=false;
 class Clock extends Date{static now(){return now;}}
 const el={dataset:{departure:'2026-11-16T12:02:00Z'},textContent:''};
 const doc={hidden:false,getElementById:()=>stubElement(),addEventListener(){},removeEventListener(name){if(name==='visibilitychange')removed=true;},querySelectorAll:()=>[el]};
 const c=vm.createContext({console,Date:Clock,Intl,setTimeout,clearTimeout,setInterval(fn,ms){assert.equal(ms,30000);tick=fn;return 7;},clearInterval(id){assert.equal(id,7);cleared=true;},document:doc,window:{}});
 vm.runInContext(source,c);vm.runInContext('BIND.mytrips()',c);tick();assert.equal(el.textContent,'Leaves in 2 minutes');
 now+=60000;doc.hidden=true;tick();assert.equal(el.textContent,'Leaves in 2 minutes');doc.hidden=false;tick();assert.equal(el.textContent,'Leaves in 1 minute');
 vm.runInContext('cleanupCountdowns()',c);assert.equal(cleared,true);assert.equal(removed,true);
});
