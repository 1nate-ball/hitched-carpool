// The local Census Gazetteer list is shared by signup and Edit profile.
let citiesPromise;
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function indexCities({states, places}) {
  return Object.entries(places).flatMap(([code, names]) => {
    const state = normalize(states[code]);
    return names.map(city => {
      const name = normalize(city);
      return {label:`${city}, ${code}`, name, code:code.toLowerCase(), state, words:`${name} ${code.toLowerCase()} ${state}`.split(' ')};
    });
  });
}

export function matchCities(cities, query) {
  const [cityText, ...rest] = query.split(',');
  const city = normalize(cityText), state = normalize(rest.join(' ')), whole = normalize(query);
  if (whole.length < 2) return [];
  const terms = (rest.length ? city : whole).split(' ').filter(Boolean);
  const matches = cities.flatMap(place => {
    if (state && !place.code.startsWith(state) && !place.state.startsWith(state)) return [];
    const words = rest.length ? place.name.split(' ') : place.words;
    if (!terms.every(term => words.some(word => word.startsWith(term)))) return [];
    const cityQuery = rest.length ? city : whole;
    const rank = place.name === cityQuery ? 0 : place.name.startsWith(cityQuery) ? 1 : place.name.startsWith(terms[0] || '') ? 2 : 3;
    return [{label:place.label, rank}];
  }).sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const exactCount = matches.filter(place => place.rank === 0).length;
  return matches.slice(0, Math.max(8, exactCount)).map(place => place.label);
}

function loadCities() {
  citiesPromise ||= fetch('/hitch-cities.json').then(response => {
    if (!response.ok) throw new Error('City list unavailable');
    return response.json();
  }).then(indexCities).catch(error => { citiesPromise = null; throw error; });
  return citiesPromise;
}

export function bindCityPicker(input) {
  const list = document.getElementById(`${input.id}-options`);
  const selected = document.getElementById(`${input.id}-value`);
  const status = document.getElementById(`${input.id}-status`);
  const error = document.getElementById(`${input.id}-error`);
  let choices = [], active = -1, version = 0;

  function close() {
    version++;
    list.hidden = true;
    list.replaceChildren();
    status.textContent = '';
    choices = []; active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function choose(city) {
    input.value = city;
    selected.value = city;
    close();
    input.focus();
  }

  async function search() {
    close();
    const query = input.value.trim();
    if (normalize(query).length < 2 || query === selected.value) return;
    const current = version;
    status.textContent = 'Loading cities…';
    try {
      const cities = await loadCities();
      if (current !== version || !input.isConnected) return;
      choices = matchCities(cities, query);
      status.textContent = choices.length ? '' : 'No cities found. Try another spelling or add the state.';
      if (!choices.length) return;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      for (const [index, city] of choices.entries()) {
        const item = document.createElement('div');
        item.id = `${list.id}-${index}`;
        item.className = 'place-suggestion';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', 'false');
        item.textContent = city;
        item.addEventListener('click', () => choose(city));
        list.append(item);
      }
    } catch {
      if (current === version) status.textContent = 'City search could not load. Try again or leave hometown blank.';
    }
  }

  input.addEventListener('input', () => {
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    search();
  });
  input.addEventListener('focus', search);
  input.addEventListener('blur', close);
  list.addEventListener('mousedown', event => event.preventDefault());
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (!list.hidden) event.preventDefault(); close(); return; }
    if (!choices.length) return;
    if (event.key === 'Enter' && active >= 0) {
      event.preventDefault(); choose(choices[active]); return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    active = event.key === 'ArrowDown' ? (active + 1) % choices.length : (active <= 0 ? choices.length - 1 : active - 1);
    for (const [index, item] of Array.from(list.children).entries()) item.setAttribute('aria-selected', String(index === active));
    const item = list.children[active];
    input.setAttribute('aria-activedescendant', item.id);
    item.scrollIntoView({block:'nearest'});
  });
  if (document.activeElement === input) search();
}
