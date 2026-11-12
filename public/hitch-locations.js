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
  const pins = {pickup:null, dropoff:null}, maps = [], cancelSearches = [];
  const cache = new Map();
  let placesPromise;
  const getPlaces = () => placesPromise ||= api.loadLocations(session.accessToken);
  const $ = id => form.querySelector('#' + id);
  for (const kind of ['pickup','dropoff']) {
    const details = $(`pt-${kind}-picker`), input = $(`pt-${kind}`);
    if (!details) continue;
    const status = $(`pt-${kind}-status`), search = $(`pt-${kind}-search`), list = $(`pt-${kind}-places`);
    const suggestions = $(`pt-${kind}-suggestions`), searchStatus = $(`pt-${kind}-search-status`);
    let map, marker, places = [], opened = false;
    getPlaces().then(rows => { places = rows; }).catch(() => {});
    let timer, controller, searchVersion = 0;
    function cancelSearch(){
      searchVersion++;
      clearTimeout(timer);
      controller?.abort();
      controller = null;
    }
    cancelSearches.push(cancelSearch);
    function hideSuggestions(){
      cancelSearch();
      suggestions.hidden = true;
      suggestions.replaceChildren();
      searchStatus.textContent = '';
    }
    function nearbyPlace(){
      const dest = $('pt-dest');
      const city = kind === 'pickup' ? $('pt-origin').value.trim() : DESTINATION_CITIES[dest.value] || dest.selectedOptions?.[0]?.textContent || '';
      return places.find(place => place.city.toLowerCase() === city.toLowerCase()) || PROVO;
    }
    function select(pin, name, city) {
      if (!validPin(pin)) return;
      hideSuggestions();
      pins[kind] = pin;
      if (name) input.value = name.slice(0, 120);
      if (kind === 'pickup' && city) $('pt-origin').value = city.slice(0, 80);
      status.textContent = name ? 'Pin attached. Check the map for the exact meeting point.' : 'Pin attached. Check that the address above describes the meeting point.';
      if (map) {
        if (marker) marker.setLatLng([pin.lat, pin.lng]);
        else marker = L.marker([pin.lat, pin.lng], {title:`Selected ${kind} point`}).addTo(map);
        map.panTo([pin.lat, pin.lng]);
      }
      onChange();
    }
    function showSuggestions(results, message){
      suggestions.replaceChildren();
      const seen = new Set();
      for (const place of results) {
        const label = place.label || distinct([place.name, place.city]).join(', ');
        if (seen.has(label.toLowerCase())) continue;
        seen.add(label.toLowerCase());
        const button = document.createElement('button');
        const title = document.createElement('strong'), subtitle = document.createElement('span');
        button.type = 'button'; button.className = 'place-suggestion';
        title.textContent = place.name; subtitle.textContent = place.subtitle || place.city;
        button.append(title, subtitle);
        button.addEventListener('click', () => {
          select({lat:place.latitude,lng:place.longitude}, label, place.city);
          details.open = true;
          input.focus();
        });
        suggestions.append(button);
      }
      if (message) {
        const hint = document.createElement('p'); hint.className = 'small muted'; hint.textContent = message;
        suggestions.append(hint);
      }
      suggestions.hidden = !seen.size && !message;
      searchStatus.textContent = message || `${seen.size} location ${seen.size === 1 ? 'suggestion' : 'suggestions'}. Press Down Arrow to review.`;
    }
    input.addEventListener('input', () => {
      hideSuggestions();
      pins[kind] = null;
      if (marker && map) { map.removeLayer(marker); marker = null; }
      status.textContent = 'Choose a suggestion or map point to attach a pin.';
      const query = input.value.trim();
      if (query.length < 3) return;
      const version = searchVersion;
      timer = setTimeout(async () => {
        if (version !== searchVersion || !input.isConnected) return;
        const saved = matchingPlaces(places, query).slice(0, 3), bias = nearbyPlace();
        const key = `${query.toLowerCase()}|${bias.latitude}|${bias.longitude}`;
        const request = new AbortController();
        controller = request;
        const timeout = setTimeout(() => request.abort(), 5000);
        showSuggestions([], 'Searching addresses…');
        try {
          let results = cache.get(key);
          if (!results) {
            results = await searchAddresses(query, bias, request.signal);
            if (cache.size >= 40) cache.delete(cache.keys().next().value);
            cache.set(key, results);
          }
          if (version !== searchVersion) return;
          showSuggestions([...saved, ...results], saved.length || results.length ? '' : 'No places found. Try a street and city, enter the address, or use the map.');
        } catch {
          if (version === searchVersion) showSuggestions(saved, 'Address search is unavailable. You can still type the address or use the map.');
        } finally { clearTimeout(timeout); }
      }, 500);
    });
    input.addEventListener('keydown', e => {
      if (suggestions.hidden) return;
      if (e.key === 'Escape'){ e.preventDefault(); hideSuggestions(); }
      if (e.key === 'ArrowDown' || e.key === 'Enter'){
        e.preventDefault(); suggestions.querySelector('button')?.focus();
      }
    });
    suggestions.addEventListener('keydown', e => {
      if (e.key === 'Escape'){ e.preventDefault(); hideSuggestions(); input.focus(); }
    });
    $(kind === 'pickup' ? 'pt-origin' : 'pt-dest').addEventListener('change', hideSuggestions);
    function showPlaces() {
      list.replaceChildren();
      const found = matchingPlaces(places, search.value);
      if (!found.length) { list.textContent = 'No saved places match. Move the map to your meeting spot, or enter the address above.'; return; }
      for (const place of found) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn sm'; button.textContent = `${place.name} · ${place.city}`;
        button.addEventListener('click', () => select({lat:place.latitude,lng:place.longitude}, place.name, place.city));
        list.append(button);
      }
    }
    search.addEventListener('input', showPlaces);
    details.addEventListener('toggle', async () => {
      if (!details.open || opened) { if (map) map.invalidateSize(); return; }
      opened = true;
      try {
        places = await getPlaces();
        if (!details.isConnected) return;
        showPlaces();
      } catch { list.textContent = 'Saved places could not load. You can still select a map point or type an address above.'; }
      if (!details.isConnected) return;
      if (typeof L !== 'undefined') {
        const bias = nearbyPlace(), pin = pins[kind];
        map = L.map($(`pt-${kind}-map`), {scrollWheelZoom:false}).setView(pin ? [pin.lat,pin.lng] : [bias.latitude,bias.longitude], pin ? 16 : 13);
        maps.push(map);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map).on('tileerror', () => { if (!pins[kind]) status.textContent = 'Map tiles could not load. Place suggestions still work.'; });
        map.on('click', e => select({lat:e.latlng.lat,lng:e.latlng.lng}));
        if (pin) marker = L.marker([pin.lat,pin.lng], {title:`Selected ${kind} point`}).addTo(map);
        $(`pt-${kind}-center`).addEventListener('click', () => { const p=map.getCenter(); select({lat:p.lat,lng:p.lng}); });
      } else {
        $(`pt-${kind}-map`).textContent = 'The map could not load. Choose a saved place to attach its pin, or type an address above.';
        $(`pt-${kind}-center`).disabled = true;
      }
    });
  }
  return {pins, destroy(){ cancelSearches.forEach(cancel => cancel()); maps.forEach(map => map.remove()); }};
}
