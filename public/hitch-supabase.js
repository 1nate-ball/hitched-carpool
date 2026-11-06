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

// ---------- Supabase Auth (email + password test accounts) ----------
// Sign-up UI is separate backlog work. For Sprint 1 the team signs in with test
// accounts created in the Supabase dashboard (Authentication -> Users).
const SESSION_KEY = 'hitch-supabase-session';

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* private window */ }
  return session;
}

async function authRequest(grantType, body) {
  const { url, publishableKey } = await config();
  const response = await fetch(`${url}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.msg || 'Sign-in failed.');
    error.status = response.status;
    throw error;
  }
  return saveSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: { id: data.user.id, email: data.user.email },
  });
}

export function signIn(email, password) {
  return authRequest('password', { email, password });
}

export function signOut() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

// Returns a session with a usable access token, refreshing it if it is about to expire.
export async function getSession() {
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt - 60 > Date.now() / 1000) return session;
  try {
    return await authRequest('refresh_token', { refresh_token: session.refreshToken });
  } catch {
    signOut();
    return null;
  }
}
