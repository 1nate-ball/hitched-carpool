// The place list comes from Supabase. Maps use Leaflet 1.9.4 and ordinary OSM tiles.
export function validPin(pin) {
  return pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng) &&
    pin.lat >= -90 && pin.lat <= 90 && pin.lng >= -180 && pin.lng <= 180;
}
export function matchingPlaces(places, query) {
  const q = query.trim().toLocaleLowerCase();
  return places.filter(p => `${p.name} ${p.city}`.toLocaleLowerCase().includes(q)).slice(0, 12);
}
export function bindLocationPickers({api, session, form, onChange}) {
  const pins = {pickup:null, dropoff:null}, maps = [];
  let placesPromise;
  const $ = id => form.querySelector('#' + id);
  for (const kind of ['pickup','dropoff']) {
    const details = $(`pt-${kind}-picker`), input = $(`pt-${kind}`);
    if (!details) continue;
    const status = $(`pt-${kind}-status`), search = $(`pt-${kind}-search`), list = $(`pt-${kind}-places`);
    let map, marker, places = [], opened = false;
    function select(pin, name, city) {
      if (!validPin(pin)) return;
      pins[kind] = pin;
      if (name) input.value = name;
      if (kind === 'pickup' && city) $('pt-origin').value = city;
      status.textContent = `Pin selected: ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}. ${kind === 'dropoff' ? 'This is the arrival point, not the return pickup.' : 'Confirm the starting city and meeting spot.'}`;
      if (map) {
        if (marker) marker.setLatLng([pin.lat, pin.lng]);
        else marker = L.marker([pin.lat, pin.lng], {title:`Selected ${kind} point`}).addTo(map);
        map.panTo([pin.lat, pin.lng]);
      }
      onChange();
    }
    input.addEventListener('input', () => {
      pins[kind] = null;
      if (marker && map) { map.removeLayer(marker); marker = null; }
      status.textContent = 'Location text changed. Choose a pin again to attach it.';
    });
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
        placesPromise ||= api.loadLocations(session.accessToken);
        places = await placesPromise;
        if (!details.isConnected) return;
        showPlaces();
      } catch { list.textContent = 'Saved places could not load. You can still select a map point or type an address above.'; }
      if (!details.isConnected) return;
      if (typeof L !== 'undefined') {
        map = L.map($(`pt-${kind}-map`), {scrollWheelZoom:false}).setView([40.2485,-111.6472], 13);
        maps.push(map);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map).on('tileerror', () => { status.textContent = 'Map tiles could not load. Saved-place buttons still work.'; });
        map.on('click', e => select({lat:e.latlng.lat,lng:e.latlng.lng}));
        if (pins[kind]) select(pins[kind]);
        $(`pt-${kind}-center`).addEventListener('click', () => { const p=map.getCenter(); select({lat:p.lat,lng:p.lng}); });
      } else {
        $(`pt-${kind}-map`).textContent = 'The map could not load. Choose a saved place to attach its pin, or type an address above.';
        $(`pt-${kind}-center`).disabled = true;
      }
    });
  }
  return {pins, destroy(){ maps.forEach(map => map.remove()); }};
}
