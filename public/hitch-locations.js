// The place list comes from Supabase. Maps use Leaflet 1.9.4 and ordinary OSM tiles.
export function validPin(pin) {
  return pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng) &&
    pin.lat >= -90 && pin.lat <= 90 && pin.lng >= -180 && pin.lng <= 180;
}
export function matchingPlaces(places, query) {
  const q = query.trim().toLocaleLowerCase();
  return places.filter(p => `${p.name} ${p.city}`.toLocaleLowerCase().includes(q)).slice(0, 12);
}

const PROVO = {latitude:40.2485, longitude:-111.6472};
const DESTINATION_CITIES = {bearlake:'Garden City', zion:'Springdale', jackson:'Jackson'};
const distinct = values => [...new Set(values.filter(Boolean))];

async function searchAddresses(query, bias, signal) {
  const params = new URLSearchParams({q:query, limit:'5', lat:bias.latitude, lon:bias.longitude});
  const response = await fetch(`https://photon.komoot.io/api/?${params}`, {signal});
  if (!response.ok) throw new Error('Address search is unavailable.');
  const {features} = await response.json();
  return features.flatMap(({geometry, properties:p}) => {
    if (geometry?.type !== 'Point' || !p) return [];
    const [lng, lat] = geometry.coordinates;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const city = p.city || p.town || p.village || p.locality || '';
    const name = p.name || street || city;
    if (!name || !validPin({lat,lng})) return [];
    const label = distinct([name, street, city, p.state]).join(', ');
    return [{name, city, label, subtitle:distinct([street, city, p.state, p.country].filter(v=>v!==name)).join(', '), latitude:lat, longitude:lng}];
  });
}

