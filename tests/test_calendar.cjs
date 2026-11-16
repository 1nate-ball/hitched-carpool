const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const load=()=>import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync('public/hitch-calendar.js')).toString('base64'));
const trip={id:'saved-trip',origin:'Provo',destination:'Moab',pickup:'WSC, north; door',dropoff:'Main St',departureAt:'2026-11-27T16:00:00-07:00',returnAt:'2026-11-29T18:00:00-07:00'};
test('calendar exports two start-time events with correct UTC times and stable distinct IDs',async()=>{
 const {tripCalendar}=await load(),a=tripCalendar(trip),b=tripCalendar(trip);
 assert.equal((a.match(/BEGIN:VEVENT/g)||[]).length,2);assert.match(a,/DTSTART:20261127T230000Z/);assert.match(a,/DTSTART:20261130T010000Z/);
 assert.match(a,/LOCATION:WSC\\, north\\; door/);assert.match(a,/Confirm the meeting spot/);assert.doesNotMatch(a,/DTEND|ATTENDEE|VALARM/);
 assert.deepEqual(a.match(/UID:.*/g),b.match(/UID:.*/g));assert.equal(new Set(a.match(/UID:.*/g)).size,2);
 assert.equal((tripCalendar({...trip,returnAt:null}).match(/BEGIN:VEVENT/g)||[]).length,1);
 assert.match(tripCalendar({...trip,departureAt:'2026-07-01T16:00:00-06:00',returnAt:null}),/DTSTART:20260701T220000Z/);
});
test('calendar escapes content injection, folds UTF-8 safely, and rejects invalid times',async()=>{
 const {tripCalendar}=await load(),out=tripCalendar({...trip,pickup:'é'.repeat(100)+'\r\nATTENDEE:intruder'});
 assert.doesNotMatch(out,/\r\nATTENDEE:/);for(const line of out.split('\r\n'))assert.ok(Buffer.byteLength(line)<=75);
 assert.match(out.replace(/\r\n /g,''),/é{100}\\nATTENDEE/);
 for(const change of [{departureAt:'nope'},{departureAt:'2026-11-27T16:00'},{returnAt:'2026-11-20T12:00:00Z'},{id:'bad\r\n'}])assert.throws(()=>tripCalendar({...trip,...change}));
});
test('calendar is offered only on future saved trips for the driver or confirmed riders',()=>{
 const source=fs.readFileSync('public/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/,'');
 const c=vm.createContext({console,Date,Intl,setTimeout,clearTimeout,document:{getElementById(){return null},addEventListener(){}},window:{}});vm.runInContext(source,c);
 const run=s=>vm.runInContext(s,c);run("globalThis.t={dbTrip:true,id:'test',driver:'other',passengers:['me'],requests:[],departureAt:'2099-01-01T12:00:00Z'}");
 assert.equal(run('calendarAllowed(t)'),true);run('t.passengers=[]');assert.equal(run('calendarAllowed(t)'),false);
 run("t.driver='me'");assert.equal(run('calendarAllowed(t)'),true);run('t.cancelled=true');assert.equal(run('calendarAllowed(t)'),false);
 run("t.cancelled=false;t.departureAt='2000-01-01T12:00:00Z'");assert.equal(run('calendarAllowed(t)'),false);
 run("t.departureAt='2099-01-01T12:00:00Z';t.dbTrip=false");assert.equal(run('calendarAllowed(t)'),false);
});
