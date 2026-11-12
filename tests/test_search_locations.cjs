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

test('trip details show the saved starting city',()=>{
  const code=fs.readFileSync('public/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/,'');
  const c=vm.createContext({console,Date,Intl,setTimeout,clearTimeout,document:{getElementById(){return null;},addEventListener(){}},window:{}});
  vm.runInContext(code,c);
  const detail=vm.runInContext("TRIPS.push({...TRIPS[0],id:'saved-ride',origin:'Orem'}); S.params.id='saved-ride'; SCREENS.detail()",c);
  assert.match(detail,/Orem →/);
  assert.doesNotMatch(detail,/Provo →/);
});

test('saved-place selection attaches separate pins, updates starting city, and clears changed addresses',async()=>{
  const {bindLocationPickers}=await import(moduleURL('public/hitch-locations.js'));
  const fields=new Map();
  function element(){return {value:'',textContent:'',innerHTML:'',children:[],listeners:{},isConnected:true,open:true,
    focus(){},showModal(){this.open=true;},close(){this.open=false;},contains(){return false;},querySelector(){return this.children.find(c=>c.type==='button');},addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(){this.children=[];},append(...children){this.children.push(...children);}};}
  const get=id=>{if(!fields.has(id)) fields.set(id,element());return fields.get(id);};
  const originalDocument=global.document, originalFetch=global.fetch;
  global.document={createElement:element};
  let changes=0;
  const api={loadLocations:async()=>[{name:'Campus meeting point',city:'Orem',latitude:40.2786,longitude:-111.7187}]};
  try {
    const picker=bindLocationPickers({api,session:{accessToken:'test'},form:{querySelector:selector=>get(selector.slice(1)),addEventListener(){},removeEventListener(){}},onChange(){changes++;}});
    await get('pt-pickup-open').listeners.click();
    get('pt-pickup-places').children[0].listeners.click();
    assert.equal(picker.pins.pickup,null, 'choosing in the dialog is only a draft');
    get('pt-pickup-confirm').listeners.click();
    assert.equal(picker.pins.pickup.lat,40.2786); assert.equal(picker.pins.dropoff,null);
    assert.equal(get('pt-origin').value,'Orem'); assert.equal(get('pt-pickup').value,'Campus meeting point, Orem');
    assert.equal(get('pt-pickup-center').disabled,true); // Address/list fallback works without the map library.
    await get('pt-dropoff-open').listeners.click();
    get('pt-dropoff-places').children[0].listeners.click();
    get('pt-dropoff-confirm').listeners.click();
    assert.ok(picker.pins.dropoff); assert.equal(changes,2);
    get('pt-pickup').value='A changed address'; get('pt-pickup').listeners.input();
    assert.equal(picker.pins.pickup,null); assert.ok(picker.pins.dropoff);
    const response=new Promise(resolve=>{
      global.fetch=async url=>{
        assert.equal(new URL(url).searchParams.get('q'),'A changed address');
        return {ok:true,json:async()=>{
          resolve();
          return {features:[{geometry:{type:'Point',coordinates:[-111.6,40.2]},properties:{name:'Library',street:'Main Street',city:'Provo'}}]};
        }};
      };
    });
    await response; await new Promise(resolve=>setImmediate(resolve));
    get('pt-pickup-suggestions').children[0].listeners.click();
    assert.deepEqual(picker.pins.pickup,{lat:40.2,lng:-111.6});
    assert.equal(get('pt-pickup').value,'Library, Main Street, Provo');
    assert.equal(get('pt-origin').value,'Provo');
    assert.equal(get('pt-pickup-suggestions').hidden,true);
    await get('pt-pickup-open').listeners.click();
    get('pt-pickup-search').value='Unsaved change'; get('pt-pickup-search').listeners.input();
    get('pt-pickup-cancel').listeners.click();
    assert.equal(get('pt-pickup').value,'Library, Main Street, Provo');
    assert.deepEqual(picker.pins.pickup,{lat:40.2,lng:-111.6});
    picker.destroy();
  } finally {global.document=originalDocument;global.fetch=originalFetch;}
});

test('signed-in home shows saved future rides and excludes samples, past rides and full rides',()=>{
  const source=fs.readFileSync('public/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/,'');
  const c=vm.createContext({console,Date,Intl,setTimeout,clearTimeout,document:{getElementById(){return null;},addEventListener(){}},window:{}});
  vm.runInContext(source,c);
  const output=vm.runInContext(`S.me={first:'Test',last:'Student',color:'#214b3b'};DB.session={user:{id:'me'}};S.ridesState='done';
    for(const [id,departure,dest,seats] of [['future','2099-11-20T23:00:00Z','moab',2],['past','2000-01-01T23:00:00Z','slc',3],['full','2099-11-21T23:00:00Z','jackson',0]])
      upsertTrip(fromRow({id,driver_id:'driver',departure_at:departure,destination_id:dest,total_seats:3,seats_available:seats,price_per_seat:22,pickup_location:'Saved meeting point',dropoff_location:'Arrival'}));
    homeRideList();`,c);
  assert.match(output,/Moab/);assert.match(output,/Saved meeting point/);
  assert.doesNotMatch(output,/Sample ride|Salt Lake City|Jackson Hole|Kaylee|Marcus/);
});