export function bindLocationPickers({api, session, form, onChange}) {
  const pins = {pickup:null, dropoff:null}, maps = [], cleanups = [], cache = new Map();
  let places = [], destroyed = false;
  const placesPromise = api.loadLocations(session.accessToken).then(rows => places = rows).catch(() => []);
  const $ = id => form.querySelector('#' + id);
  for (const kind of ['pickup', 'dropoff']) {
    const input = $(`pt-${kind}`), dialog = $(`pt-${kind}-dialog`), search = $(`pt-${kind}-search`);
    const status = $(`pt-${kind}-status`), mapStatus = $(`pt-${kind}-map-status`);
    let map, marker, draft = {pin:null, name:'', city:''};
    const nearbyPlace = () => {
      const dest = $('pt-dest'), typed = $('pt-dest-name');
      if (kind === 'dropoff' && dest?.dataset.lat && dest?.dataset.lng) { // typed destination picked from search
        const latitude = Number(dest.dataset.lat), longitude = Number(dest.dataset.lng);
        if (validPin({lat:latitude, lng:longitude})) return {latitude, longitude};
      }
      const city = kind === 'pickup' ? $('pt-origin').value.trim() : DESTINATION_CITIES[dest?.value] || typed?.value.trim() || '';
      return places.find(place => place.city.toLowerCase() === city.toLowerCase()) || PROVO;
    };
    function moveMarker(pin) {
      if (!map) return;
      if (marker) map.removeLayer(marker);
      marker = pin ? L.marker([pin.lat,pin.lng], {draggable:true, title:`Selected ${kind} point`}).addTo(map) : null;
      marker?.on('dragend', () => setDraftPin(marker.getLatLng()));
      if (pin) map.setView([pin.lat,pin.lng], 16);
    }
    function setDraftPin(pin) {
      if (!validPin(pin)) return;
      draft.pin = {lat:pin.lat,lng:pin.lng};
      if (marker) marker.setLatLng([pin.lat,pin.lng]); else moveMarker(draft.pin);
      mapStatus.textContent = 'Pin selected. Drag it to adjust the meeting point.';
    }
    function commit(pin, name, city) {
      pins[kind] = validPin(pin) ? {lat:pin.lat,lng:pin.lng} : null;
      input.value = name.slice(0,120);
      if (kind === 'pickup' && city) $('pt-origin').value = city.slice(0,80);
      status.textContent = pins[kind] ? 'Pin attached' : '';
      onChange();
    }
    // The form and map dialog share the same address search and saved places.
    function bindSearch(field, list, onSelect, isDialog) {
      let timer, controller, version = 0, suppressFocus = false;
      function refocus() { suppressFocus=true; field.focus(); queueMicrotask(()=>suppressFocus=false); }
      function cancel() { version++; clearTimeout(timer); controller?.abort(); }
      function hide() { cancel(); list.hidden = true; list.replaceChildren(); }
      function show(results, message = '') {
        list.replaceChildren();
        const seen = new Set();
        for (const place of results) {
          const label = place.label || distinct([place.name,place.city]).join(', ');
          if (seen.has(label.toLowerCase())) continue;
          seen.add(label.toLowerCase());
          const button = document.createElement('button'), title = document.createElement('strong'), subtitle = document.createElement('span');
          button.type = 'button'; button.className = 'place-suggestion';
          title.textContent = place.name; subtitle.textContent = place.subtitle || place.city;
          button.append(title,subtitle);
          button.addEventListener('mousedown', e => e.preventDefault());
          button.addEventListener('click', () => { hide(); onSelect(place, label); if(isDialog) $(`pt-${kind}-confirm`).focus(); else refocus(); });
          list.append(button);
        }
        if (message) { const p = document.createElement('p'); p.className='small muted'; p.textContent=message; list.append(p); }
        list.hidden = !seen.size && !message;
        if (!isDialog) $(`pt-${kind}-search-status`).textContent = message || `${seen.size} places. Press Down Arrow to review.`;
      }
      async function run() {
        cancel();
        const current = version, query = field.value.trim();
        await placesPromise;
        if (destroyed || current !== version) return;
        const saved = matchingPlaces(places,query).slice(0,5);
        show(saved);
        if (query.length < 3) { show(saved); return; }
        timer = setTimeout(async () => {
          if (current !== version || destroyed || !field.isConnected) return;
          const bias = nearbyPlace(), key = `${query.toLowerCase()}|${bias.latitude}|${bias.longitude}`;
          controller = new AbortController();
          const timeout = setTimeout(() => controller?.abort(),5000);
          show(saved,'Searching addresses…');
          try {
            let rows = cache.get(key);
            if (!rows) {
              rows = await searchAddresses(query,bias,controller.signal);
              if (cache.size >= 40) cache.delete(cache.keys().next().value);
              cache.set(key,rows);
            }
            if (current === version && !destroyed) show([...saved,...rows], saved.length || rows.length ? '' : 'No places found. Try a street and city, or choose on the map.');
          } catch {
            if (current === version && !destroyed) show(saved,'Address search is unavailable. Enter an address or choose on the map.');
          } finally { clearTimeout(timeout); }
        },500);
      }
      field.addEventListener('input', () => {
        if (isDialog) { draft.name=field.value; draft.city=''; draft.pin=null; moveMarker(null); mapStatus.textContent='Choose a suggestion or tap the map.'; }
        else { pins[kind]=null; status.textContent=''; }
        run();
      });
      field.addEventListener('focus', () => { if(!suppressFocus) run(); });
      field.addEventListener('keydown', e => {
        if (e.key==='Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); hide(); }
        if (e.key==='ArrowDown' && !list.hidden) { e.preventDefault(); list.querySelector('button')?.focus(); }
        if (e.key==='Enter' && isDialog) { e.preventDefault(); list.querySelector('button')?.focus(); }
      });
      list.addEventListener('keydown', e => {
        const buttons=[...list.querySelectorAll('button')], i=buttons.indexOf(document.activeElement);
        if (e.key==='ArrowDown' || e.key==='ArrowUp') { e.preventDefault(); buttons[(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus(); }
        if (e.key==='Escape') { e.preventDefault(); e.stopPropagation(); hide(); refocus(); }
      });
      const outside = e => { if (e.target !== field && !list.contains(e.target)) hide(); };
      form.addEventListener('click',outside);
      cleanups.push(() => { cancel(); form.removeEventListener('click',outside); });
      return {run,hide};
    }
    const inline = bindSearch(input,$(`pt-${kind}-suggestions`),(place,label) => commit({lat:place.latitude,lng:place.longitude},label,place.city),false);
    const modal = bindSearch(search,$(`pt-${kind}-places`),(place,label) => {
      draft = {pin:{lat:place.latitude,lng:place.longitude}, name:label, city:place.city};
      search.value = label; moveMarker(draft.pin); mapStatus.textContent='Pin selected. Drag it to adjust the meeting point.';
    },true);
    $(`pt-${kind}-open`).addEventListener('click',async () => {
      inline.hide(); draft={pin:pins[kind],name:input.value,city:''}; search.value=input.value;
      dialog.showModal(); await placesPromise;
      if (destroyed || !dialog.open) return;
      if (!map && typeof L !== 'undefined') {
        const bias=nearbyPlace();
        map=L.map($(`pt-${kind}-map`),{scrollWheelZoom:false}).setView([bias.latitude,bias.longitude],13);
        maps.push(map);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
        map.on('click',e => setDraftPin(e.latlng));
      }
      if (!map) {
        $(`pt-${kind}-map`).textContent='Map unavailable. You can still choose an address from the suggestions.';
        $(`pt-${kind}-center`).disabled=true;
      } else { map.invalidateSize(); moveMarker(draft.pin); }
      mapStatus.textContent=draft.pin ? 'Pin selected. Drag it to adjust the meeting point.' : 'Search a place or tap the map.';
      modal.run(); search.focus();
    });
    const close = () => { modal.hide(); dialog.close(); $(`pt-${kind}-open`).focus(); };
    $(`pt-${kind}-close`).addEventListener('click',close);
    $(`pt-${kind}-cancel`).addEventListener('click',close);
    dialog.addEventListener('cancel', () => modal.hide());
    $(`pt-${kind}-center`).addEventListener('click', () => { if(map) setDraftPin(map.getCenter()); });
    $(`pt-${kind}-confirm`).addEventListener('click', () => {
      const name=search.value.trim() || (draft.pin ? `Map pin at ${draft.pin.lat.toFixed(5)}, ${draft.pin.lng.toFixed(5)}` : '');
      if (!name) { mapStatus.textContent='Choose a place or a map point first.'; search.focus(); return; }
      commit(draft.pin,name,draft.city); close();
    });
    $(kind==='pickup'?'pt-origin':'pt-dest-name')?.addEventListener('change', () => { inline.hide(); modal.hide(); });
  }
  return {pins, destroy(){ destroyed=true; cleanups.forEach(fn=>fn()); maps.forEach(map=>map.remove()); }};
}

// ---------- Post a Trip: type any destination ----------
// Known places (presets + destinations other drivers added) that match what was typed.
export function matchingDestinations(dests, query) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  return dests.filter(d => d.name.toLocaleLowerCase().includes(q) || (d.alias || []).some(a => a.includes(q) || q.includes(a))).slice(0, 6);
}
const sameName = (a, b) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

// Combobox for the Destination field. `known()` returns [{id, name, alias, lat, lng}].
// Choosing a known place stores its id in the hidden #pt-dest. Anything else (a search result
// or plain typed text) leaves #pt-dest empty; the form then creates the destination on publish.
export function bindDestinationPicker({input, hidden, box, status, known, onChange, search = searchAddresses}) {
  let timer, controller, version = 0;
  const cache = new Map();
  function setPin(lat, lng) {
    if (validPin({lat, lng})) { hidden.dataset.lat = String(lat); hidden.dataset.lng = String(lng); }
    else { delete hidden.dataset.lat; delete hidden.dataset.lng; }
  }
  function close() {
    version++; clearTimeout(timer); controller?.abort();
    box.hidden = true; box.replaceChildren(); input.setAttribute('aria-expanded', 'false');
  }
  function choose(item) {
    input.value = item.name.slice(0, 80);
    hidden.value = item.id || '';
    setPin(item.lat ?? item.latitude, item.lng ?? item.longitude);
    close();
    status.textContent = item.id ? `${item.name} selected.` : `${item.name} selected. It will be added as a new destination when you publish.`;
    onChange(); input.focus();
  }
  function show(items, message) {
    box.replaceChildren();
    const seen = new Set();
    for (const item of items) {
      const key = item.name.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const button = document.createElement('button'), title = document.createElement('strong'), sub = document.createElement('span');
      button.type = 'button'; button.className = 'place-suggestion'; button.setAttribute('role', 'option');
      title.textContent = item.name; sub.textContent = item.subtitle || (item.id ? 'Hitch destination' : 'New destination');
      button.append(title, sub);
      button.addEventListener('click', () => choose(item));
      box.append(button);
    }
    if (message) { const p = document.createElement('p'); p.className = 'small muted'; p.textContent = message; box.append(p); }
    box.hidden = !seen.size && !message;
    input.setAttribute('aria-expanded', String(!box.hidden));
    status.textContent = message || `${seen.size} destination ${seen.size === 1 ? 'suggestion' : 'suggestions'}. Press Down Arrow to review.`;
  }
  // Typing the exact name of a known place counts as choosing it.
  function matchExact() {
    const hit = known().find(d => sameName(d.name, input.value) || (d.alias || []).some(a => sameName(a, input.value)));
    if (hit) { hidden.value = hit.id; setPin(hit.lat, hit.lng); }
    return hit;
  }
  input.addEventListener('input', () => {
    close();
    hidden.value = ''; setPin();
    const query = input.value.trim();
    matchExact();
    onChange();
    if (!query) { status.textContent = ''; return; }
    const local = matchingDestinations(known(), query).map(d => ({...d, subtitle:'Hitch destination'}));
    if (query.length < 3) { show(local, ''); return; }
    show(local, 'Searching places…');
    const mine = version;
    timer = setTimeout(async () => {
      if (mine !== version || !input.isConnected) return;
      const request = new AbortController(); controller = request;
      const timeout = setTimeout(() => request.abort(), 5000);
      try {
        let found = cache.get(query.toLowerCase());
        if (!found) {
          found = (await search(query, {latitude:40.2338, longitude:-111.6585}, request.signal))
            .map(p => ({name:p.name, subtitle:p.subtitle, latitude:p.latitude, longitude:p.longitude}));
          cache.set(query.toLowerCase(), found);
        }
        if (mine !== version) return;
        const fresh = found.filter(p => !local.some(d => sameName(d.name, p.name)));
        show([...local, ...fresh], local.length || fresh.length ? '' : `No matches. You can still publish with "${query}" as a new destination.`);
      } catch {
        if (mine === version) show(local, `Place search is unavailable. You can still publish with "${query}".`);
      } finally { clearTimeout(timeout); }
    }, 400);
  });
  input.addEventListener('change', () => { matchExact(); onChange(); });
  input.addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); box.querySelector('button')?.focus(); }
  });
  box.addEventListener('keydown', e => {
    const buttons = [...box.querySelectorAll('button')], i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); input.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[Math.min(i + 1, buttons.length - 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); i <= 0 ? input.focus() : buttons[i - 1].focus(); }
  });
  return {choose, destroy: close};
}
