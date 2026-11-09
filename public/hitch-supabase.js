// Publishable configuration only. Caller supplies a current Supabase Auth session.
// Used by signed-in trips, requests and account profiles.
let configuration;
async function config() {
  if (!configuration) {
    const response = await fetch('/supabase-config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load Hitch database configuration.');
    configuration = await response.json();
  }
  return configuration;
}

async function request(path, accessToken, payload, method, prefer) {
  if (!accessToken) throw new Error('Sign in before using the Hitch database.');
  const { url, publishableKey } = await config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: method || (payload ? 'POST' : 'GET'),
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      ...(payload ? { 'Content-Type': 'application/json', Prefer: ['return=representation', prefer].filter(Boolean).join(',') } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || 'Database request failed.');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

// Every destination, including ones drivers typed in. Falls back to id/name if the
// any-destination migration hasn't been applied yet, so older databases keep working.
export async function loadDestinations(accessToken) {
  try {
    return await request('destinations?select=id,name,latitude,longitude,photo_url&order=name', accessToken);
  } catch (error) {
    if (error.status !== 400) throw error;
    return request('destinations?select=id,name&order=name', accessToken);
  }
}

// Post a Trip: returns the destination row for a typed place, creating it if it's new.
// The database cleans the name, reuses an existing row ignoring case, and generates the id.
export async function ensureDestination(accessToken, { name, latitude = null, longitude = null }) {
  const pin = Number.isFinite(latitude) && Number.isFinite(longitude);
  const data = await request('rpc/find_or_create_destination', accessToken, {
    p_name: String(name || '').trim(),
    p_latitude: pin ? latitude : null,
    p_longitude: pin ? longitude : null,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) throw new Error('Could not save the destination.');
  return row;
}

export function loadTrips(accessToken) {
  // Bounded initial list; pagination can be added if the class demo grows.
  return request('trips?select=*&order=departure_at&limit=100', accessToken);
}

// Find Rides: the database does the filtering (destination, date window, max price).
// Only future trips come back. `fromIso`/`toIso` are UTC ISO strings; `maxPrice` is whole dollars.
export function searchTrips(accessToken, { destinationId, fromCity, fromIso, toIso, maxPrice } = {}) {
  const q = ['select=*', 'order=departure_at', 'limit=100'];
  if (destinationId) q.push(`destination_id=eq.${encodeURIComponent(destinationId)}`);
  q.push(`departure_at=gte.${encodeURIComponent(fromIso || new Date().toISOString())}`);
  if (toIso) q.push(`departure_at=lt.${encodeURIComponent(toIso)}`);
  if (fromCity) q.push(`origin_city=ilike.${encodeURIComponent(fromCity.trim().replace(/[\%_*]/g, ''))}`);
  if (maxPrice) q.push(`price_per_seat=lte.${Number(maxPrice)}`);
  return request(`available_trips?${q.join('&')}`, accessToken);
}

export function loadLocations(accessToken) {
  return request('locations?select=id,name,city,latitude,longitude&order=name&limit=200', accessToken);
}

export async function publishTrip(accessToken, fields) {
  // Identity, UUID and creation timestamp come from the database.
  const payload = Object.fromEntries([
    'destination_id', 'departure_at', 'pickup_location', 'dropoff_location',
    'total_seats', 'price_per_seat', 'return_at', 'origin_city',
    'pickup_latitude', 'pickup_longitude', 'dropoff_latitude', 'dropoff_longitude',
  ].filter(key => fields[key] !== undefined).map(key => [key, fields[key]]));
  const rows = await request('trips?select=*', accessToken, payload);
  if (!Array.isArray(rows) || !rows[0]?.id) throw new Error('Could not confirm the saved trip.');
  return rows[0];
}

// Request a Seat. rider_id and status ('pending') are set by the database, never sent from here.
// The database rejects a second request for the same trip (23505) and requests on your own trip (42501).
export async function requestSeat(accessToken, tripId, note = '') {
  const rows = await request('ride_requests?select=*', accessToken, { trip_id: tripId, note: note.trim() });
  if (!Array.isArray(rows) || !rows[0]?.id) throw new Error('Could not confirm the seat request.');
  return rows[0];
}

// The signed-in rider's own requests (RLS also lets drivers read requests on their trips; filter those out).
export function loadMyRequests(accessToken, riderId) {
  return request(`ride_requests?select=trip_id,status,note,created_at&rider_id=eq.${encodeURIComponent(riderId)}`, accessToken);
}

// ---------- Driver: accept or decline seat requests ----------
const inList = ids => `(${[...new Set(ids)].map(encodeURIComponent).join(',')})`;

// Every request on the given trips. RLS returns only trips the signed-in user drives.
export function loadTripRequests(accessToken, tripIds) {
  if (!tripIds.length) return Promise.resolve([]);
  return request(`ride_requests?select=id,trip_id,rider_id,note,status,created_at&trip_id=in.${inList(tripIds)}&order=created_at`, accessToken);
}

// Names for riders/drivers. Emails are never readable through the API.
export async function loadProfiles(accessToken, userIds) {
  if (!userIds.length) return Promise.resolve([]);
  const rows = await request(`profiles?select=id,full_name,avatar_path&id=in.${inList(userIds)}`, accessToken);
  return Promise.all(rows.map(async row => ({...row, photo:await profilePhotoUrl(accessToken,row.avatar_path)})));
}

// Seats left per trip, counting accepted requests. Full or departed trips aren't returned.
export async function loadSeatsAvailable(accessToken, tripIds) {
  if (!tripIds.length) return {};
  const rows = await request(`available_trips?select=id,seats_available&id=in.${inList(tripIds)}`, accessToken);
  return Object.fromEntries(rows.map(r => [r.id, r.seats_available]));
}

// status: 'accepted' or 'declined'. The database allows this only for the trip's driver, only on
// pending requests, and refuses an accept when the trip is full (23514, "This trip is full.").
export async function decideRequest(accessToken, requestId, status) {
  const rows = await request(`ride_requests?id=eq.${encodeURIComponent(requestId)}&select=id,status`, accessToken, { status }, 'PATCH');
  if (!Array.isArray(rows) || rows[0]?.status !== status) {
    const error = new Error('Only the driver can respond to this request.'); error.code = '42501'; throw error;
  }
  return rows[0];
}

// ---------- Supabase Auth (email + password) ----------
// The session is kept in localStorage so a page refresh keeps the user signed in.
const SESSION_KEY = 'hitch-supabase-session';

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* private window */ }
  return session;
}
function toSession(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: { id: data.user.id, email: data.user.email },
  };
}

