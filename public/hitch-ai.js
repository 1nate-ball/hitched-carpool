// AI proposes values only. Publishing remains the existing form's separate action.
const FIELDS = {
  origin_city:'pt-origin', destination_name:'pt-dest-name', departure_date:'pt-depart',
  departure_time:'pt-time', pickup_location:'pt-pickup', dropoff_location:'pt-dropoff',
  seats:'pt-seats', price_per_seat:'pt-price', return_date:'pt-return', return_time:'pt-return-time',
};

export function applyTripDraft(form, fields, dirty = new Set()) {
  if (!fields || typeof fields !== 'object') throw new Error('AI returned an invalid draft. Try again.');
  const get = id => form.querySelector('#'+id);
  let applied = 0;
  const change = field => { field.dispatchEvent(new Event('input',{bubbles:true})); field.dispatchEvent(new Event('change',{bubbles:true})); };
  const checkbox = get('pt-ret');
  if (fields.return_requested === true && !checkbox.checked && !dirty.has('pt-ret')) {
    checkbox.checked = true; change(checkbox); applied++;
  }
  for (const [key,id] of Object.entries(FIELDS)) {
    const field = get(id), value = fields[key];
    if (!field || value == null || dirty.has(id)) continue;
    if (key.startsWith('return_') && !checkbox.checked) continue;
    const untouchedOrigin = id === 'pt-origin' && field.value === 'Provo';
    if (String(field.value || '').trim() && !untouchedOrigin) continue;
    if (key === 'seats' || key === 'price_per_seat') {
      if (!Number.isInteger(value) || value < 1 || value > (key === 'seats' ? 7 : 150)) continue;
    } else {
      if (typeof value !== 'string' || !value.trim() || value.length > (key.includes('location') ? 120 : 80)) continue;
      if (key.endsWith('_date') && !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
      if (key.endsWith('_time') && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) continue;
    }
    if (id === 'pt-dest-name') {
      const destination = get('pt-dest');
      destination.value = ''; delete destination.dataset.lat; delete destination.dataset.lng;
    }
    field.value = String(value);
    // Use normal picker events so an AI address never retains an unrelated pin.
    change(field); applied++;
  }
  return applied;
}

export function bindTripDraft({form, getSession, getAccount, isCurrent}) {
  const get = id => form.querySelector('#'+id);
  const input = get('pt-ai-description'), button = get('pt-ai-fill'), status = get('pt-ai-status');
  const dirty = new Set(), owner = getAccount();
  let active = true, busy = false, applying = false, controller, timer, version = 0;
  const snapshot = () => JSON.stringify([...Object.values(FIELDS),'pt-ret','pt-car','pt-color','pt-plate'].map(id => {
    const el = get(id); return [id,el?.value || '',!!el?.checked];
  }));
  const edit = event => { if (!applying && event.target?.id) dirty.add(event.target.id); };
  form.addEventListener('input',edit); form.addEventListener('change',edit);
  const fill = async () => {
    if (busy || !active) return;
    const description = input.value.trim();
    if (description.length < 10 || description.length > 2000) {
      status.textContent = 'Describe your trip in 10 to 2,000 characters.'; input.focus(); return;
    }
    const request = ++version, before = snapshot();
    controller = new AbortController();
    busy = true; button.disabled = true; button.textContent = 'Drafting…'; button.setAttribute('aria-busy','true');
    status.textContent = 'Reading your trip description…';
    timer = setTimeout(() => controller.abort(),45000);
    try {
      const session = await getSession();
      if (!active || !isCurrent() || request !== version || getAccount() !== owner) return;
      if (!session || session.user.id !== owner) throw new Error('Your sign-in changed. Log in again before drafting.');
      const response = await fetch('/api/ai/trip-draft',{
        method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.accessToken},
        body:JSON.stringify({description}), signal:controller.signal,
      });
      const result = await response.json().catch(()=>({}));
      if (!active || !isCurrent() || request !== version || getAccount() !== owner) return;
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'AI could not draft this trip. Try again or enter it yourself.');
      if (before !== snapshot() || input.value.trim() !== description) {
        status.textContent = 'You edited the trip while AI was working. No AI changes were applied. Try again when ready.'; return;
      }
      applying = true;
      const count = applyTripDraft(form,result.fields,dirty);
      applying = false;
      status.textContent = count
        ? 'AI filled '+count+' detail'+(count===1?'':'s')+'. Review the form, complete anything missing, then publish. Your existing entries were kept.'
        : 'No blank fields were filled. Try a more specific description, or complete the form yourself.';
      if (Array.isArray(result.missing) && result.missing.length) {
        const missing = result.missing.filter(x => typeof x === 'string' && x.length <= 40).slice(0,10);
        if (missing.length) status.textContent += ' Not supplied by AI: '+missing.join(', ')+'.';
      }
    } catch(error) {
      if (active && isCurrent() && request === version && getAccount() === owner) {
        status.textContent = error.name === 'AbortError'
          ? 'AI took too long. Your form is unchanged; try again or enter the details yourself.'
          : error.message || 'AI is unavailable. You can still enter the trip yourself.';
      }
    } finally {
      clearTimeout(timer); applying = false;
      if (active && request === version) {
        busy = false; button.disabled = false; button.textContent = 'Fill trip details'; button.removeAttribute('aria-busy');
      }
    }
  };
  button.addEventListener('click',fill);
  return () => {
    active = false; version++; clearTimeout(timer); controller?.abort();
    button.removeEventListener('click',fill); form.removeEventListener('input',edit); form.removeEventListener('change',edit);
  };
}
