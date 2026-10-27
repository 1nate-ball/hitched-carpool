// Publishable configuration only. Caller supplies a current Supabase Auth session.
// This helper does not replace the existing profile backend or wire up the form.
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

export async function publishTrip(accessToken, fields) {
  // Identity, UUID and creation timestamp come from the database.
  const payload = Object.fromEntries([
    'destination_id', 'departure_at', 'pickup_location', 'dropoff_location',
    'total_seats', 'price_per_seat', 'return_at',
  ].filter(key => fields[key] !== undefined).map(key => [key, fields[key]]));
  const rows = await request('trips?select=*', accessToken, payload);
  return rows[0];
}