// Supabase Auth errors come back as {error_code, msg} (newer) or {error, error_description} (older).
function authError(response, data, fallback) {
  const error = new Error(data.msg || data.error_description || data.message || fallback);
  error.status = response.status;
  error.code = data.error_code || data.code || data.error;
  return error;
}

async function authFetch(path, body, accessToken, method = 'POST') {
  const { url, publishableKey } = await config();
  const response = await fetch(`${url}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: publishableKey,
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(method === 'GET' ? {} : {body: JSON.stringify(body || {})}),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function tokenRequest(grantType, body, recovery = false) {
  const { response, data } = await authFetch(`token?grant_type=${grantType}`, body);
  if (!response.ok) throw authError(response, data, 'Sign-in failed.');
  const session = toSession(data);
  if (recovery) session.recovery = true;
  return saveSession(session);
}

export function signIn(email, password) {
  return tokenRequest('password', { email: email.trim().toLowerCase(), password });
}

export async function requestPasswordReset(email) {
  const redirect = encodeURIComponent(location.origin);
  const { response, data } = await authFetch(`recover?redirect_to=${redirect}`, { email: email.trim().toLowerCase() });
  if (!response.ok) throw authError(response, data, 'Could not send a reset link.');
}

export async function updatePassword(accessToken, password) {
  const { response, data } = await authFetch('user', { password }, accessToken, 'PUT');
  if (!response.ok) throw authError(response, data, 'Could not update the password.');
}

function profileDetails(user) {
  const data = user.user_metadata || {};
  const readText = (value, limit) => typeof value === 'string' ? [...value.trim()].slice(0, limit).join('') : '';
  return {hometown:readText(data.hometown, 100), bio:readText(data.bio, 160), color:readText(data.avatar_color, 7)};
}

export async function loadProfileDetails(accessToken) {
  const {response, data} = await authFetch('user', null, accessToken, 'GET');
  if (!response.ok) throw authError(response, data, 'Could not load your profile details.');
  return profileDetails(data);
}

export async function saveProfileDetails(accessToken, {hometown, bio, color}) {
  const {response, data} = await authFetch('user', {data:{hometown, bio, avatar_color:color}}, accessToken, 'PUT');
  if (!response.ok) throw authError(response, data, 'Could not save your profile details.');
  return profileDetails(data);
}

// Sign Up. The full name goes into the user's metadata; a database trigger copies it
// into public.profiles (see supabase/migrations/20261105000100_profiles_auth.sql).
// Returns {session} when the user is signed in right away, or {needsConfirmation: true}
// when the project requires email confirmation first.
// Errors: code 'user_already_exists' (duplicate email) and 'weak_password'.
export async function signUp(fullName, email, password, {hometown = '', bio = ''} = {}) {
  const redirect = encodeURIComponent(globalThis.location ? location.origin : '');
  const { response, data } = await authFetch(`signup?redirect_to=${redirect}`, {
    email: email.trim().toLowerCase(),
    password,
    data: {
      full_name: fullName.trim(),
      ...(hometown.trim() ? {hometown:hometown.trim()} : {}),
      ...(bio.trim() ? {bio:bio.trim()} : {}),
    },
  });
  if (!response.ok) throw authError(response, data, 'Sign-up failed.');
  if (data.access_token) return { session: saveSession(toSession(data)) };
  // With email confirmation on, Supabase hides duplicates: it answers 200 with a user
  // that has no identities instead of an error. Treat that as a duplicate email.
  const user = data.user || data;
  if (Array.isArray(user.identities) && user.identities.length === 0) {
    const error = new Error('User already registered');
    error.status = 422; error.code = 'user_already_exists';
    throw error;
  }
  return { needsConfirmation: true };
}

// After the user clicks the confirmation link, Supabase redirects back with the
// session in the URL hash (#access_token=...). Save it and clean the URL.
export async function sessionFromUrl() {
  const hash = globalThis.location ? location.hash.slice(1) : '';
  if (!hash.includes('access_token=')) return null;
  const p = new URLSearchParams(hash);
  history.replaceState(null, '', location.pathname + location.search);
  const { url, publishableKey } = await config();
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${p.get('access_token')}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  const session = toSession({
    access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
    expires_at: Number(p.get('expires_at')) || undefined, expires_in: Number(p.get('expires_in')) || undefined, user,
  });
  if (p.get('type') === 'recovery') session.recovery = true;
  return saveSession(session);
}

export function signOut() {
  const session = readSession();
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  // Best effort: also revoke the refresh token on the server.
  if (session?.accessToken) authFetch('logout', {}, session.accessToken).catch(() => {});
}

// Returns a session with a usable access token, refreshing it if it is about to expire.
// Only a rejected refresh signs the user out; a dropped connection keeps the saved session.
export async function getSession() {
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt - 60 > Date.now() / 1000) return session;
  try {
    return await tokenRequest('refresh_token', { refresh_token: session.refreshToken }, session.recovery);
  } catch (error) {
    if (error.status === 400 || error.status === 401) signOut();
    return null;
  }
}

// Verified = a confirmed byu.edu email (see 20261108000100_driver_verification.sql).
// Returns {userId: true|false} for up to 200 ids. No emails are returned.
export async function loadVerification(accessToken, userIds) {
  const ids = [...new Set(userIds)].slice(0, 200);
  if (!ids.length) return {};
  const rows = await request('rpc/verification_status', accessToken, { user_ids: ids });
  return Object.fromEntries(rows.map(r => [r.user_id, r.is_verified === true]));
}

// Trip Detail: one trip by id, fresh from the database.
export async function loadTrip(accessToken, tripId) {
  const rows = await request(`trips?select=*&id=eq.${encodeURIComponent(tripId)}`, accessToken);
  return rows[0] || null;
}

// The signed-in user's row in public.profiles (created at sign-up).
export async function loadMyProfile(accessToken, userId) {
  const rows = await request(`profiles?select=id,full_name,avatar_path&id=eq.${encodeURIComponent(userId)}`, accessToken);
  return rows[0] ? {...rows[0], photo:await profilePhotoUrl(accessToken,rows[0].avatar_path)} : null;
}

const photoUrls = new Map();
const photoPath = path => typeof path === 'string' && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(path);
async function storageRequest(path, accessToken, body, method='POST') {
  if (!accessToken) throw new Error('Sign in before changing your photo.');
  const {url,publishableKey} = await config(), binary = body instanceof Blob;
  const response = await fetch(`${url}/storage/v1/${path}`,{
    method, headers:{apikey:publishableKey,Authorization:`Bearer ${accessToken}`,
      'Content-Type':binary ? 'image/jpeg' : 'application/json'},
    body:binary ? body : JSON.stringify(body),
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.message || data.error || 'Could not save your profile photo. Try again.');
  return data;
}
async function signPhoto(accessToken,path) {
  const {url} = await config();
  const data = await storageRequest(`object/sign/profile-photos/${path}`,accessToken,{expiresIn:3600});
  if (!data.signedURL?.startsWith('/object/sign/profile-photos/')) throw new Error('Could not display your profile photo.');
  return `${url}/storage/v1${data.signedURL}`;
}
export async function profilePhotoUrl(accessToken,path) {
  if (!photoPath(path)) return null;
  const key = `${accessToken}|${path}`, cached = photoUrls.get(key);
  if (cached && cached.expires > Date.now()) return cached.url;
  try {
    const url = await signPhoto(accessToken,path);
    if (photoUrls.size >= 100) photoUrls.delete(photoUrls.keys().next().value);
    photoUrls.set(key,{url,expires:Date.now()+50*60*1000});
    return url;
  } catch { return null; } // An unavailable image does not prevent loading the account or trip.
}
export async function saveProfilePhoto(accessToken,userId,photo) {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('Sign in again before changing your photo.');
  if (photo !== null && (!(photo instanceof Blob) || photo.type !== 'image/jpeg' || !photo.size || photo.size > 1048576)) throw new Error('Choose a valid profile photo smaller than 1 MB.');
  const previous = await loadMyProfile(accessToken,userId);
  const path = photo ? `${userId}/${crypto.randomUUID()}.jpg` : null;
  const remove = p => storageRequest('object/profile-photos',accessToken,{prefixes:[p]},'DELETE');
  let uploaded = false, attemptedSave = false, photoUrl = null;
  try {
    if (photo) {
      await storageRequest(`object/profile-photos/${path}`,accessToken,photo);
      uploaded = true;
      photoUrl = await signPhoto(accessToken,path);
    }
    attemptedSave = true;
    const rows = await request(`profiles?id=eq.${userId}&select=id,avatar_path`,accessToken,{avatar_path:path},'PATCH');
    if (rows[0]?.id !== userId || rows[0]?.avatar_path !== path) throw new Error('Could not save your profile photo.');
  } catch(error) {
    if (attemptedSave && error.status === undefined) {
      // A lost response may still have committed. Never delete a photo until the profile is checked.
      let current;
      try { current = await loadMyProfile(accessToken,userId); }
      catch { throw new Error('Could not confirm whether your photo saved. Refresh your profile before trying again.'); }
      if (current?.avatar_path === path) return {avatar_path:path,photo:photoUrl};
    }
    if (uploaded) await remove(path).catch(()=>{});
    throw error;
  }
  if (photoPath(previous?.avatar_path) && previous.avatar_path !== path) await remove(previous.avatar_path).catch(()=>{});
  return {avatar_path:path,photo:photoUrl};
}

// ---------- Pickup identification (car details + pickup code) ----------
// RLS returns the row only to the trip's driver and to riders whose request was accepted.
export async function loadPickupDetails(accessToken, tripId) {
  const rows = await request(`trip_pickup_details?select=trip_id,vehicle_make_model,vehicle_color,license_plate,pickup_code&trip_id=eq.${encodeURIComponent(tripId)}`, accessToken);
  return rows[0] || null;
}

// Driver only. Creates the row (the database picks the pickup code) or updates the car details.
export async function savePickupDetails(accessToken, tripId, { makeModel = '', color = '', plate = '' } = {}) {
  const rows = await request('trip_pickup_details?on_conflict=trip_id&select=trip_id,vehicle_make_model,vehicle_color,license_plate,pickup_code', accessToken, {
    trip_id: tripId,
    vehicle_make_model: makeModel.trim().slice(0, 60),
    vehicle_color: color.trim().slice(0, 30),
    license_plate: plate.trim().toUpperCase().slice(0, 10),
  }, 'POST', 'resolution=merge-duplicates');
  if (!Array.isArray(rows) || !rows[0]) throw new Error('Could not save the car details.');
  return rows[0];
}
