const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const moduleURL = file => 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(file,'utf8')).toString('base64');

test('city, date, price filters query only the open-trip view; payload cannot spoof identity',async()=>{
  const requests=[];
  const prior=global.fetch;
  global.fetch=async(url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>url==='/supabase-config.json'?{url:'https://example.test',publishableKey:'public'}:[{id:'saved'}]};
  };
  try {
    const api=await import(moduleURL('public/hitch-supabase.js'));
    await api.searchTrips('session',{destinationId:'moab',fromCity:'Salt Lake City',fromIso:'2099-11-06T23:00:00Z',toIso:'2099-11-07T07:00:00Z',maxPrice:25});
    const url=new URL(requests.at(-1).url);
    assert.equal(url.pathname,'/rest/v1/available_trips');
    assert.equal(url.searchParams.get('origin_city'),'ilike.Salt Lake City');
    assert.equal(url.searchParams.get('destination_id'),'eq.moab');
    assert.equal(url.searchParams.get('price_per_seat'),'lte.25');
    assert.equal(url.searchParams.get('departure_at'),'gte.2099-11-06T23:00:00Z');
    await api.publishTrip('session',{driver_id:'someone-else',destination_id:'moab',origin_city:'Orem',pickup_latitude:40.2,pickup_longitude:-111.6});
    const payload=JSON.parse(requests.at(-1).options.body);
    assert.equal(payload.driver_id,undefined); assert.equal(payload.origin_city,'Orem'); assert.equal(payload.pickup_latitude,40.2);
  } finally {global.fetch=prior;}
});

test('place search supports name/city and rejects incomplete or out-of-range coordinates',async()=>{
  const {matchingPlaces,validPin}=await import(moduleURL('public/hitch-locations.js'));
  const places=[{name:'Helaman Halls',city:'Provo'},{name:'Utah Valley University',city:'Orem'}];
  assert.equal(matchingPlaces(places,' HELAMAN ')[0].city,'Provo');
  assert.equal(matchingPlaces(places,'orem').length,1);
  assert.equal(matchingPlaces(places,'missing').length,0);
  assert.ok(validPin({lat:40,lng:-111}));
  for(const pin of [{lat:91,lng:0},{lat:0,lng:181},{lat:null,lng:0},{lat:40}]) assert.ok(!validPin(pin));
});

test('search uses real time, does not mix sample rows into signed-in results, and counts aggregate availability',async()=>{
  const html=fs.readFileSync('public/index.html','utf8');
  const code=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/,'');
  const c=vm.createContext({console,Date,Intl,setTimeout,clearTimeout,document:{getElementById(){return null;},addEventListener(){}},window:{}});
  vm.runInContext(code,c); const run=code=>vm.runInContext(code,c);
  c.api={getSession:async()=>({accessToken:'token',user:{id:'a'}}),searchTrips:async(token,opts)=>{assert.equal(opts.fromCity,'Orem');assert.ok(Date.parse(opts.fromIso)>=Date.now()-1000);return [];}};
  run("DB.api=api; S.screen='results'; S.params.dest='moab'; S.search.from='Orem'; S.search.date='2020-01-01';");
  await run('searchDbTrips()');
  assert.equal(run('S.dbSearch.state'),'done');
  assert.match(run('resultsList()'),/No rides found/);
  assert.equal(run('seatsLeft({dbTrip:true,available:0,seats:3,passengers:[]})'),0);
  assert.equal(run('seatsLeft({dbTrip:true,available:2,seats:3,passengers:["me"]})'),2);
});
