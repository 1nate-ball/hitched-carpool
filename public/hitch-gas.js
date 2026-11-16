// Public EPA data only. No account information or locations are sent to the EPA.
export function gasShare({miles, mpg, price, seats, roundTrip}) {
  if (![miles,mpg,price,seats].every(Number.isFinite) || miles<1 || miles>10000 || mpg<1 || mpg>150 || price<0.1 || price>20 || !Number.isInteger(seats) || seats<1 || seats>7) return null;
  const total=miles*(roundTrip?2:1)/mpg*price;
  return {total, perPerson:total/(seats+1), suggested:Math.max(1,Math.ceil(total/(seats+1)))};
}
const cache=new Map();
async function epa(path, signal) {
  if (cache.has(path)) return cache.get(path);
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),8000);
  const abort=()=>controller.abort(); signal.addEventListener('abort',abort,{once:true});
  try {
    const res=await fetch('https://www.fueleconomy.gov/ws/rest/'+path,{headers:{Accept:'application/json'},signal:controller.signal});
    if (!res.ok) throw new Error('EPA unavailable');
    const data=await res.json(); if (!data) throw new Error('No EPA data');
    if(cache.size>100) cache.clear(); cache.set(path,data); return data;
  } finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
export function bindGasEstimate({form,getPins,milesBetween}) {
  const $=id=>form.querySelector('#'+id), panel=$('pt-gas'), controller=new AbortController();
  let active=true, started=false, revision=0, autoMiles='', lastPins='', lastResult=null, customPrice=false;
  const status=$('gas-status');
  function reset(id,label) {const el=$(id);el.replaceChildren(new Option(label,''));el.disabled=true;}
  function options(id,label,data) {
    const rows=Array.isArray(data.menuItem)?data.menuItem:data.menuItem?[data.menuItem]:[];
    reset(id,label);
    for(const row of rows) if(row.value && row.text) $(id).append(new Option(row.text,row.value));
    $(id).disabled=!rows.length;
    if(!rows.length) status.textContent='No matching EPA vehicles. Enter MPG manually.';
  }
  function update() {
    const pins=getPins(), key=JSON.stringify(pins);
    if(key!==lastPins) {
      lastPins=key;
      if(!$('gas-miles').value || $('gas-miles').value===autoMiles) {
        autoMiles=pins.from && pins.to ? String(Math.max(1,Math.round(milesBetween(pins.from,pins.to)*1.2))) : '';
        $('gas-miles').value=autoMiles;
        $('gas-distance').textContent=autoMiles?'Miles approximate the road distance from your map pins. Edit for your route.':'Enter route miles, or choose pickup and drop-off pins.';
      }
    }
    const result=gasShare({miles:Number($('gas-miles').value),mpg:Number($('gas-mpg').value),price:Number($('gas-price').value),seats:Number($('pt-seats').value),roundTrip:$('pt-ret').checked});
    lastResult=result;
    $('gas-use').disabled=!result || result.suggested>150;
    $('gas-result').textContent=result ? `$${result.perPerson.toFixed(2)} gas per person · $${result.total.toFixed(2)} total${$('pt-ret').checked?' round trip':' one way'}. Split between the driver + ${$('pt-seats').value} rider${Number($('pt-seats').value)===1?'':'s'}.` : 'Enter miles, MPG, gas price, and available seats to calculate.';
    if(result?.suggested>150) $('gas-result').textContent+=' This exceeds the $150 seat-price limit.';
  }
  async function menu(level) {
    const mine=++revision, year=$('gas-year').value, make=$('gas-make').value, model=$('gas-model').value;
    if(level==='make') reset('gas-make','Choose make');
    if(level!=='option') reset('gas-model','Choose model');
    reset('gas-option','Choose option'); $('gas-mpg').value=''; update();
    $('gas-source').textContent='Choose your vehicle for EPA combined MPG, or enter MPG yourself.';
    status.textContent='Loading vehicles…';
    const params=new URLSearchParams({year,...(level!=='make'?{make}:{}),...(level==='option'?{model}:{})});
    try {const data=await epa('vehicle/menu/'+(level==='option'?'options':level)+'?'+params,controller.signal);
      if(!active || mine!==revision) return;
      status.textContent='';options('gas-'+level,'Choose '+(level==='option'?'option':level),data);
    } catch {if(active && mine===revision) status.textContent='Vehicle lookup unavailable. Enter MPG manually.';}
  }
  async function vehicle() {
    const mine=++revision, id=$('gas-option').value;
    $('gas-mpg').value=''; update(); if(!id) return;
    status.textContent='Loading fuel economy…';
    try {const data=await epa('vehicle/'+encodeURIComponent(id),controller.signal);
      if(!active || mine!==revision) return;
      if(!/gasoline|diesel/i.test(data.fuelType1 || '') || /plug-in/i.test(data.atvType || '')) {
        status.textContent='This vehicle needs an electric or alternative-fuel estimate. Enter your own fuel cost and MPG if applicable.';return;
      }
      const mpg=Number(data.comb08); if(!(mpg>=1 && mpg<=150)) throw new Error('No MPG');
      $('gas-mpg').value=String(mpg);
      $('gas-source').textContent=`EPA combined: ${mpg} MPG · ${data.year} ${data.make} ${data.model}. Adjust MPG for your driving.`;
      status.textContent='';
      if(!$('pt-car').value) {$('pt-car').value=`${data.year} ${data.make} ${data.model}`.slice(0,60);$('pt-car').dispatchEvent(new Event('input',{bubbles:true}));}
      if(!customPrice) {const fuel=await epa('fuelprices',controller.signal);if(active && mine===revision && !customPrice) $('gas-price').value=String(fuel[/diesel/i.test(data.fuelType1)?'diesel':/premium/i.test(data.fuelType1)?'premium':'regular'] || '');}
      if(active && mine===revision) update();
    } catch {if(active && mine===revision) status.textContent='Fuel data unavailable. Enter MPG and gas price manually.';}
  }
  const open=()=>{if(panel.open && !started){started=true;menu('make');epa('fuelprices',controller.signal).then(data=>{if(active && !customPrice){$('gas-price').value=String(data.regular || ''); update();}}).catch(()=>{if(active) status.textContent='Enter your gas price; the national average is unavailable.';});}};
  const use=()=>{if(!lastResult || lastResult.suggested>150) return;$('pt-price').value=String(lastResult.suggested);$('pt-price').dispatchEvent(new Event('input',{bubbles:true}));status.textContent='Seat price set, rounded up to the next dollar. You can edit it.';};
  const changePrice=()=>{customPrice=true;};
  $('gas-mpg').addEventListener('input',()=>{revision++;status.textContent='';$('gas-source').textContent='Using your MPG estimate.';});
  panel.addEventListener('toggle',open);$('gas-year').addEventListener('change',()=>menu('make'));
  $('gas-make').addEventListener('change',()=>menu('model'));$('gas-model').addEventListener('change',()=>menu('option'));$('gas-option').addEventListener('change',vehicle);
  $('gas-price').addEventListener('input',changePrice);$('gas-use').addEventListener('click',use);
  form.addEventListener('input',update);form.addEventListener('change',update);form.addEventListener('hitch-route-updated',update); update();
  return ()=>{active=false;revision++;controller.abort();form.removeEventListener('input',update);form.removeEventListener('change',update);form.removeEventListener('hitch-route-updated',update);};
}
