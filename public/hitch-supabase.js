// Publishable configuration only. Caller supplies a current Supabase Auth session.
// Used by the Post a Trip form; the profile page still uses the Python/SQLite backend.
let configuration;
async function config() {
  if (!configuration) {
    const response = await fetch('/supabase-config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load Hitch database configuration.');
    configuration = await response.json();
  }
  return configuration;
}

async function request(path, accessToken, payload) {
  if (!accessToken) throw new Error('Sign in before using the Hitch database.');
  const { url, publishableKey } = await config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
      ...(payload ? { 'Content-Type': 'application/json', Prefer: 'return=representation' } : {}),
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

export function loadDestinations(accessToken) {
  return request('destinations?select=id,name&order=name', accessToken);
}

export function loadTrips(accessToken) {
  // Bounded initial list; pagination can be added if the class demo grows.
  return request('trips?select=*&order=departure_at&limit=100', accessToken);
}

// Find Rides: the database does the filtering (destination, date window, max price).
// Only future trips come back. `fromIso`/`toIso` are UTC ISO strings; `maxPrice` is whole dollars.
export function searchTrips(accessToken, { destinationId, fromIso, toIso, maxPrice } = {}) {
  const q = ['select=*', 'order=departure_at', 'limit=100'];
  if (destinationId) q.push(`destination_id=eq.${encodeURIComponent(destinationId)}`);
  q.push(`departure_at=gte.${encodeURIComponent(fromIso || new Date().toISOString())}`);
  if (toIso) q.push(`departure_at=lt.${encodeURIComponent(toIso)}`);
  if (maxPrice) q.push(`price_per_seat=lte.${Number(maxPrice)}`);
  return request(`trips?${q.join('&')}`, accessToken);
}

export async function publishTrip(accessToken, fields) {
  // Identity, UUID and creation timestamp come from the database.
  const payload = Object.fromEntries([
    'destination_id', 'departure_at', 'pickup_location', 'dropoff_location',
    'total_seats', 'price_per_seat', 'return_at',
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

async function authFetch(path, body, accessToken) {
  const { url, publishableKey } = await config();
  const response = await fetch(`${url}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function tokenRequest(grantType, body) {
  const { response, data } = await authFetch(`token?grant_type=${grantType}`, body);
  if (!response.ok) throw authError(response, data, 'Sign-in failed.');
  return saveSession(toSession(data));
}

export function signIn(email, password) {
  return tokenRequest('password', { email: email.trim().toLowerCase(), password });
}

// Sign Up. The full name goes into the user's metadata; a database trigger copies it
// into public.profiles (see supabase/migrations/20261105000100_profiles_auth.sql).
// Returns {session} when the user is signed in right away, or {needsConfirmation: true}
// when the project requires email confirmation first.
// Errors: code 'user_already_exists' (duplicate email) and 'weak_password'.
export async function signUp(fullName, email, password) {
  const redirect = encodeURIComponent(globalThis.location ? location.origin : '');
  const { response, data } = await authFetch(`signup?redirect_to=${redirect}`, {
    email: email.trim().toLowerCase(),
    password,
    data: { full_name: fullName.trim() },
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
  return saveSession(toSession({
    access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
    expires_at: Number(p.get('expires_at')) || undefined, expires_in: Number(p.get('expires_in')) || undefined, user,
  }));
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
    return await tokenRequest('refresh_token', { refresh_token: session.refreshToken });
  } catch (error) {
    if (error.status === 400 || error.status === 401) signOut();
    return null;
  }
}

// The signed-in user's row in public.profiles (created at sign-up).
export async function loadMyProfile(accessToken, userId) {
  const rows = await request(`profiles?select=id,full_name&id=eq.${encodeURIComponent(userId)}`, accessToken);
  return rows[0] || null;
}
